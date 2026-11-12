const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const {
  createProcessRoleAuthority,
  roleLockKey,
  LEASE_MS,
} = require('../src/server/infrastructure/postgres/process-role-authority.cjs');
const uuid = (n) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
const STORE = uuid(1),
  OWNER = uuid(2);
const code = (value) => (error) => error?.code === value && error.status === 503;
function clockOf(t) {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return {
    advance(ms, runTimers = true) {
      now += ms;
      if (runTimers) t.mock.timers.tick(ms);
    },
  };
}
function fakeDatabase() {
  const database = { rows: new Map(), now: 1000000, blocked: false };
  const locks = new Map();
  const rowKey = (store, owner) => store + ':' + owner;
  const clone = (rows) =>
    new Map([...rows].map(([key, row]) => [key, { ...row, hash: Buffer.from(row.hash) }]));
  let pid = 10;
  class Client extends EventEmitter {
    constructor() {
      super();
      this.pid = ++pid;
      this.queries = [];
      this.tx = null;
      this.scope = null;
      this.destroyed = false;
      this.endCalls = 0;
      this.endMode = 'resolve';
      this.commitMode = 'normal';
      this.rollbackMode = 'normal';
      this.beforeQuery = null;
      this.connection = { stream: { destroy: () => this.disconnect() } };
    }
    disconnect() {
      this.destroyed = true;
      this.tx = null;
      for (const [key, owner] of locks) if (owner === this) locks.delete(key);
    }
    async query(sql, values = []) {
      this.queries.push({ sql, values });
      if (this.beforeQuery) await this.beforeQuery(sql, values);
      if (this.destroyed) throw Error('Fake disconnected session.');
      if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') {
        assert.equal(this.tx, null);
        this.tx = clone(database.rows);
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        if (this.rollbackMode === 'fail') throw Error('Fake rollback failure.');
        this.tx = null;
        for (const [key, owner] of locks) if (owner === this) locks.delete(key);
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        assert.ok(this.tx);
        database.rows = this.tx;
        this.tx = null;
        for (const [key, owner] of locks) if (owner === this) locks.delete(key);
        if (this.commitMode === 'commit-then-throw')
          throw Error('Fake lost commit acknowledgement.');
        return { rows: [] };
      }
      assert.ok(this.tx, 'Every technical operation uses its own transaction.');
      if (sql.includes("set_config('cartoteca.kind','platform',true)")) {
        this.scope = values[0];
        return { rows: [] };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        const other = locks.get(values[0]);
        const locked = !database.blocked && (!other || other === this);
        if (locked) locks.set(values[0], this);
        return { rows: [{ locked }] };
      }
      assert.ok(sql.includes('cartoteca_catalog.process_role_leases'));
      assert.equal(this.scope, values[0]);
      const [store, owner, role, hash] = values;
      const key = rowKey(store, owner),
        current = this.tx.get(key);
      const matches =
        current &&
        current.role === role &&
        current.hash.equals(hash) &&
        current.expires > database.now;
      if (sql.startsWith('SELECT owner,role'))
        return {
          rows: [...this.tx.values()]
            .filter((r) => r.store === store && r.expires > database.now)
            .slice(0, 65)
            .map((r) => ({ owner: r.owner, role: r.role })),
        };
      if (sql.startsWith('SELECT 1 AS present')) return { rows: matches ? [{ present: 1 }] : [] };
      if (sql.startsWith('INSERT INTO')) {
        assert.ok(Buffer.isBuffer(hash) && hash.length === 32);
        assert.ok(!current);
        this.tx.set(key, {
          store,
          owner,
          role,
          hash: Buffer.from(hash),
          expires: database.now + LEASE_MS,
        });
        return { rows: [{ inserted: 1 }] };
      }
      if (sql.startsWith('UPDATE')) {
        if (matches) current.expires = database.now + LEASE_MS;
        return { rows: matches ? [{ renewed: 1 }] : [] };
      }
      if (sql.startsWith('DELETE') && sql.includes('RETURNING 1 AS released')) {
        if (matches) this.tx.delete(key);
        return { rows: matches ? [{ released: 1 }] : [] };
      }
      if (sql.startsWith('DELETE') && sql.includes('expires_at<=clock_timestamp()')) {
        for (const [id, row] of this.tx)
          if (row.store === store && row.expires <= database.now) this.tx.delete(id);
        return { rows: [] };
      }
      throw Error('Unknown fake technical SQL.');
    }
    end() {
      this.endCalls++;
      this.disconnect();
      if (this.endMode === 'hang') return new Promise(() => {});
      return this.endMode === 'reject'
        ? Promise.reject(Error('Fake close failed.'))
        : Promise.resolve();
    }
  }
  return {
    database,
    create: () => new Client(),
    rows: () => [...database.rows.values()],
    expire(store) {
      for (const row of database.rows.values())
        if (row.store === store) row.expires = database.now - 1;
    },
  };
}
async function authority(db, store = STORE) {
  const client = db.create();
  return {
    client,
    value: await createProcessRoleAuthority(client, {
      platformStoreId: store,
      lineageVerified: true,
    }),
  };
}
async function acquire(entry, owner = OWNER, role = 'background') {
  return entry.value.dispatch({ op: 'acquire', owner, role });
}

