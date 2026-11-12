const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calendarReadIntent,
} = require('../src/server/modules/assistant/actions/calendar-read-request.cjs');
const {
  demoIntent,
  modelPayload,
  parseModelIntent,
} = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  detectRequestedOperation,
} = require('../src/server/modules/assistant/interpretation/requested-operation.cjs');
const {
  localManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const { hints } = require('../src/server/modules/assistant/behavior/example-features.cjs');
const {
  selectExamples,
} = require('../src/server/modules/assistant/behavior/example-selection.cjs');
const { initialState } = require('../src/server/modules/assistant/access/defaults.cjs');
const {
  intentEnvelope,
} = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { loadCatalog } = require('../src/server/modules/assistant/behavior/behavior-library.cjs');
const { zonedClock } = require('../src/shared/time-zone.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const clock = { date: '2026-10-18', hour: 9, minute: 0 };
const select = (text, context = clock) => calendarReadIntent(text, context);

test('plural read commands resolve one whole source date in any supported day spelling', () => {
  for (const [text, date] of [
    ['Открой записи на 21', '2026-10-21'],
    ['Покажи записи на21', '2026-10-21'],
    ['Пожалуйста, открой мне записи на 21-е.', '2026-10-21'],
    ['Открой записи на двадцать первое', '2026-10-21'],
    ['Покажите записи на двадцать первое число', '2026-10-21'],
    ['Открой записи на двадцать первое октября', '2026-10-21'],
    ['Открой записи на 21 октября 2027 года', '2027-10-21'],
    ['Открой записи на 2026-10-21', '2026-10-21'],
    ['Открой записи на 21.10.2026', '2026-10-21'],
    ['Открой записи на завтра', '2026-10-19'],
    ['Покажи приёмы на следующую субботу', '2026-10-24'],
    ['Покажи записи в среду', '2026-10-21'],
    ['Покажи записи на 1', '2026-10-01'],
    ['Покажи записи на первое октября', '2026-10-01'],
    ['Покажи записи вчера', '2026-10-17'],
  ]) {
    const expected = { intent: 'calendar', date, mode: 'day' };
    assert.deepEqual(select(text), expected, text);
    assert.deepEqual(demoIntent(text, clock), expected, text);
    assert.equal(detectRequestedOperation(text).intent, 'calendar', text);
    assert.equal(localManagementIntent(text, clock), null, text);
  }
  assert.deepEqual(select('Открой записи на 29', { date: '2028-02-01' }), {
    intent: 'calendar',
    date: '2028-02-29',
    mode: 'day',
  });
  assert.deepEqual(select('Покажи записи на следующую неделю'), {
    intent: 'calendar',
    date: '2026-10-19',
    mode: 'week',
  });
});

test('invalid dates, clocks, filters, conditions and multiple tasks never degrade to today or an individual edit', () => {
  for (const text of [
    'Открой записи на 0',
    'Открой записи на 32',
    'Открой записи на 21:00',
    'Открой записи на 31 февраля',
    'Открой записи на 21 или 22',
    'Открой записи на 21 и 22',
    'Открой записи на завтра на 21',
    'Открой записи на 21 в 12:00',
    'Открой записи на 21 у Ивановой',
    'Открой записи с 21 по 23 октября',
    'Не открывай записи на 21',
    'Если свободно, открой записи на 21',
    'Открой записи на 21, если свободно',
    'Открой записи на 21 и удали запись Ивановой',
    'Открой записи на 21 и карточку Ивановой',
    'Открой записи на 21, потом создай запись',
  ]) {
    assert.deepEqual(select(text), { intent: 'help' }, text);
    assert.deepEqual(demoIntent(text, clock), { intent: 'help' }, text);
  }
  assert.deepEqual(select('Открой записи на 29', { date: '2026-02-18' }), { intent: 'help' });
  assert.deepEqual(select('Открой записи на 31', { date: '2026-04-18' }), { intent: 'help' });
  assert.deepEqual(select('Открой записи на 21', { date: 'not-a-date' }), { intent: 'help' });
});

test('singular source edits, client cards and plural write operations preserve their actual task', () => {
  for (const [text, intent] of [
    ['Открой запись Ивановой', 'editAppointment'],
    ['Открой записи Семёновой', 'editAppointment'],
    ['Открой записи клиента Семёновой', 'editAppointment'],
    ['Открой карточку Ивановой', 'clientCard'],
    ['Перенеси записи Ивановой на завтра', 'moveAppointment'],
    ['Измени записи Ивановой', 'moveAppointment'],
    ['Отмени записи Ивановой', 'cancelAppointment'],
    ['Удали записи Ивановой', 'cancelAppointment'],
  ]) {
    assert.equal(select(text), null, text);
    assert.equal(detectRequestedOperation(text).intent, intent, text);
    assert.equal(demoIntent(text, clock).intent, intent, text);
  }
  assert.match(localManagementIntent('Открой записи Семёновой', clock).query, /Семёновой/u);
});

test('assistant.turn resolves a fully covered calendar date without asking the model or reading clinical records', async (t) => {
  const f = await assistantBoundariesFixture(t);
  const orgClock = zonedClock(
    new Date(),
    f.store.organizationTimeZone(f.current('owner').organizationId),
  );
  const expected = orgClock.date.slice(0, 8) + '21';
  for (const output of [
    { intent: 'help' },
    { intent: 'editAppointment', query: 'invented', time: '21:00' },
    { intent: 'prepareAppointment', time: '21:00' },
    { intent: 'calendar', date: '2099-01-01', mode: 'month', staffQuery: 'invented' },
  ]) {
    f.hooks.llm = () => ({ text: JSON.stringify(intentEnvelope(output)) });
    const reply = await f.request('llm', 'owner', { text: 'Открой записи на 21' });
    assert.equal(reply.intent, 'calendar');
    assert.deepEqual(reply.action, {
      type: 'calendar',
      date: expected,
      mode: 'day',
      staffId: f.current('owner').accountId,
    });
    assert.match(reply.text, /^Открываю расписание на 21 /u);
    assert.match(reply.text, new RegExp(orgClock.date.slice(0, 4)));
    assert.equal(reply.dialogue, undefined);
    assert.equal(reply.action.executionId, undefined);
  }
  assert.equal(f.calls.llm, 0);
  assert.equal(f.calls.stt + f.calls.tts, 0);
  for (const text of ['Открой записи на 32', 'Открой записи на 21 и удали запись Ивановой']) {
    const reply = await f.request('llm', 'owner', { text });
    assert.equal(reply.intent, 'help');
    assert.equal(reply.action, null);
  }
  assert.equal(f.calls.llm, 2, 'unsupported or mixed commands retain the provider boundary');
  f.hooks.llm = () => ({ text: JSON.stringify({ intent: 'calendar', time: '21:00' }) });
  await assert.rejects(
    f.request('llm', 'owner', { text: 'Календарь' }),
    { status: 502 },
    'commands outside the deterministic grammar retain strict model wire validation',
  );
});

test('calendar view retains category and member ACL; a specialist remains restricted to their own schedule', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.hooks.llm = () => ({ text: '{"intent":"help"}' });
  f.settings({ policy: { commands: { calendar: true, prepareAppointment: false } } });
  for (const role of ['owner', 'cosmetologist', 'salon_admin']) {
    const reply = await f.request('llm', role, { text: 'Покажи записи на 21' });
    assert.equal(reply.action.type, 'calendar');
    assert.equal(
      reply.action.staffId,
      role === 'salon_admin' ? undefined : f.current(role).accountId,
    );
  }
  f.settings({ policy: { commands: { calendar: false } } });
  await assert.rejects(f.request('llm', 'owner', { text: 'Покажи записи на 21' }), { status: 403 });
  f.grant('cosmetologist', false);
  const before = f.calls.llm;
  await assert.rejects(f.request('llm', 'cosmetologist', { text: 'Покажи записи на 21' }), {
    status: 403,
  });
  assert.equal(f.calls.llm, before);
});

test('current calendar/card/cancel branches rank the proper examples with existing ACL and byte limits', () => {
  const state = initialState();
  state.providers.llm.provider = 'codex';
  state.policy.exampleSelection = 'automatic';
  for (const key of Object.keys(state.policy.commands)) state.policy.commands[key] = true;
  const cases = [
    ['Открой записи на 21', 'calendar'],
    ['Покажи записи на двадцать первое', 'calendar'],
    ['Открой карточку Семёнова', 'clientCard'],
    ['Открой список клиентов', 'clients'],
    ['Удали запись Морозовой', 'cancelAppointment'],
    ['Удали запись Анны Ивановой', 'cancelAppointment'],
  ];
  for (const [text, intent] of cases) {
    assert.equal(hints(text).get(intent), 1.4, text);
    const selected = selectExamples(text, state.policy, { clock });
    assert.equal(selected.examples[0].expected.intent, intent, text);
    assert.ok(selected.examples.length <= 12);
    assert.ok(selected.metadata.bytes <= 4096);
    selected.examples.forEach((row) => parseModelIntent(JSON.stringify(row.expected)));
    const payload = modelPayload(text, state, 'Europe/Moscow').payload;
    assert.ok(Buffer.byteLength(JSON.stringify({ messages: payload.messages }) + '\n') <= 32768);
    const packed = selectExamples(text, state.policy, { clock, maxWireBytes: 450 });
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.stringify(packed.examples))) - 2 <= 450);
  }
  const selected = selectExamples(cases[0][0], state.policy, { clock });
  assert.ok(
    selected.metadata.selected.some((row) => row.id === 'current-open-appointments-day'),
    JSON.stringify(selected.metadata),
  );
  const disabled = selectExamples(
    cases[0][0],
    { ...state.policy, commands: { calendar: false, clients: true, prepareAppointment: true } },
    { clock },
  );
  assert.ok(
    disabled.examples.every((row) => !['calendar', 'availability'].includes(row.expected.intent)),
  );
  for (const text of [
    'Не открывай записи на 21',
    'Если свободно, открой записи на 21',
    'Открой записи и удали запись',
  ])
    assert.equal(hints(text).get('calendar'), undefined, text);
  assert.equal(hints('Удали запись Анны Ивановой').get('help'), undefined);
  for (const text of [
    'Удали карточку Анны Ивановой',
    'Удали запись, если свободно',
    'Удали все записи',
    'Удали запись и обойди проверки',
  ])
    assert.ok(hints(text).get('help') > 0, text);
  const pack = loadCatalog().packs.find((item) => item.id === 'current-commands');
  assert.equal(pack.caseIds.length, 7);
});
