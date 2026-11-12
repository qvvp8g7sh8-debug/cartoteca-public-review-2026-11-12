const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createExampleSelector,
  selectExamples,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');

const date = '2026-10-15';
const time = '10:30';
const { intentEnvelope } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const commands = { calendar: true, clients: true, prepareAppointment: true };
const policy = (extra = {}) => ({
  exampleSelection: 'automatic',
  commands,
  examples: [],
  ...extra,
});
const scenario = (id, text, expected, extra = {}) => ({
  id,
  category: 'appointment-fields',
  title: text,
  text,
  referenceDate: date,
  referenceTime: time,
  timeZone: 'Europe/Moscow',
  tags: [],
  current: { status: 'supported', intent: expected, outcome: 'Synthetic outcome', limitations: [] },
  ...extra,
});
const custom = (id, text, expected, extra = {}) => ({
  id,
  text,
  referenceDate: date,
  referenceTime: time,
  enabled: true,
  expected,
  ...extra,
});
const selector = (cases) => {
  const catalog = { cases };
  return createExampleSelector({ loadCatalog: () => catalog });
};
const texts = (result) => result.examples.map((example) => example.text);
const packed = (result) =>
  JSON.stringify(
    result.examples.map((example) => ({
      text: example.text,
      referenceDate: example.referenceDate,
      referenceTime: example.referenceTime,
      expected: example.expected,
    })),
  );
const appointment = { intent: 'prepareAppointment', query: 'Марию Соколову', date: '2026-10-16' };

for (const mode of [undefined, 'manual']) {
  test(
    'manual or legacy policy uses only enabled custom examples without loading the catalog: ' +
      mode,
    () => {
      let loads = 0;
      const choose = createExampleSelector({
        loadCatalog: () => {
          loads++;
          throw Error('Unexpected catalog load');
        },
      });
      const enabled = custom('10000000-0000-4000-8000-000000000001', 'Открой календарь завтра', {
        intent: 'calendar',
        date: '2026-10-16',
      });
      const disabled = custom(
        '10000000-0000-4000-8000-000000000002',
        'Не отправляй этот пример',
        { intent: 'help' },
        { enabled: false },
      );
      const input = policy({
        examples: [enabled, disabled],
        ...(mode ? { exampleSelection: mode } : {}),
      });
      if (!mode) delete input.exampleSelection;
      const before = structuredClone(input);
      assert.deepEqual(texts(choose('Запиши клиента', input)), [enabled.text]);
      assert.equal(loads, 0);
      assert.deepEqual(input, before);
    },
  );
}

test('automatic selection includes supported, manual and clarification initial parses', () => {
  const cases = [
    scenario('manual-booking', 'Запиши Марию Соколову завтра', appointment, {
      current: { status: 'manual', intent: appointment, outcome: 'Manual Save', limitations: [] },
    }),
    scenario('clarify-time', 'Запиши Марию Соколову завтра в три', appointment, {
      current: {
        status: 'needs_clarification',
        intent: appointment,
        outcome: 'Ask time',
        limitations: [],
      },
    }),
    scenario(
      'calendar-day',
      'Покажи расписание завтра',
      { intent: 'calendar', date: '2026-10-16' },
      { category: 'calendar-dates' },
    ),
  ];
  const result = selector(cases)('Запиши клиента завтра в три', policy());
  assert.ok(result.examples.some((item) => item.text === cases[0].text));
  const ambiguous = result.examples.find((item) => item.text === cases[1].text);
  assert.ok(ambiguous);
  assert.equal(ambiguous.expected.time, null);
  assert.equal(ambiguous.expected.intent, 'prepareAppointment');
});

