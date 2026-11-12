// Workspace-only proposal. Requires root's Node169 apply before execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  hotCalendarFixture169,
  hotSQL169,
  bounded169,
} = require('./helpers/postgres-hot-calendar169-fixture.cjs');
function assetStamps169(f) {
  return ['postgresql-runtime.json', 'platform/platform.key', 'encryption.key'].map((p) => {
    const s = fs.lstatSync(path.join(f.dir, p), { bigint: true });
    return [
      p,
      ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'].map((k) =>
        String(s[k]),
      ),
    ];
  });
}
test(
  '169 actual PG calendar hot path preserves fresh auth/assets, two owners and physical error retirement',
  { timeout: 180000 },
  async (t) => {
    const f = await hotCalendarFixture169(t);
    try {
      await t.test(
        'real cold token yields exact oneSQL unchanged without RR or clinical fetch',
        async () => {
          const k = await f.make(),
            cold = await f.cold(k);
          k.clear();
          const before = k.operations.sqlCalls();
          const reply = await f.run(k, cold.url);
          assert.equal(reply.status, 200);
          assert.deepEqual(reply.body, { revision: cold.body.revision, unchanged: true });
          assert.equal(k.operations.sqlCalls() - before, 1);
          assert.equal(k.trace.length, 1);
          assert.ok(hotSQL169(k.trace[0].text));
          assert.equal(k.operations.ownerStats166().borrowed, 0);
          const miss = new URL(cold.url, 'http://synthetic.invalid');
          miss.searchParams.set('projection', 'occupancy');
          k.clear();
          assert.equal((await f.run(k, miss.pathname + miss.search)).status, 200);
          assert.ok(
            k.trace.some((r) => r.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
          );
          assert.equal(
            k.trace.filter((r) => hotSQL169(r.text)).length,
            1,
            'fresh metadata prelude',
          );
          assert.equal(
            k.trace.filter((r) => r.text.includes('WITH auth_guard AS MATERIALIZED')).length,
            1,
            'cold miss retains the fresh post-COMMIT guard without duplicate preauthorization',
          );
          await k.close();
        },
      );
      await t.test(
        'two parallel hot jobs own distinct clients; crossactor/org token cannot reuse prior scope',
        async () => {
          const k = await f.make(),
            owner = await f.cold(k),
            staff = await f.cold(k, f.actors[1]);
          k.clear();
          const a = k.arm('result'),
            b = k.arm('result');
          const left = f.run(k, owner.url),
            right = f.run(k, staff.url, f.actors[1]);
          const [ga, gb] = await Promise.all([bounded169(a.entered), bounded169(b.entered)]);
          assert.notEqual(ga.index, gb.index);
          assert.equal(k.operations.ownerStats166().borrowed, 2);
          a.release();
          b.release();
          const replies = await Promise.all([left, right]);
          assert.ok(replies.every((r) => r.status === 200 && r.body.unchanged === true));
          assert.equal(k.trace.length, 2);
          assert.ok(k.trace.every((r) => hotSQL169(r.text)));
          assert.equal(k.clients.length, 2);
          const crossActor = await f.run(k, owner.url, f.actors[1]);
          assert.equal(crossActor.status, 200);
          assert.notEqual(crossActor.body.unchanged, true);
          assert.ok(crossActor.body.appointments.every((a) => a.staffId === f.actors[1].accountId));
          const different = await f.run(k, owner.url, f.actors[3]);
          assert.equal(different.status, 200);
          assert.notEqual(different.body.unchanged, true);
          assert.ok(different.body.appointments.every((a) => a.patientId === 'other-patient'));
          const wrongTab = await f.run(k, owner.url, f.actors[0], {
            change: (m) => {
              m.headers['x-cartoteca-organization-id'] = f.organizations[1];
            },
          });
          assert.equal(wrongTab.status, 428);
          assert.equal(wrongTab.body.code, 'AUTH_CONTEXT_CHANGED');
          await k.close();
        },
      );
      await t.test(
        'revoke committed BEFORE actual guard submission denies old token without fallback',
        async () => {
          const k = await f.make(),
            cold = await f.cold(k),
            gate = k.arm('submit');
          k.clear();
          const running = f.run(k, cold.url);
          await bounded169(gate.entered);
          f.a.p
            .prepare(
              "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
            )
            .run(f.organizations[0], f.actors[0].accountId);
          try {
            gate.release();
            const reply = await running;
            assert.equal(reply.status, 401);
            assert.equal(reply.body.unchanged, undefined);
            assert.equal(k.trace.length, 1);
            assert.ok(hotSQL169(k.trace[0].text));
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
        'changed postSQL lstat evidence fails fresh asset check without mutating files',
        async (st) => {
          const k = await f.make(),
            cold = await f.cold(k),
            gate = k.arm('result');
          k.clear();
          const running = f.run(k, cold.url);
          await bounded169(gate.entered);
          const file = path.join(f.dir, 'platform', 'platform.key'),
            before = assetStamps169(f);
          const real = fs.promises.lstat.bind(fs.promises);
          let inject = true;
          const mock = st.mock.method(fs.promises, 'lstat', async (p, ...args) => {
            const s = await real(p, ...args);
            if (inject && path.resolve(String(p)) === file) {
              inject = false;
              return new Proxy(s, {
                get(target, key) {
                  if (key === 'ctimeNs') return target.ctimeNs + 1n;
                  const value = Reflect.get(target, key, target);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            }
            return s;
          });
          try {
            gate.release();
            const reply = await running;
            assert.equal(reply.status, 503);
            assert.equal(reply.body.unchanged, undefined);
            assert.equal(k.trace.length, 1);
            assert.equal(inject, false);
          } finally {
            mock.mock.restore();
            gate.release();
            await k.close();
            assert.deepEqual(assetStamps169(f), before);
          }
        },
      );
      await t.test(
        'expiry after SQL and cancellation while SQL result is held never return old unchanged',
        async (st) => {
          const k = await f.make(),
            cold = await f.cold(k),
            gate = k.arm('result');
          k.clear();
          const expires = Number(
            (
              await f.admin.query(
                'SELECT expires_at FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND account_id=$2',
                [f.platform.storeId, f.actors[0].accountId],
              )
            ).rows[0].expires_at,
          );
          const running = f.run(k, cold.url);
          await bounded169(gate.entered);
          const before = assetStamps169(f),
            real = fs.promises.lstat.bind(fs.promises);
          let signalAsset,
            releaseAsset,
            intercepted = false,
            now;
          const enteredAsset = new Promise((resolve) => {
            signalAsset = resolve;
          });
          const waitAsset = new Promise((resolve) => {
            releaseAsset = resolve;
          });
          const mock = st.mock.method(fs.promises, 'lstat', async (p, ...args) => {
            const s = await real(p, ...args);
            if (
              !intercepted &&
              path.resolve(String(p)) === path.join(f.dir, 'platform/platform.key')
            ) {
              intercepted = true;
              signalAsset();
              await waitAsset;
            }
            return s;
          });
          try {
            gate.release();
            await bounded169(enteredAsset);
            assert.equal(k.operations.ownerStats166().borrowed, 1);
            now = st.mock.method(Date, 'now', () => expires + 1);
            releaseAsset();
            assert.equal((await running).status, 401);
            assert.equal(k.trace.length, 1);
          } finally {
            now?.mock.restore();
            releaseAsset();
            mock.mock.restore();
            gate.release();
            await k.close();
            assert.deepEqual(assetStamps169(f), before);
          }
          const next = await f.make(),
            fresh = await f.cold(next),
            hold = next.arm('result'),
            cancel = new SharedArrayBuffer(4);
          next.clear();
          let completed = false;
          const pending = f.run(next, fresh.url, f.actors[0], { cancel }).then((r) => {
            completed = true;
            return r;
          });
          await bounded169(hold.entered);
          Atomics.store(new Int32Array(cancel), 0, 1);
          assert.equal(completed, false);
          assert.equal(next.operations.ownerStats166().borrowed, 1);
          hold.release();
          assert.equal((await pending).status, 499);
          assert.equal(next.operations.ownerStats166().borrowed, 0);
          assert.equal((await f.run(next, fresh.url)).status, 200);
          await next.close();
        },
      );
      await t.test(
        'readViewsEnabled false keeps old RR conditional even with prepared169',
        async () => {
          const producer = await f.make(),
            cold = await f.cold(producer);
          await producer.close();
          const k = await f.make({ readViewsEnabled: false });
          k.clear();
          const reply = await f.run(k, cold.url);
          assert.equal(reply.status, 200);
          assert.ok(reply.body.unchanged === true || Array.isArray(reply.body.appointments));
          assert.equal(
            k.trace.some((r) => hotSQL169(r.text)),
            false,
          );
          assert.ok(
            k.trace.some((r) => r.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
          );
          assert.ok(k.trace.filter((r) => /fence_locked/.test(r.text)).length >= 2);
          await k.close();
        },
      );
      await t.test(
        'real SQL error holds owner through delayed physical end and does not replay',
        async () => {
          const k = await f.make(),
            cold = await f.cold(k),
            submit = k.arm('submit');
          k.clear();
          k.faultNextHot();
          let done = false;
          const failed = f.run(k, cold.url).then((r) => {
            done = true;
            k.events.push({ event: 'reply' });
            return r;
          });
          const selected = await bounded169(submit.entered),
            end = k.arm('end', (_, index) => index === selected.index);
          submit.release();
          await bounded169(end.entered);
          assert.equal(done, false);
          assert.equal(k.operations.ownerStats166().borrowed, 1);
          const sibling = await f.run(k, cold.url);
          assert.equal(sibling.status, 200);
          assert.equal(sibling.body.unchanged, true);
          let closed = false;
          const closing = k.close().then(() => {
            closed = true;
          });
          await Promise.resolve();
          assert.equal(closed, false);
          end.release();
          const reply = await failed;
          assert.ok([500, 503].includes(reply.status));
          await bounded169(closing);
          assert.equal(k.clients.length, 2);
          assert.equal(k.trace.length, 2, 'one failed attempt and one sibling, no replay');
          const physical = k.events.findIndex(
              (e) => e.index === selected.index && e.event === 'physical-end',
            ),
            terminal = k.events.findIndex((e) => e.event === 'reply');
          assert.ok(physical >= 0 && terminal > physical);
          assert.equal(k.operations.ownerStats166().borrowed, 0);
          assert.equal(
            Number(
              (
                await f.admin.query('SELECT count(*) n FROM pg_stat_activity WHERE pid=$1', [
                  selected.client.processID,
                ])
              ).rows[0].n,
            ),
            0,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  '169 wrong tab with naturally absent foreign Ckey returns428 and preserves exact assets',
  { timeout: 120000 },
  async (t) => {
    const f = await hotCalendarFixture169(t, { otherCabinet: false });
    try {
      const k = await f.make(),
        cold = await f.cold(k),
        before = assetStamps169(f);
      const missing = path.join(f.dir, 'tenants', f.organizations[1], 'encryption.key');
      assert.equal(fs.existsSync(missing), false);
      k.clear();
      const reply = await f.run(k, cold.url, f.actors[0], {
        change: (m) => {
          m.headers['x-cartoteca-organization-id'] = f.organizations[1];
        },
      });
      assert.equal(reply.status, 428);
      assert.equal(reply.body.code, 'AUTH_CONTEXT_CHANGED');
      assert.equal(k.trace.length, 1);
      assert.ok(hotSQL169(k.trace[0].text));
      assert.equal(fs.existsSync(missing), false);
      assert.deepEqual(assetStamps169(f), before);
      await k.close();
    } finally {
      await f.close();
    }
  },
);

test(
  '169 absent optional component keeps original warm9SQL conditional',
  { timeout: 120000 },
  async (t) => {
    const f = await hotCalendarFixture169(t, { prepared: false });
    try {
      const k = await f.make(),
        cold = await f.cold(k);
      k.clear();
      const before = k.operations.sqlCalls(),
        reply = await f.run(k, cold.url);
      assert.equal(reply.status, 200);
      assert.equal(reply.body.unchanged, true);
      assert.equal(k.operations.sqlCalls() - before, 9);
      assert.equal(
        k.trace.some((r) => hotSQL169(r.text)),
        false,
      );
      await k.close();
    } finally {
      await f.close();
    }
  },
);