test('lease TTL and own key are fixed and scope-bound, without public clock overrides', async () => {
  assert.equal(LEASE_MS, 60000);
  assert.equal(roleLockKey(STORE), roleLockKey(STORE.toUpperCase()));
  assert.notEqual(roleLockKey(STORE), roleLockKey(uuid(3)));
  const db = fakeDatabase(),
    client = db.create();
  await assert.rejects(
    createProcessRoleAuthority(client, {
      platformStoreId: STORE,
      lineageVerified: true,
      clock: () => 0,
    }),
    code('POSTGRES_ROLE_AUTHORITY_ARGUMENT'),
  );
  assert.equal(client.queries.length, 0);
});

test('combined allows64 owners, background excludes them, and another platform remains independent', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    entries = [];
  t.after(async () => {
    for (const entry of entries) await entry.value.close();
  });
  for (let n = 0; n < 64; n++) {
    const entry = await authority(db);
    entries.push(entry);
    await acquire(entry, uuid(100 + n), 'combined');
  }
  assert.equal(db.rows().length, 64);
  const overflow = await authority(db);
  await assert.rejects(
    acquire(overflow, uuid(200), 'combined'),
    code('POSTGRES_ROLE_AUTHORITY_CAPACITY'),
  );
  const excluded = await authority(db);
  await assert.rejects(acquire(excluded, uuid(201)), code('POSTGRES_ROLE_AUTHORITY_CONFLICT'));
  assert.equal(db.rows().length, 64);
  const independent = await authority(db, uuid(300));
  entries.push(independent);
  await acquire(independent, uuid(301));
  assert.equal(db.rows().length, 65);
});

test('session loss keeps durable TTL: new background is denied until expiry and stale token never resurrects', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    first = await authority(db);
  const oldToken = await acquire(first),
    savedHash = Buffer.from(db.rows()[0].hash),
    expiry = db.rows()[0].expires;
  first.client.disconnect();
  first.client.emit('error', Error('Fake socket failure.'));
  await first.value.close();
  assert.equal(db.rows()[0].expires, expiry);
  assert.ok(db.rows()[0].hash.equals(savedHash));
  const tooEarly = await authority(db);
  await assert.rejects(acquire(tooEarly, uuid(4)), code('POSTGRES_ROLE_AUTHORITY_CONFLICT'));
  db.expire(STORE);
  const replacement = await authority(db);
  t.after(() => replacement.value.close());
  const newToken = await acquire(replacement, uuid(4));
  assert.ok(newToken !== oldToken);
  assert.equal(await first.value.dispatch({ op: 'renew', owner: OWNER, token: oldToken }), false);
  assert.equal(
    await replacement.value.dispatch({ op: 'renew', owner: OWNER, token: oldToken }),
    false,
  );
  assert.equal(db.rows().length, 1);
});

