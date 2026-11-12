const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeClockSeparators,
  parseTimeText,
} = require('../src/server/modules/assistant/language/time/temporal.cjs');
const {
  initialTemporalConstraints,
} = require('../src/server/modules/assistant/language/time/initial-temporal-constraints.cjs');
const {
  intentRequestConstraints,
} = require('../src/server/modules/assistant/interpretation/intent-request-duration.cjs');
const { dialogueFixture, day: dayForContext } = require('./helpers/assistant-dialogue-fixture.cjs');
const clock = { date: '2026-10-16', hour: 6, minute: 0 };
const select = (text, current = clock) =>
  initialTemporalConstraints({ intent: 'prepareAppointment' }, text, current);
const permutations = (values) =>
  values.length === 0
    ? [[]]
    : values.flatMap((value, index) =>
        permutations(values.filter((_, other) => index !== other)).map((tail) => [value, ...tail]),
      );

test('the user phrase pins the literal dash time independently of the provider proposal', () => {
  const text = 'Запиши Артема Макартичана, на завтра на 12-30 консультаций.';
  assert.equal(
    normalizeClockSeparators(text),
    'Запиши Артема Макартичана, на завтра на 12:30 консультаций.',
  );
  assert.deepEqual(select(text), { date: '2026-10-17', time: '12:30' });
  assert.deepEqual(intentRequestConstraints({ intent: 'prepareAppointment' }, text), {});
});

for (const [index, blocks] of permutations([
  'Анну Семёнову',
  'на консультацию',
  'на завтра',
  'на 12-30',
]).entries()) {
  test('field permutation ' + (index + 1) + ' preserves one date and one dash clock', () => {
    const text = 'Запиши ' + blocks.join(', ') + '.';
    assert.deepEqual(select(text), { date: '2026-10-17', time: '12:30' }, text);
  });
}

for (const [dateText, date] of [
  ['завтра', '2026-10-17'],
  ['послезавтра', '2026-10-18'],
  ['сегодня', '2026-10-16'],
  ['в воскресенье', '2026-10-18'],
  ['20 числа', '2026-10-20'],
  ['20 октября', '2026-10-20'],
  ['двадцатого октября', '2026-10-20'],
  ['20 октября 2026 года', '2026-10-20'],
  ['2026-10-20', '2026-10-20'],
  ['20.10.2026', '2026-10-20'],
  ['через 3 дня', '2026-10-19'],
  ['через неделю', '2026-10-23'],
]) {
  test('a separate date disambiguates low dash minutes in either order: ' + dateText, () => {
    for (const text of [
      'Запиши Анну ' + dateText + ' на 12-05 на консультацию.',
      'На 12-05 запиши Анну на консультацию ' + dateText + '.',
      'Консультация для Анны, на 12-05, ' + dateText + '.',
    ])
      assert.deepEqual(select(text), dateText === '20 числа'
        ? { date: null, dateProposal: { day: 20, date }, time: '12:05' }
        : { date, time: '12:05' }, text);
  });
}

test('explicit time grammar supports dashes spaces and the full 24-hour day without an invented date', () => {
  for (const [text, time] of [
    ['в 8-30', '08:30'],
    ['в 08 – 30.', '08:30'],
    ['к 12—05', '12:05'],
    ['начало приема в 12-05', '12:05'],
    ['время 17-10', '17:10'],
    ['на 12-30', '12:30'],
    ['на 12-00', '12:00'],
    ['на 23-59', '23:59'],
    ['в 0-00', '00:00'],
    ['на 0-00', '00:00'],
    ['в 23-59', '23:59'],
  ]) {
    assert.equal(parseTimeText(text), time, text);
    assert.deepEqual(select('Запиши Анну ' + text + ' на консультацию'), { time }, text);
  }
  for (const [text, date] of [
    ['завтра 12-30', '2026-10-17'],
    ['12-30 завтра', '2026-10-17'],
    ['20 числа 12-30', '2026-10-20'],
    ['12-30 на 20 числа', '2026-10-20'],
  ])
    assert.deepEqual(select(text), text.includes('числа')
      ? { date: null, dateProposal: { day: 20, date }, time: '12:30' }
      : { date, time: '12:30' }, text);
});