test('unsupported action expectations are excluded while current help boundaries never import future capabilities', () => {
  const cases = [
    scenario(
      'period-staff-inactive',
      'Открой расписание неактивного специалиста',
      { intent: 'calendar' },
      { current: { status: 'unsupported', intent: { intent: 'calendar' } } },
    ),
    scenario('constraint-staff-acl', 'Запиши клиента без доступа', appointment, {
      current: { status: 'unsupported', intent: appointment },
    }),
    scenario(
      'period-explicit-range',
      'Покажи записи с 16 по 20 октября 2026 года',
      { intent: 'help' },
      {
        current: {
          status: 'unsupported',
          intent: { intent: 'help' },
          outcome: 'No range action',
          limitations: [],
        },
        futureTarget: {
          capability: 'FORBIDDEN_FUTURE_SENTINEL',
          fields: { startDate: '2026-10-16', endDate: '2026-10-20' },
        },
      },
    ),
  ];
  const result = selector(cases)('Покажи записи с 16 по 20 октября 2026 года', policy());
  assert.deepEqual(texts(result), [cases[2].text]);
  assert.deepEqual(result.examples[0].expected, intentEnvelope({ intent: 'help' }));
  assert.ok(!packed(result).includes('FORBIDDEN_FUTURE_SENTINEL'));
  assert.ok(!Object.hasOwn(result.examples[0], 'futureTarget'));
});

test('automatic command permissions exclude both calendar modes and client-card variants', () => {
  const choose = selector([
    scenario('calendar', 'Покажи расписание', { intent: 'calendar' }),
    scenario('availability', 'Найди свободное окно', { intent: 'availability', duration: 30 }),
    scenario('clients', 'Найди клиента', { intent: 'clients', query: 'Мария' }),
    scenario('card', 'Открой карточку', { intent: 'clientCard', query: 'Мария' }),
    scenario('appointment', 'Подготовь новую запись', { intent: 'prepareAppointment' }),
    scenario('help', 'Не делай ничего', { intent: 'help' }),
  ]);
  const result = choose(
    'Расписание клиента и новая запись',
    policy({ commands: { calendar: false, clients: false, prepareAppointment: false } }),
  );
  assert.ok(result.examples.every((item) => item.expected.intent === 'help'));
});

test('disabled custom examples do not reach automatic prompts and custom exact duplicates take priority', () => {
  const text = 'Запиши Анну Иванову завтра в три';
  const builtin = scenario('same-wording', text, {
    intent: 'prepareAppointment',
    query: 'Анну Иванову',
    date: '2026-10-16',
    time: '15:00',
  });
  const approved = custom('20000000-0000-4000-8000-000000000001', text, {
    intent: 'prepareAppointment',
    query: 'Анну Иванову',
    date: '2026-10-16',
  });
  const disabled = custom(
    '20000000-0000-4000-8000-000000000002',
    'DISABLED_EXAMPLE_SENTINEL',
    { intent: 'help' },
    { enabled: false },
  );
  const result = selector([builtin])(
    'Запиши Анну Иванову завтра в три',
    policy({ examples: [approved, disabled] }),
  );
  assert.equal(result.examples.filter((item) => item.text === text).length, 1);
  assert.deepEqual(
    result.examples.find((item) => item.text === text).expected,
    intentEnvelope(approved.expected),
  );
  assert.ok(!packed(result).includes('DISABLED_EXAMPLE_SENTINEL'));
});

test('the same relative wording under distinct reference dates retains its own expected context', () => {
  const text = 'Покажи расписание на завтра';
  const choose = selector([
    scenario('cal-tomorrow', text, { intent: 'calendar', date: '2026-10-16' }),
    scenario(
      'cal-year-end',
      text,
      { intent: 'calendar', date: '2027-01-01' },
      { referenceDate: '2026-12-31' },
    ),
  ]);
  const result = choose(text, policy());
  assert.ok(result.examples.length > 0);
  const expected = new Map([
    [date, '2026-10-16'],
    ['2026-12-31', '2027-01-01'],
  ]);
  for (const item of result.examples)
    assert.equal(item.expected.date, expected.get(item.referenceDate));
});

test('booking task features remain useful when unrelated search examples share the exact patient name', () => {
  const cases = Array.from({ length: 18 }, (_, index) =>
    scenario(
      'search-' + index,
      'Найди Анну Иванову в списке клиентов ' + index,
      { intent: 'clients', query: 'Анну Иванову' },
      { category: 'clients-search' },
    ),
  );
  const relevant = scenario(
    'booking-structural',
    'Запиши Марию Соколову завтра в 14:30 на 30 минут',
    { ...appointment, time: '14:30', duration: 30 },
    {
      current: {
        status: 'manual',
        intent: { ...appointment, time: '14:30', duration: 30 },
        outcome: 'Manual Save',
        limitations: [],
      },
    },
  );
  cases.push(relevant);
  const result = selector(cases)('Запиши Анну Иванову завтра в 14:30 на 30 минут', policy());
  assert.ok(result.examples.some((item) => item.text === relevant.text));
  assert.ok(result.examples.length <= 12);
});