test('matching acquire is idempotent without extending durable or local TTL and only token hash enters SQL', async (t) => {
  const clock = clockOf(t),
    db = fakeDatabase(),
    entry = await authority(db);
  t.after(() => entry.value.close());
  const token = await acquire(entry),
    expiry = db.rows()[0].expires;
  clock.advance(10000);
  db.database.now += 10000;
  const remaining = entry.value.status().remainingMs;
  const again = await acquire(entry);
  assert.ok(again === token);
  assert.equal(db.rows()[0].expires, expiry);
  assert.equal(entry.value.status().remainingMs, remaining);
  assert.equal(entry.client.queries.filter((q) => q.sql.startsWith('INSERT INTO')).length, 1);
  assert.equal(
    entry.client.queries.some((q) => q.values.includes(token)),
    false,
  );
});

test('wrong owner/token cannot renew or release, while matching renew CAS extends both confirmed TTLs', async (t) => {
  const clock = clockOf(t),
    db = fakeDatabase(),
    entry = await authority(db);
  t.after(() => entry.value.close());
  const token = await acquire(entry),
    before = db.rows()[0].expires;
  clock.advance(10000);
  db.database.now += 10000;
  for (const op of ['renew', 'release']) {
    assert.equal(await entry.value.dispatch({ op, owner: uuid(5), token }), false);
    assert.equal(await entry.value.dispatch({ op, owner: OWNER, token: uuid(6) }), false);
  }
  assert.equal(db.rows()[0].expires, before);
  assert.equal(await entry.value.dispatch({ op: 'renew', owner: OWNER, token }), true);
  assert.equal(db.rows()[0].expires, db.database.now + LEASE_MS);
  assert.equal(entry.value.status().remainingMs, LEASE_MS);
});

test('DB-expired row cannot be renewed, recreated or deleted by stale release', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    entry = await authority(db),
    token = await acquire(entry);
  db.expire(STORE);
  assert.equal(await entry.value.dispatch({ op: 'renew', owner: OWNER, token }), false);
  assert.equal(db.rows().length, 1);
  assert.equal(await entry.value.dispatch({ op: 'release', owner: OWNER, token }), false);
  assert.equal(entry.client.queries.filter((q) => q.sql.startsWith('INSERT INTO')).length, 1);
});

test('worker watchdog expiry closes session but retains the durable row until DB TTL', async (t) => {
  const clock = clockOf(t),
    db = fakeDatabase(),
    entry = await authority(db),
    token = await acquire(entry);
  clock.advance(LEASE_MS + 1);
  assert.equal(entry.client.destroyed, true);
  assert.equal(entry.value.status().state, 'expired');
  assert.equal(db.rows().length, 1);
  assert.equal(await entry.value.dispatch({ op: 'renew', owner: OWNER, token }), false);
  await assert.rejects(acquire(entry), code('POSTGRES_ROLE_AUTHORITY_UNAVAILABLE'));
});

test('renew awaiting SQL at watchdog expiry cannot revive local proof or delete committed TTL', async (t) => {
  const clock = clockOf(t),
    db = fakeDatabase(),
    entry = await authority(db),
    token = await acquire(entry);
  const originalExpiry = db.rows()[0].expires;
  let unblock;
  entry.client.beforeQuery = (sql) =>
    sql.startsWith('UPDATE')
      ? new Promise((resolve) => {
          unblock = resolve;
        })
      : undefined;
  const pending = entry.value.dispatch({ op: 'renew', owner: OWNER, token });
  for (let n = 0; n < 10 && !unblock; n++) await Promise.resolve();
  assert.equal(typeof unblock, 'function');
  clock.advance(LEASE_MS + 1);
  unblock();
  assert.equal(await pending.catch(() => false), false);
  assert.equal(entry.value.status().held, false);
  assert.equal(db.rows()[0].expires, originalExpiry);
});

