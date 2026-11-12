const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createMultiServer } = require('../multi-server.cjs');
const roles = require('../src/server/infrastructure/process-role-lease.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const { staffMaxFixture } = require('./helpers/staff-max-fixture.cjs');
const options = {
  production: false,
  origin: '',
  sendMail: null,
  telegramBot: null,
  supportDelivery: {},
  notificationSchema: 17,
  telegramIdentityAutostart: false,
  telegramAutostart: false,
  maxAutostart: false,
  pushAutostart: false,
  supportAutostart: false,
  adminEmailAutostart: false,
  bookingPublicationAutostart: false,
};
function busy(overrides = {}) {
  return Object.assign(
    Error('Synthetic refused BEGIN'),
    {
      postgres: true,
      postgresCode: 'POSTGRES_BUSY',
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
      retryableBeforeBegin: true,
      transactionOpen: false,
      channelPoisoned: false,
    },
    overrides,
  );
}
async function fixture(t, renewal) {
  const f = await staffMaxFixture(t, { schema: 17 });
  const startedAt = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: startedAt });
  t.mock.method(console, 'error', () => {});
  const original = roles.createProcessRoleLease;
  const state = { attempts: 0, releases: 0, errors: 0, stops: 0 };
  t.mock.method(roles, 'createProcessRoleLease', (database) => {
    const lease = original(database);
    return {
      ...lease,
      renew(...args) {
        state.attempts++;
        return renewal({ lease, args, state, startedAt, clock: t.mock.timers });
      },
      release(...args) {
        state.releases++;
        return lease.release(...args);
      },
    };
  });
  const server = createMultiServer({ ...options, dataDir: f.source });
  server.on('backgroundError', () => state.errors++);
  for (const name of [
    'telegramRuntime',
    'maxRuntime',
    'staffPushRuntime',
    'supportRuntime',
    'adminEmailRuntime',
    'bookingPublicationRuntime',
  ]) {
    const stop = server[name].stop;
    t.mock.method(server[name], 'stop', () => {
      state.stops++;
      return stop();
    });
  }
  const row = () =>
    f.database.db
      .prepare("SELECT value FROM telegram_runtime WHERE key='application-process-roles'")
      .get();
  const owners = () => f.database.open(row().value).owners;
  assert.equal(server.startBackground(), true);
  assert.equal(owners()[0].until, startedAt + 60000);
  return {
    server,
    state,
    startedAt,
    owners,
    bytes: () => Buffer.from(row().value),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test('a definite clean busy preserves the confirmed lease unchanged until the next normal renewal tick', async (t) => {
  const f = await fixture(t, ({ lease, args, state }) => {
    if (state.attempts === 1) throw busy();
    return lease.renew(...args);
  });
  try {
    const originalBytes = f.bytes();
    const token = f.owners()[0].token;
    t.mock.timers.tick(10000);
    assert.equal(f.state.attempts, 1);
    assert.equal(f.server.backgroundStatus().active, true);
    assert.equal(f.server.backgroundStatus().state, 'running');
    assert.deepEqual(
      f.bytes(),
      originalBytes,
      'No persisted lease or TTL is changed by a refused BEGIN',
    );
    assert.equal(f.state.releases, 0);
    assert.equal(f.state.stops, 0);
    assert.equal(f.state.errors, 0);
    t.mock.timers.tick(9999);
    assert.equal(f.state.attempts, 1, 'No immediate retry or shorter timer was introduced');
    t.mock.timers.tick(1);
    assert.equal(f.state.attempts, 2);
    assert.equal(f.owners()[0].token, token);
    assert.equal(f.owners()[0].until, f.startedAt + 80000);
    assert.equal(f.server.backgroundStatus().active, true);
  } finally {
    await f.close();
  }
});

test('repeated clean busy never extends ownership and stops at the original expiry', async (t) => {
  const f = await fixture(t, () => {
    throw busy();
  });
  try {
    const originalBytes = f.bytes();
    t.mock.timers.tick(50000);
    assert.equal(f.state.attempts, 5);
    assert.equal(f.server.backgroundStatus().active, true);
    assert.deepEqual(f.bytes(), originalBytes);
    t.mock.timers.tick(9999);
    assert.equal(f.server.backgroundStatus().active, true);
    t.mock.timers.tick(1);
    assert.equal(f.state.attempts, 6);
    assert.deepEqual(f.server.backgroundStatus(), {
      role: 'combined',
      state: 'lease-lost',
      active: false,
    });
    assert.equal(f.state.stops, 6);
    assert.equal(f.state.errors, 1);
    assert.equal(f.state.releases, 1);
    assert.equal(f.server.startBackground(), false);
    assert.deepEqual(f.server.bookingPublicationRuntime.tick(), { cursor: '', skipped: true });
    t.mock.timers.tick(60000);
    assert.equal(f.state.attempts, 6, 'Lost lifetime cannot restart its timer');
  } finally {
    await f.close();
  }
});

test('expiry occurring during a failed renewal is evaluated after the error, never at its earlier start time', async (t) => {
  const f = await fixture(t, ({ clock, startedAt }) => {
    clock.setTime(startedAt + 60000);
    throw busy();
  });
  try {
    t.mock.timers.tick(10000);
    assert.equal(f.server.backgroundStatus().active, false);
    assert.equal(f.server.backgroundStatus().state, 'lease-lost');
    assert.equal(f.state.errors, 1);
  } finally {
    await f.close();
  }
});

test('unknown, poisoned, after-BEGIN, incomplete proof and lost-token renewals still stop immediately', async (t) => {
  for (const [name, result] of [
    [
      'unknown outcome',
      () => {
        throw busy({ outcomeUnknown: true });
      },
    ],
    [
      'poisoned channel',
      () => {
        throw busy({ channelPoisoned: true });
      },
    ],
    [
      'transaction remains open',
      () => {
        throw busy({ transactionOpen: true });
      },
    ],
    [
      'not before BEGIN',
      () => {
        throw busy({ retryableBeforeBegin: false });
      },
    ],
    [
      'missing channel proof',
      () => {
        throw busy({ channelPoisoned: undefined });
      },
    ],
    [
      'unmapped error code',
      () => {
        throw busy({ postgresCode: undefined });
      },
    ],
    [
      'SQLite busy without PG proof',
      () => {
        throw busy({ postgres: undefined });
      },
    ],
    [
      'ordinary error',
      () => {
        throw Error('Synthetic storage failure');
      },
    ],
    ['lost token', () => false],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, result);
      try {
        t.mock.timers.tick(10000);
        assert.equal(f.server.backgroundStatus().active, false);
        assert.equal(f.server.backgroundStatus().state, 'lease-lost');
        assert.equal(f.state.attempts, 1);
        assert.equal(f.state.stops, 6);
        assert.equal(f.state.errors, 1);
        assert.equal(f.server.startBackground(), false);
      } finally {
        await f.close();
      }
    });
  }
});

