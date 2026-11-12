const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRoleRenewalDiagnostics,
  renewalRecord,
} = require('../src/server/application/role-renewal-diagnostics.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const roles = require('../src/server/infrastructure/process-role-lease.cjs');
const timing = { attemptedAt: 10000, expectedAt: 9000, finishedAt: 10012, confirmedUntil: 60000 };
const busy = (overrides = {}) =>
  Object.assign(
    Error('PRIVATE SQL OWNER TOKEN'),
    {
      postgres: true,
      code: 'POSTGRES_ROLE_AUTHORITY_BUSY',
      leaseUnchanged: true,
      transactionOpen: false,
      channelPoisoned: false,
      outcomeUnknown: false,
    },
    overrides,
  );

test('closed diagnostics classify definite lease-only busy and preserve expiry/unknown/poison distinctions', () => {
  const valid = renewalRecord(busy(), timing, 'background');
  assert.equal(valid.renewalState, 'lease-busy-valid');
  assert.equal(valid.leaseUnchanged, true);
  assert.equal(valid.cleanLeaseBusy, true);
  assert.equal(valid.elapsedMs, 12);
  assert.equal(valid.timerLateMs, 1000);
  assert.equal(valid.remainingLeaseMs, 49988);
  assert.equal(
    renewalRecord(busy(), { ...timing, finishedAt: 60000 }, 'background').renewalState,
    'lease-busy-expired',
  );
  assert.equal(
    renewalRecord(busy({ outcomeUnknown: true }), timing).renewalState,
    'outcome-unknown',
  );
  assert.equal(
    renewalRecord(busy({ channelPoisoned: true }), timing).renewalState,
    'channel-poisoned',
  );
  for (const [key, value] of [
    ['leaseUnchanged', undefined],
    ['transactionOpen', undefined],
    ['channelPoisoned', undefined],
    ['postgres', false],
    ['code', 'POSTGRES_BUSY'],
  ])
    assert.equal(renewalRecord(busy({ [key]: value }), timing).cleanLeaseBusy, false);
  assert.equal(
    renewalRecord(
      busy({ code: 'ERR_SQLITE_ERROR', postgresCode: 'POSTGRES_ROLE_AUTHORITY_BUSY' }),
      timing,
    ).cleanLeaseBusy,
    true,
  );
  assert.equal(renewalRecord(null, timing).renewalState, 'not-renewed');
  assert.equal(
    renewalRecord(null, { ...timing, finishedAt: 60000 }).renewalState,
    'expired-not-renewed',
  );
  assert.equal(renewalRecord(busy(), {}).renewalState, 'timing-unavailable');
});

test('diagnostics retain the old before-BEGIN proof and only allow known codes/technical fields', () => {
  const old = busy({
    code: 'ERR_SQLITE_ERROR',
    postgresCode: 'POSTGRES_BUSY',
    errcode: 5,
    retryableBeforeBegin: true,
    leaseUnchanged: undefined,
  });
  assert.equal(renewalRecord(old, timing, 'combined').renewalState, 'before-begin-busy-valid');
  const errors = [
    busy(),
    busy({ code: 'POSTGRES_ROLE_LINEAGE_MISMATCH' }),
    busy({ code: 'POSTGRES_ROLE_SCHEMA_INVALID' }),
    busy({ code: '55P03' }),
    busy({
      code: 'PRIVATE-CODE',
      postgresCode: 'PRIVATE-POSTGRES-CODE',
      sql: 'PRIVATE SQL',
      owner: 'PRIVATE OWNER',
      token: 'PRIVATE TOKEN',
      toJSON() {
        throw Error('not allowed');
      },
    }),
  ];
  const records = [];
  const d = createRoleRenewalDiagnostics({
    role: 'PRIVATE ROLE',
    write: (value) => records.push(JSON.parse(value)),
  });
  for (const error of errors) assert.equal(d.report(error, timing), true);
  assert.equal(records[3].code, '55P03');
  assert.equal(records[4].code, 'UNKNOWN');
  assert.equal(records[4].postgresCode, 'UNKNOWN');
  assert.equal(records[4].role, 'unknown');
  assert.ok(!JSON.stringify(records).includes('PRIVATE'));
  for (const record of records)
    assert.ok(
      Object.keys(record).every(
        (key) => !['message', 'stack', 'sql', 'owner', 'token'].includes(key),
      ),
    );
});

test('diagnostic lifetime budget includes throwing sinks/getters and never creates an unbounded error stream', () => {
  let writes = 0;
  const d = createRoleRenewalDiagnostics({
    write: () => {
      writes++;
      throw Error('PRIVATE SINK');
    },
  });
  const throwing = {
    get code() {
      throw Error('PRIVATE GETTER');
    },
  };
  for (let n = 0; n < 100; n++) assert.equal(d.report(n % 2 ? busy() : throwing, timing), false);
  assert.deepEqual(d.stats(), { records: 64, suppressed: 36, limit: 64 });
  assert.equal(writes, 32);
  const records = [],
    d2 = createRoleRenewalDiagnostics({ write: (x) => records.push(JSON.parse(x)) });
  for (let n = 0; n < 100; n++) d2.report(null, timing);
  assert.equal(records.length, 64);
  assert.equal(records[63].sample, 64);
  assert.equal(records[63].diagnosticsCapped, true);
  assert.equal(records[62].diagnosticsCapped, false);
});

function fixture(t, renewal) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-renewal129-'));
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const logs = [];
  t.mock.method(console, 'error', (line) => logs.push(line));
  const original = roles.createProcessRoleLease;
  let database;
  const state = { attempts: 0, releases: 0, errors: 0, current: true };
  t.mock.method(roles, 'createProcessRoleLease', (db) => {
    database = db;
    const lease = original(db);
    return {
      ...lease,
      isCurrent: () => state.current,
      renew(...args) {
        state.attempts++;
        return renewal({ state, lease, args, now, clock: t.mock.timers });
      },
      release(...args) {
        state.releases++;
        return lease.release(...args);
      },
    };
  });
  const server = createMultiServer({
    dataDir: directory,
    production: false,
    origin: '',
    sendMail: null,
    telegramBot: null,
    supportDelivery: {},
    notificationSchema: 11,
    telegramIdentityAutostart: false,
    telegramAutostart: false,
    maxAutostart: false,
    pushAutostart: false,
    supportAutostart: false,
    adminEmailAutostart: false,
    bookingPublicationAutostart: false,
  });
  server.on('backgroundError', () => state.errors++);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-renewal129-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const row = () =>
    database.db
      .prepare("SELECT value FROM telegram_runtime WHERE key='application-process-roles'")
      .get();
  const owners = () => database.open(row().value).owners;
  assert.equal(server.startBackground(), true);
  return { server, state, logs, now, owners, bytes: () => Buffer.from(row().value) };
}

