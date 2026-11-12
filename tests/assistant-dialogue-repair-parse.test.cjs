const test = require('node:test');
const assert = require('node:assert/strict');
const { repairOperation } = require('../src/server/modules/assistant/dialogue/dialogue-repair-parse.cjs');
const clock = { date: '2099-01-05', time: '09:00', timezone: 'Europe/Moscow' };
function current(step = 'review', count = 3) {
  return {
    step,
    data: {
      date: '2099-01-05',
      time: '10:00',
      duration: 30,
      patient: { id: 'synthetic-client', label: 'Анна Семенова' },
    },
    options: new Map(
      Array.from({ length: count }, (_, i) => [
        'opaque-' + (i + 1),
        { kind: step === 'review' ? 'ready' : 'slot', label: 'Вариант ' + (i + 1) },
      ]),
    ),
  };
}
const p = (edits) => ({ kind: 'patch', edits, confirm: false });
const one = (field, text) => p([{ field, text }]);
function parse(text, step = 'review', count = 3) {
  return repairOperation(current(step, count), text, clock);
}

test('named corrections produce only bounded field edits and never confirmation', () => {
  for (const [text, field, value] of [
    ['нет, поменяй дату на завтра', 'date', '2099-01-06'],
    ['лучше в 16:30', 'time', '16:30'],
    ['поменяй клиента на Наталью Иванову', 'client', 'наталью иванову'],
    ['клиента Анну Семёнову', 'client', 'анну семенову'],
    ['специалиста на Елену Петрову', 'staff', 'елену петрову'],
    ['исправь врача на Наталью Смирнову', 'staff', 'наталью смирнову'],
    ['услугу на Консультацию', 'service', 'консультацию'],
    ['длительность на сорок пять минут', 'duration', '45'],
    ['продолжительность: два часа', 'duration', '120'],
    ['длительность на час', 'duration', '60'],
    ['на 15 минут', 'duration', '15'],
    ['время = 14:30', 'time', '14:30'],
  ])
    assert.deepEqual(parse(text), one(field, value), text);
});

test('missing named values return to one field without inventing a value', () => {
  for (const [text, field] of [
    ['поменяй клиента', 'client'],
    ['измени специалиста', 'staff'],
    ['услуга', 'service'],
    ['исправь дату', 'date'],
    ['поменяй время', 'time'],
    ['длительность', 'duration'],
  ])
    assert.deepEqual(parse(text), { kind: 'edit', field }, text);
});

test('clear multipart corrections stay one atomic patch and preserve service conjunctions', () => {
  assert.deepEqual(
    parse('поменяй дату на завтра, время на 11:30'),
    p([
      { field: 'date', text: '2099-01-06' },
      { field: 'time', text: '11:30' },
    ]),
  );
  assert.deepEqual(
    parse('клиента Анну Семёнову, длительность 45 минут'),
    p([
      { field: 'client', text: 'анну семенову' },
      { field: 'duration', text: '45' },
    ]),
  );
  assert.deepEqual(
    parse('услугу на лицо и шея и дату на послезавтра'),
    p([
      { field: 'service', text: 'лицо и шея' },
      { field: 'date', text: '2099-01-07' },
    ]),
  );
  assert.deepEqual(
    parse('дату на завтра, время на в три'),
    p([
      { field: 'date', text: '2099-01-06' },
      { field: 'time', text: '15:00' },
    ]),
  );
  assert.equal(parse('дату на завтра, дату на послезавтра').kind, 'localHelp');
});

test('absolute date and time corrections consume the whole phrase', () => {
  for (const text of ['завтра в 16:30', 'на завтра, 16:30', 'лучше завтра в 16:30'])
    assert.deepEqual(
      parse(text),
      p([
        { field: 'date', text: '2099-01-06' },
        { field: 'time', text: '16:30' },
      ]),
      text,
    );
  assert.deepEqual(
    parse('2099-01-06 в 14:30'),
    p([
      { field: 'date', text: '2099-01-06' },
      { field: 'time', text: '14:30' },
    ]),
  );
  assert.deepEqual(parse('06.01.2099'), one('date', '2099-01-06'));
  assert.deepEqual(parse('6 января 2099'), one('date', '2099-01-06'));
  assert.deepEqual(
    parse('в 16:30 завтра'),
    p([
      { field: 'date', text: '2099-01-06' },
      { field: 'time', text: '16:30' },
    ]),
  );
  assert.equal(parse('завтра и послезавтра').kind, 'localHelp');
  assert.equal(parse('завтра в 16:30 и в 17:30').kind, 'localHelp');
  assert.equal(parse('завтра случайные слова в 16:30').kind, 'localHelp');
  assert.equal(parse('лучше Иванову в 16:30').kind, 'localHelp');
  assert.equal(parse('лучше какой-нибудь полдень').kind, 'localHelp');
});

