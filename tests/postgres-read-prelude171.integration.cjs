const test = require('node:test');
const assert = require('node:assert/strict');
const {
  preludeFixture171,
  instrumentPrelude171,
  barrier171,
  counts171,
  hotSQL169,
  bounded169,
} = require('./helpers/postgres-read-prelude171-fixture.cjs');

test(
  '171 one-job prelude removes duplicate cold authorization but not owning RR or fresh tail',
  { timeout: 240000 },
  async (t) => {
    const f = await preludeFixture171(t);
    try {
      for (const kind of ['calendar', 'directory'])
        await t.test(kind + ' miss reuses one fresh prelude and keeps one tail guard', async () => {
          const k = await f.make(),
            { url } = await f.candidate(k, kind);
          const c = instrumentPrelude171(k);
          try {
            const r = await f.raw(k, url);
            assert.equal(r.status, 200);
            assert.equal(r.body.unchanged, undefined);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
            assert.equal(c.accepted.length, 1);
            assert.equal(c.contexts.length, 1);
            assert.equal(c.contexts[0].sessionId, c.accepted[0].sessionId);
            assert.equal(c.contexts[0].role, c.accepted[0].role);
            if (kind === 'directory')
              assert.equal(r.body.directory.find((p) => p.id === 'patient').visitCount, 171);
          } finally {
            c.restore();
            await k.close();
          }
        });
      await t.test(
        'no optional finish callback retains independent ordinary preauthorization',
        async () => {
          const k = await f.make(),
            { url } = await f.candidate(k, 'calendar');
          const c = instrumentPrelude171(k, { omitCallback: true });
          try {
            assert.equal((await f.raw(k, url)).status, 200);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 2, rr: 1, commit: 1 });
            assert.equal(c.accepted.length, 0);
          } finally {
            c.restore();
            await k.close();
          }
        },
      );
      await t.test(
        'expired client fingerprint does not become cached authority and renews through RR',
        async (st) => {
          const k = await f.make(),
            cold = await f.cold(k),
            c = instrumentPrelude171(k);
          const expires = cold.body.validUntil;
          const original = Date.now();
          const hash = f.database.tokenHash(f.actors[0].token);
          const oldExpiry = f.a.p
            .prepare('SELECT expires_at FROM platform_sessions WHERE token_hash=?')
            .get(hash).expires_at;
          f.a.p
            .prepare('UPDATE platform_sessions SET expires_at=? WHERE token_hash=?')
            .run(original + 86400000, hash);
          const mock = st.mock.method(Date, 'now', () => Math.max(original, expires + 1));
          try {
            k.clear();
            const r = await f.raw(k, cold.url);
            assert.equal(r.status, 200);
            assert.equal(r.body.unchanged, undefined);
            assert.equal(c.accepted.length, 1);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
          } finally {
            mock.mock.restore();
            f.a.p
              .prepare('UPDATE platform_sessions SET expires_at=? WHERE token_hash=?')
              .run(oldExpiry, hash);
            c.restore();
            await k.close();
          }
        },
      );
      await t.test(
        'source clocks from prelude are never reused as the later clinical RR snapshot',
        async () => {
          const k = await f.make(),
            cold = await f.cold(k);
          await f.bumpPlatform();
          k.clear();
          const pause = barrier171(),
            seen = [];
          const original = k.clients.map((c) => c.query);
          k.clients.forEach((client, index) => {
            client.query = (input, ...args) => {
              const p = original[index](input, ...args),
                text = typeof input === 'string' ? input : input.text;
              return hotSQL169(text)
                ? p.then((result) => {
                    const r = result.rows[0];
                    seen.push(JSON.stringify([r.scope_component_epoch169, ...r.scope_rows169]));
                    return result;
                  })
                : p;
            };
          });
          const c = instrumentPrelude171(k, { beforeRun: () => pause.pause() });
          try {
            const pending = f.raw(k, cold.url);
            await bounded169(pause.entered);
            assert.equal(c.accepted.length, 1);
            assert.equal(seen.length, 1);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
            await f.bumpPlatform();
            pause.release();
            const r = await pending;
            assert.equal(r.status, 200);
            assert.equal(r.body.unchanged, undefined);
            const payload = JSON.parse(
              Buffer.from(r.body.version.split('.')[1], 'base64url').toString('utf8'),
            );
            assert.notEqual(
              payload[2],
              seen[0],
              'RR source version follows the intervening commit',
            );
            assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
          } finally {
            pause.release();
            c.restore();
            k.clients.forEach((client, i) => {
              client.query = original[i];
            });
            await k.close();
          }
        },
      );
      await t.test('a successful hot response never mints a cold prelude', async () => {
        const k = await f.make(),
          cold = await f.cold(k),
          c = instrumentPrelude171(k);
        try {
          k.clear();
          const r = await f.raw(k, cold.url);
          assert.equal(r.body.unchanged, true);
          assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
          assert.equal(c.accepted.length, 0);
          assert.equal(c.contexts.length, 0);
        } finally {
          c.restore();
          await k.close();
        }
      });
    } finally {
      await f.close();
    }
  },
);
