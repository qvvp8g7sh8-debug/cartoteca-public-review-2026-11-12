const test = require('node:test');
const assert = require('node:assert/strict');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const {
  createNotificationChannelState,
} = require('../src/server/modules/notifications/channel-state.cjs');
const {
  createNotificationStore,
} = require('../src/server/modules/notifications/notification-store.cjs');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');
const {
  createNotificationPolicy,
} = require('../src/server/modules/notifications/notification-policy.cjs');

test(
  'native idle queue hints reduce actual RPCs without caching cross-process queue/channel authority',
  { timeout: 120000 },
  async (t) => {
    let now = 1000;
    const f = await queueFixture(t),
      db = f.a.p,
      other = await f.open();
    const c = {
      db,
      seal: (value) => Buffer.from(JSON.stringify(value)),
      open: (value) => JSON.parse(Buffer.from(value).toString()),
      transaction: (work) => db.transaction(work),
      tokenHash: (value) => value,
      audit() {},
    };
    c.notificationChannels = createNotificationChannelState(c, {
      telegram: true,
      max: true,
      push: false,
    });
    const store = createNotificationStore(c),
      providers = Object.fromEntries(
        ['telegram', 'max'].map((channel) => [
          channel,
          { status: () => ({ configured: true, connected: true }) },
        ]),
      );
    const policy = createNotificationPolicy({
      platform: c,
      store,
      providers,
      tenantStore() {
        assert.fail('idle must not open a cabinet');
      },
      clock: () => now,
    });
    const make = (value) =>
      createNotificationWorker({
        platform: c,
        store: value,
        providers,
        policy,
        clock: () => now,
        tenantStore() {
          assert.fail('idle must not open a cabinet');
        },
      });
    // Missing capability preserves the exact old discovery/claim fallback, using
    // the same real PG channel state, recipient index and worker on both sides.
    const legacy = make({ ...store, hasPendingWork: undefined }),
      current = make(store);
    await legacy.tickManaged();
    await current.tickManaged();
    const measure = async (worker) => {
      const before = f.a.owner.stats().calls;
      for (let n = 0; n < 40; n++) await worker.tick();
      return f.a.owner.stats().calls - before;
    };
    const legacyRpcCalls = await measure(legacy),
      currentRpcCalls = await measure(current);
    assert.equal(currentRpcCalls, 40, 'one fresh cross-process head RPC for each original tick');
    assert.ok(legacyRpcCalls >= currentRpcCalls * 4);
    t.diagnostic(
      JSON.stringify({
        ticks: 40,
        legacyRpcCalls,
        currentRpcCalls,
        timerIntervalsChanged: false,
        permissionsCached: false,
      }),
    );
    const adaptive = make(store),
      beforeAdaptive = f.a.owner.stats().calls;
    for (let n = 0; n < 80; n++) {
      await adaptive.tickManaged();
      now += 250;
    }
    const adaptiveRpcCalls = f.a.owner.stats().calls - beforeAdaptive;
    assert.ok(adaptiveRpcCalls <= 18, 'two head/alarm RPCs per infrequent empty probe');
    t.diagnostic(
      JSON.stringify({
        ticks: 80,
        tickMilliseconds: 250,
        adaptiveRpcCalls,
        crossProcessFallbackMs: 5000,
      }),
    );
    adaptive.close();
    now = 1000;
    await t.test(
      'other owner inserts/future due/expired leases are visible on the very next head read',
      () => {
        const put = (id, status, due, lease) =>
          other.p
            .prepare(
              'INSERT INTO notification_channel_jobs(id,organization_id,patient_id,appointment_id,stamp,channel,callback_hash,value,status,next_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              id,
              f.organizations[0],
              'p',
              id,
              id,
              'telegram',
              id,
              c.seal({ callback: id }),
              status,
              due,
              10000,
              lease,
            );
        put('future', 'pending', 1100, 0);
        assert.equal(store.hasPendingWork(1000), false);
        assert.equal(store.nextPendingAt(1000), 1100);
        assert.equal(store.hasPendingWork(1100), true);
        assert.equal(store.hasPendingWork(1100, ['max']), false);
        other.p.prepare("UPDATE notification_channel_jobs SET status='sent'").run();
        put('expired-lease', 'reserved', 1000, 1200);
        assert.equal(store.hasPendingWork(1199), false);
        assert.equal(store.nextPendingAt(1100), 1200);
        assert.equal(store.hasPendingWork(1200), true);
      },
    );
    await t.test(
      'the positive hint cannot hide another process disabling and replacing the channel epoch',
      () => {
        const previous = c.notificationChannels.version('telegram');
        other.p.prepare('INSERT OR REPLACE INTO telegram_runtime(key,value) VALUES(?,?)').run(
          'notification-channel-state-v1',
          c.seal({
            telegram: { enabled: false, version: 'synthetic-revoked' },
            max: { enabled: true, version: '' },
            push: { enabled: false, version: '' },
          }),
        );
        assert.equal(store.hasPendingWork(1200), true);
        assert.equal(c.notificationChannels.enabled('telegram'), false);
        assert.notEqual(c.notificationChannels.version('telegram'), previous);
        assert.deepEqual(policy.readyChannels(), ['max']);
      },
    );
    await t.test(
      'actual enqueue activity is observed only after the synchronous outer commit/rollback',
      async () => {
        db.prepare('DELETE FROM notification_channel_jobs').run();
        const seen = [],
          unsubscribe = store.subscribePending(() => seen.push(store.hasPendingWork(now)));
        const enqueue = (id) =>
          store.enqueue(
            {
              org: f.organizations[0],
              patient: 'p',
              appointment: id,
              stamp: id,
              channel: 'telegram',
              recipient: { chatId: 'synthetic' },
              expiresAt: now + 10000,
            },
            now,
          );
        db.transaction(() => {
          enqueue('local-commit');
          assert.deepEqual(seen, []);
        });
        await new Promise(setImmediate);
        assert.deepEqual(seen, [true]);
        db.prepare('DELETE FROM notification_channel_jobs').run();
        assert.throws(
          () =>
            db.transaction(() => {
              enqueue('local-rollback');
              throw Error('Synthetic rollback');
            }),
          /Synthetic rollback/,
        );
        await new Promise(setImmediate);
        assert.deepEqual(seen, [true, false]);
        unsubscribe();
      },
    );
  },
);