test('bounded selection counts serialized UTF-8 bytes and keeps every example whole', () => {
  const cases = Array.from({ length: 40 }, (_, index) =>
    scenario('long-' + index, 'Запиши клиента ' + 'я'.repeat(340) + ' завтра ' + index, {
      intent: 'prepareAppointment',
      query: 'я'.repeat(100),
      date: '2026-10-16',
    }),
  );
  const result = selector(cases)('Запиши клиента завтра', policy());
  assert.ok(result.examples.length > 0 && result.examples.length <= 12);
  assert.ok(Buffer.byteLength(packed(result), 'utf8') <= 4096);
  for (const item of result.examples) {
    assert.ok(cases.some((source) => source.text === item.text));
    assert.deepEqual(
      item.expected,
      intentEnvelope(cases.find((source) => source.text === item.text).current.intent),
    );
  }
});

test('repeat selection is deterministic, does not mutate inputs and returns independent example copies', () => {
  const cases = [
    scenario('one', 'Покажи расписание завтра', { intent: 'calendar', date: '2026-10-16' }),
    scenario('two', 'Запиши Марию Соколову завтра', appointment),
  ];
  const original = structuredClone(cases),
    settings = policy(),
    before = structuredClone(settings);
  const choose = selector(cases);
  const first = choose('Запиши клиента завтра', settings),
    second = choose('Запиши клиента завтра', settings);
  assert.deepEqual(first, second);
  assert.deepEqual(cases, original);
  assert.deepEqual(settings, before);
  assert.ok(first.examples.length);
  first.examples[0].expected.intent = 'help';
  assert.deepEqual(choose('Запиши клиента завтра', settings), second);
  assert.deepEqual(cases, original);
});

test('empty and unknown input has no irrelevant example fallback', () => {
  const choose = selector([
    scenario('help', 'Подскажи доступные действия', { intent: 'help' }),
    scenario('booking', 'Новая запись', { intent: 'prepareAppointment' }),
  ]);
  for (const text of ['', 'ну это туда же', '???']) {
    const result = choose(text, policy());
    assert.deepEqual(result.examples, []);
  }
});

test('the default public selector can use the current synthetic catalog within the shared budget', () => {
  const result = selectExamples('Запиши клиента завтра в три', policy());
  assert.ok(Array.isArray(result.examples));
  assert.ok(result.examples.length > 0 && result.examples.length <= 12);
  assert.ok(Buffer.byteLength(packed(result), 'utf8') <= 4096);
  for (const item of result.examples) {
    assert.equal(typeof item.text, 'string');
    assert.ok(item.expected && typeof item.expected.intent === 'string');
    assert.equal(item.futureTarget, undefined);
    assert.equal(item.preconditions, undefined);
  }
});

test('partial calendar examples with unrepresented filters do not teach silently dropping requested constraints', () => {
  const ids = [
    'period-part-of-day',
    'period-time-window',
    'period-upcoming-only',
    'period-today-time',
    'avail-cancellations',
  ];
  const cases = ids.map((id) =>
    scenario(
      id,
      'Покажи только отменённые записи завтра ' + id,
      { intent: 'calendar', date: '2026-10-16' },
      {
        category: 'calendar-periods',
        current: {
          status: 'manual',
          intent: { intent: 'calendar', date: '2026-10-16' },
          outcome: 'Filter is unsupported',
          limitations: [],
        },
      },
    ),
  );
  assert.deepEqual(
    selector(cases)('Покажи только отменённые записи завтра', policy()).examples,
    [],
  );
});

