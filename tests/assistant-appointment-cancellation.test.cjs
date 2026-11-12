const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const { fail } = require('../src/shared/errors.cjs');
const { nextDate } = require('../src/shared/work-schedule.cjs');
function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('cancel initially asks exact source confirmation; only execute mutates the chosen appointment through the common pipeline', async (t) => {
  const f = cancellationFixture(t),
    before = structuredClone(f.row()),
    revision = f.storage.get('revision');
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.text, 'Отменить сегодня в 10:00?');
  assert.equal(f.result.dialogue.prompt, f.result.text);
  assert.equal(f.result.dialogue.options[0].label, 'Да, отменить');
  assert.match(
    f.result.dialogue.fields.find((field) => field.key === 'client').value,
    /Анна Семёнова/u,
  );
  const pending = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  assert.equal(
    pending.data.management.cancelConfirmation.description,
    'Анна Семёнова, сегодня в 10:00',
  );
  assert.deepEqual(pending.data.management.cancelConfirmation.appointment, before);
  const { body: confirmedBody } = f.answer({ text: 'да' });
  assert.equal(f.result.action.type, 'cancelAppointment');
  assert.equal(f.result.text, 'Отменяю запись.');
  assert.deepEqual(f.row(), before);
  assert.equal(f.storage.get('revision'), revision);
  const saved = await f.api.execute(f.c, f.body());
  assert.equal(saved.saved, true);
  assert.equal(saved.cancelled, true);
  assert.equal(saved.operation, 'cancel');
  assert.equal(saved.appointmentId, before.id);
  assert.equal(saved.text, 'Отменил запись: Анна Семёнова, сегодня в 10:00.');
  assert.equal(saved.action.type, 'calendar');
  const { outcomeAt, outcomeBy, ...appointment } = f.row();
  assert.equal(Number.isSafeInteger(outcomeAt), true);
  assert.ok(outcomeAt > 0 && outcomeAt <= Date.now());
  assert.equal(outcomeBy, f.c.current.accountId);
  assert.deepEqual(appointment, { ...before, status: 'cancelled' });
  assert.equal(f.calls(), 1);
  const receipt = f.management.continueDialogue(f.c, confirmedBody, f.state, f.member, f.clock);
  assert.equal(receipt.cancelled, true);
  assert.equal(receipt.appointmentId, before.id);
});

test('three existing appointments require source selection followed by one short bound cancellation question', async (t) => {
  const f = cancellationFixture(t);
  const current = f.storage.read();
  const selected = {
    ...structuredClone(current.patients[0].appointments[0]),
    id: randomUUID(),
    date: nextDate(f.clock.date),
    time: '18:00',
  };
  const other = {
    ...structuredClone(selected),
    id: randomUUID(),
    date: nextDate(selected.date),
    time: '12:00',
  };
  current.patients[0].appointments.push(selected, other);
  f.storage.write(current);
  const revision = f.storage.get('revision');
  let reply = f.management.start(
    f.c,
    { intent: 'cancelAppointment', query: 'Анна Семёнова' },
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
  );
  assert.equal(reply.dialogue.phase, 'appointmentChoice');
  assert.equal(reply.dialogue.options.length, 3);
  let entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
  const choice = [...entry.options].find(([, row]) => row.value.appointmentId === selected.id);
  assert.ok(choice);
  reply = f.management.continueDialogue(
    f.c,
    { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, choice: choice[0] },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(reply.text, 'Отменить завтра в 18:00?');
  assert.equal(reply.dialogue.prompt, reply.text);
  assert.equal(reply.dialogue.phase, 'cancelConfirmation');
  assert.equal(reply.dialogue.options[0].label, 'Да, отменить');
  assert.equal(reply.action, null);
  assert.match(
    reply.dialogue.fields.find((field) => field.key === 'client').value,
    /Анна Семёнова/u,
  );
  entry = f.flow.get(f.c, f.member, f.state, reply.dialogue.id);
  assert.equal(
    entry.data.management.cancelConfirmation.description,
    'Анна Семёнова, завтра в 18:00',
  );
  assert.deepEqual(entry.data.management.cancelConfirmation.appointment, selected);
  assert.equal(entry.data.management.cancelConfirmation.binding.source.appointmentId, selected.id);
  assert.equal(f.calls(), 0);
  assert.equal(f.storage.get('revision'), revision);
  const confirmedBody = {
    dialogueId: reply.dialogue.id,
    dialogueVersion: reply.dialogue.version,
    text: 'да, отменить',
  };
  reply = f.management.continueDialogue(f.c, confirmedBody, f.state, f.member, f.clock);
  assert.equal(reply.action.type, 'cancelAppointment');
  const saved = await f.api.execute(f.c, {
    executionId: reply.action.executionId,
    policyVersion: f.state.revision,
  });
  assert.equal(saved.saved, true);
  assert.equal(saved.appointmentId, selected.id);
  assert.equal(saved.text, 'Отменил запись: Анна Семёнова, завтра в 18:00.');
  const rows = f.storage.readSelected([f.patients[0].id]).patients[0].appointments;
  assert.equal(rows.find((row) => row.id === selected.id).status, 'cancelled');
  assert.equal(rows.find((row) => row.id === other.id).status, 'scheduled');
  assert.equal(rows.find((row) => row.id === f.source.id).status, 'scheduled');
  assert.equal(f.calls(), 1);
  assert.equal(
    f.management.continueDialogue(f.c, confirmedBody, f.state, f.member, f.clock).cancelled,
    true,
  );
  assert.equal(f.calls(), 1);
});

for (const answer of ['нет', 'не надо', 'стоп', 'отмена', 'cancel'])
  test('negative confirmation preserves the appointment: ' + answer, async (t) => {
    const f = cancellationFixture(t),
      before = structuredClone(f.row());
    f.answer({ text: answer });
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue, null);
    assert.deepEqual(f.row(), before);
    assert.equal(f.calls(), 0);
  });

