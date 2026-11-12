const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  hotDirectoryFixture170,
  hotSQL169,
  bounded169,
} = require('./helpers/postgres-hot-directory170-fixture.cjs');
const one = (k) => {
  assert.equal(k.trace.length, 1);
  assert.ok(hotSQL169(k.trace[0].text));
};

test(
  '170 cached directory keeps physical owner, fresh assets and final expiry through awaits',
  { timeout: 240000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    try {
      await t.test(
        'eviction during metadata await cannot pin an old body or bypass a fresh cold read',
        async () => {
          const k = await f.make(),
            cold = await f.warm(k),
            gate = k.arm('result');
          const pending = f.raw(k);
          await bounded169(gate.entered);
          k.operations.readCacheBudget.clear();
          assert.equal(k.operations.viewStats().directoryResponses165.entries, 0);
          gate.release();
          const reply = await pending;
          assert.equal(reply.status, 200);
          assert.deepEqual(reply.bytes, cold.bytes);
          assert.ok(
            k.trace.some((r) => r.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
          );
          await k.close();
        },
      );
      await t.test(
        'expiry during a real filesystem await after SQL denies before body lookup',
        async (st) => {
          const k = await f.make();
          await f.warm(k);
          const gate = k.arm('result');
          const expires = Number(
            (
              await f.admin.query(
                'SELECT expires_at FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND account_id=$2',
                [f.platform.storeId, f.actors[0].accountId],
              )
            ).rows[0].expires_at,
          );
          const pending = f.raw(k);
          await bounded169(gate.entered);
          const before = f.assetStamps(),
            real = fs.promises.lstat.bind(fs.promises);
          let signal,
            release,
            intercepted = false,
            now;
          const entered = new Promise((resolve) => {
            signal = resolve;
          });
          const wait = new Promise((resolve) => {
            release = resolve;
          });
          const mock = st.mock.method(fs.promises, 'lstat', async (p, ...args) => {
            const stat = await real(p, ...args);
            if (
              !intercepted &&
              path.resolve(String(p)) === path.join(f.dir, 'platform/platform.key')
            ) {
              intercepted = true;
              signal();
              await wait;
            }
            return stat;
          });
          try {
            gate.release();
            await bounded169(entered);
            assert.equal(k.operations.ownerStats166().borrowed, 1);
            now = st.mock.method(Date, 'now', () => expires + 1);
            release();
            const denied = await pending;
            assert.equal(denied.status, 401);
            assert.equal(denied.body.directory, undefined);
            one(k);
          } finally {
            now?.mock.restore();
            release();
            mock.mock.restore();
            gate.release();
            await k.close();
            assert.deepEqual(f.assetStamps(), before);
          }
        },
      );
      await t.test(
        'changed cabinet-key stat evidence after SQL rejects while actual files stay identical',
        async (st) => {
          const k = await f.make();
          await f.warm(k);
          const gate = k.arm('result');
          const pending = f.raw(k);
          await bounded169(gate.entered);
          const before = f.assetStamps(),
            file = path.join(f.dir, 'encryption.key');
          const real = fs.promises.lstat.bind(fs.promises);
          let injected = false;
          const mock = st.mock.method(fs.promises, 'lstat', async (p, ...args) => {
            const stat = await real(p, ...args);
            if (!injected && path.resolve(String(p)) === file) {
              injected = true;
              return new Proxy(stat, {
                get(target, key) {
                  if (key === 'ctimeNs') return target.ctimeNs + 1n;
                  const value = Reflect.get(target, key, target);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              });
            }
            return stat;
          });
          try {
            gate.release();
            const denied = await pending;
            assert.equal(denied.status, 503);
            assert.equal(denied.body.directory, undefined);
            one(k);
            assert.equal(injected, true);
          } finally {
            mock.mock.restore();
            gate.release();
            await k.close();
            assert.deepEqual(f.assetStamps(), before);
          }
        },
      );
      await t.test(
        'cancelled job keeps owner until its SQL settles and a later job can reuse it safely',
        async () => {
          const k = await f.make();
          await f.warm(k);
          const gate = k.arm('result');
          const cancel = new SharedArrayBuffer(4);
          let done = false;
          const pending = f.raw(k, f.directoryUrl, f.actors[0], { cancel }).then((r) => {
            done = true;
            return r;
          });
          await bounded169(gate.entered);
          Atomics.store(new Int32Array(cancel), 0, 1);
          assert.equal(done, false);
          assert.equal(k.operations.ownerStats166().borrowed, 1);
          gate.release();
          const denied = await pending;
          assert.equal(denied.status, 499);
          one(k);
          assert.equal(k.operations.ownerStats166().borrowed, 0);
          k.clear();
          assert.equal((await f.raw(k)).status, 200);
          one(k);
          await k.close();
        },
      );
      await t.test(
        'SQL error never falls back, waits for physical end, and does not replace or replay the owner',
        async () => {
          const k = await f.make();
          await f.warm(k);
          const submit = k.arm('submit');
          k.faultNextHot();
          let done = false;
          const failed = f.raw(k).then((r) => {
            done = true;
            k.events.push({ event: 'reply' });
            return r;
          });
          const selected = await bounded169(submit.entered);
          const end = k.arm('end', (_, index) => index === selected.index);
          submit.release();
          await bounded169(end.entered);
          assert.equal(done, false);
          assert.equal(k.operations.ownerStats166().borrowed, 1);
          const sibling = await f.raw(k);
          assert.equal(sibling.status, 200);
          let closed = false;
          const closing = k.close().then(() => {
            closed = true;
          });
          await Promise.resolve();
          assert.equal(closed, false);
          end.release();
          assert.ok([500, 503].includes((await failed).status));
          await bounded169(closing);
          assert.equal(k.clients.length, 2);
          assert.equal(k.trace.length, 2);
          const physical = k.events.findIndex(
            (e) => e.index === selected.index && e.event === 'physical-end',
          );
          const terminal = k.events.findIndex((e) => e.event === 'reply');
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
      await t.test('a rejected COMMIT acknowledgment publishes no candidate or body', async () => {
        const k = await f.make();
        let fail = true;
        const original = k.clients.map((c) => c.query);
        k.clients.forEach((client, index) => {
          client.query = (input, ...args) => {
            const text = typeof input === 'string' ? input : input.text;
            if (fail && text === 'COMMIT') {
              fail = false;
              return Promise.reject(
                Object.assign(Error('Synthetic170 ACK failure'), { code: '08006' }),
              );
            }
            return original[index](input, ...args);
          };
        });
        try {
          assert.ok([500, 503].includes((await f.raw(k)).status));
          assert.equal(k.operations.viewStats().directoryResponses165.entries, 0);
        } finally {
          k.clients.forEach((c, i) => {
            c.query = original[i];
          });
        }
        k.clear();
        assert.equal((await f.raw(k)).status, 200);
        assert.ok(
          k.trace.some((r) => r.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
        );
        k.clear();
        assert.equal((await f.raw(k)).status, 200);
        one(k);
        await k.close();
      });
    } finally {
      await f.close();
    }
  },
);
