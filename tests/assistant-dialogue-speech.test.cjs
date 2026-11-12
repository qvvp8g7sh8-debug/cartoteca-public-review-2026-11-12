const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const { parseTimeText } = require('../src/server/modules/assistant/language/time/temporal.cjs');
const { parseDuration } = require('../src/server/modules/assistant/dialogue/dialogue-input.cjs');
const complete = { query: 'Анну Семенову', serviceQuery: 'Чистка', date: day, time: '10:00' };

test('spoken booking fills every missing field and opens an ordinary form only on review confirmation', () => {
  const f = dialogueFixture();
  f.start();
  f.answer({ text: 'Анна Семёнова' });
  assert.equal(f.result.dialogue.step, 'service');
  f.answer({ text: 'первый вариант' });
  assert.equal(f.result.dialogue.step, 'date');
  f.answer({ text: 'сегодня' });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.dialogue.phase, 'period');
  f.answer({ text: 'любое время' });
  assert.equal(f.result.dialogue.phase, 'slots');
  assert.equal(f.result.dialogue.options.length, 3);
  assert.equal(f.result.action, null);
  const label = f.result.dialogue.options[1].label;
  f.answer({ text: 'второй вариант' });
  assert.equal(f.result.dialogue.step, 'review');
  assert.equal(f.result.action, null);
  const done = f.answer({ text: 'открой форму' }).result;
  assert.equal(done.action.type, 'prepareAppointment');
  assert.equal(done.action.patientId, f.patients[0].id);
  assert.equal(done.action.date, day);
  assert.ok(label.includes(done.action.time));
  assert.deepEqual(done.action.serviceIds, ['clean']);
  assert.equal(done.dialogue, null);
  assert.equal(f.patients[0].appointments.length, 0);
  assert.match(done.text, /^Подготовил запись: /u);
});

test('spoken ordinal is bound to current opaque client choices and current dialogue version', () => {
  const f = dialogueFixture({ ambiguous: true });
  f.patients[1].phone = f.patients[0].phone;
  const first = f.start({ ...complete, query: f.patients[0].phone });
  assert.equal(first.dialogue.options.length, 2);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(f.patients[0].id + '|' + f.patients[1].id));
  assert.throws(() => f.answer({ text: 'третий вариант' }), { status: 400 });
  const accepted = f.answer({ text: 'выбираю второй вариант' });
  assert.match(f.result.dialogue.fields.find((row) => row.key === 'client').value, /Ольга/);
  assert.deepEqual(
    f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock),
    accepted.result,
  );
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { ...accepted.body, text: 'первый вариант' },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
  assert.equal(f.answer({ text: 'подтверждаю' }).result.action.patientId, f.patients[1].id);
});

test('review accepts explicit spoken confirmations and an early yes never completes missing fields', () => {
  for (const text of ['да', 'подтверждаю', 'всё верно', 'открой форму', 'подготовь форму записи']) {
    const f = dialogueFixture();
    f.start(complete);
    assert.equal(f.answer({ text }).result.action.type, 'prepareAppointment', text);
    assert.equal(f.patients[0].appointments.length, 0);
  }
  const f = dialogueFixture();
  const first = f.start();
  assert.throws(() => f.answer({ text: 'да' }), { status: 400 });
  assert.equal(f.result, first);
  assert.equal(f.result.action, null);
});

test('spoken corrections return to the named field, back returns one filled field and cancel writes nothing', () => {
  for (const [text, field] of [
    ['поменяй клиента', 'client'],
    ['измени услугу', 'service'],
    ['поменяй дату', 'date'],
    ['исправь время', 'time'],
    ['поменяй длительность', 'duration'],
    ['назад', 'duration'],
  ]) {
    const f = dialogueFixture();
    f.start(complete);
    assert.equal(f.answer({ text }).result.dialogue.step, field, text);
    assert.equal(f.result.action, null);
    assert.equal(f.patients[0].appointments.length, 0);
  }
  const only = dialogueFixture();
  only.start(complete);
  assert.equal(only.answer({ text: 'поменяй специалиста' }).result.dialogue.step, 'review');
  assert.equal(only.result.action, null);
  const unchanged = only.answer({ text: 'открой форму' }).result.action;
  assert.equal(unchanged.staffId, 'owner');
  assert.deepEqual(unchanged.serviceIds, ['clean']);
  assert.equal(unchanged.duration, 30);
  assert.equal(unchanged.date, day);
  assert.equal(unchanged.time, '10:00');
  assert.equal(only.patients[0].appointments.length, 0);
  const f = dialogueFixture();
  f.start(complete);
  assert.equal(f.answer({ text: 'поменяй время на два часа дня' }).result.dialogue.step, 'review');
  assert.equal(f.result.dialogue.fields.find((row) => row.key === 'time').value, '14:00');
  assert.equal(f.answer({ text: 'отмени подготовку' }).result.dialogue, null);
  assert.equal(f.patients[0].appointments.length, 0);
});