test('unqualified date-like tokens and numbered service labels never become clocks', () => {
  for (const text of ['12-30', '17-10', '7-30', '8-05', '20-10'])
    assert.equal(parseTimeText(text), null, text);
  for (const text of ['Запиши Анну на 17-10.', 'Запиши Анну на 17–10.', 'Запиши Анну на 17.10.'])
    assert.deepEqual(select(text), { date: null, time: null }, text);
  for (const text of [
    'Запиши Анну на услугу номер 12-30 завтра.',
    'Запиши Анну на процедуру 12-30 завтра.',
    'Запиши Анну в кабинет 12-30 завтра.',
    'Запиши Анну, код 12-30, на завтра.',
  ]) {
    assert.equal(parseTimeText(text), null, text);
    assert.deepEqual(select(text), { date: '2026-10-17' }, text);
  }
  assert.deepEqual(select('Запиши Анну на 2026-10-20.'), { date: '2026-10-20' });
  assert.deepEqual(select('Запиши Анну на 20.10.2026.'), { date: '2026-10-20' });
});

test('invalid hours minutes signs and numeric chains clear the model time in every supported clock context', () => {
  for (const tail of [
    '25-30',
    '24-00',
    '112-30',
    '12-70',
    '12-300',
    '12-3',
    '12-30-13-30',
    '12-30 - 13-30',
    '12-30-13:30',
    '12-30-13.30',
    '12-30-13,30',
    '-12-30',
    '+12-30',
    '- 12-30',
    '12-30-20',
  ]) {
    const text = 'Запиши Анну завтра на ' + tail + ' на консультацию.';
    assert.equal(parseTimeText(text), null, text);
    assert.deepEqual(select(text), { date: '2026-10-17', time: null }, text);
  }
});

test('negative approximate alternative and comparative requests keep conservative temporal constraints', () => {
  for (const [text, expected] of [
    ['Запиши Анну завтра примерно на 12-30.', { date: '2026-10-17', time: null }],
    ['Запиши Анну завтра в 12-30 или в 13-30.', { date: '2026-10-17', time: null }],
    ['Запиши Анну завтра не в 12-30.', { date: null, time: null }],
  ])
    assert.deepEqual(select(text), expected, text);
  for (const text of [
    'Запиши Анну завтра после 12-30.',
    'Запиши Анну завтра до 12-30.',
    'Запиши Анну завтра с 12-30 до 13-30.',
    'Запиши Анну завтра между 12-30 и 13-30.',
  ])
    assert.throws(() => select(text), { status: 400 }, text);
  assert.deepEqual(select('Запиши Анну завтра на 12-30, точнее на 13-05.'), {
    date: '2026-10-17',
    time: '13:05',
  });
  assert.deepEqual(select('Запиши Анну завтра на 12-30, точнее на 25-05.'), {
    date: '2026-10-17',
    time: null,
  });
  assert.deepEqual(select('Запиши Анну на 12-30 завтра, точнее на послезавтра.'), {
    date: '2026-10-18',
    time: '12:30',
  });
});

const proposal = (fields) => ({
  operation: 'patch',
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
  field: null,
});
function modelFixture() {
  const f = dialogueFixture();
  f.services[0].name = 'Консультация';
  f.c.platform.workSchedules.view = () => ({
    days: { '2099-01-06': { status: 'working', intervals: [['07:00', '20:00']] } },
    closures: {},
  });
  let result = f.start();
  const entry = () => f.flow.get(f.c, f.member, f.state, result.dialogue.id);
  return {
    f,
    entry,
    get result() {
      return result;
    },
    model(text, fields) {
      const body = {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        text,
      };
      const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
      if (!snapshot) {
        result = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
        return result;
      }
      result = f.flow.applyModelTurn(
        f.c,
        body,
        f.state,
        f.member,
        f.clock,
        proposal(fields),
        snapshot,
      );
      return result;
    },
    open() {
      result = f.flow.continueDialogue(
        f.c,
        {
          dialogueId: result.dialogue.id,
          dialogueVersion: result.dialogue.version,
          text: 'открой форму',
        },
        f.state,
        f.member,
        f.clock,
      );
      return result;
    },
  };
}

test('raw contextual clock constraints produce a manual form after differently ordered full phrases without Save', () => {
  for (const text of [
    'Запиши Анну Семёнову на завтра на 12-30 на консультацию.',
    'На 12-30, на консультацию, Анну Семёнову запиши завтра.',
    'Завтра на консультацию на 12-30 запиши Анну Семёнову.',
  ]) {
    const h = modelFixture();
    h.model(text, {
      client: 'Анну Семёнову',
      service: 'консультацию',
      date: '2099-01-06',
      time: '12:30',
    });
    assert.equal(h.result.dialogue.step, 'review', text);
    assert.equal(h.entry().data.date, '2099-01-06', text);
    assert.equal(h.entry().data.time, '12:30', text);
    assert.equal(h.result.action, null, text);
    const ready = h.open();
    assert.equal(ready.action.type, 'prepareAppointment', text);
    assert.equal(ready.action.time, '12:30', text);
    assert.equal(ready.action.date, '2099-01-06', text);
    assert.ok(
      h.f.patients.every((row) => row.appointments.length === 0),
      text,
    );
  }
});

