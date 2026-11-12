const test = require('node:test');
const assert = require('node:assert/strict');
const {
  monthDateView,
  monthDateOperation,
} = require('../src/server/modules/assistant/dialogue/bare-day-proposal.cjs');
const {
  createAssistantDialogue,
} = require('../src/server/modules/assistant/dialogue/dialogue-flow.cjs');
const { spokenReply } = require('../src/server/modules/assistant/speech/spoken-reply.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-20', hour: 8, minute: 0 };

for (const [date, caption] of [
  ['2026-10-21', 'Двадцать первого октября'],
  ['2026-10-30', 'Тридцатого октября'],
  ['2026-10-31', 'Тридцать первого октября'],
  ['2027-01-01', 'Первого января 2027 года'],
])
  test(
    'a proposed date asks one explicit confirmation while its choice remains only the date: ' +
      date,
    () => {
      const data = { dateProposal: { day: Number(date.slice(8)), date } };
      const before = structuredClone(data);
      const view = monthDateView(data, clock);
      assert.equal(view.prompt, caption + ', верно?');
      assert.equal(view.choices.length, 1);
      assert.equal(view.choices[0].label, caption);
      assert.equal(view.choices[0].value, date);
      for (const answerable of [true, false]) {
        const reply = {
          text: view.prompt,
          action: null,
          dialogue: {
            ...view,
            options: view.choices.map((row) => ({ id: 'synthetic-date', label: row.label })),
          },
        };
        assert.equal(spokenReply(reply, answerable), view.prompt);
      }
      assert.deepEqual(data, before);
    },
  );

for (const answer of ['да', 'ага', 'верно', 'правильно', 'да-да'])
  test('date confirmation still accepts the same short affirmative answer: ' + answer, () => {
    const choice = { kind: 'dateMonth', value: '2026-10-21', day: 21 };
    const entry = {
      step: 'date',
      data: { dateProposal: { day: 21, date: choice.value } },
      options: new Map([['synthetic-date-choice', choice]]),
    };
    assert.deepEqual(monthDateOperation(entry, answer, clock), {
      kind: 'choice',
      choice: 'synthetic-date-choice',
    });
  });

test('past or impossible dates stay explanations without affirmative choices', () => {
  for (const proposal of [
    { day: 19, date: '2026-10-19' },
    { day: 31, date: null },
  ]) {
    const data = {
      dateProposal: proposal,
      ...(proposal.date ? {} : { dateMonthContext: '2026-11' }),
    };
    const view = monthDateView(data, clock);
    assert.equal(view.choices.length, 0);
    assert.doesNotMatch(view.prompt, /верно/u);
    assert.match(view.prompt, proposal.date ? /уже прошло/u : /нет 31-го числа/u);
  }
});

test('a time supplied during month confirmation is retained and one yes completes the draft without saving', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T05:00:00Z') });
  const f = dialogueFixture();
  f.c.platform.workSchedules.view = () => ({
    days: {
      '2026-10-21': {
        status: 'working',
        intervals: [['07:00', '20:00']],
      },
    },
    closures: {},
  });
  const flow = createAssistantDialogue();
  const before = JSON.stringify(f.patients);
  let reply = flow.start(
    f.c,
    { intent: 'prepareAppointment', query: 'Анна Семёнова', serviceQuery: 'Чистка' },
    f.state,
    f.member,
    clock,
    flow.beginCommand(f.c, f.member, f.state),
    { openWhenComplete: true },
  );
  const send = (text) => {
    reply = flow.continueDialogue(
      f.c,
      { dialogueId: reply.dialogue.id, dialogueVersion: reply.dialogue.version, text },
      f.state,
      f.member,
      clock,
    );
    return reply;
  };
  send('на двадцать первое');
  assert.equal(reply.dialogue.prompt, 'Двадцать первого октября, верно?');
  send('В восемь утра');
  assert.equal(reply.dialogue.prompt, 'Двадцать первого октября, верно?');
  const pending = flow.get(f.c, f.member, f.state, reply.dialogue.id);
  assert.equal(pending.data.time, '08:00');
  assert.equal(pending.data.date, null);
  assert.equal(pending.data.patient.id, f.patients[0].id);
  assert.equal(pending.data.service.id, 'clean');
  send('да');
  assert.equal(reply.action?.type, 'prepareAppointment');
  assert.equal(reply.action.date, '2026-10-21');
  assert.equal(reply.action.time, '08:00');
  assert.equal(reply.action.patientId, f.patients[0].id);
  assert.deepEqual(reply.action.serviceIds, ['clean']);
  assert.equal(JSON.stringify(f.patients), before);
});
