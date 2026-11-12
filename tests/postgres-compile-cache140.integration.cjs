const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { queueFixture } = require('./helpers/postgres-queue134-fixture.cjs');
const { compileCacheStats } = require('../src/server/infrastructure/postgres/dialect.cjs');
const { createSessions } = require('../src/server/modules/auth/sessions.cjs');
const { fail } = require('../src/shared/errors.cjs');

test(
  'actual PostgreSQL shared SQL structures preserve cold scopes, authority, RR and failures',
  { timeout: 120000 },
  async (t) => {
    const f = await queueFixture(t),
      p = f.a.p;
    for (let n = 0; n < 2; n++)
      f.a.c[n]
        .prepare('INSERT INTO patients(id,value) VALUES(?,?)')
        .run('same-id', Buffer.from('tenant-' + n));

    await t.test(
      'cold handles reuse structure but fresh scope values and RLS select the owning tenant',
      () => {
        f.a.c.forEach((db) => db.close());
        const before = compileCacheStats();
        for (let n = 0; n < 20; n++) {
          const db = f.a.owner.open(f.cabinets[n % 2]);
          try {
            db.exec('BEGIN READONLY');
            const row = db
              .prepare('SELECT value FROM patients WHERE id=? /* native-cold140 */')
              .get('same-id');
            assert.equal(row.value.toString(), 'tenant-' + (n % 2));
            const catalog = db
              .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
              .all();
            assert.ok(catalog.some((entry) => entry.name === 'patients'));
          } finally {
            if (db.isTransaction) db.exec('ROLLBACK');
            db.close();
          }
        }
        const after = compileCacheStats();
        assert.ok(
          after.hits - before.hits >= 38,
          'two fixed SQL shapes survive all twenty cold handle opens',
        );
        t.diagnostic(
          JSON.stringify({
            coldHandleOpens: 20,
            structuralCacheHits: after.hits - before.hits,
            structuralCacheMisses: after.misses - before.misses,
            allNativeScopeInspectionsRetained: true,
          }),
        );
      },
    );

    await t.test(
      'native cached read grammar still validates changed plan effects, SQL text and fresh values',
      async () => {
        const raw = await f.raw(),
          scope = f.platform;
        const plan = {
          text: 'SELECT $1::text AS value /* native-structural142 */',
          values: ['first'],
          effect: 'read',
        };
        raw.request({ op: 'begin', scope, mode: 'READONLY' });
        try {
          const execute = () =>
            raw.request({ op: 'execute', scope, plan, method: 'get', mutating: false });
          assert.equal(execute().rows[0].value, 'first');
          plan.values = ['second'];
          assert.equal(execute().rows[0].value, 'second');
          plan.effect = 'write';
          assert.throws(execute, { code: 'POSTGRES_QUERY_ONLY' });
          plan.effect = 'read';
          const original = plan.text;
          plan.text = "SELECT set_config('cartoteca.store_id',$1,false)";
          assert.throws(execute, { code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN' });
          plan.text = original;
          assert.equal(
            execute().rows[0].value,
            'second',
            'structural refusal did not execute SQL or abort the owning snapshot',
          );
        } finally {
          raw.request({ op: 'rollback', scope });
        }
      },
    );
    await t.test(
      'cached joined session SQL observes membership revocation without authority caching',
      () => {
        const account = randomUUID(),
          token = randomUUID();
        p.prepare('INSERT INTO accounts(id,email_hash,value,created_at) VALUES(?,?,?,?)').run(
          account,
          randomUUID(),
          Buffer.from(
            JSON.stringify({ email: 'synthetic@example.invalid', displayName: 'Synthetic' }),
          ),
          1,
        );
        p.prepare(
          'INSERT INTO memberships(organization_id,account_id,role,status,created_at) VALUES(?,?,?,?,?)',
        ).run(f.organizations[0], account, 'owner', 'active', 1);
        p.prepare(
          'INSERT INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)',
        ).run(
          token,
          randomUUID(),
          account,
          f.organizations[0],
          Buffer.from('{}'),
          Date.now() + 60000,
        );
        const sessions = createSessions({
          db: p,
          tokenHash: String,
          open: (value) => JSON.parse(value.toString()),
          availableMemberships: () => [],
          fail,
        });
        assert.equal(sessions.session(token).accountId, account);
        p.prepare('UPDATE memberships SET status=? WHERE organization_id=? AND account_id=?').run(
          'revoked',
          f.organizations[0],
          account,
        );
        assert.equal(sessions.session(token), null);
      },
    );

    await t.test(
      'a template holds no result bytes and preserves one physical RR snapshot',
      async () => {
        const key = 'compiler-rr140',
          first = Buffer.from('first'),
          second = Buffer.from('second');
        p.prepare('INSERT INTO telegram_runtime(key,value) VALUES(?,?)').run(key, first);
        const read = () =>
          p.prepare('SELECT value FROM telegram_runtime WHERE key=?').get(key).value;
        assert.deepEqual(read(), first);
        const b = await f.open();
        p.exec('BEGIN READONLY');
        try {
          assert.deepEqual(read(), first);
          b.p.prepare('UPDATE telegram_runtime SET value=? WHERE key=?').run(second, key);
          assert.deepEqual(read(), first);
        } finally {
          p.exec('ROLLBACK');
        }
        assert.deepEqual(read(), second);
      },
    );

    await t.test(
      'cached writes remain forbidden in READONLY and a caught SQL error stays aborted',
      () => {
        const db = f.a.owner.open(f.cabinets[0]);
        try {
          const write = db.prepare('UPDATE patients SET value=? WHERE id=?');
          write.run(Buffer.from('warm-write'), 'same-id');
          const division = db.prepare('SELECT 10 / ? AS value');
          assert.equal(division.get(2).value, 5);
          db.exec('BEGIN READONLY');
          assert.throws(() => write.run(Buffer.from('denied'), 'same-id'), {
            code: 'POSTGRES_QUERY_ONLY',
          });
          assert.throws(
            () => division.get(0),
            (error) => error.code === '22012',
          );
          assert.throws(
            () => division.get(2),
            (error) => error.code === '25P02',
          );
          db.exec('ROLLBACK');
          assert.equal(division.get(2).value, 5);
          assert.equal(
            db.prepare('SELECT value FROM patients WHERE id=?').get('same-id').value.toString(),
            'warm-write',
          );
        } finally {
          if (db.isTransaction) db.exec('ROLLBACK');
          db.close();
        }
      },
    );
  },
);
