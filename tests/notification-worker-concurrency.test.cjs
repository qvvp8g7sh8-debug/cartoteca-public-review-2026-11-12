const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createNotificationWorker,
} = require('../src/server/modules/notifications/notification-worker.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');
const { createMaxRuntime } = require('../src/server/modules/notifications/max-runtime.cjs');
const { createTelegramPacing } = require('../src/server/modules/notifications/telegram-pacing.cjs');
const turn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

// A deterministic in-memory queue/provider boundary. No timers, network or data files.
function fixture(channels = ['telegram', 'max'], count = 2) {
  const now = 1000000;
  const jobs = channels.flatMap((channel) =>
    Array.from({ length: count }, (_, index) => ({
      id: channel + index,
      organization_id: 'synthetic-org',
      patient_id: 'synthetic-client',
      appointment_id: 'synthetic-appointment',
      status: 'pending',
      next_at: now,
      lease_until: now + 120000,
      decoded: {
        channel,
        kind: 'reminder',
        callback: channel + index,
        recipient:
          channel === 'telegram' ? { chatId: 'synthetic' } : { botId: 'bot', userId: 'synthetic' },
      },
    })),
  );
  const claims = [],
    transitions = [],
    sends = [],
    paused = [];
  const connected = new Set(channels);
  let valid = () => true;
  const store = {
    transaction: (work) => work(),
    hasNotificationRecipients: (ready) => ready.some((channel) => connected.has(channel)),
    claim: (_time, ready) => {
      const job = jobs.find(
        (row) =>
          row.status === 'pending' && row.next_at <= now && ready.includes(row.decoded.channel),
      );
      if (!job) return null;
      job.status = 'reserved';
      claims.push(job.id);
      return job;
    },
    transition: (job, from, status, nextAt = 0) => {
      if (job.status !== from) return false;
      transitions.push({ id: job.id, from, status });
      job.status = status;
      job.next_at = nextAt;
      return true;
    },
  };
  const current = {
    a: { date: '2099-01-01', time: '10:00', duration: 60, staffId: 'synthetic-staff' },
    settings: { showServices: false },
  };
  const providers = Object.fromEntries(
    channels.map((channel) => [
      channel,
      {
        status: () => ({ configured: true, connected: connected.has(channel) }),
        acquire: async () => true,
        pause: (delay) => paused.push({ channel, delay }),
        send: async (value) => {
          sends.push({ channel, token: value.confirmationToken });
          return { message_id: 1, mid: 'synthetic' };
        },
      },
    ]),
  );
  const worker = createNotificationWorker({
    platform: {
      telegram: {
        link: () => null,
        messageIdentity: () => ({ organization: { name: 'Synthetic' } }),
      },
      organization: () => ({ phone: '' }),
    },
    tenantStore: () => ({ transaction: (work) => work() }),
    store,
    providers,
    policy: {
      readyChannels: () => [...connected],
      valid: (job) => (valid(job) ? current : null),
    },
    clock: () => now,
  });
  return {
    worker,
    jobs,
    claims,
    transitions,
    sends,
    providers,
    paused,
    connected,
    now,
    validity: (check) => {
      valid = check;
    },
  };
}

for (const blocked of ['telegram', 'max']) {
  test(
    `a slow ${blocked} send does not block its sibling; same-channel sends stay ordered`,
    { timeout: 2000 },
    async (t) => {
      const f = fixture(),
        release = deferred(),
        entered = deferred(),
        siblingDone = deferred();
      const sibling = blocked === 'telegram' ? 'max' : 'telegram';
      const started = [],
        finished = [];
      t.after(() => release.resolve());
      for (const channel of ['telegram', 'max']) {
        f.providers[channel].send = async ({ confirmationToken: token }) => {
          started.push(token);
          if (token === blocked + '0') {
            entered.resolve();
            await release.promise;
          }
          finished.push(token);
          if (token === sibling + '1') siblingDone.resolve();
          return {};
        };
      }
      const running = f.worker.tick();
      await entered.promise;
      await siblingDone.promise;
      assert.deepEqual(
        started.filter((token) => token.startsWith(blocked)),
        [blocked + '0'],
      );
      assert.deepEqual(
        finished.filter((token) => token.startsWith(sibling)),
        [sibling + '0', sibling + '1'],
      );
      const claims = f.claims.length;
      await f.worker.tick();
      assert.equal(f.claims.length, claims, 'overlapping tick cannot acquire more work');
      release.resolve();
      await running;
      assert.deepEqual(
        finished.filter((token) => token.startsWith(blocked)),
        [blocked + '0', blocked + '1'],
      );
      assert.ok(f.jobs.every((job) => job.status === 'sent'));
    },
  );
}

