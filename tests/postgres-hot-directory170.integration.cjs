const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');
const {
  hotDirectoryFixture170,
  hotSQL169,
  bounded169,
} = require('./helpers/postgres-hot-directory170-fixture.cjs');
const rr = (k) => k.trace.some((r) => r.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
const one = (k) => {
  assert.equal(k.trace.length, 1);
  assert.ok(hotSQL169(k.trace[0].text));
};

test(
  '170 actual PG directory reuses only ACKed source with fresh authority and exact query binding',
  { timeout: 240000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    try {
      await t.test(
        'oneSQL hot body is byte-identical, owned and not a parsed graph response',
        async (st) => {
          const k = await f.make(),
            cold = await f.warm(k),
            expected = Buffer.from(cold.bytes);
          const original = JSON.parse,
            forbidden = expected.toString('utf8');
          let bodyParses = 0;
          const mock = st.mock.method(JSON, 'parse', (value, ...args) => {
            if (value === forbidden) {
              bodyParses++;
              throw Error('Cached clinical JSON graph was parsed');
            }
            return original(value, ...args);
          });
          let reply;
          try {
            reply = await k.kernel.run(f.metadata(f.directoryUrl), null, {
              memoryClass: 'query-probe',
              requestMemoryClass: async () => {},
            });
          } finally {
            mock.mock.restore();
          }
          const bytes = Buffer.from(reply.body);
          assert.equal(reply.status, 200);
          one(k);
          assert.equal(bodyParses, 0);
          assert.deepEqual(bytes, expected);
          assert.equal(k.operations.ownerStats166().borrowed, 0);
          assert.match(bytes.toString('utf8'), /Бета/);
          bytes.fill(0);
          cold.bytes.fill(0);
          k.clear();
          const again = await f.raw(k);
          one(k);
          assert.deepEqual(again.bytes, expected);
          assert.equal(again.headers['Content-Type'], 'application/json; charset=utf-8');
          await k.close();
        },
      );
      await t.test(
        'q trim/case shares page1 and page2 while cursor scope remains exact',
        async () => {
          const k = await f.make(),
            url = f.directoryUrl.replace('limit=100', 'limit=1');
          const first = await f.warm(k, url);
          assert.ok(first.body.nextCursor);
          const equivalent = url.replace('q=Synthetic', 'q=%20synthetic%20');
          const hot = await f.raw(k, equivalent);
          one(k);
          assert.deepEqual(hot.bytes, first.bytes);
          const next = equivalent + '&cursor=' + encodeURIComponent(first.body.nextCursor);
          const page2 = await f.raw(k, next);
          assert.equal(page2.status, 200);
          assert.notEqual(page2.body.directory[0].id, first.body.directory[0].id);
          k.clear();
          const secondHot = await f.raw(k, next.replace('q=%20synthetic%20', 'q=SYNTHETIC'));
          one(k);
          assert.deepEqual(secondHot.bytes, page2.bytes);
          const wrong = next.replace('q=%20synthetic%20', 'q=Synthetic%20%20Patient');
          assert.equal((await f.raw(k, wrong)).status, 400);
          await k.close();
        },
      );
      await t.test(
        'same cookie role/session changes cannot return the prior owner body',
        async () => {
          const k = await f.make();
          const owner = await f.warm(k);
          assert.equal(owner.body.directory.find((p) => p.id === 'patient').appointments.length, 2);
          f.a.p
            .prepare('UPDATE memberships SET role=? WHERE organization_id=? AND account_id=?')
            .run('cosmetologist', f.organizations[0], f.actors[0].accountId);
          try {
            const staff = await f.raw(k);
            assert.equal(staff.status, 200);
            assert.ok(rr(k));
            assert.equal(staff.body.directory.length, 1);
            assert.equal(staff.body.directory[0].id, 'patient');
            assert.equal(staff.body.directory[0].appointments.length, 1);
          } finally {
            f.a.p
              .prepare('UPDATE memberships SET role=? WHERE organization_id=? AND account_id=?')
              .run('owner', f.organizations[0], f.actors[0].accountId);
          }
          await f.warm(k);
          const old = f.a.p
            .prepare('SELECT id FROM platform_sessions WHERE token_hash=?')
            .get(f.database.tokenHash(f.actors[0].token)).id;
          f.a.p
            .prepare('UPDATE platform_sessions SET id=? WHERE token_hash=?')
            .run(randomUUID(), f.database.tokenHash(f.actors[0].token));
          try {
            k.clear();
            assert.equal((await f.raw(k)).status, 200);
            assert.ok(rr(k));
          } finally {
            f.a.p
              .prepare('UPDATE platform_sessions SET id=? WHERE token_hash=?')
              .run(old, f.database.tokenHash(f.actors[0].token));
          }
          await k.close();
        },
      );
      await t.test(
        'committed revoke before actual metadata submission denies without cached body or retry',
        async () => {
          const k = await f.make();
          await f.warm(k);
          const gate = k.arm('submit');
          const running = f.raw(k);
          await bounded169(gate.entered);
          f.a.p
            .prepare(
              "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
            )
            .run(f.organizations[0], f.actors[0].accountId);
          try {
            gate.release();
            const denied = await running;
            assert.equal(denied.status, 401);
            assert.equal(denied.body.directory, undefined);
            one(k);
          } finally {
            gate.release();
            f.a.p
              .prepare(
                "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], f.actors[0].accountId);
            await k.close();
          }
        },
      );
      await t.test(
        'rollback preserves a hot source; raw committed summary DML invalidates it',
        async () => {
          const k = await f.make(),
            cold = await f.warm(k);
          const sql =
            "UPDATE cabinet_summaries SET value=? WHERE patient_id='patient' AND audience='*'";
          const source = f.a.c[0]
            .prepare(
              "SELECT value FROM cabinet_summaries WHERE patient_id='patient' AND audience='*'",
            )
            .get().value;
          const changed = f.storage.encode({ ...f.storage.decode(source), visitCount: 123 });
          f.a.c[0].exec('BEGIN');
          f.a.c[0].prepare(sql).run(changed);
          f.a.c[0].exec('ROLLBACK');
          assert.deepEqual((await f.raw(k)).bytes, cold.bytes);
          one(k);
          f.a.c[0].prepare(sql).run(changed);
          k.clear();
          const updated = await f.raw(k);
          assert.equal(updated.status, 200);
          assert.ok(rr(k));
          assert.equal(updated.body.directory.find((p) => p.id === 'patient').visitCount, 123);
          k.clear();
          assert.deepEqual((await f.raw(k)).bytes, updated.bytes);
          one(k);
          await k.close();
        },
      );
      await t.test('late older RR publication cannot overwrite freshness proof', async () => {
        const k = await f.make();
        const gate = k.arm('result', (text) => text === 'COMMIT');
        const older = f.raw(k);
        await bounded169(gate.entered);
        const source = f.a.c[0]
          .prepare(
            "SELECT value FROM cabinet_summaries WHERE patient_id='patient' AND audience='*'",
          )
          .get().value;
        const priorCount = f.storage.decode(source).visitCount;
        f.a.c[0]
          .prepare(
            "UPDATE cabinet_summaries SET value=? WHERE patient_id='patient' AND audience='*'",
          )
          .run(f.storage.encode({ ...f.storage.decode(source), visitCount: 456 }));
        const newer = await f.raw(k);
        assert.equal(newer.status, 200);
        assert.equal(newer.body.directory.find((p) => p.id === 'patient').visitCount, 456);
        gate.release();
        const old = await older;
        assert.equal(old.status, 200);
        assert.equal(old.body.directory.find((p) => p.id === 'patient').visitCount, priorCount);
        k.clear();
        const current = await f.raw(k);
        assert.equal(current.status, 200);
        assert.equal(current.body.directory.find((p) => p.id === 'patient').visitCount, 456);
        assert.ok(rr(k), 'old published stamp forces cold rather than stale body');
        await k.close();
      });
      await t.test(
        'busy maintenance result is503 and never an ordinary cold fallback',
        async () => {
          const k = await f.make();
          await f.warm(k);
          await f.admin.query('BEGIN');
          await f.admin.query('SELECT pg_advisory_xact_lock($1::bigint)', [KEYS.maintenance]);
          try {
            const denied = await f.raw(k);
            assert.equal(denied.status, 503);
            one(k);
          } finally {
            await f.admin.query('ROLLBACK');
          }
          k.clear();
          assert.equal((await f.raw(k)).status, 200);
          one(k);
          await k.close();
        },
      );
      await t.test('unsupported picker keeps ordinary cold behavior', async () => {
        const k = await f.make();
        await f.warm(k);
        const picker = await f.raw(k, f.directoryUrl + '&picker=1');
        assert.equal(picker.status, 200);
        assert.ok(Array.isArray(picker.body.patients));
        assert.ok(rr(k));
        assert.equal(
          k.trace.some((r) => hotSQL169(r.text)),
          false,
        );
        await k.close();
      });
      await t.test(
        'compatibility producer without the accepted167 tail cannot publish a hot claim',
        async () => {
          const k = await f.make(),
            borrow = k.operations.borrow166;
          k.operations.borrow166 = () => {
            const owned = borrow();
            if (!owned) return owned;
            return {
              ...owned,
              run(context, execution) {
                const copy = { ...context };
                delete copy.assertFreshAfterCommit167;
                return owned.run(copy, execution);
              },
            };
          };
          let cold;
          try {
            cold = await f.raw(k);
            assert.equal(cold.status, 200);
          } finally {
            k.operations.borrow166 = borrow;
          }
          assert.equal(k.operations.viewStats().directoryResponses165.entries, 1);
          k.clear();
          const normal = await f.raw(k);
          assert.equal(normal.status, 200);
          assert.deepEqual(normal.bytes, cold.bytes);
          assert.ok(rr(k));
          assert.equal(
            k.trace.some((r) => hotSQL169(r.text)),
            false,
            'no claim from weaker publication',
          );
          await k.close();
        },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  '170 wrong-tab lookup never opens a naturally missing foreign cabinet key',
  { timeout: 120000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t, { otherCabinet: false });
    try {
      const k = await f.make(),
        before = f.assetStamps();
      await f.warm(k);
      const r = await f.raw(k, f.directoryUrl, f.actors[0], {
        change: (m) => {
          m.headers['x-cartoteca-organization-id'] = f.organizations[1];
        },
      });
      assert.equal(r.status, 428);
      assert.equal(r.body.directory, undefined);
      assert.equal(r.body.code, 'AUTH_CONTEXT_CHANGED');
      assert.deepEqual(f.assetStamps(), before);
      await k.close();
    } finally {
      await f.close();
    }
  },
);