for (const answer of ['верно', 'ага', 'да, верно'])
  test('bounded affirmative confirms exactly the currently bound source: ' + answer, (t) => {
    const f = cancellationFixture(t);
    f.answer({ text: answer });
    assert.equal(f.result.action.type, 'cancelAppointment');
    assert.equal(f.row().status, 'scheduled');
  });

test('an ordinal or arbitrary action word is not an affirmative cancellation answer; stale choice/version is rejected', (t) => {
  const f = cancellationFixture(t),
    old = {
      dialogueId: f.result.dialogue.id,
      dialogueVersion: f.result.dialogue.version,
      choice: f.result.dialogue.options[0].id,
    };
  for (const text of ['первый', 'запиши', 'открой форму', 'да но не отменяй']) {
    f.answer({ text });
    assert.equal(f.result.action, null);
  }
  assert.throws(() => f.management.continueDialogue(f.c, old, f.state, f.member, f.clock), {
    status: 409,
  });
  assert.equal(f.row().status, 'scheduled');
});

test('client clarification retains the server pilot capability until the explicit cancellation confirmation', (t) => {
  const f = cancellationFixture(t, { query: '' });
  assert.equal(f.result.dialogue.step, 'client');
  f.answer({ text: 'Анна Семёнова' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
  f.answer({ choice: f.result.dialogue.options[0].id });
  assert.equal(f.result.action.type, 'cancelAppointment');
});

test('unconfirmed tokens, preview-default and arbitrary HTTP overrides cannot cancel', async (t) => {
  const f = cancellationFixture(t);
  await assert.rejects(
    f.api.execute(f.c, { executionId: f.result.dialogue.id, policyVersion: f.state.revision }),
    { status: 409 },
  );
  f.answer({ text: 'да' });
  for (const extra of [
    { patientId: randomUUID() },
    { appointmentId: randomUUID() },
    { status: 'cancelled' },
    { operation: 'cancel' },
  ])
    await assert.rejects(f.api.execute(f.c, { ...f.body(), ...extra }), { status: 400 });
  const disabled = cancellationFixture(t, { enabled: false });
  disabled.answer({ text: 'да' });
  assert.equal(disabled.result.action.type, 'appointmentPreview');
  await assert.rejects(
    disabled.api.execute(disabled.c, {
      executionId: randomUUID(),
      policyVersion: disabled.state.revision,
    }),
    { status: 403 },
  );
  assert.equal(disabled.row().status, 'scheduled');
  assert.equal(f.row().status, 'scheduled');
});

test('concurrent cancel execution and durable replay after restart/login/expiry never duplicate a mutation or fabricate an appointment id', async (t) => {
  const f = cancellationFixture(t);
  f.answer({ text: 'да' });
  const request = f.body(),
    entered = gate(),
    wait = gate();
  f.hooks.beforeCommit = async () => {
    entered.resolve();
    await wait.promise;
  };
  const first = f.api.execute(f.c, request);
  await entered.promise;
  const second = f.api.execute(f.c, request);
  wait.resolve();
  const replies = await Promise.all([first, second]);
  assert.ok(replies.every((r) => r.saved));
  assert.equal(replies[1].alreadySaved, true);
  assert.equal(replies[1].appointmentId, null);
  assert.equal(f.calls(), 1);
  f.flow.clearSession(f.c.current.sessionId);
  f.c.current.sessionId = randomUUID();
  f.state.revision++;
  const restarted = createAppointmentExecution(f.options),
    replay = await restarted.execute(f.c, request);
  assert.equal(replay.alreadySaved, true);
  assert.equal(replay.cancelled, true);
  assert.equal(replay.appointmentId, null);
  assert.equal(replay.action, null);
  assert.equal(f.row().status, 'cancelled');
  assert.equal(f.calls(), 1);
  f.c.current = { ...f.c.current, accountId: 'other-account', sessionId: randomUUID() };
  const hidden = await restarted.execute(f.c, request);
  assert.equal(hidden.saved, false);
  assert.equal(hidden.code, 'ASSISTANT_EXECUTION_EXPIRED');
});

test('a response lost after the common commit reconciles the permanent cancellation marker', async (t) => {
  const f = cancellationFixture(t);
  f.answer({ text: 'да' });
  f.hooks.afterCommit = () => {
    throw fail(503, 'Synthetic lostresponse');
  };
  const result = await f.api.execute(f.c, f.body());
  assert.equal(result.alreadySaved, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.appointmentId, null);
  assert.equal(f.calls(), 1);
});

test('post-marker failure rolls cancellation and its boolean marker back in the same cabinet transaction', async (t) => {
  const f = cancellationFixture(t, { failWritten: true });
  f.answer({ text: 'да' });
  const revision = f.storage.get('revision');
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 503 });
  assert.equal(f.row().status, 'scheduled');
  assert.equal(f.storage.get('revision'), revision);
  assert.equal(
    f.storage.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'assistant-cancelled:%'").get()
      .n,
    0,
  );
});

