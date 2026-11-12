const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const { createAssistantDialogue } = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const {
  isAffirmativeAnswer,
  isConfirmationAnswer,
} = require('../src/server/modules/assistant/dialogue/affirmative-answer.cjs');
const {
  fastBookingOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-fast-booking.cjs');
const {
  clientSuggestionOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const {
  serviceChoiceOperation,
} = require('../src/server/modules/assistant/language/services/service-suggestions.cjs');

const affirmations = ['записать', 'ЗАПИСАТЬ!', '  Записать.  ', 'записать…'];
const negatives = [
  'не записать',
  'не надо записывать',
  'нет, записать',
  'да нет, записать',
  'записать, но не надо',
  'записать если свободно',
  'записать или отменить',
];

function booking(t, { role = 'owner', time = '12:00', closed = false, save = false } = {}) {
  const f = dialogueFixture({ role });
  if (role === 'cosmetologist') f.members[0].role = role;
  if (closed) f.c.platform.workSchedules.view = () => ({ days: {}, closures: {} });
  const store = f.c.tenantStore('org');
  let writes = 0;
  for (const key of ['save', 'write'])
    store[key] = () => {
      writes++;
      throw Error('Confirmation must not bypass the appointment executor');
    };
  const flow = createAssistantDialogue({ appointmentSavingEnabled: save });
  let result = flow.start(
    f.c,
    {
      intent: 'prepareAppointment',
      query: 'Анна Семёнова',
      serviceQuery: 'Чистка',
      date: day,
      ...(time ? { time } : {}),
    },
    f.state,
    f.member,
    f.clock,
    flow.beginCommand(f.c, f.member, f.state),
    { createRequested: save },
  );
  const entryId = result.dialogue.id;
  const body = (operation) => ({
    policyVersion: f.state.revision,
    dialogueId: result.dialogue.id,
    dialogueVersion: result.dialogue.version,
    ...operation,
  });
  t.after(() => {
    assert.equal(writes, 0);
    assert.ok(f.patients.every((row) => row.appointments.length === 0));
  });
  return {
    f,
    flow,
    body,
    entry: () => flow.get(f.c, f.member, f.state, entryId),
    answer(operation) {
      result = flow.continueDialogue(f.c, body(operation), f.state, f.member, f.clock);
      return result;
    },
    get result() {
      return result;
    },
  };
}

test('bare record confirms only the matching create gate with case and punctuation normalized', () => {
  for (const raw of affirmations) {
    assert.equal(isConfirmationAnswer(raw, 'create'), true, raw);
    assert.equal(isAffirmativeAnswer(raw), false, raw);
    assert.equal(isConfirmationAnswer(raw, 'cancel'), false, raw);
    assert.equal(isConfirmationAnswer(raw, 'move'), false, raw);
  }
  for (const raw of negatives) assert.equal(isConfirmationAnswer(raw, 'create'), false, raw);
});

test('bare record accepts the pending closed-day booking question locally for owner and administrator', async (t) => {
  for (const role of ['owner', 'salon_admin'])
    for (const raw of affirmations)
      await t.test(role + '/' + raw, (t) => {
        const s = booking(t, { role, closed: true, time: null });
        assert.equal(s.result.dialogue.prompt, 'День не открыт. Записать?');
        const body = s.body({ text: raw });
        assert.equal(s.flow.prepareModelTurn(s.f.c, body, s.f.state, s.f.member, s.f.clock), null);
        s.answer({ text: raw });
        assert.equal(s.entry().data.closedDayConfirmation, day + '|owner');
        assert.equal(s.result.dialogue.prompt, 'Во сколько записать?');
        assert.equal(s.result.action, null);
        s.answer({ text: 'в 12:00' });
        assert.equal(s.result.dialogue.step, 'review');
      });
});

test('bare record grants outside-hours consent only to the selected appointment tuple', (t) => {
  const s = booking(t, { role: 'salon_admin', time: '19:00' });
  assert.equal(s.result.dialogue.prompt, 'Вне рабочего графика. Записать?');
  s.answer({ text: 'записать' });
  assert.equal(s.result.dialogue.step, 'review');
  assert.equal(s.entry().data.closedDayConfirmation, day + '|owner|19:00|30');
  s.answer({ edit: 'time' });
  s.answer({ text: 'в 20:00' });
  assert.equal(s.result.dialogue.phase, 'closedDay');
  assert.equal(s.result.action, null);
  s.answer({ text: 'записать' });
  assert.equal(s.entry().data.closedDayConfirmation, day + '|owner|20:00|30');
  assert.equal(s.result.dialogue.step, 'review');
});

test('bare record does not grant schedule override permission to a specialist', (t) => {
  const s = booking(t, { role: 'cosmetologist', closed: true });
  s.answer({ text: 'записать' });
  assert.equal(s.result.dialogue.phase, 'closedDay');
  assert.equal(s.entry().data.closedDayConfirmation, undefined);
  assert.equal(s.result.action, null);
});

test('negative and mixed record replies never grant the pending booking consent', async (t) => {
  for (const raw of negatives)
    await t.test(raw, (t) => {
      const s = booking(t, { closed: true });
      s.answer({ text: raw });
      assert.equal(s.entry().data.closedDayConfirmation, undefined, raw);
      assert.equal(s.result.action, null, raw);
    });
});

test('bare record at final review matches yes for prepare and create without bypassing executor', async (t) => {
  for (const save of [false, true])
    for (const raw of ['да', 'записать', 'ЗАПИСАТЬ!'])
      await t.test(String(save) + '/' + raw, (t) => {
        const s = booking(t, { save });
        assert.equal(s.result.dialogue.step, 'review');
        const result = s.answer({ text: raw });
        assert.equal(result.action.type, save ? 'createAppointment' : 'prepareAppointment');
        assert.equal(result.action.date, day);
        assert.equal(result.action.time, '12:00');
        assert.equal(result.action.staffId, 'owner');
        assert.equal(Boolean(result.action.executionId), save);
      });
});

test('bare record does not choose an unrelated service, client or offered time', () => {
  const entry = (step, phase, row) => ({
    step,
    data: {},
    response: { dialogue: { phase } },
    options: new Map([['opaque', row]]),
  });
  assert.equal(
    fastBookingOperation(entry('time', 'slots', { kind: 'slot' }), 'записать'),
    null,
  );
  assert.equal(
    serviceChoiceOperation(
      entry('service', 'serviceChoice', {
        kind: 'service',
        approximateService: true,
        serviceName: 'Чистка',
      }),
      'записать',
    ),
    null,
  );
  assert.equal(
    clientSuggestionOperation(
      entry('client', 'clientChoice', { kind: 'client', approximate: true }),
      'записать',
    ),
    null,
  );
});

test('record cannot execute a missing or stale booking question', (t) => {
  const s = booking(t, { closed: true });
  const stale = s.body({ text: 'ЗАПИСАТЬ!' });
  s.answer({ text: 'записать' });
  assert.throws(
    () => s.flow.continueDialogue(s.f.c, stale, s.f.state, s.f.member, s.f.clock),
    (error) => error.status === 409,
  );
  assert.throws(
    () =>
      s.flow.continueDialogue(
        s.f.c,
        { ...stale, dialogueId: randomUUID() },
        s.f.state,
        s.f.member,
        s.f.clock,
      ),
    (error) => error.status === 404 || error.status === 409 || error.status === 410,
  );
});

test('bare record never confirms an existing appointment cancellation', (t) => {
  const f = cancellationFixture(t);
  const before = structuredClone(f.row());
  for (const raw of affirmations) {
    f.answer({ text: raw });
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.equal(f.result.action, null);
    assert.deepEqual(f.row(), before);
    assert.equal(f.calls(), 0);
  }
});
