const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dayTurnConstraints,
  monthDateOperation,
  monthDateView,
} = require('../src/server/modules/assistant/dialogue/bare-day-proposal.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const {
  createAssistantDialogue,
} = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-17', hour: 8, minute: 0 };
const initial = (text, at = clock) =>
  bookingTemporalConstraints({ intent: 'prepareAppointment' }, text, at);

for (const text of ['на двадцатое', 'на двадцатое число'])
  test('initial source binds a current-month proposal before any model date: ' + text, () => {
    const proof = initial('Запиши Анну ' + text + ' на чистку в 12:30');
    assert.equal(proof.date, null);
    assert.deepEqual(proof.dateProposal, { day: 20, date: '2026-10-20' });
    const f = dialogueFixture();
    const flow = createAssistantDialogue({ appointmentSavingEnabled: true });
    const result = flow.start(
      f.c,
      {
        intent: 'prepareAppointment',
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        date: '2026-11-20',
        time: '12:30',
      },
      f.state,
      f.member,
      clock,
      flow.beginCommand(f.c, f.member, f.state),
      { ...proof, createRequested: true, openWhenComplete: true },
    );
    assert.equal(result.text, 'Двадцатого октября, верно?');
    assert.equal(result.dialogue.prompt, 'Двадцатого октября, верно?');
    assert.equal(result.action, null);
    const entry = flow.get(f.c, f.member, f.state, result.dialogue.id);
    assert.equal(entry.data.date, null);
    assert.equal(entry.data.time, '12:30');
    assert.equal(entry.data.patient.id, f.patients[0].id);
    assert.equal(entry.data.service.id, 'clean');
    assert.equal(f.patients[0].appointments.length, 0);
  });

for (const text of ['на двадцатое', 'на двадцатое число', 'на 20', '20'])
  test('a date-step continuation asks the current month directly without a model: ' + text, () => {
    const f = dialogueFixture();
    const flow = createAssistantDialogue({ appointmentSavingEnabled: true });
    const first = flow.start(
      f.c,
      {
        intent: 'prepareAppointment',
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        time: '12:30',
      },
      f.state,
      f.member,
      clock,
      flow.beginCommand(f.c, f.member, f.state),
      { createRequested: true, openWhenComplete: true },
    );
    const entry = flow.get(f.c, f.member, f.state, first.dialogue.id);
    const selected = structuredClone(entry.data);
    const body = { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text };
    assert.equal(flow.prepareModelTurn(f.c, body, f.state, f.member, clock), null);
    const reply = flow.continueDialogue(f.c, body, f.state, f.member, clock);
    assert.equal(reply.text, 'Двадцатого октября, верно?');
    assert.equal(reply.dialogue.prompt, reply.text);
    assert.equal(reply.action, null);
    assert.equal(entry.data.date, null);
    for (const key of ['patient', 'service', 'staff', 'time', 'duration'])
      assert.deepEqual(entry.data[key], selected[key]);
    assert.equal(f.patients[0].appointments.length, 0);
  });

test('a malformed model field cannot erase an independently sourced day or replace its prompt', () => {
  const f = dialogueFixture();
  const flow = createAssistantDialogue();
  const first = flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '12:30' },
    f.state,
    f.member,
    clock,
    flow.beginCommand(f.c, f.member, f.state),
  );
  const body = {
    dialogueId: first.dialogue.id,
    dialogueVersion: first.dialogue.version,
    text: 'на двадцатое число на чистку',
  };
  const snapshot = flow.prepareModelTurn(f.c, body, f.state, f.member, clock);
  assert.ok(snapshot);
  const reply = flow.applyModelTurn(
    f.c,
    body,
    f.state,
    f.member,
    clock,
    {
      operation: 'patch',
      fields: {
        client: null,
        staff: null,
        service: 'Несказанная услуга',
        date: '2026-11-20',
        time: null,
        duration: null,
      },
      choice: null,
      field: null,
    },
    snapshot,
  );
  assert.equal(reply.text, 'Двадцатого октября, верно?');
  assert.equal(reply.dialogue.prompt, reply.text);
  const entry = flow.get(f.c, f.member, f.state, reply.dialogue.id);
  assert.equal(entry.data.service.id, 'clean');
  assert.equal(entry.data.time, '12:30');
  assert.equal(entry.data.patient.id, f.patients[0].id);
  assert.equal(entry.data.date, null);
  assert.deepEqual(entry.data.dateProposal, { day: 20, date: '2026-10-20' });
  assert.equal(reply.action, null);
});

test('bare numeric date is restricted to the date step and an established month remains authoritative', () => {
  for (const step of ['time', 'client', 'staff', 'service', 'review']) {
    const active = { step, data: {}, options: new Map() };
    assert.equal(monthDateOperation(active, '20', clock), null);
    assert.equal(dayTurnConstraints(active, 'на 20', clock), null);
  }
  assert.deepEqual(
    dayTurnConstraints(
      { step: 'date', data: { dateMonthContext: '2026-11' } },
      'на двадцатое число',
      clock,
    ),
    { date: '2026-11-20' },
  );
});

test('past or impossible current-month dates expose no confirmation choice and never roll forward', () => {
  for (const [text, date, expectedDate, expectedPrompt] of [
    ['на двадцатое', '2026-10-21', '2026-10-20', '20 октября уже прошло. Назовите другую дату.'],
    ['на тридцать первое', '2026-04-17', null, 'В апреле нет 31-го числа. Какого месяца?'],
  ]) {
    const at = { ...clock, date };
    const proof = initial('Запиши Анну ' + text, at);
    assert.equal(proof.date, null);
    assert.equal(proof.dateProposal.date, expectedDate);
    const data = { dateProposal: proof.dateProposal };
    const view = monthDateView(data, at);
    assert.equal(view.prompt, expectedPrompt);
    assert.equal(view.choices.length, 0);
    assert.equal(data.dateProposal.date, expectedDate);
  }
});

test('an explicit future month survives an impossible day in the current civil month', () => {
  const at = { ...clock, date: '2026-04-17' };
  assert.deepEqual(initial('Запиши Анну на 10 мая, точнее на тридцать первое', at), {
    date: '2026-05-31',
  });
});

test('day-source retention does not convert another requested action into booking data', () => {
  const active = { step: 'date', data: {}, options: new Map() };
  for (const text of ['удали клиента на двадцатое', 'покажи расписание на двадцатое'])
    assert.equal(dayTurnConstraints(active, text, clock), null);
});