test('ordinary spoken clock and duration answers remain exact and ambiguous speech asks again', () => {
  for (const [text, time] of [
    ['два часа тридцать минут дня', '14:30'],
    ['два', '14:00'],
    ['три тридцать', '15:30'],
    ['полтретьего', '14:30'],
    ['в 2:30 дня', '14:30'],
    ['четырнадцать тридцать', '14:30'],
    ['в шесть часов вечера', '18:00'],
    ['в час дня', '13:00'],
    ['половина третьего дня', '14:30'],
    ['полтретьего дня', '14:30'],
    ['четверть третьего дня', '14:15'],
    ['без четверти три дня', '14:45'],
    ['без четверти двенадцать дня', '11:45'],
    ['без пяти два дня', '13:55'],
    ['четырнадцать часов ноль пять минут', '14:05'],
  ])
    assert.equal(parseTimeText(text), time, text);
  for (const text of [
    'двадцать пять',
    'примерно два часа дня',
    'два или три часа дня',
    'не в два часа дня',
    'четырнадцать часов и пятнадцать часов',
    '23:30 утра',
  ])
    assert.equal(parseTimeText(text), null, text);
  for (const [text, minutes] of [
    ['сорок пять минут', 45],
    ['два часа', 120],
    ['пятнадцать минут', 15],
  ])
    assert.equal(parseDuration(text), minutes, text);
  const f = dialogueFixture();
  const initial = f.start({ ...complete, time: undefined });
  const version = f.result.dialogue.version;
  const accepted = f.answer({ text: 'в три' }).result;
  assert.equal(accepted.dialogue.step, 'review');
  assert.equal(accepted.dialogue.version, version + 1);
  assert.equal(accepted.action, null);
  assert.equal(accepted.dialogue.fields.find((row) => row.key === 'time').value, '15:00');
  assert.deepEqual(
    accepted.dialogue.fields.filter((row) => row.key !== 'time'),
    initial.dialogue.fields,
  );
  assert.equal(f.patients[0].appointments.length, 0);
  assert.equal(f.answer({ text: 'да' }).result.action.time, '15:00');
  assert.equal(f.patients[0].appointments.length, 0);
  const explicit = dialogueFixture();
  explicit.start({ ...complete, time: undefined });
  explicit.answer({ text: 'два часа дня' });
  assert.equal(explicit.result.dialogue.step, 'review');
  assert.equal(explicit.result.action, null);
  assert.equal(explicit.result.dialogue.fields.find((row) => row.key === 'time').value, '14:00');
  assert.equal(explicit.answer({ text: 'да' }).result.action.time, '14:00');
  assert.equal(explicit.patients[0].appointments.length, 0);
});

test('a spoken window request retains the verified client and catalog service during required-duration clarification', () => {
  const f = dialogueFixture();
  f.start({ query: 'Анна Семёнова' }, { requireDuration: true });
  f.answer({ text: 'Чистка' });
  f.answer({ text: 'сегодня' });
  assert.equal(f.result.dialogue.step, 'duration');
  f.answer({ text: 'подбери время' });
  assert.equal(f.result.dialogue.step, 'duration');
  f.answer({ text: 'сорок пять минут' });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.dialogue.phase, 'slots');
  const pending = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  assert.equal(
    pending.data.timeWindow.kind,
    'any',
    'The earlier free-time request survives duration clarification',
  );
  assert.equal(pending.data.time, null);
  assert.ok(f.result.dialogue.options.length > 0 && f.result.dialogue.options.length <= 3);
  const expectedTime = f.result.dialogue.options[0].label.match(/ · (\d{2}:\d{2})/u)[1];
  f.answer({ text: 'первый вариант' });
  const done = f.answer({ text: 'да' }).result;
  assert.equal(done.action.date, day);
  assert.equal(done.action.time, expectedTime);
  assert.equal(done.action.duration, 45);
  assert.deepEqual(done.action.serviceIds, ['clean']);
  assert.equal(done.action.patientId, f.patients[0].id);
});

