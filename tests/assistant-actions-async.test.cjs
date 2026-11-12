const test = require('node:test');
const assert = require('node:assert/strict');
const {
  appointmentContext,
} = require('../src/server/modules/assistant/actions/availability-context.cjs');
const {
  findAvailability,
  verifyAvailability,
} = require('../src/server/modules/assistant/actions/availability.cjs');
const {
  managementClientContext,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-scope.cjs');
const {
  managementSource,
  sourceIdentity,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-references.cjs');
const {
  cancellationConfirmation,
  confirmCancellation,
} = require('../src/server/modules/assistant/actions/appointments/appointment-cancellation-snapshot.cjs');
const {
  refreshManagementReceipt,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-replay.cjs');
const DATE = '2099-01-02';
const NOW = Date.parse('2099-01-01T00:00:00Z');
const TIMEZONE = 'Europe/Moscow';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  let allowed = true,
    revision = 1;
  const members = [
    { accountId: 'owner', role: 'owner', status: 'active', displayName: 'Специалист' },
    { accountId: 'other', role: 'cosmetologist', status: 'active', displayName: 'Другой' },
  ];
  const services = [{ id: 'service', name: 'Услуга', duration: 30, staffId: 'owner' }];
  const appointment = {
    id: 'appointment',
    date: DATE,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    status: 'scheduled',
  };
  const patients = [
    { id: 'patient', firstName: 'Тест', lastName: 'Первый', appointments: [appointment] },
  ];
  const schedule = {
    days: { [DATE]: { status: 'working', intervals: [['09:00', '18:00']] } },
    closures: {},
  };
  const settings = { enabled: false, rooms: [] };
  const storage = {
    filename: 'synthetic-async-only',
    encode: JSON.stringify,
    decode: JSON.parse,
    get: () => revision,
    readServices: () => services,
    readSelected: (ids) => ({
      patients: patients.filter((row) => ids.includes(row.id)),
      services,
      revision,
    }),
    indexes: {
      appointments: () => [appointment],
      summaryRows: (current, ids) =>
        patients
          .filter((row) => !ids || ids.includes(row.id))
          .map((row) => ({ patient_id: row.id, value: JSON.stringify(row) })),
    },
  };
  const c = {
    current: { organizationId: 'org', accountId: 'owner', role: 'owner', sessionId: 'session' },
    token: 'synthetic',
    assertCurrent() {
      if (!allowed) throw Object.assign(Error('revoked'), { status: 403 });
    },
    tenantStore(org) {
      assert.equal(org, 'org');
      return storage;
    },
    platform: {
      workspaceMembers: () => members,
      organizationTimeZone: () => TIMEZONE,
      workspaceSettings: () => settings,
      workSchedules: { view: () => schedule },
      bookingRequests: { reserves: () => [] },
      personalEvents: { occupancy: () => [] },
    },
  };
  const invoke = async (value) => {
    await tick();
    c.assertCurrent();
    return value;
  };
  const assistantReads = {
    appointmentContext: () => invoke({ members, services }),
    timeZone: () => invoke(TIMEZONE),
    revision: () => invoke(revision),
    selected: (ids) =>
      invoke({ patients: patients.filter((row) => ids.includes(row.id)), services, revision }),
    availability: ({ staffIds, from, to }) => {
      assert.equal(from, DATE);
      assert.equal(to, DATE);
      return invoke({
        appointments: [appointment],
        personalEvents: [],
        reserves: [],
        settings,
        schedules: new Map(staffIds.map((id) => [id, schedule])),
        timeZone: TIMEZONE,
      });
    },
    directory: async (query, limit, { predicate } = {}) => {
      const rows = await invoke(patients);
      const eligible = predicate ? rows.filter(predicate) : rows;
      return { directory: eligible.slice(0, limit), matched: eligible.length };
    },
    summaries: async (ids, { predicate } = {}) => {
      const rows = await invoke(patients.filter((row) => ids.includes(row.id)));
      return predicate ? rows.filter(predicate) : rows;
    },
  };
  const forbidden = () => {
    throw Error('Synchronous data read in async path');
  };
  const asyncContext = {
    ...c,
    assistantReads,
    platform: new Proxy({}, { get: () => forbidden }),
    tenantStore(org) {
      assert.equal(org, 'org');
      return {
        ...storage,
        get: forbidden,
        readServices: forbidden,
        readSelected: forbidden,
        indexes: { appointments: forbidden, summaryRows: forbidden },
      };
    },
  };
  return {
    c,
    asyncContext,
    patients,
    appointment,
    assistantReads,
    revoke: () => {
      allowed = false;
    },
    changeRevision: () => {
      revision++;
    },
  };
}

test('async context, availability and exact slot retain the same domain result without sync reads', async () => {
  const f = fixture(),
    values = { from: DATE, to: DATE, duration: 30, staffIds: ['owner'], serviceIds: ['service'] };
  const expectedContext = appointmentContext(f.c),
    expected = findAvailability(f.c, values, NOW);
  assert.equal(expected.then, undefined, 'legacy fixture remains synchronous');
  assert.deepEqual(await appointmentContext(f.asyncContext), expectedContext);
  const pending = findAvailability(f.asyncContext, values, NOW);
  assert.equal(typeof pending.then, 'function');
  let progressed = false;
  setImmediate(() => {
    progressed = true;
  });
  assert.deepEqual(await pending, expected);
  assert.equal(progressed, true);
  const exact = {
    date: DATE,
    time: '09:00',
    duration: 30,
    staffId: 'owner',
    serviceIds: ['service'],
  };
  assert.deepEqual(
    await verifyAvailability(f.asyncContext, exact, NOW),
    verifyAvailability(f.c, exact, NOW),
  );
});

test('permission revoked while an async availability read is pending rejects the action', async () => {
  const f = fixture();
  const pending = findAvailability(
    f.asyncContext,
    { from: DATE, duration: 30, staffIds: ['owner'] },
    NOW,
  );
  f.revoke();
  await assert.rejects(pending, (error) => error.status === 403);
});

test('async management sources and filtered directory preserve future-only eligibility and source stamp', async () => {
  const f = fixture();
  f.patients.push(
    { id: 'empty', appointments: [] },
    { id: 'past', appointments: [{ ...f.appointment, date: '2000-01-01' }] },
  );
  const scoped = await managementClientContext(f.asyncContext);
  assert.deepEqual(
    (await scoped.assistantReads.directory('', 12)).directory.map((row) => row.id),
    ['patient'],
  );
  assert.deepEqual(
    (await scoped.assistantReads.summaries(['patient', 'empty', 'past'])).map((row) => row.id),
    ['patient'],
  );
  const identity = sourceIdentity('patient', f.appointment);
  assert.deepEqual(
    await managementSource(f.asyncContext, identity, NOW),
    managementSource(f.c, identity, NOW),
  );
  f.appointment.time = '11:00';
  await assert.rejects(
    managementSource(f.asyncContext, identity, NOW),
    (error) => error.status === 409,
  );
});

test('async cancellation confirmation reads revision before rendering and rejects stale consent', async () => {
  const f = fixture(),
    identity = sourceIdentity('patient', f.appointment);
  const source = await managementSource(f.asyncContext, identity, NOW);
  const entry = {
    id: 'dialogue',
    version: 1,
    expiresAt: '2099-01-02',
    data: { patient: { label: 'Тест' }, management: { operation: 'cancel', source: identity } },
  };
  const reply = await cancellationConfirmation(f.asyncContext, entry, source, {
    date: '2099-01-01',
  });
  assert.equal(reply.dialogue.phase, 'cancelConfirmation');
  assert.equal(entry.data.management.cancelConfirmation.binding.revision, 1);
  const choice = [...entry.options.values()][0];
  f.changeRevision();
  await assert.rejects(
    confirmCancellation(f.asyncContext, entry, choice),
    (error) => error.code === 'ASSISTANT_CANCEL_CONFIRMATION_STALE',
  );
  assert.equal(entry.data.management.cancelConfirmed, undefined);
});

test('async replay refresh awaits its callback before comparing receipts or mutating entry', async () => {
  const entry = {
    id: 'dialogue',
    version: 2,
    data: { management: {} },
    options: new Map(),
    controls: new Map(),
    response: { text: 'old', action: null, dialogue: null },
  };
  const reply = await refreshManagementReceipt({}, entry, {}, async (c, fresh) => {
    await tick();
    fresh.data.management.targetDate = DATE;
    return { text: 'fresh', action: null, dialogue: null };
  });
  assert.equal(reply.text, 'fresh');
  assert.equal(entry.response, reply);
  assert.equal(entry.version, 3);
  assert.equal(entry.data.management.targetDate, DATE);
});
