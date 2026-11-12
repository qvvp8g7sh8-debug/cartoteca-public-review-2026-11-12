const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dayEvidence,
  bareDayProposal,
  monthDateView,
  monthDateOperation,
} = require('../src/server/modules/assistant/dialogue/bare-day-proposal.cjs');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {
  continuationOperation,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  appointmentCreateIntent,
} = require('../src/server/modules/assistant/actions/appointment-create-request.cjs');
const {
  bookingTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/booking-temporal-constraints.cjs');
const { parseDateText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { spokenReply } = require('../src/server/modules/assistant/speech/spoken-reply.cjs');
const clock = { date: '2026-10-17', hour: 8, minute: 0 };
const constraints = (text, at = clock) =>
  initialTemporalConstraints({ intent: 'prepareAppointment' }, text, at);
const entry = (data = {}) => ({ step: 'date', data, options: new Map() });
const snapshot = (text) => ({ text });
const proposal = (fields = {}, operation = 'patch') => ({
  operation,
  fields: {
    client: null,
    staff: null,
    service: null,
    date: null,
    time: null,
    duration: null,
    ...fields,
  },
  choice: null,
  field: operation === 'clarify' ? 'date' : null,
});

for (const text of [
  'на двадцатое',
  'на двадцатое число',
  'двадцатого числа',
  '20 числа',
  'на 20-е число',
])
  test('day-only evidence needs a short explicit month confirmation: ' + text, () => {
    assert.deepEqual(dayEvidence(text), { day: 20, whole: true });
    assert.deepEqual(bareDayProposal(text, clock), { day: 20, date: '2026-10-20' });
    const input = monthDateOperation(entry(), text, clock);
    assert.deepEqual(input, {
      kind: 'dateMonthPropose',
      proposal: { day: 20, date: '2026-10-20' },
    });
    const view = monthDateView({ dateProposal: input.proposal }, clock);
    assert.equal(view.prompt, 'Двадцатого октября, верно?');
    assert.equal(view.step, 'date');
    assert.equal(view.choices.length, 1);
  });

for (const [text, at, expected, prompt] of [
  ['на первое', '2026-10-17', '2026-10-01', '1 октября уже прошло. Назовите другую дату.'],
  ['на тридцать первое', '2026-04-30', null, 'В апреле нет 31-го числа. Какого месяца?'],
  ['на двадцать девятое', '2027-02-01', null, 'В феврале нет 29-го числа. Какого месяца?'],
  ['на первое', '2026-12-31', '2026-12-01', '1 декабря уже прошло. Назовите другую дату.'],
])
  test(
    'a day-only date remains in the current month without a silent rollover: ' + text + ' / ' + at,
    () => {
      const atClock = { ...clock, date: at };
      const pending = bareDayProposal(text, atClock);
      assert.equal(pending.date, expected);
      assert.equal(monthDateView({ dateProposal: pending }, atClock).prompt, prompt);
    },
  );

for (const text of [
  'Запиши Анну на двадцатое на чистку в 12:30',
  'На двадцатое число в 12:30 запиши Анну на чистку',
  'На чистку Анну в 12:30 на двадцатое',
])
  test(
    'initial reordered command clears a model-guessed month and preserves exact clock: ' + text,
    () => {
      assert.deepEqual(constraints(text), {
        date: null,
        dateProposal: { day: 20, date: '2026-10-20' },
        time: '12:30',
      });
    },
  );

test('explicit complete month/date remains direct; unknown month never comes from model output', () => {
  assert.deepEqual(constraints('Запиши Анну на двадцатое ноября в 12:30'), {
    date: '2026-11-20',
    time: '12:30',
  });
  const operation = continuationOperation(
    proposal({ date: '2026-11-20' }),
    snapshot('на двадцатое'),
    entry(),
    clock,
  );
  assert.equal(operation.constraints.date, null);
  assert.deepEqual(operation.constraints.dateProposal, { day: 20, date: '2026-10-20' });
  assert.ok(operation.edits?.every((row) => row.field !== 'date') ?? true);
});

test('previous explicit month wins over the current clock in whole and mixed followups', () => {
  const active = entry({ dateMonthContext: '2026-11' });
  assert.deepEqual(monthDateOperation(active, 'на двадцатое число', clock), {
    kind: 'patch',
    edits: [{ field: 'date', text: '2026-11-20' }],
  });
  const operation = continuationOperation(
    proposal({ time: '12:30' }),
    snapshot('на двадцатое в 12:30'),
    active,
    clock,
  );
  assert.equal(operation.constraints.date, '2026-11-20');
  assert.equal(operation.constraints.dateProposal, undefined);
  assert.ok(operation.edits.some((row) => row.field === 'date' && row.text === '2026-11-20'));
});

test('exact ordinal service choice is not consumed as a new date outside the date step', () => {
  assert.equal(monthDateOperation({ ...entry(), step: 'service' }, 'первого', clock), null);
  assert.equal(dayEvidence('Запиши Анну на уход первого класса'), null);
});

test('alternatives, negation and explicit corrections keep date provenance closed', () => {
  for (const text of ['не на двадцатое', 'на двадцатое или двадцать первое', 'если на двадцатое']) {
    assert.equal(bareDayProposal(text, clock), null);
    assert.equal(constraints('Запиши Анну ' + text).date, null);
    assert.equal(constraints('Запиши Анну ' + text).dateProposal, undefined);
  }
  assert.deepEqual(constraints('Запиши Анну на двадцатое, точнее 21 ноября'), {
    date: '2026-11-21',
  });
  assert.deepEqual(constraints('Запиши Анну не на двадцатое, а 21 ноября'), { date: '2026-11-21' });
  assert.deepEqual(constraints('Запиши Анну на 21 ноября, точнее на двадцатое'), {
    date: '2026-11-20',
  });
  assert.deepEqual(constraints('Запиши Анну не 21 ноября, а на двадцатое'), { date: '2026-11-20' });
});

function current(f) {
  return f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
}
function body(f, text) {
  return {
    policyVersion: f.state.revision,
    dialogueId: f.result.dialogue.id,
    dialogueVersion: f.result.dialogue.version,
    text,
  };
}

for (const text of ['на пятое', 'на пятое число'])
  test('live continuation holds all fields until month confirmation: ' + text, () => {
    const f = dialogueFixture();
    f.start(
      { query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '12:30' },
      { openWhenComplete: true },
    );
    const known = structuredClone(current(f).data);
    assert.equal(f.flow.prepareModelTurn(f.c, body(f, text), f.state, f.member, f.clock), null);
    f.answer({ text });
    assert.equal(f.result.dialogue.prompt, 'Пятого января, верно?');
    assert.equal(f.result.action, null);
    assert.equal(current(f).data.date, null);
    for (const key of ['patient', 'staff', 'service', 'time', 'duration'])
      assert.deepEqual(current(f).data[key], known[key]);
    f.answer({ text: 'ага' });
    assert.equal(f.result.action.type, 'prepareAppointment');
    assert.equal(f.result.action.date, day);
    assert.equal(f.result.action.time, '12:30');
    assert.equal(f.result.action.duration, 30);
    assert.equal(f.patients[0].appointments.length, 0);
  });

test('initial mixed day-only source overrides a different model date before any ready action', () => {
  const f = dialogueFixture();
  const proven = constraints('Запиши Анну на пятое число в 12:30 на чистку', f.clock);
  f.start(
    { query: 'Анна Семёнова', serviceQuery: 'Чистка', date: '2099-02-05', time: '12:30' },
    { ...proven, openWhenComplete: true },
  );
  assert.equal(f.result.dialogue.prompt, 'Пятого января, верно?');
  assert.equal(f.result.action, null);
  assert.equal(current(f).data.date, null);
  assert.equal(current(f).data.time, '12:30');
  f.answer({ text: 'да' });
  assert.equal(f.result.action.date, day);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('no asks only the month, then the named date is confirmed', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '12:30' });
  f.answer({ text: 'на пятое число' });
  f.answer({ text: 'нет' });
  assert.equal(f.result.dialogue.prompt, 'Какого месяца?');
  assert.equal(current(f).data.dateProposal.day, 5);
  assert.equal(f.result.dialogue.options.length, 0);
  f.answer({ text: 'января' });
  assert.equal(f.result.dialogue.prompt, 'Пятого января, верно?');
  assert.equal(current(f).data.date, null);
  f.answer({ text: 'да' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(current(f).data.date, day);
  assert.equal(current(f).data.dateProposal, undefined);
  assert.equal(current(f).data.time, '12:30');
  assert.equal(f.patients[0].appointments.length, 0);
});

test('month choice handles May, invalid month dates and explicit past years', () => {
  const active = entry({ dateProposal: { day: 31, date: '2026-10-31' } });
  assert.equal(monthDateOperation(active, 'апреля', clock).kind, 'localHelp');
  assert.equal(monthDateOperation(active, 'ноября 2025 года', clock).kind, 'localHelp');
  assert.deepEqual(monthDateOperation(active, 'в мае', clock), {
    kind: 'patch',
    edits: [{ field: 'date', text: '2027-05-31' }],
  });
});

test('stale month option and revoked access cannot accept a proposed date', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '12:30' });
  f.answer({ text: 'на пятое' });
  const id = f.result.dialogue.options[0].id;
  f.answer({ text: 'нет' });
  assert.throws(() => f.answer({ choice: id }), { status: 409 });
  f.c.assertCurrent = () => {
    throw Object.assign(Error('synthetic denied'), { status: 403 });
  };
  assert.throws(() => f.flow.prepareModelTurn(f.c, body(f, 'января'), f.state, f.member, f.clock), {
    status: 403,
  });
  assert.equal(f.patients[0].appointments.length, 0);
});

