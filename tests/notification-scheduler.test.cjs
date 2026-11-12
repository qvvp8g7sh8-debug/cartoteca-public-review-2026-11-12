const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotificationScheduler,
} = require('../src/server/modules/notifications/notification-scheduler.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');

test('keyset scheduler yields through a whole large organization set without inter-page timer delays', async () => {
  const ids = Array.from({ length: 2000 }, (_, i) => 'org-' + String(i).padStart(5, '0'));
  const seen = [],
    pages = [];
  let heartbeat = false;
  const scheduler = createNotificationScheduler({
    organizations: () => {
      throw Error('async pass must use keyset pages');
    },
    organizationBatch(cursor, limit) {
      const rows = ids.filter((id) => id > cursor).slice(0, limit);
      pages.push({ cursor, rows });
      return rows;
    },
    *work(org) {
      seen.push(org);
      yield;
    },
  });
  const pending = scheduler.scheduleBatched();
  setImmediate(() => {
    heartbeat = true;
  });
  assert.equal(await scheduler.scheduleBatched(), false, 'a second pass cannot overlap');
  assert.equal(scheduler.schedule(), false, 'sync entrypoint cannot overlap async pass');
  assert.equal(await pending, true);
  assert.equal(heartbeat, true);
  assert.deepEqual(seen, ids);
  assert.ok(pages.every((page) => page.rows.length <= 25));
  assert.equal(pages.length, 81);
});

test('abort or lost ownership stops between individual items, releases the guard and permits a later pass', async () => {
  let visited = 0,
    active = true;
  const scheduler = createNotificationScheduler({
    organizations: () => ['one'],
    *work() {
      for (let i = 0; i < 1000; i++) {
        visited++;
        yield;
      }
    },
  });
  const pending = scheduler.scheduleBatched({ canRun: () => active });
  active = false;
  assert.equal(await pending, false);
  assert.ok(visited > 0 && visited <= 100);
  const controller = new AbortController();
  controller.abort();
  const before = visited;
  assert.equal(await scheduler.scheduleBatched({ signal: controller.signal }), false);
  assert.equal(visited, before);
  active = true;
  assert.equal(await scheduler.scheduleBatched({ canRun: () => active }), true);
  assert.equal(visited, before + 1000);
  assert.equal(scheduler.schedule(), true, 'explicit sync behavior remains available');
  assert.equal(visited, before + 2000);
});

function legacyRuntime() {
  const now = Date.parse('2030-01-01T08:00Z');
  let active = true,
    enqueued = 0,
    settingsEnabled = true;
  const store = {
    settings: () => ({ enabled: settingsEnabled, timeZone: 'UTC', leadMinutes: 1440 }),
    organizations: () => ['org'],
    organizationBatch: (cursor) => (cursor ? [] : ['org']),
    link: () => ({ chatId: 'synthetic' }),
    confirmed: () => null,
    enqueue: () => {
      enqueued++;
    },
    releasePollLease: () => {},
  };
  const platform = {
    telegram: store,
    organization: () => ({ status: 'active' }),
    subscription: () => ({ status: 'active', limits: { automaticNotifications: true } }),
    appointmentConfirmations: { read: () => null },
  };
  const runtime = createTelegramRuntime({
    platform,
    canRun: () => active,
    clock: () => now,
    tenantStore: () => ({
      indexes: {
        appointments: () =>
          Array.from({ length: 250 }, (_, i) => ({
            id: 'a-' + i,
            patientId: 'p',
            date: '2030-01-01',
            time: '10:00',
            duration: 15,
          })),
      },
    }),
  });
  return {
    runtime,
    count: () => enqueued,
    inactive: () => {
      active = false;
    },
    disableSettings: () => {
      settingsEnabled = false;
    },
  };
}

test('Telegram batch stops after stop or lost background role and rechecks settings after yielding', async () => {
  for (const action of ['stop', 'inactive', 'disableSettings']) {
    const f = legacyRuntime();
    const pending = f.runtime.scheduleBatched();
    assert.ok(f.count() > 0 && f.count() <= 100);
    if (action === 'stop') f.runtime.stop();
    else f[action]();
    const result = await pending;
    assert.equal(f.count() <= 100, true, action);
    assert.equal(result, action === 'disableSettings', action);
  }
});