test('a proposed clock that differs from the raw dash clock cannot mutate the draft or save', () => {
  for (const time of ['00:30', '12:00', '13:30']) {
    const h = modelFixture(),
      before = structuredClone(h.entry().data);
    h.model('Запиши Анну Семёнову на консультацию завтра на 12-30.', {
      client: 'Анну Семёнову',
      service: 'консультацию',
      date: '2099-01-06',
      time,
    });
    assert.deepEqual(h.entry().data, before);
    assert.equal(h.result.action, null);
    assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
  }
});

test('an invalid or ranged raw dash token cannot inherit a model-selected point time', () => {
  for (const tail of ['12-70', '12-30-13:30', '24-00', '-12-30']) {
    const h = modelFixture();
    h.model('Запиши Анну Семёнову на консультацию завтра на ' + tail + '.', {
      client: 'Анну Семёнову',
      service: 'консультацию',
      date: '2099-01-06',
      time: '12:30',
    });
    assert.equal(h.entry().data.date, '2099-01-06', tail);
    assert.equal(h.entry().data.time, null, tail);
    assert.equal(h.result.action, null, tail);
    assert.ok(
      h.f.patients.every((row) => row.appointments.length === 0),
      tail,
    );
  }
});

test('attached short time prepositions pin colon and dash clocks in both date orders', () => {
  for (const prefix of ['в', 'на', 'к', 'ко']) {
    for (const spelling of ['12:30', '12-30']) {
      for (const text of [
        'Запиши сегодня Анну Семёнову на консультацию первичную ' + prefix + spelling,
        'Запиши ' + prefix + spelling + ' Анну Семёнову на консультацию сегодня.',
        prefix + spelling + ' сегодня Анну Семёнову на консультацию запиши.',
      ])
        assert.deepEqual(select(text), { date: '2026-10-16', time: '12:30' }, text);
      assert.equal(parseTimeText(prefix + spelling), '12:30', prefix + spelling);
    }
  }
  assert.equal(
    normalizeClockSeparators('Анну завтра в12-30 на консультацию.'),
    'Анну завтра в 12:30 на консультацию.',
  );
  assert.deepEqual(select('Запиши Анну на17-10.'), { date: null, time: null });
});

test('embedded preposition-like substrings and non-time words do not provide clock evidence', () => {
  for (const word of [
    'нев12:30',
    'словоv12:30',
    'при12:30',
    'анна12:30',
    'нев12-30',
    'слово12-30',
  ]) {
    const text = 'Запиши Анну завтра ' + word + ' на консультацию.';
    assert.equal(parseTimeText(word), null, word);
    assert.deepEqual(select(text), { date: '2026-10-17' }, text);
    assert.equal(normalizeClockSeparators(word), word, word);
  }
});

test('attached clock prefixes retain negation invalid-clock and numeric-range safeguards', () => {
  assert.deepEqual(select('Запиши Анну завтра не в12:30.'), { date: null, time: null });
  assert.deepEqual(select('Запиши Анну завтра примерно в12-30.'), {
    date: '2026-10-17',
    time: null,
  });
  for (const value of ['в25:00', 'на12-70', 'к12-30-13:30', 'ко12:30:45']) {
    const text = 'Запиши Анну завтра ' + value + ' на консультацию.';
    assert.equal(parseTimeText(value), null, value);
    assert.deepEqual(select(text), { date: '2026-10-17', time: null }, text);
  }
});

test('a raw attached clock prepares the same manual form and cannot inherit a different model time', () => {
  const text = 'Запиши Анну Семёнову на консультацию завтра в12-30.';
  const h = modelFixture();
  h.model(text, {
    client: 'Анну Семёнову',
    service: 'консультацию',
    date: '2099-01-06',
    time: '12:30',
  });
  assert.equal(h.result.dialogue.step, 'review');
  assert.equal(h.entry().data.time, '12:30');
  assert.equal(h.open().action.time, '12:30');
  assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
  const bad = modelFixture(),
    before = structuredClone(bad.entry().data);
  bad.model(text, {
    client: 'Анну Семёнову',
    service: 'консультацию',
    date: '2099-01-06',
    time: '13:30',
  });
  assert.deepEqual(bad.entry().data, before);
  assert.equal(bad.result.action, null);
  assert.ok(bad.f.patients.every((row) => row.appointments.length === 0));
});

