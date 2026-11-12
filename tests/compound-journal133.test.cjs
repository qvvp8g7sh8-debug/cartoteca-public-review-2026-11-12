const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createClientAppointmentEvents,
} = require('../src/server/modules/notifications/client-appointment-events.cjs');
const {
  createStaffEventReplay,
} = require('../src/server/modules/notifications/staff-event-replay.cjs');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');
const key = 'appointment-notification-events-v1';
function fixture(audience = 'client') {
  const state = {
    calls: [],
    jobs: [],
    committed: false,
    fail: false,
    nested: false,
    cabinet: false,
  };
  const entry = {
    id: 'durable-event',
    audience,
    kind: 'created',
    createdAt: 1000,
    expiresAt: 10000,
    patientId: 'patient',
    appointmentId: 'appointment',
    staffId: 'staff',
    sourceStamp: 'stamp',
    recipients:
      audience === 'client'
        ? { telegram: { chatId: '7', bindingId: '1', channelVersion: '' } }
        : { telegram: [{ accountId: 'staff', bindingId: 'binding' }] },
    channelVersions: { telegram: '' },
    reference: { patientId: 'patient', appointmentId: 'appointment' },
  };
  let rows = [entry];
  const storage = {
    db: { scope: { kind: 'cabinet', storeId: 'cabinet-synthetic' } },
    get: () => structuredClone(rows),
    set(_, next) {
      if (next.length < rows.length)
        assert.equal(state.committed, true, 'journal may retire only after outer commit');
      rows = structuredClone(next);
    },
    transaction(callback) {
      const old = state.cabinet;
      state.cabinet = true;
      try {
        return callback();
      } finally {
        state.cabinet = old;
      }
    },
  };
  const platform = {
    notificationChannels: { enabled: (c) => c === 'telegram', version: () => '' },
    telegram: {
      settings: () => ({ enabled: true, events: ['created'], timeZone: 'UTC' }),
      link: () => ({ chatId: '7', linkedAt: 1 }),
    },
    withCompoundMutation(callback, scope) {
      state.calls.push(scope);
      const count = state.jobs.length;
      const out = callback();
      if (state.fail) {
        state.jobs.length = count;
        throw Object.assign(Error('Synthetic uncertain commit'), { outcomeUnknown: true });
      }
      state.committed = true;
      return out;
    },
    withWriteLock() {
      throw Error('Generic writer must not be selected when the compound port exists.');
    },
  };
  const store = {
    inTransaction: () => state.nested,
    transaction(callback) {
      assert.equal(state.nested, false, 'an existing platform transaction must be reused');
      state.legacy = (state.legacy || 0) + 1;
      return callback();
    },
    enqueue(value) {
      assert.equal(state.cabinet, true);
      state.jobs.push(value);
    },
    hasAppointmentRecipients: () => true,
    organizationPage: () => ({ organizations: ['org'], cursor: '' }),
    enqueueAppointment(...args) {
      assert.equal(state.cabinet, true);
      state.jobs.push(args);
    },
  };
  platform.staffNotifications = store;
  const policy = {
    readyChannels: () => ['telegram'],
    current: () => ({
      stamp: 'stamp',
      channels: ['telegram'],
      recipients: { telegram: { chatId: '7' } },
    }),
  };
  return { state, storage, platform, store, policy, pending: () => rows };
}
test('client replay commits the organization queue before retiring its durable cabinet journal', () => {
  const f = fixture();
  const replay = createClientAppointmentEvents({
    ...f,
    tenantStore: () => f.storage,
    clock: () => 1000,
  });
  assert.equal(replay.replayOrganization('org'), 1);
  assert.equal(f.state.jobs.length, 1);
  assert.equal(f.pending().length, 0);
  assert.deepEqual(f.state.calls, [
    { operation: 'journal', organizationId: 'org', cabinetStoreId: 'cabinet-synthetic' },
  ]);
});
test('unknown compound commit is not replayed and leaves the client journal durable', () => {
  const f = fixture();
  f.state.fail = true;
  const replay = createClientAppointmentEvents({
    ...f,
    tenantStore: () => f.storage,
    clock: () => 1000,
  });
  assert.throws(
    () => replay.replayOrganization('org'),
    (e) => e.outcomeUnknown === true,
  );
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.pending().length, 1);
  assert.equal(f.state.jobs.length, 0);
});
test('staff replay selects scoped compound and retires only the confirmed queue projection', () => {
  const f = fixture('staff');
  const replay = createStaffEventReplay({ ...f, tenantStore: () => f.storage, clock: () => 1000 });
  replay(null, () => true);
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.calls[0].operation, 'journal');
  assert.equal(f.state.jobs.length, 1);
  assert.equal(f.pending().length, 0);
  assert.equal(replay.status().error, '');
  const failed = fixture('staff');
  failed.state.fail = true;
  const retry = createStaffEventReplay({
    ...failed,
    tenantStore: () => failed.storage,
    clock: () => 1000,
  });
  retry(null, () => true);
  assert.equal(failed.state.calls.length, 1);
  assert.equal(failed.pending().length, 1);
  assert.match(retry.status().error, /уведомлений/);
});
test('client confirmation opens one scoped compound, while an existing outer transaction keeps its owner', () => {
  const f = fixture();
  const worker = createNotificationWorker({
    ...f,
    tenantStore: () => f.storage,
    providers: {},
    clock: () => 1000,
  });
  let called = 0;
  assert.equal(
    worker.locked({ organization_id: 'org' }, () => {
      called++;
      assert.equal(f.state.cabinet, true);
      return 'confirmed';
    }),
    'confirmed',
  );
  assert.equal(called, 1);
  assert.equal(f.state.calls[0].operation, 'confirmation');
  assert.equal(f.state.legacy || 0, 0);
  f.state.nested = true;
  assert.equal(
    worker.locked({ organization_id: 'org' }, () => ++called),
    2,
  );
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.legacy || 0, 0);
});