for (const [number, forms] of [
  [1, ['январь', 'января', 'в январе']],
  [2, ['февраль', 'февраля', 'в феврале']],
  [3, ['март', 'марта', 'в марте']],
  [4, ['апрель', 'апреля', 'в апреле']],
  [5, ['май', 'мая', 'в мае']],
  [6, ['июнь', 'июня', 'в июне']],
  [7, ['июль', 'июля', 'в июле']],
  [8, ['август', 'августа', 'в августе']],
  [9, ['сентябрь', 'сентября', 'в сентябре']],
  [10, ['октябрь', 'октября', 'в октябре']],
  [11, ['ноябрь', 'ноября', 'в ноябре']],
  [12, ['декабрь', 'декабря', 'в декабре']],
])
  test('explicit month accepts its grammatical forms without inventing a date: ' + number, () => {
    const active = entry({ dateProposal: { day: 20, date: '2026-10-20' } });
    const year = number < 10 ? '2027' : '2026';
    const date = year + '-' + String(number).padStart(2, '0') + '-20';
    for (const form of forms)
      assert.deepEqual(monthDateOperation(active, form, clock), {
        kind: 'patch',
        edits: [{ field: 'date', text: date }],
      });
  });

test('month grammar rejects suffix words, alternatives and malformed or past years', () => {
  const active = entry({ dateProposal: { day: 20, date: '2026-10-20' } });
  for (const text of [
    'майский',
    'маевка',
    'в маевке',
    'ноябряззз',
    'май или июнь',
    'мае2099',
    'в мае 20',
  ])
    assert.equal(monthDateOperation(active, text, clock), null, text);
  assert.equal(monthDateOperation(active, 'в мае 2025 года', clock).kind, 'localHelp');
  assert.equal(monthDateOperation(active, 'в мае 0000 года', clock).kind, 'localHelp');
  assert.equal(dayEvidence('на двадцатое число в мае'), null);
});

