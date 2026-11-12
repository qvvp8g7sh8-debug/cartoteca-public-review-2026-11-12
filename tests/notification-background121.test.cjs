const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');
const turn = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture({ invalidateOnPrepare = false } = {}) {
  let active = true,
    valid = true,
    inCallback = false,
    callbacks = 0,
    sends = 0,
    acquisitions = 0,
    releases = 0;
  const scopes = [],
    entered = deferred(),
    settlement = deferred();
  const job = {
    id: 'job',
    organization_id: 'own-org',
    patient_id: 'patient',
    status: 'pending',
    lease_until: 200000,
    decoded: {
      channel: 'telegram',
      kind: 'reminder',
      recipient: { chatId: 'synthetic' },
      callback: 'synthetic',
    },
  };
  const context = {
    a: { date: '2099-01-01', time: '10:00', duration: 30, staffId: 'staff' },
    settings: { showServices: false },
  };
  const worker = createNotificationWorker({
    platform: {
      telegram: {
        link: () => null,
        messageIdentity: () => ({ organization: { name: 'Synthetic' } }),
      },
      organization: () => ({ phone: '' }),
    },
    tenantStore: () => ({
      transaction: (work) => {
        assert.equal(inCallback, true);
        return work();
      },
    }),
    store: {
      transaction: (work) => work(),
      claim: () => assert.fail('managed worker must use its bounded claim'),
      claimManaged: () => {
        assert.equal(inCallback, true);
        if (job.status !== 'pending') return null;
        job.status = 'reserved';
        return job;
      },
      transition: (_job, from, status) => {
        if (job.status !== from) return false;
        job.status = status;
        return true;
      },
    },
    policy: { readyChannels: () => ['telegram'], valid: () => (valid ? context : null) },
    providers: {
      telegram: {
        status: () => ({ configured: true, connected: true }),
        acquire: async () => {
          acquisitions++;
          return true;
        },
        release: () => {
          releases++;
        },
        send: () => {
          assert.equal(
            inCallback,
            true,
            'fresh checks and external start share the admitted callback',
          );
          sends++;
          entered.resolve();
          return settlement.promise;
        },
      },
    },
    clock: () => 100000,
    async runBackgroundWork(callback, org) {
      scopes.push(org);
      await turn();
      // Discovery has its own admission now. Revoke at the semantic boundary:
      // the job's preparation is queued after validation and provider pacing.
      if (
        invalidateOnPrepare &&
        org === job.organization_id &&
        job.status === 'reserved' &&
        acquisitions > 0
      )
        valid = false;
      callbacks++;
      inCallback = true;
      try {
        return callback();
      } finally {
        inCallback = false;
      }
    },
  });
  return {
    worker,
    job,
    entered,
    settlement,
    scopes,
    active: () => active,
    stop: () => {
      active = false;
    },
    stats: () => ({ callbacks, sends, acquisitions, releases, inCallback }),
  };
}

test(
  'managed validation and external start are admitted; known provider ACK commits without another queued permit',
  { timeout: 3000 },
  async (t) => {
    const f = fixture();
    t.after(() => f.settlement.resolve({}));
    const running = f.worker.tickManaged(undefined, f.active);
    await f.entered.promise;
    const callbacksAtSend = f.stats().callbacks;
    assert.equal(f.stats().acquisitions, 1);
    assert.deepEqual(
      f.scopes.slice(-2),
      ['own-org', 'own-org'],
      'validation and send preparation retain the owning organization',
    );
    assert.equal(f.job.status, 'sending');
    assert.equal(f.stats().inCallback, false, 'provider wait does not hold a callback permit');
    assert.equal(f.stats().releases, 0, 'actual provider slot remains held');
    f.stop();
    f.settlement.resolve({ message_id: 1 });
    await running;
    assert.equal(f.job.status, 'sent');
    assert.equal(
      f.stats().callbacks,
      callbacksAtSend,
      'ACK commit is not deferred behind another queue admission',
    );
    assert.equal(f.stats().releases, 1);
    assert.ok(f.scopes.includes('own-org'));
  },
);

test(
  'access changed while the send-preparation callback is queued cancels before any external send',
  { timeout: 3000 },
  async () => {
    const f = fixture({ invalidateOnPrepare: true });
    await f.worker.tickManaged(undefined, f.active);
    assert.equal(f.stats().sends, 0);
    assert.equal(
      f.stats().acquisitions,
      1,
      'revocation happens after pacing, while preparation is queued',
    );
    assert.equal(f.job.status, 'cancelled');
    assert.equal(f.stats().releases, 1);
  },
);

