const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fail } = require('../src/shared/errors.cjs');
const {
  createAppointmentExecution,
} = require('../src/server/modules/assistant/actions/appointments/appointment-execution.cjs');
const {
  moveExecutionFixture,
  day,
  tomorrow,
} = require('./helpers/assistant-move-execution-fixture.cjs');
const gate = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const movedMarkers = (f) =>
  f.storage.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'assistant-moved:%'").get().n;
function chooseSource(f) {
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
  const choice = [...f.entry().options].find(
    ([, row]) => row.kind === 'appointmentSource' && row.value.appointmentId === f.row().id,
  );
  assert.ok(choice, 'the original source must be explicitly selected');
  f.answer({ choice: choice[0] });
}
function assertReady(f) {
  assert.equal(f.result.action?.type, 'moveAppointment');
  assert.equal(f.result.action.executionId, f.entry().id);
  assert.equal(f.result.dialogue, null);
  assert.equal(f.calls(), 0);
}

test('automatic move prepares without a clinical write; execute updates the same appointment through the actual common writer', async (t) => {
  const f = moveExecutionFixture(t),
    before = structuredClone(f.row());
  const revision = f.storage.get('revision');
  assertReady(f);
  assert.equal(f.result.text, 'Переношу запись.');
  assert.equal(f.storage.get('revision'), revision);
  assert.deepEqual(f.row(), before);
  assert.equal(movedMarkers(f), 0);
  const result = await f.api.execute(f.c, f.body());
  assert.equal(result.saved, true);
  assert.equal(result.moved, true);
  assert.equal(result.operation, 'move');
  assert.equal(result.appointmentId, before.id);
  assert.match(result.text, /^Перен[её]с запись:/u);
  assert.equal(result.action.type, 'calendar');
  assert.equal(result.action.date, tomorrow);
  assert.equal(f.rows().length, 1);
  assert.deepEqual(f.row(), { ...before, date: tomorrow, time: '12:30', roomId: 'main' });
  assert.equal(f.storage.get('revision'), revision + 1);
  assert.equal(f.calls(), 1);
  assert.ok(f.scheduleChecks.length > 0, 'the real schedule check is used');
  assert.ok(f.scheduleAssertions.length > 0, 'the real common writer applies schedule assertions');
  assert.equal(movedMarkers(f), 1);
});

test('self-overlap does not prevent moving fifteen minutes later and does not duplicate the original row', async (t) => {
  const f = moveExecutionFixture(t, { targetDate: day, targetTime: '10:15' });
  assertReady(f);
  const id = f.row().id;
  await f.api.execute(f.c, f.body());
  assert.equal(f.rows().length, 1);
  assert.equal(f.row().id, id);
  assert.equal(f.row().time, '10:15');
});

test('a moved historical service snapshot and noncatalog duration remain unchanged', async (t) => {
  const f = moveExecutionFixture(t, { historical: true, sourceDuration: 45 });
  const before = structuredClone(f.row());
  assertReady(f);
  await f.api.execute(f.c, f.body());
  assert.deepEqual(f.row().serviceItems, before.serviceItems);
  assert.equal(f.row().service, before.service);
  assert.equal(f.row().duration, 45);
  assert.equal(f.row().id, before.id);
  assert.equal(f.row().notes, before.notes);
});

test('a busy destination is offered as an alternative, which does not execute before explicit selection', async (t) => {
  const f = moveExecutionFixture(t, {
    beforeStart: (value) => value.addBooking({ time: '12:30', duration: 60 }),
  });
  const before = structuredClone(f.row());
  chooseSource(f);
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'period');
  assert.match(f.result.text, /занято/u);
  assert.equal(f.result.dialogue.options.length, 2);
  assert.deepEqual(f.row(), before);
  assert.equal(f.calls(), 0);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  f.answer({ text: 'в 14:00' });
  assertReady(f);
  await f.api.execute(f.c, f.body());
  assert.notEqual(f.row().time, '12:30');
  assert.equal(f.row().id, before.id);
  assert.equal(f.rows().length, 2);
});

test('an appointment must fit wholly in the working interval; an unfitting destination never executes', async (t) => {
  const f = moveExecutionFixture(t, {
    sourceDuration: 60,
    targetTime: '12:30',
    intervals: [['12:00', '13:00']],
  });
  const before = structuredClone(f.row());
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
  await assert.rejects(
    f.api.execute(f.c, { executionId: f.result.dialogue.id, policyVersion: f.state.revision }),
    { status: 409 },
  );
  assert.deepEqual(f.row(), before);
});