test('relative repairs carry only a bounded signed delta for the local applicator', () => {
  for (const [text, minutes] of [
    ['на полчаса позже', 30],
    ['на час раньше', -60],
    ['на 15 минут позже', 15],
    ['перенеси запись на сорок пять минут раньше', -45],
    ['поменяй время на полчаса позже', 30],
  ])
    assert.deepEqual(parse(text), { kind: 'shiftTime', minutes }, text);
  for (const [text, days] of [
    ['на следующий день', 1],
    ['на предыдущий день', -1],
    ['на день позже', 1],
    ['на два дня раньше', -2],
    ['днем позже', 1],
    ['поменяй дату на следующий день', 1],
  ])
    assert.deepEqual(parse(text), { kind: 'shiftDate', days }, text);
  for (const text of ['попозже', 'раньше', 'на 32 дня позже', 'на пару минут позже'])
    assert.equal(parse(text).kind, 'localHelp', text);
});

test('ordinals and last options select only current opaque IDs', () => {
  for (const [text, id] of [
    ['второе', 'opaque-2'],
    ['давай второй вариант', 'opaque-2'],
    ['выбираю третье окно', 'opaque-3'],
    ['последнее', 'opaque-3'],
    ['последний вариант', 'opaque-3'],
    ['предпоследнее', 'opaque-2'],
    ['вариант номер 2', 'opaque-2'],
    ['номер 1', 'opaque-1'],
  ])
    assert.deepEqual(parse(text, 'time'), { kind: 'choice', choice: id }, text);
  assert.throws(() => parse('четвертый вариант', 'time'), { status: 400 });
  assert.throws(() => parse('последнее', 'availability', 0), { status: 400 });
  assert.throws(() => parse('предпоследнее', 'service', 1), { status: 400 });
  const old = current('time');
  old.options = new Map([['new-current-id', { kind: 'slot', label: 'Актуальное окно' }]]);
  assert.deepEqual(repairOperation(old, 'первое', clock), {
    kind: 'choice',
    choice: 'new-current-id',
  });
});

test('bare numbers do not silently replace clock or duration by an option number', () => {
  for (const text of ['2', 'два']) {
    const entry = current('time');
    const result = repairOperation(entry, text, clock);
    assert.deepEqual(result, one('time', '14:00'));
    assert.equal(
      Object.hasOwn(result, 'choice'),
      false,
      'A clock answer must not select an option',
    );
    assert.equal(entry.data.time, '10:00', 'Parsing alone does not mutate the draft');
  }
  assert.equal(parse('2', 'duration').kind, 'localHelp');
  assert.deepEqual(parse('15', 'time'), one('time', '15:00'));
  assert.deepEqual(parse('15', 'duration'), one('duration', '15'));
  assert.equal(parse('два', 'duration').kind, 'localHelp');
  assert.deepEqual(parse('вариант 2', 'time'), { kind: 'choice', choice: 'opaque-2' });
});

test('ordinary field answers keep their existing local parser and review yes remains explicit', () => {
  assert.deepEqual(parse('в три', 'time'), one('time', '15:00'));
  for (const [text, step] of [
    ['Анна Семенова', 'client'],
    ['Елена Петрова', 'staff'],
    ['Лицо и шея', 'service'],
    ['сорок пять минут', 'duration'],
    ['два часа', 'duration'],
    ['четырнадцать', 'duration'],
    ['назад', 'review'],
    ['да', 'review'],
    ['подтверждаю', 'review'],
    ['открой форму', 'review'],
    ['без услуги', 'service'],
  ])
    assert.equal(parse(text, step), null, text);
});

