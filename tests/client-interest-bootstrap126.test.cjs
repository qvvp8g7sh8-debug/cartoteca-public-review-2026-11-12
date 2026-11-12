const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const {
  createClientNotificationInterest,
} = require('../src/server/modules/notifications/client-notification-interest.cjs');
const PREFIX = 'client-interest-v1:';
function fixture(t, count = 10000) {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  raw.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE telegram_settings(organization_id TEXT PRIMARY KEY,value BLOB NOT NULL);
    CREATE TABLE telegram_links(organization_id TEXT,patient_id TEXT);
    CREATE TABLE max_client_links(organization_id TEXT,patient_id TEXT);
    CREATE TABLE telegram_runtime(key TEXT PRIMARY KEY,value BLOB NOT NULL);`);
  let nonce = 0;
  const seal = (value) => Buffer.from(JSON.stringify({ ...value, nonce: ++nonce }));
  const open = (value) => JSON.parse(Buffer.from(value).toString());
  const org = (index) => 'org-' + String(index).padStart(5, '0');
  const putOrg = raw.prepare("INSERT INTO organizations VALUES(?,'active')"),
    putSettings = raw.prepare('INSERT INTO telegram_settings VALUES(?,?)'),
    putLink = raw.prepare("INSERT INTO telegram_links VALUES(?,'patient')"),
    putMax = raw.prepare("INSERT INTO max_client_links VALUES(?,'patient')"),
    putMarker = raw.prepare('INSERT INTO telegram_runtime VALUES(?,?)');
  raw.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 1; index <= count; index++) {
      const id = org(index);
      putOrg.run(id);
      putSettings.run(id, seal({ enabled: true, events: ['reminder'] }));
      putLink.run(id);
      putMax.run(id);
      putMarker.run(PREFIX + 'all:' + id, seal({ active: true }));
      putMarker.run(PREFIX + 'reminder:' + id, seal({ active: true }));
    }
    putMarker.run('poll-leader', seal({ unrelated: true }));
    putMarker.run(PREFIX + 'future-format:opaque', seal({ unrelated: true }));
    raw.exec('COMMIT');
  } catch (error) {
    raw.exec('ROLLBACK');
    throw error;
  }
  const stats = { calls: 0, reads: 0, writes: 0, maxMutationArguments: 0, failReady: false };
  const db = {
    get isTransaction() {
      return raw.isTransaction;
    },
    prepare(text) {
      const statement = raw.prepare(text);
      return Object.fromEntries(
        ['get', 'all', 'run'].map((method) => [
          method,
          (...args) => {
            stats.calls++;
            if (method === 'run') {
              stats.writes++;
              stats.maxMutationArguments = Math.max(stats.maxMutationArguments, args.length);
              if (stats.failReady && args[0] === PREFIX + 'ready')
                throw Error('Synthetic ready publication failure');
            } else stats.reads++;
            return statement[method](...args);
          },
        ]),
      );
    },
  };
  const transaction = (callback) => {
    raw.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      raw.exec('COMMIT');
      return result;
    } catch (error) {
      raw.exec('ROLLBACK');
      throw error;
    }
  };
  const context = { db, seal, open, transaction, notificationChannels: { enabled: () => true } };
  const digest = () => {
    const hash = createHash('sha256');
    for (const row of raw.prepare('SELECT key,value FROM telegram_runtime ORDER BY key').all()) {
      hash.update(row.key + '\0');
      hash.update(row.value);
    }
    return hash.digest('hex');
  };
  return {
    raw,
    org,
    stats,
    seal,
    context,
    digest,
    interest: () => createClientNotificationInterest(context),
  };
}

test('10k missing-sentinel bootstrap reads SQL pages and preserves all 20k correct marker ciphertexts', (t) => {
  const f = fixture(t),
    before = f.raw.prepare('SELECT key,value FROM telegram_runtime ORDER BY key').all(),
    began = performance.now();
  assert.equal(f.interest().has(), true);
  const elapsedMs = performance.now() - began;
  assert.ok(f.stats.calls < 260, 'SQL is O(pages), never one read/write group per organization');
  assert.equal(f.stats.writes, 1, 'only the ready sentinel is published');
  for (const row of before)
    assert.deepEqual(
      f.raw.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(row.key).value,
      row.value,
    );
  assert.ok(f.raw.prepare('SELECT 1 FROM telegram_runtime WHERE key=?').get(PREFIX + 'ready'));
  const calls = f.stats.calls;
  assert.equal(f.interest().has(), true);
  assert.ok(f.stats.calls - calls <= 2);
  t.diagnostic(
    JSON.stringify({
      organizations: 10000,
      existingMarkers: 20000,
      elapsedMs,
      bootstrapSqlCalls: calls,
      bootstrapMutations: 1,
    }),
  );
});

test('fresh settings, channel-off and sparse matching pagination retain exact complete query semantics', (t) => {
  const f = fixture(t, 260),
    interest = f.interest();
  for (let index = 1; index <= 260; index++)
    f.raw
      .prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?')
      .run(
        f.seal({ events: index === 260 ? ['created'] : [], restoredPaused: index === 259 }),
        f.org(index),
      );
  assert.deepEqual(interest.batch('', 25, ['telegram'], 'lifecycle'), [f.org(260)]);
  assert.deepEqual(interest.organizations(['telegram'], 'all'), [f.org(260)]);
  assert.equal(interest.has(f.org(259), ['max']), false);
  assert.equal(interest.has(f.org(260), ['max'], 'lifecycle'), true);
  const off = createClientNotificationInterest({
    ...f.context,
    notificationChannels: { enabled: () => false },
  });
  assert.equal(off.has(), false);
  assert.deepEqual(off.batch(), []);
  f.raw.prepare('DELETE FROM telegram_links WHERE organization_id=?').run(f.org(260));
  assert.equal(interest.has(f.org(260), ['telegram'], 'lifecycle'), false);
  assert.equal(interest.has(f.org(260), ['max'], 'lifecycle'), true);
  // Existing touch behavior intentionally rebuilds from restoredPaused/events,
  // while fresh send policy remains authoritative for the delivery enable flag.
  f.raw
    .prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?')
    .run(f.seal({ enabled: false, events: ['reminder'] }), f.org(1));
  f.context.transaction(() => interest.touch(f.org(1)));
  assert.equal(interest.has(f.org(1)), true);
  assert.ok(f.stats.maxMutationArguments <= 128);
});

test('failed final readiness publication rolls back every differential mutation and permits a clean retry', (t) => {
  const f = fixture(t, 150),
    interest = f.interest();
  f.raw
    .prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?')
    .run(f.seal({ events: ['created'] }), f.org(1));
  f.raw.prepare('DELETE FROM telegram_runtime WHERE key=?').run(PREFIX + 'all:' + f.org(2));
  const before = f.digest();
  f.stats.failReady = true;
  assert.throws(() => interest.has(), /Synthetic ready publication failure/);
  assert.equal(f.digest(), before);
  assert.equal(
    f.raw.prepare('SELECT 1 FROM telegram_runtime WHERE key=?').get(PREFIX + 'ready'),
    undefined,
  );
  f.stats.failReady = false;
  assert.equal(interest.has(f.org(1)), false);
  assert.equal(interest.has(f.org(1), ['telegram'], 'lifecycle'), true);
  assert.equal(interest.has(f.org(2)), true);
  assert.ok(f.stats.maxMutationArguments <= 128);
});