test('a proven lease-only busy keeps exact persisted ownership and waits for the ordinary next timer tick', (t) => {
  const f = fixture(t, ({ state, lease, args }) => {
    if (state.attempts === 1) throw busy();
    return lease.renew(...args);
  });
  const before = f.bytes(),
    token = f.owners()[0].token;
  t.mock.timers.tick(10000);
  assert.equal(f.server.backgroundStatus().active, true);
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.state.attempts, 1);
  assert.equal(f.state.releases, 0);
  assert.equal(f.state.errors, 0);
  assert.equal(JSON.parse(f.logs[0]).renewalState, 'lease-busy-valid');
  t.mock.timers.tick(9999);
  assert.equal(f.state.attempts, 1);
  t.mock.timers.tick(1);
  assert.equal(f.state.attempts, 2);
  assert.equal(f.owners()[0].token, token);
  assert.equal(f.owners()[0].until, f.now + 80000);
});

test('dedicated monotonic ownership gates delivery immediately and clean busy cannot keep an expired channel alive', (t) => {
  const f = fixture(t, () => {
    throw busy();
  });
  t.mock.timers.tick(10000);
  f.state.current = false;
  assert.equal(f.server.backgroundStatus().active, false);
  assert.equal(f.server.backgroundStatus().state, 'lease-expired');
  assert.deepEqual(f.server.bookingPublicationRuntime.tick(), { cursor: '', skipped: true });
  t.mock.timers.tick(10000);
  assert.equal(f.server.backgroundStatus().state, 'lease-lost');
  assert.equal(f.state.errors, 1);
  assert.equal(f.state.releases, 1);
  assert.equal(f.server.startBackground(), false);
});

test('repeated lease-only busy never advances the confirmed deadline and stops at original TTL', (t) => {
  const f = fixture(t, () => {
    throw busy();
  });
  const before = f.bytes();
  t.mock.timers.tick(50000);
  assert.deepEqual(f.bytes(), before);
  assert.equal(f.server.backgroundStatus().active, true);
  t.mock.timers.tick(10000);
  assert.equal(f.server.backgroundStatus().active, false);
  assert.equal(f.state.attempts, 6);
  assert.equal(f.state.errors, 1);
  assert.ok(
    f.logs.some((line) => {
      try {
        return JSON.parse(line).renewalState === 'lease-busy-expired';
      } catch {
        return false;
      }
    }),
  );
});

test('unproven lease busy, unknown/poison/open transaction and lost-token renewal still stop', async (t) => {
  for (const [name, change] of [
    ['missing unchanged proof', { leaseUnchanged: undefined }],
    ['open transaction', { transactionOpen: true }],
    ['missing transaction proof', { transactionOpen: undefined }],
    ['poisoned', { channelPoisoned: true }],
    ['missing channel proof', { channelPoisoned: undefined }],
    ['unknown', { outcomeUnknown: true }],
    ['not PostgreSQL', { postgres: false }],
    ['wrong code', { code: 'POSTGRES_ROLE_AUTHORITY_LOST' }],
    ['false result', null],
  ])
    await t.test(name, (t) => {
      const f = fixture(t, () => {
        if (change === null) return false;
        throw busy(change);
      });
      t.mock.timers.tick(10000);
      assert.equal(f.server.backgroundStatus().active, false);
      assert.equal(f.server.backgroundStatus().state, 'lease-lost');
      assert.equal(f.state.releases, 1);
      assert.equal(f.state.errors, 1);
    });
});
