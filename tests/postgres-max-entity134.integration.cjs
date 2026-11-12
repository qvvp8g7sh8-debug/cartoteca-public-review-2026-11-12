const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { createMaxInbox } = require('../src/server/modules/notifications/max-inbox.cjs');
const {
  statements,
  terminalPurge,
} = require('../src/server/infrastructure/postgres/max-inbox-sql134.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const NOW = 1000000000;
const incoming = (timestamp) => ({
  update_type: 'bot_started',
  timestamp,
  user: { user_id: '456', is_bot: false },
});
const hash = (kind, value) => kind + ':' + createHash('sha256').update(String(value)).digest('hex');
const scope = (kind, key, botHash) => ({
  domain: 'max-inbox',
  kind,
  key,
  ...(kind === 'event' ? { botHash } : {}),
});
const eventScope = (row) => scope('event', row.id, row.bot_hash);
const cleanBusy = (e) =>
  e.code === 'ERR_SQLITE_ERROR' &&
  e.postgresCode === 'POSTGRES_BUSY' &&
  e.retryableBeforeBegin === true &&
  e.transactionOpen === false &&
  !e.outcomeUnknown &&
  !e.channelPoisoned;
function inboxOwner(owner) {
  let failAfterWork = false;
  const db = owner.p;
  const c = {
    db,
    limitKey: hash,
    seal: (value) => Buffer.from(JSON.stringify(value)),
    open: (value) => JSON.parse(Buffer.from(value).toString()),
    transaction: () => {
      throw Error('Unexpected global writer.');
    },
    queueTransaction: () => {
      throw Error('Unexpected domain writer.');
    },
    entityQueueTransaction(work, cap) {
      db.beginQueueEntity(cap);
      try {
        const result = work();
        if (failAfterWork) throw Error('Synthetic post-event failure.');
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    db,
    inbox: createMaxInbox(c),
    setFailure: (value) => {
      failAfterWork = value;
    },
  };
}
test(
  'native MAX inbox keeps exact admission caps while independent events and bot owners settle concurrently',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      a = inboxOwner(f.a),
      b = inboxOwner(await f.open());
    const reset = () =>
      a.db.transaction(() => {
        a.db.prepare('DELETE FROM max_event_inbox').run();
        a.db.prepare('DELETE FROM max_runtime_leases').run();
      });
    const stored = (id) => b.db.prepare('SELECT * FROM max_event_inbox WHERE id=?').get(id);
    await t.test(
      'held event write does not delay another bot or another ready event of the same bot',
      () => {
        for (const [bot, time] of [
          ['101', NOW],
          ['101', NOW + 1],
          ['102', NOW + 2],
        ])
          a.inbox.accept(bot, incoming(time), time);
        const first = a.inbox.claim('101', NOW + 2);
        a.db.beginQueueEntity(eventScope(first));
        try {
          assert.equal(
            a.db
              .prepare(statements.save.sql)
              .run(
                Buffer.from(JSON.stringify(first.decoded)),
                first.id,
                first.bot_hash,
                first.lease_id,
                first.lease_until,
                first.attempt,
              ).changes,
            1,
          );
          const same = b.inbox.claim('101', NOW + 2),
            other = b.inbox.claim('102', NOW + 2);
          assert.ok(same);
          assert.ok(other);
          assert.equal(
            b.inbox.saveResult(other, { callbackId: 'saved', notification: 'ok' }),
            true,
          );
          assert.equal(b.inbox.finish(same, 'done'), true);
          assert.equal(b.inbox.finish(other, 'done'), true);
          assert.equal(b.inbox.acquire('102', 'different-bot', NOW + 2), true);
          assert.equal(a.db.isTransaction, true);
          assert.equal(stored(other.id).status, 'done');
        } finally {
          a.db.exec('ROLLBACK');
        }
        assert.equal(stored(first.id).status, 'processing');
      },
    );
    await t.test(
      'one pending event has one winner and a failed claim rolls attempt, lease and status back',
      () => {
        reset();
        a.inbox.accept('103', incoming(NOW), NOW);
        const row = a.db.prepare('SELECT * FROM max_event_inbox').get();
        a.db.beginQueueEntity(eventScope(row));
        try {
          assert.equal(
            a.db
              .prepare(statements.claim.sql)
              .run(NOW + 120000, 'held-lease', row.id, row.bot_hash, 0, 0, null, NOW, NOW).changes,
            1,
          );
          assert.throws(() => b.inbox.claim('103', NOW), cleanBusy);
          a.db.exec('COMMIT');
        } finally {
          if (a.db.isTransaction) a.db.exec('ROLLBACK');
        }
        assert.equal(b.inbox.claim('103', NOW), null);
        assert.equal(stored(row.id).attempt, 1);
        reset();
        a.inbox.accept('103', incoming(NOW), NOW);
        const pending = a.db.prepare('SELECT * FROM max_event_inbox').get();
        b.setFailure(true);
        try {
          assert.throws(() => b.inbox.claim('103', NOW), /Synthetic post-event failure/);
        } finally {
          b.setFailure(false);
        }
        assert.equal(b.db.isTransaction, false);
        assert.equal(stored(pending.id).status, 'pending');
        assert.equal(stored(pending.id).attempt, 0);
        assert.equal(stored(pending.id).lease_id, null);
        assert.equal(b.inbox.claim('103', NOW).attempt, 1);
      },
    );
    await t.test(
      'event authority holds its bot guard until settlement and stale owner, ACK, save and refund fail closed',
      () => {
        reset();
        a.inbox.accept('104', incoming(NOW), NOW);
        assert.equal(a.inbox.acquire('104', 'first', NOW), true);
        const old = a.inbox.claim('104', NOW, { owner: 'first', until: NOW + 30000 });
        a.db.beginQueueEntity(eventScope(old));
        try {
          assert.throws(() => b.inbox.acquire('104', 'second', NOW + 30001), cleanBusy);
          assert.equal(b.inbox.acquire('105', 'other', NOW), true);
        } finally {
          a.db.exec('ROLLBACK');
        }
        assert.equal(b.inbox.acquire('104', 'second', NOW + 120001), true);
        assert.equal(
          a.inbox.claim('104', NOW + 120001, { owner: 'first', until: NOW + 30000 }),
          null,
        );
        assert.equal(
          a.inbox.saveResult(old, { callbackId: 'durable', notification: 'known' }),
          true,
        );
        const fresh = b.inbox.claim('104', NOW + 120001, { owner: 'second', until: NOW + 150001 });
        assert.equal(fresh.attempt, 2);
        assert.equal(fresh.decoded.result.callbackId, 'durable');
        assert.equal(a.inbox.finish(old, 'done'), false);
        assert.equal(a.inbox.saveResult(old, {}), false);
        assert.equal(a.inbox.defer(old, NOW + 120001), false);
        assert.equal(b.inbox.defer(fresh, NOW + 120002), true);
        const final = b.inbox.claim('104', NOW + 120002, { owner: 'second', until: NOW + 150001 });
        assert.equal(final.attempt, 2);
        assert.equal(b.inbox.finish(final, 'done'), true);
      },
    );
    await t.test(
      'global acceptance lock never becomes an event-processing barrier, including the exact600 boundary',
      async () => {
        reset();
        a.inbox.accept('106', incoming(NOW - 1), NOW - 1);
        const active = a.inbox.claim('106', NOW);
        const botHash = hash('max-inbox-bot', '107');
        await f.admin.query(
          `INSERT INTO cartoteca_platform.max_event_inbox
      (_store_id,id,bot_hash,event_hash,value,status,created_at,next_at,expires_at)
      SELECT $1,md5($2||n::text),$3,$2||n::text,$4,'done',$5,$5,$6 FROM generate_series(1,599) n`,
          [f.platform.storeId, 'synthetic-quota-', botHash, Buffer.from('{}'), NOW, NOW + 86400000],
        );
        a.db.beginQueueEntity(scope('admission', botHash));
        try {
          a.db
            .prepare(statements.insert.sql)
            .run(
              randomUUID(),
              botHash,
              'synthetic600',
              Buffer.from('{}'),
              NOW,
              NOW,
              NOW + 86400000,
            );
          assert.throws(() => b.inbox.accept('108', incoming(NOW), NOW), cleanBusy);
          assert.equal(b.inbox.finish(active, 'done'), true);
          assert.equal(b.inbox.acquire('108', 'independent', NOW), true);
          a.db.exec('COMMIT');
        } finally {
          if (a.db.isTransaction) a.db.exec('ROLLBACK');
        }
        assert.throws(() => b.inbox.accept('107', incoming(NOW), NOW), { status: 429 });
        assert.equal(b.inbox.accept('108', incoming(NOW), NOW).repeated, false);
        assert.equal(
          b.db
            .prepare('SELECT count(*) n FROM max_event_inbox WHERE bot_hash=? AND created_at>?')
            .get(botHash, NOW - 60000).n,
          600,
        );
      },
    );
    await t.test(
      'retention and insert roll back together; closed terminal cleanup cannot mutate active or live rows',
      async () => {
        reset();
        a.inbox.accept('109', incoming(NOW), NOW);
        const row = a.db.prepare('SELECT * FROM max_event_inbox').get();
        a.db
          .prepare("UPDATE max_event_inbox SET status='done',expires_at=? WHERE id=?")
          .run(NOW - 1, row.id);
        b.setFailure(true);
        try {
          assert.throws(
            () => b.inbox.accept('110', incoming(NOW), NOW),
            /Synthetic post-event failure/,
          );
        } finally {
          b.setFailure(false);
        }
        assert.equal(stored(row.id).status, 'done');
        assert.equal(b.db.prepare('SELECT count(*) n FROM max_event_inbox').get().n, 1);
        b.inbox.accept('110', incoming(NOW), NOW);
        assert.equal(stored(row.id), undefined);
        const active = b.db.prepare('SELECT * FROM max_event_inbox').get();
        a.db.beginQueueEntity(scope('admission', active.bot_hash));
        try {
          assert.equal(
            a.db
              .prepare(terminalPurge(1).sql)
              .run(active.id, 'pending', active.expires_at, NOW + 864000000).changes,
            0,
          );
        } finally {
          a.db.exec('ROLLBACK');
        }
        const raw = await f.raw();
        raw.request({
          op: 'begin',
          scope: f.platform,
          mode: 'QUEUEENTITY',
          scopedQueue: eventScope(active),
        });
        try {
          assert.throws(() =>
            raw.request({
              op: 'execute',
              scope: f.platform,
              plan: compile(
                terminalPurge(1).sql,
                f.platform,
                [active.id, 'done', active.expires_at, NOW],
                'run',
                f.catalog,
              ),
              method: 'run',
              mutating: true,
            }),
          );
        } finally {
          raw.request({ op: 'rollback', scope: f.platform });
        }
        assert.equal(stored(active.id).status, 'pending');
      },
    );
    await t.test(
      'legacy domain, global writer and maintenance still exclude entity writes without poisoning their owner',
      async () => {
        for (const start of [
          () => a.db.beginQueue('max-inbox'),
          () => a.db.exec('BEGIN IMMEDIATE'),
        ]) {
          start();
          try {
            assert.throws(() => b.inbox.acquire('111', 'blocked', NOW), cleanBusy);
          } finally {
            a.db.exec('ROLLBACK');
          }
        }
        await f.admin.query('SELECT pg_advisory_lock($1::bigint)', [KEYS.maintenance]);
        try {
          assert.throws(() => b.inbox.accept('111', incoming(NOW), NOW), cleanBusy);
        } finally {
          await f.admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]);
        }
        assert.equal(b.inbox.acquire('111', 'healthy', NOW), true);
      },
    );
  },
);