test('attached bare hours preserve a separate date and apply the configured daytime defaults', () => {
  assert.deepEqual(select('Запиши на завтра на12 неволину Юлию на консультацию.'), {
    date: '2026-10-17',
    time: '12:00',
  });
  for (const prefix of ['в', 'на', 'к', 'ко']) {
    for (const [hour, time] of [
      ['12', '12:00'],
      ['8', '08:00'],
      ['14', '14:00'],
      ['0', '00:00'],
    ]) {
      for (const text of [
        'Запиши Анну завтра ' + prefix + hour + ' на консультацию.',
        prefix + hour + ' Анну на консультацию запиши завтра.',
      ])
        assert.deepEqual(select(text), { date: '2026-10-17', time }, text);
    }
  }
  assert.deepEqual(select('Запиши Анну завтра на12 дня на консультацию.'), {
    date: '2026-10-17',
    time: '12:00',
  });
  assert.deepEqual(select('Запиши Анну завтра на8 утра на консультацию.'), {
    date: '2026-10-17',
    time: '08:00',
  });
});

test('bare-hour prefix spacing keeps numbered days duration units and embedded words outside the clock path', () => {
  assert.deepEqual(select('Запиши Анну на17 числа на консультацию.'), { date: null, dateProposal: { day: 17, date: '2026-10-17' } });
  for (const value of ['на30 минут', 'нев12', 'номер12']) {
    assert.deepEqual(
      select('Запиши Анну завтра ' + value + ' на консультацию.'),
      { date: '2026-10-17' },
      value,
    );
  }
});

test('the daytime default noon prepares an ordinary manual form without saving', () => {
  const h = modelFixture();
  h.model('Запиши Анну Семёнову на консультацию завтра на12.', {
    client: 'Анну Семёнову',
    service: 'консультацию',
    date: '2099-01-06',
    time: '12:00',
  });
  assert.equal(h.entry().data.date, '2099-01-06');
  assert.equal(h.entry().data.time, '12:00');
  assert.equal(h.result.dialogue.step, 'review');
  assert.equal(h.result.action, null);
  assert.equal(h.open().action.time, '12:00');
  assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
});

test('numeric minute alternatives cannot add a bare-hour candidate beside an exact clock', () => {
  for (const minutes of ['10 или 20', '30 либо 40'])
    assert.deepEqual(
      select('Запиши Анну на ' + minutes + ' минут завтра в14:00.'),
      {
        date: '2026-10-17',
        time: '14:00',
      },
      minutes,
    );
});

test('business daytime defaults map whole numeric and spoken hours while explicit night overrides them', () => {
  for (const [word, time] of [
    ['час', '13:00'],
    ['один', '13:00'],
    ['два', '14:00'],
    ['три', '15:00'],
    ['четыре', '16:00'],
    ['пять', '17:00'],
    ['шесть', '18:00'],
    ['семь', '07:00'],
    ['восемь', '08:00'],
    ['девять', '09:00'],
    ['десять', '10:00'],
    ['одиннадцать', '11:00'],
    ['двенадцать', '12:00'],
  ]) {
    assert.equal(parseTimeText(word), time, word);
    assert.equal(parseTimeText('в ' + word), time, word);
    assert.equal(parseTimeText('на' + word), time, word);
    assert.deepEqual(
      select('Запиши Анну завтра на ' + word + ' на консультацию.'),
      { date: '2026-10-17', time },
      word,
    );
  }
  for (const [text, expected] of [
    ['12 ночи', '00:00'],
    ['двенадцать ночи', '00:00'],
    ['два утра', '02:00'],
    ['два дня', '14:00'],
    ['два вечера', '14:00'],
  ])
    assert.equal(parseTimeText(text), expected, text);
  assert.deepEqual(select('Запиши Анну завтра на12 ночи.'), { date: '2026-10-17', time: '00:00' });
  assert.equal(parseTimeText('02:30'), '02:30');
  assert.equal(parseTimeText('полтретьего'), '14:30');
  assert.equal(parseTimeText('без четверти три'), '14:45');
});