test('only proven no-DML own-key busy may keep old proof, without before-BEGIN mislabelling or TTL extension', async (t) => {
  const clock = clockOf(t),
    db = fakeDatabase(),
    entry = await authority(db);
  t.after(() => entry.value.close());
  const token = await acquire(entry),
    expiry = db.rows()[0].expires;
  clock.advance(10000);
  db.database.now += 10000;
  db.database.blocked = true;
  const remaining = entry.value.status().remainingMs;
  await assert.rejects(entry.value.dispatch({ op: 'renew', owner: OWNER, token }), (error) => {
    assert.equal(error.code, 'POSTGRES_ROLE_AUTHORITY_BUSY');
    assert.equal(error.leaseUnchanged, true);
    assert.equal(error.transactionOpen, false);
    assert.equal(error.outcomeUnknown, false);
    assert.equal(error.channelPoisoned, false);
    assert.notEqual(error.retryableBeforeBegin, true);
    return true;
  });
  assert.equal(entry.value.status().held, true);
  assert.equal(entry.value.status().remainingMs, remaining);
  assert.equal(db.rows()[0].expires, expiry);
  assert.equal(entry.client.destroyed, false);
  db.database.blocked = false;
  assert.equal(await entry.value.dispatch({ op: 'renew', owner: OWNER, token }), true);
});

test('rollback failure never gets unchanged proof and closes the authority', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    entry = await authority(db),
    token = await acquire(entry);
  db.database.blocked = true;
  entry.client.rollbackMode = 'fail';
  await assert.rejects(entry.value.dispatch({ op: 'renew', owner: OWNER, token }), (error) => {
    assert.notEqual(error.leaseUnchanged, true);
    assert.equal(error.channelPoisoned, true);
    assert.equal(error.outcomeUnknown, true);
    return true;
  });
  assert.equal(entry.client.destroyed, true);
  assert.equal(db.rows().length, 1);
});

test('unknown acquire COMMIT retains durable lease and excludes fast takeover', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    entry = await authority(db);
  entry.client.commitMode = 'commit-then-throw';
  await assert.rejects(acquire(entry), (error) => {
    assert.equal(error.outcomeUnknown, true);
    assert.equal(error.channelPoisoned, true);
    assert.notEqual(error.leaseUnchanged, true);
    return true;
  });
  assert.equal(entry.value.status().held, false);
  assert.equal(db.rows().length, 1);
  const replacement = await authority(db);
  await assert.rejects(acquire(replacement, uuid(8)), code('POSTGRES_ROLE_AUTHORITY_CONFLICT'));
});

test('normal release CAS deletes only own row; close alone retains rows and is idempotent', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    one = await authority(db),
    two = await authority(db);
  const token1 = await acquire(one, OWNER, 'combined');
  await acquire(two, uuid(9), 'combined');
  assert.equal(await one.value.dispatch({ op: 'release', owner: OWNER, token: token1 }), true);
  assert.equal(db.rows().length, 1);
  assert.equal(db.rows()[0].owner, uuid(9));
  const closing = two.value.close();
  assert.ok(two.value.close() === closing);
  await closing;
  assert.equal(two.client.endCalls, 1);
  assert.equal(db.rows().length, 1);
});

test('close timeout is finite and does not delete the still-valid durable row', async (t) => {
  const clock = clockOf(t),
    db = fakeDatabase(),
    entry = await authority(db);
  await acquire(entry);
  entry.client.endMode = 'hang';
  const closing = entry.value.close(),
    rejected = assert.rejects(closing, code('POSTGRES_ROLE_AUTHORITY_CLOSE_TIMEOUT'));
  clock.advance(2000);
  await rejected;
  assert.equal(db.rows().length, 1);
  assert.equal(entry.value.status().held, false);
});

test('malformed commands and unverified lineage fail before SQL, without raw error context', async (t) => {
  clockOf(t);
  const db = fakeDatabase(),
    bad = db.create();
  await assert.rejects(
    createProcessRoleAuthority(bad, { platformStoreId: STORE, lineageVerified: false }),
    code('POSTGRES_ROLE_AUTHORITY_ARGUMENT'),
  );
  assert.equal(bad.queries.length, 0);
  const entry = await authority(db),
    token = await acquire(entry),
    before = entry.client.queries.length;
  await assert.rejects(
    entry.value.dispatch({ op: 'renew', owner: OWNER, token, sql: 'private-context' }),
    (error) => {
      assert.equal(error.code, 'POSTGRES_ROLE_AUTHORITY_ARGUMENT');
      assert.ok(!error.message.includes('private-context'));
      return true;
    },
  );
  assert.equal(entry.client.queries.length, before);
  assert.equal(db.rows().length, 1);
});