test('ambiguous, negated and unsupported repairs ask locally without mutating entry', () => {
  const entry = current();
  const before = JSON.stringify({
    data: entry.data,
    step: entry.step,
    options: [...entry.options],
  });
  for (const text of [
    'не в 14:00, а в 15:00',
    'лучше завтра или послезавтра',
    'время примерно 16:00',
    'длительность от 30 до 45 минут',
    'нет, вместо 10:00 в 11:30',
    'поменяй неизвестное поле на 42',
    'поменяй дату на 31.02.2099',
  ]) {
    assert.equal(repairOperation(entry, text, clock).kind, 'localHelp', text);
    assert.equal(
      JSON.stringify({ data: entry.data, step: entry.step, options: [...entry.options] }),
      before,
      text,
    );
  }
});

test('meta tasks are local instructions and save cannot become a client or service query', () => {
  for (const text of [
    'помощь',
    'как исправить',
    'сохрани запись',
    'запиши нового клиента',
    'удали запись',
    'покажи расписание на неделю',
    'открой карточку Анны',
    'найди клиента Иванову',
    'новая команда',
  ])
    assert.equal(parse(text, 'client').kind, 'localHelp', text);
  for (const text of [
    'стоп',
    'отмена',
    'не надо',
    'отмени запись',
    'отмени подготовку',
    'отмени черновик записи',
  ])
    assert.deepEqual(parse(text), { kind: 'cancel' }, text);
});

test('leading correction words retain cancellation and task boundaries', () => {
  assert.deepEqual(parse('нет, отмени подготовку'), { kind: 'cancel' });
  assert.deepEqual(parse('лучше не надо'), { kind: 'cancel' });
  assert.equal(parse('лучше открой календарь').kind, 'localHelp');
  assert.equal(parse('нет, сохрани запись').kind, 'localHelp');
});

test('time fragments in unknown combined requests never discard the other data', () => {
  for (const text of [
    'Анна Семенова в 16:30',
    'какой-то текст 16:30',
    'время на 16:30 с неизвестным условием',
    'завтра для Анны в 16:30',
    'случайный текст полдень',
  ])
    assert.equal(parse(text, 'client').kind, 'localHelp', text);
});

test('a prefixed simple answer corrects only the currently requested identity or service', () => {
  assert.deepEqual(parse('нет, Анну Семёнову', 'client'), one('client', 'анну семенову'));
  assert.deepEqual(parse('лучше Массаж', 'service'), one('service', 'массаж'));
  assert.deepEqual(parse('точнее Елена Петрова', 'staff'), one('staff', 'елена петрова'));
  assert.deepEqual(parse('нет, +7 (999) 111-22-33', 'client'), one('client', '+7 (999) 111-22-33'));
  for (const step of ['review', 'date', 'time', 'duration'])
    assert.equal(parse('нет, Анну Семенову', step).kind, 'localHelp', step);
});

test('prefixed simple answers retain command, negation and alternative boundaries', () => {
  for (const text of [
    'лучше включи свет',
    'нет, поменяй пароль',
    'лучше Анна или Мария',
    'нет, не Иванову',
    'лучше покажи расписание',
    'нет, назад',
    'лучше через полчаса',
  ])
    assert.equal(parse(text, 'client').kind, 'localHelp', text);
});

test('multipart date and free-window repairs carry the slot request and reject a conflicting explicit time', () => {
  const entry = current();
  const before = structuredClone(entry.data);
  const operations = [
    'дату на завтра любое время, длительность на 45 минут',
    'дату на завтра любое время, время на 11:30',
    'время на 11:30, дату на завтра любое время',
  ].map((text) => repairOperation(entry, text, clock));
  assert.deepEqual(entry.data, before);
  assert.deepEqual(
    operations.map((operation) =>
      operation.kind === 'patch' ? operation : { kind: operation.kind },
    ),
    [
      {
        ...p([
          { field: 'date', text: '2099-01-06' },
          { field: 'duration', text: '45' },
        ]),
        seekSlots: true,
      },
      { kind: 'localHelp' },
      { kind: 'localHelp' },
    ],
  );
  const { applyRepair } = require('../src/server/modules/assistant/dialogue/dialogue-repair-apply.cjs');
  assert.deepEqual(applyRepair(entry, operations[0], clock), {});
  assert.equal(entry.data.date, '2099-01-06');
  assert.equal(entry.data.duration, 45);
  assert.equal(entry.data.time, null);
  assert.equal(entry.data.seekSlots, true);
});