const worker = path.join(__dirname, 'helpers/postgres-role-renewal125.cjs');
const nativeBusy = {
  code: 'POSTGRES_BUSY',
  retryableBeforeBegin: true,
  transactionOpen: false,
  outcomeUnknown: false,
  channelPoisoned: false,
};
test(
  'physical PG transport and mapped coordinator retain the definite clean busy proof without running a transaction callback',
  { timeout: 15000 },
  async (t) => {
    const transport = createTransport({ filename: worker, timeoutMs: 1000 });
    t.after(() => transport.close());
    await transport.ready();
    const owner = createPostgresCoordinator({
      allowBlocking: true,
      catalog: { tables: {} },
      transport: {
        request: () => transport.request({ op: 'fault', error: nativeBusy }, { mutating: true }),
        stats: transport.stats,
        close: transport.close,
        closeSync: transport.closeSync,
      },
    });
    const db = owner.open({ kind: 'platform', storeId: 'synthetic-platform125' });
    let callbacks = 0;
    assert.throws(
      () => db.transaction(() => callbacks++),
      (error) => {
        assert.equal(error.postgres, true);
        assert.equal(error.code, 'ERR_SQLITE_ERROR');
        assert.equal(error.postgresCode, 'POSTGRES_BUSY');
        assert.equal(error.errcode, 5);
        assert.equal(error.retryableBeforeBegin, true);
        assert.equal(error.transactionOpen, false);
        assert.equal(error.channelPoisoned, false);
        assert.notEqual(error.outcomeUnknown, true);
        return true;
      },
    );
    assert.equal(callbacks, 0);
    assert.equal(db.isTransaction, false);
    assert.equal(transport.stats().poisoned, false);
    assert.equal(transport.request({ op: 'echo', value: 7 }), 7);
  },
);

test(
  'a poisoned refused-BEGIN reply keeps its poison flag and cannot admit a later command',
  { timeout: 15000 },
  async (t) => {
    const transport = createTransport({ filename: worker, timeoutMs: 1000 });
    t.after(() => transport.close());
    await transport.ready();
    assert.throws(
      () =>
        transport.request(
          { op: 'fault', error: { ...nativeBusy, channelPoisoned: true } },
          { mutating: true },
        ),
      {
        code: 'POSTGRES_BUSY',
        retryableBeforeBegin: true,
        transactionOpen: false,
        channelPoisoned: true,
      },
    );
    assert.equal(transport.stats().poisoned, true);
    assert.throws(() => transport.request({ op: 'echo', value: 7 }), {
      code: 'POSTGRES_BUSY',
      channelPoisoned: true,
    });
    assert.equal(transport.stats().calls, 1);
  },
);
