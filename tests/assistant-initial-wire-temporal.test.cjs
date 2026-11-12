const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseInitialModelResponse,
} = require('../src/server/modules/assistant/interpretation/initial-model-response.cjs');
const { parseModelIntent } = require('../src/server/modules/assistant/interpretation/intents.cjs');
const {
  modelOutputContract,
} = require('../src/server/modules/assistant/interpretation/model-output-contract.cjs');
const { intentEnvelope } = require('../src/server/modules/assistant/interpretation/intent-contract.cjs');
const { continuationSchema } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const { zonedClock } = require('../src/shared/time-zone.cjs');
const { shiftDate } = require('../src/server/modules/assistant/language/time/temporal.cjs');

test('only blank nullable temporal wire fields become null; the shared strict parser still rejects them', () => {
  for (const field of ['date', 'endDate', 'time', 'endTime', 'duration'])
    for (const blank of ['', ' ', '\t\r\n']) {
      const raw = JSON.stringify({ ...intentEnvelope({ intent: 'availability' }), [field]: blank });
      assert.throws(() => parseModelIntent(raw), { status: 502 });
      assert.deepEqual(parseInitialModelResponse(raw), { intent: 'availability' });
    }
});

test('wire compatibility never trims valid-looking content or coerces invalid values, identifiers, keys or intent', () => {
  const invalid = [
    { intent: '' },
    { intent: ' ' },
    { intent: 'save' },
    { intent: 'prepareAppointment', patientId: '' },
    { intent: 'prepareAppointment', unexpected: null },
    { intent: 'prepareAppointment', mode: '' },
    { intent: 'prepareAppointment', date: ' 2026-10-20 ' },
    { intent: 'prepareAppointment', date: '2026-02-31' },
    { intent: 'prepareAppointment', time: '13' },
    { intent: 'prepareAppointment', time: '25:00' },
    { intent: 'prepareAppointment', time: 0 },
    { intent: 'prepareAppointment', duration: '60' },
    { intent: 'prepareAppointment', duration: 0 },
    { intent: 'prepareAppointment', duration: 7 },
    { intent: 'prepareAppointment', time: '\u0000' },
    { intent: 'prepareAppointment', date: {} },
    null,
    [],
    true,
    1,
    'prepareAppointment',
  ];
  for (const value of invalid)
    assert.throws(() => parseInitialModelResponse(JSON.stringify(value)), { status: 502 });
  for (const raw of ['', 'not-json', '{"intent":"prepareAppointment"} trailing'])
    assert.throws(() => parseInitialModelResponse(raw), { status: 502 });
});

test('initial wire preserves the former overflow-number treatment while strict parsing rejects it', () => {
  const raw = '{"intent":"prepareAppointment","duration":1e400,"query":-1e400}';
  assert.deepEqual(parseInitialModelResponse(raw), { intent: 'prepareAppointment' });
  assert.throws(() => parseModelIntent(raw), { status: 502 });
  assert.throws(() => parseInitialModelResponse('{"intent":"help","unknown":1e400}'), {
    status: 502,
  });
});

test('normalization is attached only to initial provider output, never the continuation contract', () => {
  const initial = modelOutputContract({ response_format: { type: 'json_object' } });
  assert.deepEqual(initial.parseResponse('{"intent":"prepareAppointment","time":""}'), {
    intent: 'prepareAppointment',
  });
  const continuation = modelOutputContract({
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'cartoteca_continuation', strict: true, schema: continuationSchema },
    },
  });
  const value = {
    operation: 'patch',
    fields: { client: null, staff: null, service: null, date: null, time: '', duration: null },
    choice: null,
    field: null,
  };
  assert.throws(() => continuation.parseResponse(JSON.stringify(value)), { status: 502 });
});

test('captured malformed initial response reaches the actual service no-save form at thirteen with catalog duration', async (t) => {
  const f = await assistantBoundariesFixture(t),
    world = dialogueFixture(),
    c = f.context();
  const actor = c.current.accountId;
  world.patients[0].createdBy = actor;
  world.members[0].accountId = actor;
  world.services.splice(0, world.services.length, {
    id: 'almond',
    name: 'Миндальный пилинг',
    duration: 45,
    staffId: actor,
  });
  const date = shiftDate(zonedClock(new Date(), 'Europe/Moscow').date, 1);
  c.tenantStore = world.c.tenantStore;
  c.platform = {
    ...world.c.platform,
    workspaceSettings: () => require('../src/server/modules/workspace/policy.cjs').defaults(actor),
    workSchedules: {
      view: () => ({
        days: { [date]: { status: 'working', intervals: [['09:00', '18:00']] } },
        closures: {},
      }),
    },
  };
  const captured = intentEnvelope({
    intent: 'prepareAppointment',
    query: 'Анну Семёнову',
    serviceQuery: 'миндальный пилинг',
    date,
    time: '',
    duration: 60,
  });
  captured.time = ''; // Preserve the actual malformed wire value; author-example projection maps blanks to null.
  const bytes = JSON.stringify(captured);
  assert.throws(() => parseModelIntent(bytes), { status: 502 });
  f.hooks.llm = () => ({ text: bytes });
  const reply = await f.api.turn(c, {
    policyVersion: f.revision(),
    text: 'Запиши Анну Семёнову на завтра на час на миндальный пилинг.',
  });
  assert.equal(f.calls.llm, 1);
  assert.equal(reply.dialogue, null);
  assert.equal(reply.action.type, 'prepareAppointment');
  assert.equal(reply.action.patientId, world.patients[0].id);
  assert.equal(reply.action.staffId, actor);
  assert.equal(reply.action.date, date);
  assert.equal(reply.action.time, '13:00');
  assert.equal(reply.action.duration, 45);
  assert.deepEqual(reply.action.serviceIds, ['almond']);
  assert.equal(world.patients[0].appointments.length, 0);
});
