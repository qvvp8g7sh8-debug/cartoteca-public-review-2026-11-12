const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramPacing } = require('../src/server/modules/notifications/telegram-pacing.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');

test('outgoing messages share 10/s pacing and each chat waits a second', async () => {
  let now = 0;
  const pacing = createTelegramPacing({
    clock: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  const times = [];
  for (let i = 0; i < 1000; i++) {
    await pacing.acquire(String(i));
    times.push(now);
  }
  assert.equal(times[999], 99900);
  for (let i = 10; i < times.length; i++) assert.ok(times[i] - times[i - 10] >= 1000);
  await pacing.acquire('999');
  assert.equal(now, 100900);
});

test('provider cooldown covers other chats, bounded waits defer and abort stops waiting', async () => {
  let now = 0;
  const pacing = createTelegramPacing({
    clock: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  pacing.pause(7);
  assert.equal(await pacing.acquire('a', undefined, 1000), false);
  assert.equal(now, 0);
  assert.equal(await pacing.acquire('b'), true);
  assert.equal(now, 7000);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pacing.acquire('b', controller.signal), { name: 'AbortError' });
});
test('adapter preserves long Telegram retry_after instead of retrying early', async () => {
  const {
    configuredTelegram,
  } = require('../src/server/modules/notifications/telegram-adapter.cjs');
  const bot = configuredTelegram({
    token: '123456:' + 'x'.repeat(35),
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 7200 } }),
    }),
  });
  await assert.rejects(
    bot.send('synthetic', 'test'),
    (error) => error.status === 429 && error.retryAfter === 7200,
  );
});

function fixture({ failure, beforeSend, deferFailure, finishFailure } = {}) {
  let wall = 0,
    domain = Date.parse('2030-01-01T00:00:00Z');
  const appointments = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    date: '2030-01-01',
    time: '12:00',
    duration: 15,
  }));
  const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
  const jobs = appointments.map((a, i) => ({
    id: i,
    organization_id: 'o',
    patient_id: String(i),
    fingerprint: fingerprint(a, 'Europe/Moscow'),
    attempts: 1,
    decoded: { appointmentId: a.id, chatId: String(i), callback: 'synthetic' },
  }));
  const sent = [],
    finished = [],
    deferred = [],
    attempted = [];
  const store = {
    organizations: () => [],
    claim: () => jobs.shift(),
    finish(job, state) {
      finished.push([job.id, state]);
      finishFailure?.(job);
    },
    defer(job, next) {
      deferred.push([job.id, next]);
      deferFailure?.(job);
    },
    link: (org, id) => ({ chatId: id, servicesConsent: false }),
    settings: () => ({ enabled: true, showServices: false, timeZone: 'Europe/Moscow' }),
    confirmed: () => null,
    messageIdentity: () => ({ organizationName: 'Synthetic' }),
  };
  const pacing = createTelegramPacing({
    clock: () => wall,
    wait: async (ms) => {
      wall += ms;
      domain += ms;
      beforeSend?.(appointments);
    },
  });
  const platform = {
    telegram: store,
    organization: () => ({ status: 'active' }),
    subscription: () => ({ status: 'active', limits: { automaticNotifications: true } }),
    appointmentConfirmations: { read: () => null },
  };
  const bot = {
    initialize: async () => ({ username: 'Synthetic_bot' }),
    send: async (chat) => {
      attempted.push(chat);
      if (failure) throw failure;
      sent.push([chat, wall]);
    },
  };
  const runtime = createTelegramRuntime({
    platform,
    tenantStore: () => ({
      readSelected: ([id]) => ({ patients: [{ appointments: [appointments[Number(id)]] }] }),
    }),
    bot,
    clock: () => domain,
    pacing,
  });
  return { runtime, sent, finished, deferred, jobs, attempted, pacing };
}

test('queue drains beyond old 10 job batch at a controlled rate without duplicate sends', async () => {
  const f = fixture();
  await f.runtime.initialize();
  await Promise.all([f.runtime.tick(), f.runtime.tick()]);
  assert.equal(f.sent.length, 40);
  await f.runtime.tick();
  await f.runtime.tick();
  assert.equal(f.sent.length, 100);
  assert.equal(new Set(f.sent.map(([chat]) => chat)).size, 100);
  assert.equal(f.sent.at(-1)[1], 9900);
  assert.ok(f.finished.every(([, state]) => state === 'sent'));
});

test('429 defers without consuming attempts and prevents other sends during cooldown', async () => {
  const f = fixture({
    failure: Object.assign(Error('Synthetic'), { status: 429, retryAfter: 60 }),
  });
  await f.runtime.initialize();
  await f.runtime.tick();
  assert.equal(f.deferred.length, 1);
  assert.equal(f.attempted.length, 1);
  assert.equal(f.finished.length, 0);
  await f.runtime.tick();
  assert.equal(f.deferred.length, 2);
  assert.deepEqual(
    f.deferred.map(([id]) => id),
    [0, 1],
  );
  assert.equal(f.attempted.length, 1, 'Cooldown must prevent a second provider call');
  assert.equal(f.finished.length, 0);
});

test('appointment cancelled while pacing is waiting is not delivered', async () => {
  const f = fixture({
    beforeSend: (appointments) => {
      appointments[1].status = 'cancelled';
    },
  });
  await f.runtime.initialize();
  await f.runtime.tick();
  assert.ok(!f.sent.some(([chat]) => chat === '1'));
  assert.ok(f.finished.some(([id, status]) => id === 1 && status === 'cancelled'));
  assert.ok(!f.deferred.some(([id]) => id === 1), 'A cancelled lease must not be deferred again');
});
test('a failed explicit cooldown settlement is not retried by unsent cleanup', async () => {
  const f = fixture({
    failure: Object.assign(Error('Synthetic rate limit'), { status: 429, retryAfter: 60 }),
    deferFailure: (job) => {
      if (job.id === 1) throw Error('Synthetic defer write outcome unknown');
    },
  });
  await f.runtime.initialize();
  await f.runtime.tick();
  await assert.rejects(f.runtime.tick(), /Synthetic defer write outcome unknown/);
  assert.deepEqual(
    f.deferred.map(([id]) => id),
    [0, 1],
  );
  assert.equal(f.attempted.length, 1);
  assert.equal(f.finished.length, 0);
});
test('a failed explicit cancellation does not turn its lease into a pending retry', async () => {
  const f = fixture({
    beforeSend: (appointments) => {
      appointments[1].status = 'cancelled';
    },
    finishFailure: (job) => {
      if (job.id === 1) throw Error('Synthetic cancellation write outcome unknown');
    },
  });
  await f.runtime.initialize();
  await assert.rejects(f.runtime.tick(), /Synthetic cancellation write outcome unknown/);
  assert.deepEqual(f.attempted, ['0']);
  assert.deepEqual(f.finished, [
    [0, 'sent'],
    [1, 'cancelled'],
  ]);
  assert.deepEqual(f.deferred, []);
});
test('stopping during pacing returns the known unsent lease once and releases its provider slot', async () => {
  const f = fixture({ beforeSend: () => f.runtime.stop() });
  await f.runtime.initialize();
  await f.runtime.tick();
  assert.deepEqual(f.attempted, ['0']);
  assert.deepEqual(f.finished, [[0, 'sent']]);
  assert.deepEqual(
    f.deferred.map(([id]) => id),
    [1],
  );
  assert.equal(
    await f.pacing.acquireDelivery('1', undefined, 1000),
    true,
    'Stopped pre-send work must release chat ownership',
  );
  f.pacing.releaseDelivery('1');
});