test('busy desired time offers real alternatives immediately and confirmation still rechecks occupancy', () => {
  const f = dialogueFixture();
  f.busy.push({ date: day, time: '10:00', duration: 30, staffId: 'owner', roomId: 'main' });
  const initial = f.start(complete);
  assert.equal(initial.action, null);
  assert.equal(initial.dialogue.step, 'time');
  assert.equal(initial.dialogue.phase, 'period');
  assert.equal(initial.dialogue.options.length, 2);
  assert.match(initial.text, /Свободно с 09:00 до 10:00, с 10:30 до 18:00/u);
  assert.ok(
    initial.dialogue.options.every(
      (row) => !row.label.includes('10:00–') && !row.label.includes('10:15–'),
    ),
  );
  f.answer({ text: 'в 09:30' });
  assert.equal(f.result.dialogue.step, 'review');
  const time = f.result.dialogue.fields.find((row) => row.key === 'time').value;
  f.busy.push({ date: day, time, duration: 30, staffId: 'owner', roomId: 'main' });
  const rejected = f.answer({ text: 'да' }).result;
  assert.equal(rejected.action, null);
  assert.equal(rejected.dialogue.step, 'time');
  assert.ok(rejected.dialogue.options.every((row) => !row.label.includes(time + '–')));
  assert.equal(f.patients[0].appointments.length, 0);
});

test('an occupied spoken option refreshes current server options and replays the same response safely', () => {
  const f = dialogueFixture();
  f.start({ ...complete, time: undefined });
  assert.equal(f.result.dialogue.phase, 'period');
  const initial = f.answer({ text: 'любое время' }).result;
  assert.equal(initial.dialogue.phase, 'slots');
  const time = initial.dialogue.options[0].label.match(/ · (\d{2}:\d{2})/)[1];
  f.busy.push({ date: day, time, duration: 30, staffId: 'owner', roomId: 'main' });
  const accepted = f.answer({ text: 'первый вариант' });
  assert.equal(accepted.result.action, null);
  assert.equal(accepted.result.dialogue.step, 'time');
  assert.ok(accepted.result.dialogue.options.every((row) => !row.label.includes(time + '–')));
  assert.deepEqual(
    f.flow.continueDialogue(f.c, accepted.body, f.state, f.member, f.clock),
    accepted.result,
  );
  assert.throws(
    () =>
      f.flow.continueDialogue(
        f.c,
        { ...accepted.body, text: 'второй вариант' },
        f.state,
        f.member,
        f.clock,
      ),
    { status: 409 },
  );
});

test('an unopened date requires explicit confirmation and never invents working hours or slots before consent', () => {
  const f = dialogueFixture(),
    ranges = [];
  f.c.platform.workSchedules.view = (token, staff, from, to) => {
    ranges.push({ from, to });
    return { days: {}, closures: {} };
  };
  f.start({ ...complete, time: undefined });
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.match(f.result.dialogue.prompt, /день не открыт/iu);
  const pending = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
  assert.ok([...pending.options.values()].every((row) => row.kind === 'closedDayContinue'));
  assert.equal(pending.data.closedDayConfirmation, undefined);
  f.answer({ text: 'подбери время' });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.phase, 'closedDay');
  assert.ok([...pending.options.values()].every((row) => row.kind === 'closedDayContinue'));
  assert.equal(pending.data.time, null);
  assert.equal(pending.data.closedDayConfirmation, undefined);
  assert.ok(ranges.every(({ from, to }) => from === day && to === day));
  assert.equal(f.patients[0].appointments.length, 0);
});