test('a personal event blocks the requested destination without changing the source appointment', (t) => {
  const f = moveExecutionFixture(t, {
    beforeStart: (value) =>
      value.personal.push({ staffId: 'owner', date: tomorrow, time: '12:30', duration: 60 }),
  });
  assert.equal(f.result.action, null);
  assert.match(f.result.text, /занято/u);
  assert.equal(f.row().time, '10:00');
  assert.equal(f.calls(), 0);
});

test('a shared occupied room can select another eligible free room while preserving identity and service', async (t) => {
  const f = moveExecutionFixture(t, {
    beforeStart(value) {
      value.members.push({
        accountId: 'colleague',
        displayName: 'Другой специалист',
        role: 'cosmetologist',
        status: 'active',
      });
      value.workspace.rooms[0].staffMode = 'multiple';
      value.workspace.rooms[0].staffIds.push('colleague');
      value.workspace.rooms.push({
        id: 'secondary',
        name: 'Второй',
        active: true,
        preventOverlap: true,
        staffMode: 'single',
        staffIds: ['owner'],
      });
      value.addBooking({ staffId: 'colleague', roomId: 'main', time: '12:30', duration: 30 });
    },
  });
  chooseSource(f);
  assertReady(f);
  const before = structuredClone(f.row());
  await f.api.execute(f.c, f.body());
  assert.equal(f.row().roomId, 'secondary');
  assert.equal(f.row().id, before.id);
  assert.deepEqual(f.row().serviceItems, before.serviceItems);
  assert.equal(f.row().duration, before.duration);
});

for (const role of ['owner', 'salon_admin'])
  test('one closed-day confirmation authorizes only the bound move: ' + role, async (t) => {
    const f = moveExecutionFixture(t, { role, closed: true });
    const before = structuredClone(f.row());
    assert.equal(f.result.dialogue.phase, 'closedDay');
    assert.equal(f.result.action, null);
    await assert.rejects(
      f.api.execute(f.c, { executionId: f.result.dialogue.id, policyVersion: f.state.revision }),
      { status: 409 },
    );
    f.answer({ text: 'да-да' });
    assertReady(f);
    assert.deepEqual(f.row(), before);
    const result = await f.api.execute(f.c, f.body());
    assert.equal(result.moved, true);
    assert.equal(f.days[tomorrow].status, 'closed', 'an exception never opens a workday');
    assert.ok(
      f.scheduleAssertions.some(
        (value) => typeof value.acknowledgement === 'string' && value.acknowledgement.length > 0,
      ),
    );
  });

test('an employee cannot override a closed destination by saying yes or forging an HTTP field', async (t) => {
  const f = moveExecutionFixture(t, { role: 'cosmetologist', closed: true });
  const before = structuredClone(f.row());
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.equal(f.result.dialogue.options.length, 0);
  f.answer({ text: 'да' });
  assert.equal(f.result.action, null);
  await assert.rejects(
    f.api.execute(f.c, {
      executionId: f.result.dialogue.id,
      policyVersion: f.state.revision,
      allowClosedDay: true,
    }),
    { status: 400 },
  );
  assert.deepEqual(f.row(), before);
  assert.equal(f.calls(), 0);
});

for (const text of ['нет', 'не надо', 'стоп', 'отмена'])
  test('a negative answer never executes a pending closed-day move: ' + text, async (t) => {
    const f = moveExecutionFixture(t, { closed: true }),
      before = structuredClone(f.row());
    const id = f.result.dialogue.id;
    f.answer({ text });
    assert.equal(f.result.action, null);
    await assert.rejects(f.api.execute(f.c, { executionId: id, policyVersion: f.state.revision }), {
      status: 409,
    });
    assert.deepEqual(f.row(), before);
    assert.equal(f.calls(), 0);
  });

for (const change of [
  'source',
  'patient',
  'revision',
  'permission',
  'policy',
  'timeZone',
  'personal',
  'reservation',
  'room',
])
  test('the common writer rejects a fresh move race: ' + change, async (t) => {
    const f = moveExecutionFixture(t),
      before = structuredClone(f.row());
    assertReady(f);
    f.hooks.beforeCommit = () => {
      if (change === 'permission') return f.revoke();
      if (change === 'policy') {
        f.state.revision++;
        return;
      }
      if (change === 'timeZone') {
        f.c.platform.organizationTimeZone = () => 'UTC';
        return;
      }
      if (change === 'personal') {
        f.personal.push({ staffId: 'owner', date: tomorrow, time: '12:30', duration: 60 });
        return;
      }
      if (change === 'reservation') {
        f.reservations.push({
          id: randomUUID(),
          staffId: 'owner',
          roomId: 'main',
          date: tomorrow,
          time: '12:30',
          duration: 60,
          status: 'pending',
          expiresAt: Date.parse(tomorrow + 'T20:00:00Z'),
        });
        return;
      }
      if (change === 'room') {
        f.workspace.rooms[0].active = false;
        return;
      }
      f.mutate((next) => {
        if (change === 'source')
          next.patients[0].appointments[0].notes = 'Synthetic changed source';
        if (change === 'patient') {
          next.patients[0].firstName = 'Ольга';
          next.patients[0].name = 'Ольга Семёнова';
        }
      });
    };
    await assert.rejects(f.api.execute(f.c, f.body()), {
      status: change === 'permission' ? 403 : 409,
    });
    assert.equal(f.row().date, before.date);
    assert.equal(f.row().time, before.time);
    assert.equal(f.row().id, before.id);
    assert.equal(movedMarkers(f), 0);
  });