test('a tick has a fair total claim budget and a single ready channel can use all 40', async () => {
  const both = fixture(['telegram', 'max'], 45);
  await both.worker.tick();
  assert.equal(both.claims.length, 40);
  for (const channel of ['telegram', 'max'])
    assert.equal(both.sends.filter((value) => value.channel === channel).length, 20);
  const single = fixture(['telegram'], 45);
  await single.worker.tick();
  assert.equal(single.claims.length, 40);
  assert.equal(single.sends.length, 40);
});

test('429 keeps retry/pause and unknown delivery remains uncertain without delaying a sibling', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(['telegram', 'max'], 1);
    let attempts = 0;
    f.providers.max.send = async () => {
      attempts++;
      throw Object.assign(
        Error('synthetic provider failure'),
        uncertain
          ? { deliveryUncertain: true }
          : { status: 429, retryAfter: 2, deliveryUncertain: false },
      );
    };
    await f.worker.tick();
    const job = f.jobs.find((row) => row.decoded.channel === 'max');
    assert.equal(job.status, uncertain ? 'uncertain' : 'pending');
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].channel, 'telegram');
    if (!uncertain) {
      assert.deepEqual(f.paused, [{ channel: 'max', delay: 2 }]);
      assert.equal(job.next_at, f.now + 2000);
    }
    await f.worker.tick();
    assert.equal(attempts, 1);
  }
});

for (const invalidation of ['abort', 'lease', 'access', 'channel']) {
  test(
    `${invalidation} during pacing prevents a send after the await`,
    { timeout: 2000 },
    async (t) => {
      const f = fixture(['telegram'], 1),
        gate = deferred(),
        entered = deferred();
      const controller = new AbortController();
      let active = true;
      t.after(() => gate.resolve());
      f.providers.telegram.acquire = async () => {
        entered.resolve();
        await gate.promise;
        return true;
      };
      const running = f.worker.tick(controller.signal, () => active);
      await entered.promise;
      if (invalidation === 'abort') controller.abort();
      if (invalidation === 'lease') active = false;
      if (invalidation === 'access') f.validity(() => false);
      if (invalidation === 'channel') f.connected.clear();
      gate.resolve();
      await running;
      assert.equal(f.sends.length, 0);
      assert.equal(f.jobs[0].status, invalidation === 'access' ? 'cancelled' : 'pending');
    },
  );
}

test(
  'a failed lane waits for its in-flight sibling before releasing tick ownership',
  { timeout: 2000 },
  async (t) => {
    const f = fixture(),
      gate = deferred(),
      entered = deferred();
    t.after(() => gate.resolve());
    f.providers.telegram.send = async () => {
      entered.resolve();
      await gate.promise;
      return {};
    };
    f.validity((job) => {
      if (job.decoded.channel === 'max') throw Error('synthetic validation fault');
      return true;
    });
    const running = f.worker.tick();
    await entered.promise;
    const claims = f.claims.length;
    await f.worker.tick();
    assert.equal(f.claims.length, claims);
    gate.resolve();
    await assert.rejects(running, /synthetic validation fault/);
  },
);

test(
  'managed channels continue new batches while a sibling send is still pending',
  { timeout: 2000 },
  async (t) => {
    const f = fixture(['telegram', 'max'], 45),
      gate = deferred(),
      firstBatch = deferred();
    t.after(() => gate.resolve());
    let telegramActive = 0,
      maximumActive = 0,
      maxSent = 0;
    f.providers.telegram.send = async () => {
      telegramActive++;
      maximumActive = Math.max(maximumActive, telegramActive);
      await gate.promise;
      telegramActive--;
      return {};
    };
    f.providers.max.send = async () => {
      if (++maxSent === 20) firstBatch.resolve();
      return {};
    };
    const first = f.worker.tickManaged();
    await firstBatch.promise;
    await turn();
    await f.worker.tickManaged();
    assert.equal(maxSent, 40, 'a finished channel gets its next batch before the slow sibling ACK');
    assert.equal(maximumActive, 1, 'the slow channel still has only one active send');
    gate.resolve();
    await first;
  },
);

