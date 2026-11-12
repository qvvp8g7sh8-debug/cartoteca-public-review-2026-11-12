const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const { terminalPurge } = require('../src/server/infrastructure/postgres/max-inbox-sql134.cjs');
const NOW = 1000000000;
const incoming = (timestamp) => ({
  update_type: 'bot_started',
  timestamp,
  user: { user_id: '456', is_bot: false },
});
function fixture(t) {
  const raw = new DatabaseSync(':memory:'),
    key = crypto.randomBytes(32),
    capabilities = [];
  t.after(() => raw.close());
  raw.exec(`CREATE TABLE max_event_inbox (
    id TEXT PRIMARY KEY,bot_hash TEXT NOT NULL,event_hash TEXT NOT NULL UNIQUE,value BLOB NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','processing','done','failed')),
    created_at INTEGER NOT NULL,next_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_id TEXT);
    CREATE TABLE max_runtime_leases(bot_hash TEXT PRIMARY KEY,owner TEXT NOT NULL,lease_until INTEGER NOT NULL);
    PRAGMA user_version=15;`);
  const db = new Proxy(raw, {
    get(target, prop) {
      if (prop === 'revisionProfile') return 3;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const seal = (value) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const open = (value) => {
    const body = Buffer.from(value),
      decipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(0, 12));
    decipher.setAuthTag(body.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString(),
    );
  };
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const limitKey = (kind, value) =>
    kind + ':' + crypto.createHmac('sha256', key).update(String(value)).digest('hex');
  const context = {
    db,
    seal,
    open,
    limitKey,
    transaction,
    queueTransaction: () => {
      throw Error('Unexpected legacy writer.');
    },
    entityQueueTransaction(work, cap) {
      capabilities.push(cap);
      return transaction(work);
    },
  };
  const seed = (
    count,
    {
      status = 'done',
      expiresAt = NOW + 86400000,
      createdAt = NOW - 60001,
      bot = 'seed',
      prefix = 'seed',
    } = {},
  ) =>
    transaction(() => {
      const insert = db.prepare(
        'INSERT INTO max_event_inbox(id,bot_hash,event_hash,value,status,created_at,next_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (let n = 0; n < count; n++)
        insert.run(
          crypto.randomUUID(),
          limitKey('max-inbox-bot', bot),
          prefix + n,
          seal({ synthetic: true }),
          status,
          createdAt,
          createdAt,
          expiresAt,
        );
    });
  return {
    db,
    context,
    capabilities,
    seed,
    inbox: createMaxInbox(context),
    reset() {
      db.exec('DELETE FROM max_event_inbox;DELETE FROM max_runtime_leases;');
      capabilities.length = 0;
    },
  };
}
test('MAX entity inbox preserves durable behavior, bounded retention and exact capacities without a legacy writer', async (t) => {
  const f = fixture(t),
    { db, inbox } = f;
  await t.test(
    'accept encrypts minimal payloads, reconstructs dedupe and binds exact admission/event/bot capabilities',
    () => {
      inbox.accept('101', incoming(NOW), NOW);
      assert.equal(createMaxInbox(f.context).accept('101', incoming(NOW), NOW).repeated, true);
      const stored = db.prepare('SELECT * FROM max_event_inbox').get();
      assert.equal(Buffer.from(stored.value).includes(Buffer.from('bot_started')), false);
      assert.deepEqual(f.capabilities[0], {
        domain: 'max-inbox',
        kind: 'admission',
        key: stored.bot_hash,
      });
      assert.equal(inbox.acquire('101', 'owner', NOW), true);
      const row = inbox.claim('101', NOW, { owner: 'owner', until: NOW + 30000 });
      assert.equal(row.id, stored.id);
      assert.deepEqual(f.capabilities.at(-1), {
        domain: 'max-inbox',
        kind: 'event',
        key: row.id,
        botHash: row.bot_hash,
      });
      assert.equal(inbox.saveResult(row, { callbackId: 'answer', notification: 'ok' }), true);
      assert.equal(inbox.finish(row, 'done'), true);
      assert.equal(
        f.capabilities.some((cap) => cap.kind === 'bot'),
        true,
      );
    },
  );
  await t.test(
    'expired attempts retain saved outcome while stale ACK, result and refund cannot overwrite the new lease',
    () => {
      f.reset();
      inbox.accept('102', incoming(NOW), NOW);
      const old = inbox.claim('102', NOW);
      inbox.saveResult(old, { callbackId: 'saved', notification: 'confirmed' });
      const fresh = inbox.claim('102', NOW + 120001);
      assert.equal(fresh.attempt, 2);
      assert.equal(fresh.decoded.result.callbackId, 'saved');
      for (const change of [
        () => inbox.finish(old, 'done'),
        () => inbox.saveResult(old, {}),
        () => inbox.defer(old, NOW),
      ])
        assert.equal(change(), false);
      assert.equal(inbox.defer(fresh, NOW + 120002), true);
      const refunded = inbox.claim('102', NOW + 120002);
      assert.equal(refunded.attempt, 2);
      assert.equal(inbox.finish(refunded, 'done'), true);
    },
  );
  await t.test(
    'recovery affects only the chosen bot and checks fresh authority before any event mutation',
    () => {
      f.reset();
      inbox.accept('103', incoming(NOW), NOW);
      inbox.accept('104', incoming(NOW + 1), NOW + 1);
      const other = inbox.claim('104', NOW + 1);
      assert.equal(inbox.acquire('103', 'first', NOW), true);
      const before = db.prepare('SELECT * FROM max_event_inbox ORDER BY id').all();
      assert.equal(inbox.claim('103', NOW + 120002, { owner: 'first', until: NOW + 30000 }), null);
      assert.deepEqual(db.prepare('SELECT * FROM max_event_inbox ORDER BY id').all(), before);
      const first = inbox.claim('103', NOW + 120002);
      assert.ok(first);
      assert.equal(
        db.prepare('SELECT status FROM max_event_inbox WHERE id=?').get(other.id).status,
        'processing',
      );
      assert.equal(
        db.prepare('SELECT attempt FROM max_event_inbox WHERE id=?').get(other.id).attempt,
        1,
      );
    },
  );
  await t.test(
    'expired heads are retired by exact CAS; retention is bounded and a duplicate beyond its first page can be reused',
    () => {
      f.reset();
      inbox.accept('105', incoming(NOW), NOW);
      const expired = inbox.claim('105', NOW);
      db.prepare('UPDATE max_event_inbox SET expires_at=? WHERE id=?').run(NOW - 100, expired.id);
      f.seed(70, { expiresAt: NOW - 200, prefix: 'older' });
      assert.equal(
        inbox.accept('105', incoming(NOW), NOW).repeated,
        true,
        'live processing is never removed by retention',
      );
      assert.equal(inbox.claim('105', NOW + 120001), null);
      assert.equal(
        db.prepare('SELECT status FROM max_event_inbox WHERE id=?').get(expired.id).status,
        'failed',
      );
      f.seed(70, { expiresAt: NOW - 200, prefix: 'oldest' });
      assert.equal(
        inbox.accept('105', incoming(NOW), NOW).repeated,
        false,
        'expired duplicate is removed even beyond the first64',
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM max_event_inbox WHERE status='pending'").get().n,
        1,
      );
      assert.equal(db.prepare('SELECT count(*) n FROM max_event_inbox').get().n, 13);
      assert.throws(() => terminalPurge(65));
    },
  );
  await t.test(
    'content conflict rolls terminal cleanup back with the complete admission transaction',
    () => {
      f.reset();
      const callback = {
        update_type: 'message_callback',
        timestamp: NOW,
        callback: { callback_id: 'same' },
      };
      inbox.accept('106', callback, NOW);
      f.seed(2, { expiresAt: NOW - 1 });
      assert.throws(() => inbox.accept('106', { ...callback, timestamp: NOW + 1 }, NOW), {
        status: 409,
      });
      assert.equal(db.prepare('SELECT count(*) n FROM max_event_inbox').get().n, 3);
    },
  );
  await t.test(
    '600 per bot per minute, 5000 active and 20000 total caps remain exact and rejection rolls cleanup back',
    () => {
      for (const [count, options] of [
        [600, { bot: '107', createdAt: NOW }],
        [5000, { status: 'pending' }],
        [20000, {}],
      ]) {
        f.reset();
        f.seed(count, options);
        f.seed(1, { prefix: 'expired', expiresAt: NOW - 1 });
        assert.throws(() => inbox.accept('107', incoming(NOW), NOW), { status: 429 });
        assert.equal(db.prepare('SELECT count(*) n FROM max_event_inbox').get().n, count + 1);
      }
      f.reset();
      f.seed(599, { bot: '107', createdAt: NOW });
      assert.equal(inbox.accept('107', incoming(NOW), NOW).repeated, false);
      assert.throws(() => inbox.accept('107', incoming(NOW + 1), NOW + 1), { status: 429 });
      assert.equal(inbox.accept('108', incoming(NOW + 2), NOW + 2).repeated, false);
    },
  );
});