for (const channel of ['telegram', 'max'])
  for (const reclaimed of [false, true])
    test(
      `${channel} known ACK survives abort but cannot overwrite a newer durable lease, reclaimed=${reclaimed}`,
      { timeout: 30000 },
      async (t) => {
        const { maintenanceFixture } = require('./helpers/notification-maintenance-fixture.cjs');
        const { createStaffQueue } = require('../src/server/modules/notifications/staff-queue.cjs');
        const {
          createStaffTelegramRuntime,
        } = require('../src/server/modules/notifications/staff-runtime.cjs');
        const {
          createStaffMaxRuntime,
        } = require('../src/server/modules/notifications/staff-max-runtime.cjs');
        // Account creation/login keeps the real password KDF. Its setup is not
        // the provider-ACK deadline: that boundary remains strictly three seconds.
        const f = await maintenanceFixture(t, { enabled: false, prepared: false });
        await t.test(
          'provider ACK and durable lease CAS within three seconds',
          { timeout: 3000 },
          async (ack) => {
            const table = f.staff(channel, 'known-ack');
            f.c.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(
              f.c.seal({
                kind: 'test',
                event: 'test',
                chatId: channel === 'max' ? '123:456' : '456',
              }),
              'known-ack',
            );
            const queue = createStaffQueue(
              f.c,
              { interest: { hasEnabledRecipients: () => true } },
              channel,
            );
            const controller = new AbortController(),
              entered = deferred(),
              settled = deferred();
            ack.after(() => settled.resolve({}));
            const store = {
              hasPendingWork: () => true,
              claimManaged: queue.claimManaged,
              valid: () => ({}),
              finish: queue.finish,
            };
            const options = {
              platform: { staffNotifications: store, organization: () => ({ name: 'Synthetic' }) },
              store,
              identity: { botId: '123' },
              bot: {
                send: () => {
                  entered.resolve();
                  return settled.promise;
                },
              },
              pacing: { acquire: async () => true },
              clock: f.clock,
              runBackgroundWork: async (callback) => {
                await turn();
                return callback();
              },
            };
            const runtime =
              channel === 'max'
                ? createStaffMaxRuntime(options)
                : createStaffTelegramRuntime(options);
            const running = runtime.tickManaged(controller.signal, () => true, 1);
            await entered.promise;
            controller.abort();
            if (reclaimed)
              f.c.db
                .prepare(
                  `UPDATE ${table} SET lease_id='new-attempt',lease_until=lease_until+120000 WHERE id='known-ack'`,
                )
                .run();
            settled.resolve({});
            await running;
            const saved = f.c.db
              .prepare(`SELECT status,lease_id FROM ${table} WHERE id='known-ack'`)
              .get();
            assert.equal(saved.status, reclaimed ? 'sending' : 'sent');
            assert.equal(saved.lease_id, reclaimed ? 'new-attempt' : null);
          },
        );
      },
    );

test(
  'a database error after a known client ACK cannot become an explicit provider retry',
  { timeout: 3000 },
  async (t) => {
    // The actual ACK-vs-transport boundary is tested with a separately constructed
    // minimal store; no transport error is injected and no unknown is called sent.
    let status = 'pending',
      retries = 0;
    const worker = createNotificationWorker({
      platform: {
        telegram: {
          link: () => null,
          messageIdentity: () => ({ organization: { name: 'Synthetic' } }),
        },
        organization: () => ({ phone: '' }),
      },
      tenantStore: () => ({ transaction: (work) => work() }),
      store: {
        transaction: (work) => work(),
        claimManaged: () => {
          if (status !== 'pending') return null;
          status = 'reserved';
          return {
            id: 'job',
            organization_id: 'org',
            patient_id: 'patient',
            lease_until: 200000,
            decoded: { channel: 'telegram', recipient: {}, kind: 'reminder' },
          };
        },
        transition(_job, from, next) {
          if (next === 'sent') throw Error('synthetic settlement I/O failure');
          if (next === 'pending' || next === 'uncertain') retries++;
          if (status !== from) return false;
          status = next;
          return true;
        },
      },
      policy: {
        readyChannels: () => ['telegram'],
        valid: () => ({
          a: { date: '2099-01-01', time: '10:00', duration: 30 },
          settings: { showServices: false },
        }),
      },
      providers: { telegram: { acquire: async () => true, send: async () => ({ message_id: 1 }) } },
      clock: () => 100000,
    });
    await assert.rejects(worker.tickManaged(), /settlement I\/O/);
    assert.equal(status, 'sending');
    assert.equal(retries, 0, 'a success-settlement failure is not a provider failure');
  },
);