test('managed Telegram staff cannot hold back later client Telegram/MAX batches, and stop fences all cycles', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(['telegram', 'max'], 45),
    gate = deferred();
  let now = f.now,
    staffClaims = 0,
    staffSends = 0,
    staffFinished = 0,
    allowed = true;
  const staffJob = {
    organization_id: 'synthetic-org',
    decoded: { kind: 'test', chatId: 'synthetic-staff' },
  };
  const runtime = createTelegramRuntime({
    platform: {
      organization: () => ({ name: 'Synthetic' }),
      telegram: { acquirePollLease: () => true, releasePollLease() {}, offset: () => 0 },
      staffNotifications: {
        hasPendingWork: () => true,
        claim: () => (++staffClaims === 1 ? staffJob : null),
        valid: () => ({}),
        finish: () => staffFinished++,
      },
    },
    tenantStore: () => assert.fail('No clinical scan in this fixture'),
    bot: {
      initialize: async () => ({ username: 'Synthetic_bot', botId: 'synthetic' }),
      updates: (_offset, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve([]), { once: true }),
        ),
      send: async () => {
        staffSends++;
        await gate.promise;
      },
    },
    coordinator: {
      scheduleBatched: async () => true,
      tick: f.worker.tick,
      tickManaged: f.worker.tickManaged,
    },
    pacing: { acquire: async () => true },
    clock: () => now,
    canRun: () => allowed,
  });
  t.after(async () => {
    runtime.stop();
    gate.resolve();
    await turn();
  });
  runtime.start();
  await turn();
  now += 250;
  t.mock.timers.tick(250);
  await turn();
  assert.equal(staffSends, 1);
  for (const channel of ['telegram', 'max'])
    assert.equal(f.sends.filter((value) => value.channel === channel).length, 20);
  now += 250;
  t.mock.timers.tick(250);
  await turn();
  for (const channel of ['telegram', 'max'])
    assert.equal(f.sends.filter((value) => value.channel === channel).length, 40);
  assert.equal(staffSends, 1, 'no overlapping staff batches while its send is pending');
  allowed = false;
  now += 250;
  t.mock.timers.tick(250);
  await turn();
  assert.equal(f.sends.length, 80, 'ownership loss prevents another managed claim');
  runtime.stop();
  gate.resolve();
  await turn();
  assert.equal(
    staffFinished,
    1,
    'a resolved provider ACK is committed after stop through its exact lease fence',
  );
  t.mock.timers.tick(1000);
  await turn();
  assert.equal(f.sends.length, 80);
});

for (const blocked of ['staff', 'inbox']) {
  test(`managed MAX ${blocked} cannot block its other delivery cycle`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const gate = deferred(),
      rows = [],
      finished = [];
    let staffCalls = 0,
      now = 1000000,
      allowed = true;
    const row = (id) => ({
      id,
      decoded: {
        result: { callbackId: id },
        event: { callback: { user: { user_id: 'synthetic' } } },
      },
    });
    rows.push(row('first'));
    const runtime = createMaxRuntime({
      inbox: {
        acquire: () => true,
        renew: () => true,
        isCurrent: () => true,
        release() {},
        claim: () => rows.shift(),
        finish: (value) => finished.push(value.id),
      },
      events: {},
      identity: { botId: 'synthetic' },
      bot: {
        answer: async () => {
          if (blocked === 'inbox') await gate.promise;
        },
      },
      pacing: { acquire: async () => true },
      staffDelivery: {
        tick: async () => {
          staffCalls++;
          if (blocked === 'staff') await gate.promise;
        },
      },
      canRun: () => allowed,
      clock: () => now,
    });
    t.after(async () => {
      runtime.stop();
      gate.resolve();
      await turn();
    });
    runtime.start();
    await turn();
    rows.push(row('second'));
    now += 500;
    t.mock.timers.tick(500);
    await turn();
    if (blocked === 'staff') {
      assert.deepEqual(finished, ['first', 'second']);
      assert.equal(staffCalls, 1);
    } else {
      assert.deepEqual(finished, []);
      assert.equal(staffCalls, 2);
    }
    allowed = false;
    now += 500;
    t.mock.timers.tick(500);
    await turn();
    assert.equal(staffCalls, blocked === 'staff' ? 1 : 2);
    runtime.stop();
    gate.resolve();
    await turn();
    assert.equal(
      rows.length,
      blocked === 'staff' ? 0 : 1,
      'no second inbox claim after a stopped send',
    );
  });
}

test('shared pacing holds a recipient until ACK and releases on deferral or cancellation', async () => {
  let now = 0;
  const pacing = createTelegramPacing({
    clock: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  assert.equal(await pacing.acquireDelivery('same', undefined, 1000), true);
  now = 2000;
  assert.equal(
    await pacing.acquireDelivery('same', undefined, 1000),
    false,
    'one-second rate spacing does not release an active send',
  );
  assert.equal(await pacing.acquireDelivery('other', undefined, 1000), true);
  pacing.releaseDelivery('same');
  pacing.releaseDelivery('other');
  assert.equal(await pacing.acquireDelivery('same', undefined, 1000), true);
  pacing.releaseDelivery('same');
  pacing.pause(30);
  assert.equal(await pacing.acquireDelivery('deferred', undefined, 1000), false);
  now += 30000;
  assert.equal(
    await pacing.acquireDelivery('deferred', undefined, 1000),
    true,
    'a deferral did not retain the recipient',
  );
  pacing.releaseDelivery('deferred');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pacing.acquireDelivery('cancelled', controller.signal), {
    name: 'AbortError',
  });
  assert.equal(await pacing.acquireDelivery('cancelled', undefined, 1000), true);
  pacing.releaseDelivery('cancelled');
});
