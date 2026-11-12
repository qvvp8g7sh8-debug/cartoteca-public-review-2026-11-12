const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dialogueControl,
  informationResponse,
} = require('../src/server/modules/assistant/dialogue/dialogue-control.cjs');
const {
  informationTurn,
} = require('../src/server/modules/assistant/dialogue/dialogue-control-turn.cjs');
const { spokenReply } = require('../src/server/modules/assistant/speech/spoken-reply.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const {
  managementResponse,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-view.cjs');

const entry = (f) => f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
const body = (f, text) => ({
  policyVersion: f.state.revision,
  dialogueId: f.result.dialogue.id,
  dialogueVersion: f.result.dialogue.version,
  text,
});
const start = (f) =>
  f.start({ query: 'Семёнова', serviceQuery: 'Чистка', date: day, time: '12:00' });

test('whole informational questions are local controls, not entity answers or action requests', () => {
  for (const [text, expected] of [
    ['Повторите вопрос, пожалуйста.', 'question'],
    ['не расслышала', 'question'],
    ['повтори варианты', 'choices'],
    ['перечисли варианты ещё раз', 'choices'],
    ['что уже выбрано?', 'summary'],
    ['на чём мы остановились?', 'summary'],
    ['я передумала', 'stop'],
    ['останови подготовку', 'stop'],
  ])
    assert.equal(dialogueControl(text), expected, text);
  for (const text of [
    'если я передумал',
    'я не передумал',
    'повтори и запиши Анну',
    'передумал, перенеси на завтра',
    'что выбрано и измени клиента',
    'Анна',
    'да',
  ])
    assert.equal(dialogueControl(text, 'create'), null, text);
});

test('a refusal belongs only to its current create, move, cancel or edit operation', () => {
  for (const [text, operation] of [
    ['не записывай', 'create'],
    ['не переноси', 'move'],
    ['не хочу отменять', 'cancel'],
    ['я передумала менять запись', 'edit'],
  ]) {
    assert.equal(dialogueControl(text, operation), 'stop');
    for (const other of ['create', 'move', 'cancel', 'edit'].filter((value) => value !== operation))
      assert.equal(dialogueControl(text, other), null);
  }
});

function dto(options = [], fields = []) {
  return {
    text: 'Какую запись?',
    action: null,
    dialogue: {
      id: 'current',
      version: 1,
      step: 'appointment',
      prompt: 'Какую запись?',
      options,
      fields,
      input: { type: 'text', field: 'appointment' },
    },
  };
}

test('repeat choices is bounded to three current labels and no invented option numbers', () => {
  const options = Array.from({ length: 25 }, (_, index) => ({
    id: 'opaque-' + index,
    label: 'Запись ' + index,
  }));
  const reply = informationResponse(dto(options), 'choices', { date: day }, 120);
  assert.ok(reply.text.length <= 120);
  assert.match(reply.text, /Запись 0/);
  assert.match(reply.text, /Остальные — на экране/);
  assert.ok(!reply.text.includes('Запись 3'));
  assert.deepEqual(reply.dialogue.options, options);
  assert.equal(reply.action, null);
});

test('duplicate current names retain only their already shown phone suffix as a distinction', () => {
  const reply = informationResponse(
    dto([
      { id: 'a', label: 'Алла Семёнова · …1234' },
      { id: 'b', label: 'Алла Семёнова · …5678' },
    ]),
    'choices',
    { date: day },
  );
  assert.match(reply.text, /Алла Семёнова, телефон 1234/);
  assert.match(reply.text, /Алла Семёнова, телефон 5678/);
  assert.ok(!reply.text.includes('+7'));
});

test('summary reads selected DTO fields once and does not expose a phone or unselected query', () => {
  const original = dto(
    [],
    [
      { key: 'client', label: 'Клиент', value: 'Анна Семёнова · …1234' },
      { key: 'date', label: 'Дата', value: day },
      { key: 'clientQuery', label: 'Поиск', value: 'Unselected query' },
      { key: 'client', label: 'Клиент', value: 'Duplicate' },
    ],
  );
  const before = structuredClone(original);
  const reply = informationResponse(original, 'summary', { date: day });
  assert.match(reply.text, /5 января/);
  assert.equal((reply.text.match(/Анна Семёнова/gu) || []).length, 1);
  assert.ok(!/1234|Unselected|Duplicate/u.test(reply.text));
  assert.deepEqual(original, before);
  assert.equal(spokenReply(reply), reply.dialogue.prompt);
});

test('repeating closed-day choices only repeats the existing question and never its consent button', () => {
  const source = dto([{ id: 'bound', label: 'Да, продолжить' }]);
  source.dialogue.phase = 'closedDay';
  source.dialogue.prompt = 'День не открыт. Всё равно записать?';
  const reply = informationResponse(source, 'choices', { date: day });
  assert.equal(reply.text, source.dialogue.prompt);
  assert.deepEqual(reply.dialogue.options, source.dialogue.options);
  assert.equal(reply.action, null);
});

test('create informational turns bypass the model, keep fields and opaque choices, and replay once', () => {
  const f = dialogueFixture({ ambiguous: true });
  start(f);
  const selected = structuredClone(entry(f).data),
    choices = structuredClone(f.result.dialogue.options),
    originalQuestion = f.result.dialogue.prompt;
  const request = body(f, 'что уже выбрано');
  assert.equal(f.flow.prepareModelTurn(f.c, request, f.state, f.member, f.clock), null);
  const first = f.answer({ text: request.text }).result;
  assert.deepEqual(entry(f).data, selected);
  assert.deepEqual(first.dialogue.options, choices);
  assert.equal(first.action, null);
  const turns = entry(f).turns;
  assert.deepEqual(f.flow.continueDialogue(f.c, request, f.state, f.member, f.clock), first);
  assert.equal(entry(f).turns, turns);
  f.answer({ text: 'на чём остановились' });
  assert.equal((f.result.text.match(/Чистка/gu) || []).length, 1);
  f.answer({ text: 'повтори вопрос' });
  assert.equal(f.result.text, originalQuestion);
  f.answer({ choice: choices[0].id });
  assert.equal(f.result.dialogue.information, undefined);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('asking for summary or choices does not count as an unsuccessful client clarification', () => {
  const f = dialogueFixture();
  f.start({ query: '', serviceQuery: 'Чистка', date: day, time: '12:00' });
  f.answer({ text: 'Редкаяфамилия' });
  const before = structuredClone(entry(f).data._clarificationRecovery);
  for (const text of ['что уже выбрано', 'повтори варианты', 'не расслышал']) {
    f.answer({ text });
    assert.deepEqual(entry(f).data._clarificationRecovery, before);
    assert.equal(f.result.action, null);
  }
});

test('changed client references refresh information and invalidate old choices without executing', () => {
  const f = dialogueFixture({ ambiguous: true });
  start(f);
  const old = f.result.dialogue.options[0].id;
  f.patients.splice(0, 1);
  f.changed();
  f.answer({ text: 'повтори варианты' });
  assert.ok(!f.result.dialogue.options.some((choice) => choice.id === old));
  assert.equal(f.result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('information preserves stale version, session and policy guards', () => {
  const f = dialogueFixture({ ambiguous: true });
  start(f);
  const request = body(f, 'повтори варианты');
  f.answer({ text: 'что уже выбрано' });
  assert.throws(() => f.flow.continueDialogue(f.c, request, f.state, f.member, f.clock), {
    status: 409,
  });
  const current = body(f, 'повтори вопрос');
  assert.throws(
    () =>
      f.flow.continueDialogue(
        { ...f.c, current: { ...f.c.current, sessionId: 'other' } },
        current,
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  f.state.policy.commands.prepareAppointment = false;
  assert.throws(() => f.flow.continueDialogue(f.c, current, f.state, f.member, f.clock), {
    status: 403,
  });
});

test('a future executing presenter cannot turn informational refresh or replay into an action', () => {
  const current = {
    response: dto(),
    data: {},
    options: new Map(),
    controls: new Map(),
    version: 1,
    turns: 0,
  };
  const reply = informationTurn(current, 'summary', {
    refresh: () => ({ action: { type: 'createAppointment' }, dialogue: null }),
    hash: 'synthetic',
    clock: { date: day },
  });
  assert.equal(reply.action, null);
  assert.equal(current.cancelled, true);
});

test('create can stop its draft locally without creating an appointment', () => {
  const f = dialogueFixture();
  f.start({ query: '', serviceQuery: 'Чистка', date: day, time: '12:00' });
  assert.equal(
    f.flow.prepareModelTurn(f.c, body(f, 'я передумала'), f.state, f.member, f.clock),
    null,
  );
  f.answer({ text: 'я передумала' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue, null);
  assert.equal(f.result.text, 'Подготовка записи остановлена.');
  assert.equal(f.patients[0].appointments.length, 0);
});

test('cancellation summary and repeat preserve the one bound consent and never commit', (t) => {
  const f = cancellationFixture(t);
  const before = structuredClone(f.row()),
    choices = structuredClone(f.result.dialogue.options);
  const question = f.result.dialogue.prompt;
  const owned = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  const binding = structuredClone(owned.data.management.cancelConfirmation);
  for (const text of ['что уже выбрано', 'повтори варианты', 'повтори вопрос']) {
    f.answer({ text });
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.deepEqual(f.result.dialogue.options, choices);
    assert.deepEqual(owned.data.management.cancelConfirmation, binding);
    assert.equal(owned.data.management.cancelConfirmed, undefined);
    assert.equal(f.result.action, null);
    assert.equal(spokenReply(f.result), f.result.dialogue.prompt);
    if (text === 'повтори варианты') {
      assert.equal(f.result.dialogue.prompt, question);
      assert.ok(!f.result.text.includes('Да, отменить'));
    }
  }
  assert.deepEqual(f.row(), before);
  assert.equal(f.calls(), 0);
  f.answer({ choice: choices[0].id });
  assert.equal(f.result.action.type, 'cancelAppointment');
  assert.equal(f.calls(), 0);
});

test('a cancellation refusal stops only preparation and leaves the scheduled appointment intact', (t) => {
  const f = cancellationFixture(t),
    before = structuredClone(f.row());
  const { body: request } = f.answer({ text: 'не хочу отменять' });
  assert.equal(f.result.text, 'Подготовка остановлена. Запись не изменена.');
  assert.equal(f.result.action, null);
  assert.deepEqual(f.row(), before);
  assert.deepEqual(
    f.management.continueDialogue(f.c, request, f.state, f.member, f.clock),
    f.result,
  );
  assert.equal(f.calls(), 0);
});

test('a refusal of another operation does not stop the current cancellation', (t) => {
  const f = cancellationFixture(t);
  f.answer({ text: 'не хочу переносить' });
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.result.action, null);
});

test('management client clarification also handles information and draft refusal without selecting a person', (t) => {
  const f = cancellationFixture(t, { query: '' }),
    before = structuredClone(f.row());
  f.answer({ text: 'что уже выбрано' });
  assert.equal(f.result.dialogue.step, 'client');
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.information, true);
  f.answer({ text: 'не отменяй' });
  assert.equal(f.result.text, 'Подготовка остановлена. Запись не изменена.');
  assert.equal(f.result.dialogue, null);
  assert.deepEqual(f.row(), before);
  assert.equal(f.calls(), 0);
});

test('revoked access prevents even a read-only cancellation repeat', (t) => {
  const f = cancellationFixture(t);
  f.revoke();
  assert.throws(() => f.answer({ text: 'повтори вопрос' }), { status: 403 });
  assert.equal(f.calls(), 0);
});

test('a changed cancellation source refuses stale informational consent instead of copying it', (t) => {
  const f = cancellationFixture(t),
    changed = f.storage.read();
  changed.patients[0].appointments[0].time = '11:00';
  f.storage.write(changed);
  assert.throws(() => f.answer({ text: 'повтори вопрос' }), { status: 409 });
  assert.equal(f.row().time, '11:00');
  assert.equal(f.row().status, 'scheduled');
  assert.equal(f.calls(), 0);
});

test('a move keeps the chosen source and target date when asked for its selected data', (t) => {
  const f = moveExecutionFixture(t, { targetTime: null });
  const before = structuredClone(f.entry().data.management);
  f.answer({ text: 'что уже выбрано' });
  assert.deepEqual(f.entry().data.management, before);
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
  f.answer({ text: 'не переноси' });
  assert.equal(f.result.text, 'Подготовка остановлена. Запись не изменена.');
  assert.equal(f.rows()[0].time, '10:00');
});

function managementFields(management, source) {
  const owned = {
    id: 'synthetic',
    version: 0,
    options: new Map(),
    data: {
      patient: { label: 'Анна Семёнова' },
      management,
    },
  };
  return managementResponse(
    owned,
    { step: 'time', prompt: 'На какое время перенести?' },
    source,
  ).dialogue.fields.filter((field) => ['date', 'time'].includes(field.key));
}
test('management DTO shows a selected target date while the target time is still unknown', () => {
  assert.deepEqual(managementFields({ operation: 'move', targetDate: day, timeRequired: true }), [
    { key: 'date', label: 'Новая дата', value: day },
  ]);
});
test('management DTO never copies source date and time into an unknown move target', () => {
  const source = { appointment: { date: day, time: '10:00', service: 'Чистка' }, duration: 30 };
  assert.deepEqual(managementFields({ operation: 'move' }, source), []);
});
test('an unconfirmed date proposal is absent from selected management fields', () => {
  assert.deepEqual(
    managementFields({
      operation: 'move',
      targetDate: day,
      dateRequired: true,
      dateProposal: { date: day },
      targetTime: '12:00',
      timeRequired: true,
    }),
    [],
  );
});
test('cancellation DTO labels only the checked source appointment date and time', () => {
  const source = { appointment: { date: day, time: '10:00', service: 'Чистка' }, duration: 30 };
  assert.deepEqual(
    managementFields(
      { operation: 'cancel', targetDate: '2099-02-01', targetTime: '17:00' },
      source,
    ),
    [
      { key: 'date', label: 'Дата записи', value: day },
      { key: 'time', label: 'Время записи', value: '10:00' },
    ],
  );
});
