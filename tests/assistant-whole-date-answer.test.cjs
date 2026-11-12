const test = require('node:test');
const assert = require('node:assert/strict');
const {
  wholeDateAnswer,
} = require('../src/server/modules/assistant/language/time/whole-date-answer.cjs');
const {
  fastBookingOperation,
} = require('../src/server/modules/assistant/dialogue/dialogue-fast-booking.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 8, minute: 0 };
test('an unqualified current weekday in a date answer asks for a choice and preserves a simultaneous clock', () => {
  const f = dialogueFixture();
  f.clock.date = '2099-01-07';
  const next = '2099-01-14';
  f.c.platform.workSchedules.view = () => ({
    days: {
      [next]: { status: 'working', intervals: [['09:00', '18:00']] },
    },
    closures: {},
  });
  const initial = f.start({ query: 'Анну Семёнову', serviceQuery: 'Чистка' });
  assert.equal(initial.dialogue.step, 'date');
  const pending = f.answer({ text: 'на среду в 12:00' }).result;
  assert.equal(pending.dialogue.prompt, 'На сегодня или на следующую среду?');
  assert.equal(pending.dialogue.fields.find((row) => row.key === 'time').value, '12:00');
  const selected = f.answer({ choice: pending.dialogue.options[1].id }).result;
  assert.equal(selected.dialogue.fields.find((row) => row.key === 'date').value, next);
  assert.equal(selected.dialogue.fields.find((row) => row.key === 'time').value, '12:00');
  assert.equal(selected.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

for (const [today, next, dayPhrase, text] of [
  ['2099-01-07', '2099-01-14', 'следующую среду', 'На следующую.'],
  ['2099-01-07', '2099-01-14', 'следующую среду', 'следующую'],
  ['2099-01-05', '2099-01-12', 'следующий понедельник', 'на следующий'],
]) {
  test('a short weekday answer selects the offered date: ' + text + ' / ' + dayPhrase, () => {
    const f = dialogueFixture();
    f.clock.date = today;
    f.c.platform.workSchedules.view = () => ({
      days: { [next]: { status: 'working', intervals: [['09:00', '18:00']] } },
      closures: {},
    });
    const pending = f.start(
      { query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '11:00' },
      { date: null, dateWeekday: today },
    );
    assert.equal(pending.dialogue.prompt, 'На сегодня или на ' + dayPhrase + '?');
    const body = {
      dialogueId: pending.dialogue.id,
      dialogueVersion: pending.dialogue.version,
      text,
    };
    assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
    const selected = f.answer({ text }).result;
    assert.equal(selected.dialogue.fields.find((row) => row.key === 'date').value, next);
    assert.deepEqual(
      selected.dialogue.fields.filter((row) => row.key !== 'date'),
      pending.dialogue.fields,
    );
    assert.equal(selected.action, null);
    assert.equal(f.patients[0].appointments.length, 0);
  });
}

test('short weekday answers require the current matching offer and do not consume other replies', () => {
  const f = dialogueFixture();
  f.clock.date = '2099-01-07';
  const pending = f.start(
    { query: 'Анна Семёнова', serviceQuery: 'Чистка' },
    { date: null, dateWeekday: f.clock.date },
  );
  const entry = f.flow.get(f.c, f.member, f.state, pending.dialogue.id);
  for (const text of ['на следующий', 'не на следующую', 'на следующую или сегодня'])
    assert.equal(fastBookingOperation(entry, text, f.clock), null, text);
  assert.equal(
    fastBookingOperation(entry, 'на следующую', { ...f.clock, date: '2099-01-08' }),
    null,
  );
  assert.equal(fastBookingOperation({ ...entry, data: {} }, 'на следующую', f.clock), null);
  assert.equal(
    fastBookingOperation({ ...entry, options: new Map() }, 'на следующую', f.clock),
    null,
  );
  assert.equal(wholeDateAnswer('на следующую', f.clock), null);
  assert.deepEqual(fastBookingOperation(entry, 'да', f.clock), { kind: 'localHelp' });
  for (const [text, date] of [
    ['сегодня', f.clock.date],
    ['на следующую среду', '2099-01-14'],
  ])
    assert.deepEqual(fastBookingOperation(entry, text, f.clock), {
      kind: 'patch',
      edits: [{ field: 'date', text: date }],
    });
});

test('a short weekday answer checks the dialogue version and current access before choosing', () => {
  const f = dialogueFixture();
  f.clock.date = '2099-01-07';
  const first = f.start(
    { query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '11:00' },
    { date: null, dateWeekday: f.clock.date },
  );
  const repeated = f.answer({ text: 'да' }).result;
  assert.equal(repeated.dialogue.prompt, first.dialogue.prompt);
  const short = (dialogue) => ({
    dialogueId: dialogue.id,
    dialogueVersion: dialogue.version,
    text: 'на следующую',
  });
  const send = (dialogue) =>
    f.flow.continueDialogue(f.c, short(dialogue), f.state, f.member, f.clock);
  assert.throws(() => send(first.dialogue), { status: 409 });
  const assertCurrent = f.c.assertCurrent;
  f.c.assertCurrent = () => {
    throw Object.assign(new Error('Synthetic revoked access'), { status: 403 });
  };
  assert.throws(() => send(repeated.dialogue), { status: 403 });
  f.c.assertCurrent = assertCurrent;
  const entry = f.flow.get(f.c, f.member, f.state, repeated.dialogue.id);
  assert.equal(entry.data.date, null);
  assert.equal(entry.data.time, '11:00');
  assert.equal(entry.version, repeated.dialogue.version);
  assert.equal(f.patients[0].appointments.length, 0);
});

for (const [text, expected] of [
  ['завтра', '2026-10-17'],
  ['На завтра.', '2026-10-17'],
  ['на двадцатое октября', '2026-10-20'],
  ['двадцать первого октября', '2026-10-21'],
  ['семнадцатого октября 2026 года', '2026-10-17'],
  ['20.10.2026', '2026-10-20'],
  ['20/10/2026', '2026-10-20'],
  ['в понедельник', '2026-10-19'],
  ['во вторник', '2026-10-20'],
  ['в эту пятницу', '2026-10-16'],
  ['в среду', '2026-10-21'],
  ['в следующую среду', '2026-10-21'],
  ['двадцатого числа', '2026-10-20'],
  ['на двадцать первое числа', '2026-10-21'],
  ['20 числа', '2026-10-20'],
  ['через два дня', '2026-10-18'],
  ['через двадцать два дня', '2026-11-07'],
  ['через неделю', '2026-10-23'],
  ['Пожалуйста, в понедельник.', '2026-10-19'],
  ['на 20 октября, пожалуйста!', '2026-10-20'],
])
  test('a whole date answer is deterministic and local: ' + text, () => {
    assert.equal(wholeDateAnswer(text, clock), expected);
    const entry = { step: 'date', data: {}, options: new Map() };
    const pendingMonth = /числа$/u.test(text);
    assert.deepEqual(
      fastBookingOperation(entry, text, clock),
      pendingMonth
        ? { kind: 'dateMonthPropose', proposal: { day: Number(expected.slice(8)), date: expected } }
        : { kind: 'patch', edits: [{ field: 'date', text: expected }] },
    );
  });
for (const text of [
  'завтра в 12:30',
  'на двадцатое октября на консультацию',
  '20 октября, но услугу поменяй',
  'нет, в понедельник',
  'не завтра',
  'завтра или послезавтра',
  'примерно 20 октября',
  'если завтра',
  '20 октября 2025 года',
  '31 апреля 2027 года',
  '15 числа',
  'в эту среду',
  'в среду на этой неделе',
  '20 октября 2026 года 2027',
  '20.10.2026suffix',
  'prefix20.10.2026',
  '20 числа следующего месяца',
  'через 367 дней',
  'через ноль дней',
  'через два дня на консультацию',
  'отмени запись завтра',
  '20',
  'первый',
  'двадцатого',
  'пожалуйста, завтра, спасибо',
])
  test(
    'partial, ambiguous, invalid or mixed date stays outside the local fast path: ' + text,
    () => {
      assert.equal(wholeDateAnswer(text, clock), null);
      const nextMonth =
        text === '15 числа'
          ? { day: 15, date: '2026-10-15' }
          : ['двадцатого', '20'].includes(text)
            ? { day: 20, date: '2026-10-20' }
            : null;
      assert.deepEqual(
        fastBookingOperation({ step: 'date', data: {}, options: new Map() }, text, clock),
        nextMonth ? { kind: 'dateMonthPropose', proposal: nextMonth } : null,
      );
    },
  );
test('new date grammar is limited to the active date step and availability search stays untouched', () => {
  for (const step of ['client', 'staff', 'service', 'time', 'review'])
    assert.equal(
      fastBookingOperation({ step, data: {}, options: new Map() }, 'в понедельник', clock),
      null,
    );
  assert.equal(
    fastBookingOperation(
      { step: 'date', availabilitySearch: {}, data: {}, options: new Map() },
      'в понедельник',
      clock,
    ),
    null,
  );
  assert.equal(wholeDateAnswer('а'.repeat(161), clock), null);
  assert.equal(wholeDateAnswer('завтра', {}), null);
});
test('a spoken date bypasses model preparation and rechecks fresh availability while keeping the selected client/service', () => {
  const f = dialogueFixture();
  const initial = f.start({ query: 'Анну Семенову', serviceQuery: 'Чистка' });
  assert.equal(initial.dialogue.step, 'date');
  const entry = f.flow.get(f.c, f.member, f.state, initial.dialogue.id);
  const selected = structuredClone({
    patient: entry.data.patient,
    staff: entry.data.staff,
    service: entry.data.service,
    duration: entry.data.duration,
  });
  const body = {
    policyVersion: f.state.revision,
    dialogueId: initial.dialogue.id,
    dialogueVersion: initial.dialogue.version,
    text: 'пятого января 2099 года',
  };
  assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
  const previousSchedule = f.c.platform.workSchedules.view;
  f.c.platform.workSchedules.view = () => ({ days: {}, closures: {} });
  const reply = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
  assert.equal(reply.action, null);
  assert.equal(reply.dialogue.phase, 'closedDay');
  assert.deepEqual(
    {
      patient: entry.data.patient,
      staff: entry.data.staff,
      service: entry.data.service,
      duration: entry.data.duration,
    },
    selected,
  );
  assert.equal(f.patients[0].appointments.length, 0);
  f.c.platform.workSchedules.view = previousSchedule;
});
test('date fast continuation still rejects revoked request access before any response', () => {
  const f = dialogueFixture();
  const initial = f.start({ query: 'Анну Семенову', serviceQuery: 'Чистка' });
  f.c.assertCurrent = () => {
    throw Object.assign(new Error('Synthetic revoked access'), { status: 403 });
  };
  assert.throws(
    () =>
      f.flow.prepareModelTurn(
        f.c,
        {
          policyVersion: f.state.revision,
          dialogueId: initial.dialogue.id,
          dialogueVersion: initial.dialogue.version,
          text: 'пятого января 2099 года',
        },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 403 },
  );
  assert.equal(f.patients[0].appointments.length, 0);
});