test('the real continuation accepts «нет → в мае» and keeps the other booking fields', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '12:30' });
  f.answer({ text: 'на пятое число' });
  const selected = structuredClone(current(f).data);
  f.answer({ text: 'нет' });
  assert.equal(f.result.dialogue.prompt, 'Какого месяца?');
  assert.equal(f.flow.prepareModelTurn(f.c, body(f, 'в мае'), f.state, f.member, f.clock), null);
  f.answer({ text: 'в мае' });
  assert.equal(f.result.dialogue.prompt, 'Пятого мая, верно?');
  assert.equal(current(f).data.date, null);
  f.answer({ text: 'да' });
  const data = current(f).data;
  assert.equal(data.date, '2099-05-05');
  assert.equal(data.dateProposal, undefined);
  for (const key of ['patient', 'staff', 'service', 'duration', 'time'])
    assert.deepEqual(data[key], selected[key]);
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.equal(f.result.action, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('a month-only initial booking keeps the nearest calendar month without choosing a day', () => {
  for (const [today, name, context, inferredYear] of [
    ['2026-11-11', 'май', '2027-05', true],
    ['2026-11-11', 'декабрь', '2026-12', false],
    ['2026-12-10', 'январь', '2027-01', true],
    ['2026-11-11', 'май 2026 года', '2026-05', false],
    ['2026-11-11', 'май 2028 года', '2028-05', false],
  ])
    assert.deepEqual(appointmentCreateIntent('Запиши на ' + name, { ...clock, date: today }), {
      intent: 'prepareAppointment',
      date: null,
      dateMonth: { context, inferredYear },
    });
});

test('booking date proof announces an inferred year while past current-month and explicit dates stay past', () => {
  const at = { ...clock, date: '2026-11-11' };
  const prove = (text) =>
    bookingTemporalConstraints({ intent: 'prepareAppointment' }, 'Запиши ' + text, at, {
      clarifyWeekday: true,
    });
  assert.deepEqual(prove('на 20 мая в 12:30'), {
    date: null,
    dateProposal: {
      day: 20,
      date: '2027-05-20',
      month: { context: '2027-05', inferredYear: true },
    },
    time: '12:30',
  });
  assert.deepEqual(prove('на 20 декабря'), { date: '2026-12-20' });
  for (const phrase of ['на 5 ноября', 'на 20 мая 2026 года']) {
    assert.equal(prove(phrase).date, null);
    assert.equal(prove(phrase).dateProposal, undefined);
  }
  assert.equal(parseDateText('20 мая', at), null);
});

test('a corrected number keeps the explicitly named month and year without repeating the year', () => {
  const f = dialogueFixture();
  f.clock.date = '2099-11-11';
  f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '11:00' });
  f.answer({ text: 'май 2102 года' });
  assert.equal(f.result.dialogue.prompt, 'На какое число мая записать?');
  f.answer({ text: '15-е' });
  assert.equal(f.result.dialogue.prompt, 'Пятнадцатого мая, верно?');
  f.answer({ text: '16-е' });
  assert.equal(f.result.dialogue.prompt, 'Шестнадцатого мая, верно?');
  assert.equal(current(f).data.date, null);
  assert.equal(current(f).data.dateProposal.date, '2102-05-16');
  assert.equal(current(f).data.time, '11:00');
  assert.equal(f.patients[0].appointments.length, 0);
});