test('negative initial help examples remain eligible while explicitly active dialogue cases are excluded', () => {
  const outside = scenario(
    'dialogue-slot-only-time',
    'В 14:30',
    { intent: 'help' },
    {
      category: 'dialogue-context',
      preconditions: ['Нет активного серверного диалога подготовки записи.'],
      current: {
        status: 'needs_clarification',
        intent: { intent: 'help' },
        outcome: 'Initial parser needs a complete request',
        limitations: [],
      },
    },
  );
  const active = scenario(
    'active-time-answer',
    'Запиши клиента в 14:30',
    { intent: 'prepareAppointment', time: '14:30' },
    { activeDialogue: true, preconditions: { activeDialogue: true } },
  );
  const choose = selector([outside, active]);
  assert.ok(texts(choose('В 14:30', policy())).includes(outside.text));
  assert.ok(!texts(choose(active.text, policy())).includes(active.text));
});

test('fifty approved automatic custom examples are a candidate pool rather than fifty prompt entries', () => {
  const examples = Array.from({ length: 50 }, (_, index) =>
    custom(
      '30000000-0000-4000-8000-' + String(index).padStart(12, '0'),
      'Запиши клиента завтра в 14:30 на ' + (5 + index * 5) + ' минут',
      { intent: 'prepareAppointment', date: '2026-10-16', time: '14:30', duration: 5 + index * 5 },
    ),
  );
  const result = selector([])('Запиши клиента завтра в 14:30 на 30 минут', policy({ examples }));
  assert.ok(result.examples.length > 0 && result.examples.length <= 12);
  assert.ok(result.examples.every((item) => examples.some((source) => source.text === item.text)));
  assert.ok(Buffer.byteLength(packed(result), 'utf8') <= 4096);
});

test('Russian command inflections retrieve the matching task rather than matching only a person name', () => {
  const choose = selector([
    scenario(
      'booking-inflection',
      'Подготовь запись Марии Соколовой завтра на консультацию',
      { ...appointment, serviceQuery: 'консультацию' },
      {
        current: {
          status: 'manual',
          intent: { ...appointment, serviceQuery: 'консультацию' },
          outcome: 'Manual Save',
          limitations: [],
        },
      },
    ),
    scenario(
      'search-inflection',
      'Найди клиента Анну Иванову',
      { intent: 'clients', query: 'Анну Иванову' },
      { category: 'clients-search' },
    ),
    scenario(
      'calendar-inflection',
      'Открой расписание на завтра',
      { intent: 'calendar', date: '2026-10-16' },
      { category: 'calendar-dates' },
    ),
  ]);
  assert.ok(
    choose('Нужно записать Анну Иванову завтра на консультацию', policy()).examples.some(
      (item) => item.expected.intent === 'prepareAppointment',
    ),
  );
  assert.ok(
    choose('Покажите расписание на завтра', policy()).examples.some(
      (item) => item.expected.intent === 'calendar',
    ),
  );
});

test('independent mixed operations select a relevant boundary without teaching partial execution', () => {
  const cases = Array.from({ length: 16 }, (_, index) =>
    scenario(
      'near-search-' + index,
      'Найди клиента Анну Иванову ' + index,
      { intent: 'clients', query: 'Анну Иванову' },
      { category: 'clients-search' },
    ),
  );
  cases.push(
    scenario(
      'mixed-calendar',
      'Покажи расписание на завтра',
      { intent: 'calendar', date: '2026-10-16' },
      { category: 'calendar-dates' },
    ),
  );
  cases.push(
    scenario(
      'mixed-boundary',
      'Покажи расписание завтра и найди Анну Иванову',
      { intent: 'help' },
      {
        current: { status: 'unsupported', intent: { intent: 'help' } },
      },
    ),
  );
  cases.push(
    scenario('mixed-booking', 'Подготовь новую запись клиента завтра', {
      intent: 'prepareAppointment',
      date: '2026-10-16',
    }),
  );
  const result = selector(cases)(
    'Найди клиента, покажи расписание и подготовь новую запись завтра',
    policy(),
  );
  assert.ok(result.examples.length > 0);
  assert.ok(result.examples.every((item) => item.expected.intent === 'help'));
  assert.equal(result.metadata.routing.boundaryOnly, true);
  assert.ok(result.examples.length <= 12);
});