test('a dated bare one-o-clock is time while counted hours and explicit appointment length remain duration', () => {
  for (const [text, time] of [
    ['Запиши Анну завтра на час на консультацию.', '13:00'],
    ['На два запиши Анну завтра на консультацию.', '14:00'],
    ['Запиши Анну на консультацию на двенадцать завтра.', '12:00'],
  ]) {
    assert.deepEqual(select(text), { date: '2026-10-17', time }, text);
    assert.deepEqual(intentRequestConstraints({ intent: 'prepareAppointment' }, text), {}, text);
  }
  for (const [text, duration] of [
    ['Запиши Анну завтра длительностью один час.', 60],
    ['Запиши Анну завтра длительностью 2 часа.', 120],
    ['Запиши Анну завтра на 60 минут.', 60],
    ['Запиши Анну завтра продолжительностью час.', 60],
    ['Запиши Анну завтра длительностью на час.', 60],
    ['Запиши Анну завтра на час двадцать.', 80],
    ['Запиши Анну на час.', 60],
  ]) {
    assert.equal(select(text).time, undefined, text);
    assert.deepEqual(
      intentRequestConstraints({ intent: 'prepareAppointment' }, text),
      { duration },
      text,
    );
  }
});

test('a dated bare hour keeps the selected catalog duration when opening the manual form', () => {
  const text = 'Запиши Анну Семёнову завтра на час на консультацию.';
  const h = modelFixture();
  assert.deepEqual(intentRequestConstraints({ intent: 'prepareAppointment' }, text), {});
  h.model(text, {
    client: 'Анну Семёнову',
    service: 'консультацию',
    date: '2099-01-06',
    time: '13:00',
  });
  assert.equal(h.result.dialogue.step, 'review');
  assert.equal(h.entry().data.time, '13:00');
  assert.equal(h.entry().data.duration, 30);
  const ready = h.open();
  assert.equal(ready.action.time, '13:00');
  assert.equal(ready.action.duration, 30);
  assert.ok(h.f.patients.every((row) => row.appointments.length === 0));
});

test('the active time context masks whole hour clocks while labelled lengths remain durations', () => {
  const intent = { intent: 'prepareAppointment' };
  assert.deepEqual(intentRequestConstraints(intent, 'на час'), { duration: 60 });
  assert.deepEqual(intentRequestConstraints(intent, 'на час', { timeContext: true }), {});
  assert.deepEqual(intentRequestConstraints(intent, 'время на час'), {});
  for (const [text, duration] of [
    ['длительность один час', 60],
    ['длительность 2 часа', 120],
    ['продолжительность час', 60],
  ])
    assert.deepEqual(
      intentRequestConstraints(intent, text, { timeContext: true }),
      { duration },
      text,
    );
  for (const [text, time] of [['на один час', '13:00'], ['на2часа', '14:00'], ['на два часа', '14:00']]) {
    assert.equal(parseTimeText(text), time, text);
    assert.deepEqual(intentRequestConstraints(intent, text, { timeContext: true }), {});
  }
  assert.equal(parseTimeText('на час'), '13:00');
  assert.equal(parseTimeText('на два'), '14:00');
  assert.equal(parseTimeText('в один час'), '13:00');
  assert.equal(parseTimeText('на один час дня'), '13:00');
});

test('a contextual answer на час on the time step keeps the catalog length while the duration step changes only length', () => {
  for (const step of ['time', 'duration']) {
    const f = dialogueFixture();
    let result = f.flow.start(
      f.c,
      {
        intent: 'prepareAppointment',
        query: 'Анна Семёнова',
        serviceQuery: 'Чистка',
        date: dayForContext,
        ...(step === 'duration' ? { time: '10:00' } : {}),
      },
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
      step === 'duration' ? { requireDuration: true } : {},
    );
    assert.equal(result.dialogue.step, step);
    const body = {
      dialogueId: result.dialogue.id,
      dialogueVersion: result.dialogue.version,
      text: 'на час',
    };
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    result = snapshot
      ? f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock,
          proposal(step === 'time' ? { time: '13:00' } : { duration: 60 }), snapshot)
      : f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    assert.equal(result.dialogue.step, 'review', step);
    const entry = f.flow.get(f.c, f.member, f.state, result.dialogue.id);
    assert.equal(entry.data.time, step === 'time' ? '13:00' : '10:00', step);
    assert.equal(entry.data.duration, step === 'time' ? 30 : 60, step);
    result = f.flow.continueDialogue(
      f.c,
      {
        dialogueId: result.dialogue.id,
        dialogueVersion: result.dialogue.version,
        text: 'открой форму',
      },
      f.state,
      f.member,
      f.clock,
    );
    assert.equal(result.action.time, step === 'time' ? '13:00' : '10:00', step);
    assert.equal(result.action.duration, step === 'time' ? 30 : 60, step);
    assert.ok(
      f.patients.every((row) => row.appointments.length === 0),
      step,
    );
  }
});