for (const monthFirst of [true, false])
  test(
    'booking confirms the concrete date and speaks its inferred year, month first=' + monthFirst,
    () => {
      const f = dialogueFixture();
      f.clock.date = '2099-11-11';
      f.c.platform.workSchedules.view = () => ({
        days: { '2100-05-20': { status: 'working', intervals: [['09:00', '18:00']] } },
        closures: {},
      });
      f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка', time: '11:00' });
      if (monthFirst) {
        f.answer({ text: 'май' });
        assert.equal(f.result.dialogue.prompt, 'На какое число мая 2100 года записать?');
        assert.deepEqual(current(f).data.dateMonth, { context: '2100-05', inferredYear: true });
        assert.equal(current(f).data.date, null);
        f.answer({ text: '20' });
      } else {
        f.answer({ text: 'на двадцатое' });
        f.answer({ text: 'май' });
      }
      assert.equal(f.result.dialogue.prompt, 'Двадцатого мая 2100 года, верно?');
      assert.equal(spokenReply(f.result), f.result.dialogue.prompt);
      assert.equal(current(f).data.date, null);
      assert.equal(current(f).data.dateProposal.date, '2100-05-20');
      assert.equal(current(f).data.time, '11:00');
      f.answer({ text: 'да' });
      assert.equal(current(f).data.date, '2100-05-20');
      assert.equal(current(f).data.time, '11:00');
      assert.equal(f.patients[0].appointments.length, 0);
    },
  );