test('a new conflicting appointment between readiness and writer commit preserves the original move source', async (t) => {
  const f = moveExecutionFixture(t),
    before = structuredClone(f.row());
  f.hooks.beforeCommit = () => f.addBooking({ time: '12:30', duration: 60 });
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 409 });
  assert.deepEqual(f.row(), before);
  assert.equal(f.rows().length, 2, 'only the independently added conflicting appointment exists');
  assert.equal(movedMarkers(f), 0);
});

test('a changed private target or fabricated execution action cannot redirect the bound ready move', async (t) => {
  const f = moveExecutionFixture(t),
    before = structuredClone(f.row());
  const request = f.body();
  f.entry().data.management.targetTime = '15:00';
  await assert.rejects(f.api.execute(f.c, request), { status: 409 });
  assert.deepEqual(f.row(), before);
  assert.equal(movedMarkers(f), 0);
});

test('concurrent move execution and permanent replay after restart cannot move twice or expose clinical replay data', async (t) => {
  const f = moveExecutionFixture(t),
    request = f.body(),
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
  assert.ok(replies.every((reply) => reply.saved && reply.moved));
  assert.equal(replies[0].appointmentId, f.row().id);
  assert.equal(replies[1].appointmentId, null);
  assert.equal(replies[1].alreadySaved, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.rows().length, 1);
  f.flow.clearSession(f.c.current.sessionId);
  f.c.current.sessionId = randomUUID();
  f.state.revision++;
  const replay = await createAppointmentExecution(f.options).execute(f.c, request);
  assert.equal(replay.moved, true);
  assert.equal(replay.operation, 'move');
  assert.equal(replay.alreadySaved, true);
  assert.equal(replay.appointmentId, null);
  assert.equal(replay.action, null);
  assert.equal(f.calls(), 1);
  f.c.current = { ...f.c.current, accountId: 'other-account', sessionId: randomUUID() };
  const hidden = await createAppointmentExecution(f.options).execute(f.c, request);
  assert.equal(hidden.saved, false);
  assert.equal(hidden.code, 'ASSISTANT_EXECUTION_EXPIRED');
});

test('a lost post-commit response reconciles only its durable moved marker', async (t) => {
  const f = moveExecutionFixture(t);
  f.hooks.afterCommit = () => {
    throw fail(503, 'Synthetic move response lost');
  };
  const result = await f.api.execute(f.c, f.body());
  assert.equal(result.alreadySaved, true);
  assert.equal(result.moved, true);
  assert.equal(result.appointmentId, null);
  assert.equal(result.action, null);
  assert.equal(f.row().date, tomorrow);
  assert.equal(f.calls(), 1);
});

test('a post-marker failure rolls back both the move and the boolean marker in one transaction', async (t) => {
  const f = moveExecutionFixture(t, { failWritten: true }),
    before = structuredClone(f.row());
  const revision = f.storage.get('revision');
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 503 });
  assert.deepEqual(f.row(), before);
  assert.equal(f.storage.get('revision'), revision);
  assert.equal(movedMarkers(f), 0);
});

test('default-off stays an honest preview; demo and arbitrary HTTP overrides cannot execute a move', async (t) => {
  const preview = moveExecutionFixture(t, { enabled: false });
  assert.equal(preview.result.action.type, 'appointmentPreview');
  assert.equal(preview.result.action.operation, 'move');
  await assert.rejects(
    preview.api.execute(preview.c, {
      executionId: randomUUID(),
      policyVersion: preview.state.revision,
    }),
    { status: 403 },
  );
  assert.equal(preview.row().time, '10:00');
  const f = moveExecutionFixture(t);
  for (const extra of [
    { date: day },
    { time: '01:00' },
    { duration: 90 },
    { operation: 'move' },
    { appointmentId: randomUUID() },
    { allowClosedDay: true },
  ])
    await assert.rejects(f.api.execute(f.c, { ...f.body(), ...extra }), { status: 400 });
  f.state.providers.llm.provider = 'demo';
  await assert.rejects(f.api.execute(f.c, f.body()), { status: 403 });
  assert.equal(f.row().time, '10:00');
  assert.equal(f.calls(), 0);
});
