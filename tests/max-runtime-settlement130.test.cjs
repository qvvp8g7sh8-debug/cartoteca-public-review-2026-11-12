const test = require('node:test');
const assert = require('node:assert/strict');
const { createMaxRuntime } = require('../src/server/modules/notifications/max-runtime.cjs');
const {
  createStaffMaxRuntime,
} = require('../src/server/modules/notifications/staff-max-runtime.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');

test('a known MAX callback ACK stays done when its best-effort button ownership check throws', async (t) => {
  let acknowledged = false,
    answers = 0,
    edits = 0,
    postAckReads = 0;
  const row = {
    id: 'synthetic-callback-event',
    lease_id: 'synthetic-attempt',
    status: 'pending',
    decoded: {
      event: { callback: { user: { user_id: '456' } } },
      result: { callbackId: 'synthetic-callback', messageId: 'synthetic-message' },
    },
  };
  const transitions = [];
  const runtime = createMaxRuntime({
    inbox: {
      acquire: () => true,
      renew: () => true,
      release() {},
      isCurrent() {
        if (acknowledged) {
          postAckReads++;
          throw Object.assign(Error('Synthetic cleanup ownership uncertainty'), {
            outcomeUnknown: true,
          });
        }
        return true;
      },
      claim() {
        if (row.status !== 'pending') return null;
        row.status = 'processing';
        return row;
      },
      finish(candidate, status) {
        if (candidate.lease_id !== row.lease_id || row.status !== 'processing') return false;
        transitions.push(status);
        row.status = status;
        return true;
      },
    },
    events: {},
    identity: { botId: '123' },
    clock: () => 1000000,
    monotonicClock: () => 1000,
    pacing: { acquire: async () => true, pause() {} },
    bot: {
      async answer() {
        answers++;
        acknowledged = true;
      },
      async clearButtons() {
        edits++;
      },
    },
  });
  t.after(() => runtime.stop());
  await runtime.tick();
  assert.equal(postAckReads, 1, 'The error occurs after a known external ACK, inside cleanup');
  assert.equal(answers, 1);
  assert.equal(edits, 0);
  assert.equal(row.status, 'done');
  assert.deepEqual(
    transitions,
    ['done'],
    'Cleanup uncertainty cannot demote a known ACK to pending',
  );
  await runtime.tick();
  assert.equal(answers, 1, 'A blocked authority cannot replay the already acknowledged callback');
});

for (const managed of [false, true]) {
  for (const stage of ['validation', 'prepare']) {
    test(`MAX staff ${managed ? 'managed' : 'one-shot'} ${stage} ownership denial refunds an unsent attempt`, async (t) => {
      const f = await staffMaxFixture(t);
      f.connect(f.users[2], 2);
      f.create();
      const store = f.platform.staffMaxNotifications;
      let authorized = true,
        sends = 0,
        claims = 0,
        pacingReleases = 0;
      const claim = (...args) => {
        const job = (managed && store.claimManaged ? store.claimManaged : store.claim)(...args);
        if (job) {
          claims++;
          if (stage === 'validation') authorized = false;
        }
        return job;
      };
      const runtime = createStaffMaxRuntime({
        platform: f.platform,
        store: { ...store, claim, claimManaged: claim },
        identity: f.identity,
        clock: f.clock,
        bot: { send: async () => sends++ },
        pacing: {
          acquire: async () => {
            if (stage === 'prepare') authorized = false;
            return true;
          },
          releaseDelivery: () => pacingReleases++,
        },
        runBackgroundWork: async (callback) => callback(),
      });
      await (managed ? runtime.tickManaged : runtime.tick)(
        undefined,
        () => true,
        5,
        () => authorized,
      );
      assert.equal(claims, 1);
      assert.equal(sends, 0);
      assert.equal(pacingReleases, stage === 'prepare' ? 1 : 0);
      const saved = f.jobs()[0];
      assert.equal(saved.status, 'pending', 'No provider POST began, so its outcome remains known');
      assert.equal(saved.attempts, 0);
      assert.equal(saved.lease_id, null);
      assert.equal(saved.lease_until, 0);
      f.advance(120001);
      const retried = store.claim(f.clock());
      assert.equal(
        retried.id,
        saved.id,
        'An unsent attempt remains retryable instead of becoming uncertain',
      );
      assert.equal(f.jobs()[0].status, 'sending');
    });
  }
}

test('queued MAX replay cancellation stays pure and denied ownership cannot open a cabinet', async () => {
  let ownership = true,
    channelReads = 0,
    cabinetReads = 0,
    scopedCallbacks = 0;
  const runtime = createStaffMaxRuntime({
    platform: {
      notificationChannels: {
        enabled: () => {
          channelReads++;
          return true;
        },
      },
      withWriteLock: () => assert.fail('Denied replay must not enter a business transaction'),
    },
    tenantStore: () => {
      cabinetReads++;
      assert.fail('Denied replay must not open clinical storage');
    },
    store: {
      organizationPage: () => ({ cursor: '', organizations: ['synthetic-organization'] }),
      hasPendingWork: () => false,
    },
    bot: { send: async () => assert.fail('Replay-only fixture must not send') },
    identity: { botId: '123' },
    clock: () => 1000000,
    pacing: { acquire: async () => true },
    runBackgroundWork: async (callback, organizationId, canRun) => {
      const before = channelReads;
      for (let i = 0; i < 1000; i++) assert.equal(canRun(), true);
      assert.equal(channelReads, before, 'Dispatcher cancellation cannot query channel state');
      if (organizationId) {
        scopedCallbacks++;
        ownership = false;
      }
      return callback();
    },
  });
  await runtime.tickManaged(
    undefined,
    () => true,
    5,
    () => ownership,
  );
  assert.equal(scopedCallbacks, 1);
  assert.equal(
    cabinetReads,
    0,
    'Actual replay callback must freshly check ownership after waiting',
  );
});