for (const change of ['source', 'client', 'permission', 'policy', 'revision'])
  test('fresh cancellation commit rejects a changed ' + change, async (t) => {
    const f = cancellationFixture(t);
    f.answer({ text: 'да' });
    const request = f.body();
    f.hooks.beforeCommit = () => {
      if (change === 'permission') return f.revoke();
      if (change === 'policy') {
        f.state.revision++;
        return;
      }
      const next = f.storage.read();
      if (change === 'source') next.patients[0].appointments[0].notes = 'Synthetic changednote';
      else if (change === 'client') {
        next.patients[0].firstName = 'Ольга';
        next.patients[0].name = 'Ольга Семёнова';
      }
      f.storage.write(next);
    };
    await assert.rejects(f.api.execute(f.c, request), {
      status: change === 'permission' ? 403 : 409,
    });
    assert.equal(f.row().status, 'scheduled');
  });

test('demo, revoked scope and a forged move preview cannot use cancellation execution', async (t) => {
  const f = cancellationFixture(t);
  f.answer({ text: 'да' });
  const request = f.body();
  const entry = f.flow.get(f.c, f.member, f.state, request.executionId);
  entry.data.management.operation = 'move';
  await assert.rejects(f.api.execute(f.c, request), { status: 409 });
  entry.data.management.operation = 'cancel';
  f.state.providers.llm.provider = 'demo';
  await assert.rejects(f.api.execute(f.c, request), { status: 403 });
  assert.equal(f.row().status, 'scheduled');
});

for (const answer of ['Да, отменить', 'Верно, отмени', 'Ага, отменяй эту запись'])
  test(
    'action-bearing confirmation remains bound to the current cancellation source: ' + answer,
    (t) => {
      const f = cancellationFixture(t),
        before = structuredClone(f.row());
      f.answer({ text: answer });
      assert.equal(f.result.action.type, 'cancelAppointment');
      assert.deepEqual(f.row(), before);
      assert.equal(f.calls(), 0);
    },
  );
for (const answer of [
  'Да, нет, отменить',
  'Нет, отменить',
  'Да, отменить другую запись',
  'Да, запиши',
  'Да, отменить если свободно',
  'Ага, отменить и отправить сообщение',
])
  test('mixed or foreign action cannot confirm the current cancellation: ' + answer, (t) => {
    const f = cancellationFixture(t),
      before = structuredClone(f.row());
    f.answer({ text: answer });
    assert.equal(f.result.action, null);
    assert.deepEqual(f.row(), before);
    assert.equal(f.calls(), 0);
  });
