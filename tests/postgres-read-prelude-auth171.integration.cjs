const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  preludeFixture171,
  instrumentPrelude171,
  barrier171,
  counts171,
  bounded169,
} = require('./helpers/postgres-read-prelude171-fixture.cjs');

test(
  '171 cold prelude cannot outlive session, cancellation, context or fresh tail authority',
  { timeout: 240000 },
  async (t) => {
    const f = await preludeFixture171(t);
    try {
      for (const kind of ['calendar', 'directory'])
        await t.test(
          kind + ' revoke after accepted prelude and before RR is rejected by fresh tail',
          async () => {
            const k = await f.make(),
              { url } = await f.candidate(k, kind),
              pause = barrier171();
            const c = instrumentPrelude171(k, { beforeRun: () => pause.pause() });
            try {
              const pending = f.raw(k, url);
              await bounded169(pause.entered);
              assert.equal(c.accepted.length, 1);
              assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
              f.a.p
                .prepare(
                  "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
                )
                .run(f.organizations[0], f.actors[0].accountId);
              pause.release();
              const denied = await pending;
              assert.equal(denied.status, 401);
              assert.equal(denied.body.directory, undefined);
              assert.equal(denied.body.appointments, undefined);
              assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
            } finally {
              pause.release();
              f.a.p
                .prepare(
                  "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
                )
                .run(f.organizations[0], f.actors[0].accountId);
              c.restore();
              await k.close();
            }
          },
        );
      await t.test(
        'expiry immediately after accepted prelude is rechecked before RR without oldauth retry',
        async (st) => {
          const k = await f.make(),
            { url } = await f.candidate(k, 'calendar');
          let clock;
          const c = instrumentPrelude171(k, {
            onAccept(current) {
              clock = st.mock.method(Date, 'now', () => current.expiresAt + 1);
            },
          });
          try {
            assert.equal((await f.raw(k, url)).status, 401);
            assert.equal(c.accepted.length, 1);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
            assert.equal(k.operations.ownerStats166().borrowed, 0);
          } finally {
            clock?.mock.restore();
            c.restore();
            await k.close();
          }
        },
      );
      await t.test(
        'cancellation after accepted prelude is checked before RR and does not poison next job',
        async () => {
          const k = await f.make(),
            { url } = await f.candidate(k, 'calendar');
          const cancel = new SharedArrayBuffer(4);
          let first = true;
          const c = instrumentPrelude171(k, {
            onAccept() {
              if (first) {
                first = false;
                Atomics.store(new Int32Array(cancel), 0, 1);
              }
            },
          });
          try {
            assert.equal((await f.raw(k, url, f.actors[0], { cancel })).status, 499);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
            assert.equal(k.operations.ownerStats166().borrowed, 0);
            k.clear();
            assert.equal((await f.raw(k, url)).status, 200);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
          } finally {
            c.restore();
            await k.close();
          }
        },
      );
      for (const mode of ['expiry', 'cancel'])
        await t.test(
          mode +
            ' after outer authorization await and runtime processing is checked immediately before RR',
          async (st) => {
            const k = await f.make(),
              { url } = await f.candidate(k, 'calendar');
            const cancel = new SharedArrayBuffer(4);
            let armed = false,
              triggered = false,
              expires,
              clock;
            const c = instrumentPrelude171(k, {
              onAccept(current) {
                expires = current.expiresAt + 1;
                armed = true;
              },
            });
            try {
              const r = await f.raw(k, url, f.actors[0], {
                cancel,
                change(metadata) {
                  const timestamp = metadata.runtime.timestamp;
                  // Direct-kernel test-only boundary injection. Worker payloads do
                  // not carry this getter; it simulates time/cancel after the await.
                  Object.defineProperty(metadata.runtime, 'timestamp', {
                    enumerable: true,
                    get() {
                      if (armed && !triggered) {
                        triggered = true;
                        if (mode === 'expiry') clock = st.mock.method(Date, 'now', () => expires);
                        else Atomics.store(new Int32Array(cancel), 0, 1);
                      }
                      return timestamp;
                    },
                  });
                },
              });
              assert.equal(triggered, true);
              assert.equal(c.accepted.length, 1);
              assert.equal(r.status, mode === 'expiry' ? 401 : 499);
              assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
            } finally {
              clock?.mock.restore();
              c.restore();
              await k.close();
            }
          },
        );
      await t.test('fresh role and session identity are used for the new RR binding', async () => {
        const k = await f.make();
        await f.warm(k);
        const c = instrumentPrelude171(k);
        f.a.p
          .prepare('UPDATE memberships SET role=? WHERE organization_id=? AND account_id=?')
          .run('cosmetologist', f.organizations[0], f.actors[0].accountId);
        try {
          const staff = await f.raw(k);
          assert.equal(staff.status, 200);
          assert.equal(staff.body.directory.length, 1);
          assert.equal(staff.body.directory[0].appointments.length, 1);
          assert.equal(c.accepted.length, 1);
          assert.equal(c.accepted[0].role, 'cosmetologist');
          assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
        } finally {
          f.a.p
            .prepare('UPDATE memberships SET role=? WHERE organization_id=? AND account_id=?')
            .run('owner', f.organizations[0], f.actors[0].accountId);
        }
        await f.warm(k);
        k.clear();
        c.accepted.length = 0;
        const hash = f.database.tokenHash(f.actors[0].token);
        const old = f.a.p
            .prepare('SELECT id FROM platform_sessions WHERE token_hash=?')
            .get(hash).id,
          next = randomUUID();
        f.a.p.prepare('UPDATE platform_sessions SET id=? WHERE token_hash=?').run(next, hash);
        try {
          assert.equal((await f.raw(k)).status, 200);
          assert.equal(c.accepted.length, 1);
          assert.equal(c.accepted[0].sessionId, next);
          assert.deepEqual(counts171(k), { metadata: 1, authority: 1, rr: 1, commit: 1 });
        } finally {
          f.a.p.prepare('UPDATE platform_sessions SET id=? WHERE token_hash=?').run(old, hash);
          c.restore();
          await k.close();
        }
      });
      await t.test('wrong tab never provides a prelude or a clinical RR', async () => {
        const k = await f.make(),
          cold = await f.cold(k),
          c = instrumentPrelude171(k);
        k.clear();
        try {
          const denied = await f.raw(k, cold.url, f.actors[0], {
            change: (m) => {
              m.headers['x-cartoteca-organization-id'] = f.organizations[1];
            },
          });
          assert.equal(denied.status, 428);
          assert.equal(c.accepted.length, 0);
          assert.deepEqual(counts171(k), { metadata: 1, authority: 0, rr: 0, commit: 0 });
        } finally {
          c.restore();
          await k.close();
        }
      });
      await t.test(
        'prelude is local to one job; later noncandidate must authorize again',
        async () => {
          const k = await f.make(),
            { url } = await f.candidate(k, 'calendar'),
            c = instrumentPrelude171(k);
          try {
            assert.equal((await f.raw(k, url)).status, 200);
            assert.equal(c.accepted.length, 1);
            k.clear();
            f.a.p
              .prepare(
                "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], f.actors[0].accountId);
            assert.equal((await f.raw(k, '/api/cabinet/time-zone')).status, 401);
            assert.equal(c.accepted.length, 1);
            assert.deepEqual(counts171(k), { metadata: 0, authority: 1, rr: 0, commit: 0 });
          } finally {
            f.a.p
              .prepare(
                "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], f.actors[0].accountId);
            c.restore();
            await k.close();
          }
        },
      );
      await t.test(
        'oversize metadata authority falls back to full ordinary authority without a prelude',
        async () => {
          const k = await f.make(),
            cold = await f.cold(k),
            c = instrumentPrelude171(k);
          k.clear();
          const old = f.a.p
            .prepare('SELECT value FROM accounts WHERE id=?')
            .get(f.actors[0].accountId).value;
          f.a.p.prepare('UPDATE accounts SET value=? WHERE id=?').run(
            f.database.seal({
              displayName: 'Synthetic171 ' + 'x'.repeat(70 * 1024),
              email: 'synthetic171@invalid.test',
            }),
            f.actors[0].accountId,
          );
          try {
            assert.equal((await f.raw(k, cold.url)).status, 200);
            assert.equal(c.accepted.length, 0);
            assert.deepEqual(counts171(k), { metadata: 1, authority: 2, rr: 1, commit: 1 });
          } finally {
            f.a.p.prepare('UPDATE accounts SET value=? WHERE id=?').run(old, f.actors[0].accountId);
            c.restore();
            await k.close();
          }
        },
      );
      await t.test('a directory without a candidate uses ordinary pre/post authority', async () => {
        const k = await f.make(),
          c = instrumentPrelude171(k);
        try {
          assert.equal((await f.raw(k)).status, 200);
          assert.equal(c.accepted.length, 0);
          assert.deepEqual(counts171(k), { metadata: 0, authority: 2, rr: 1, commit: 1 });
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

test(
  '171 absent optional metadata component keeps original authority phases',
  { timeout: 120000 },
  async (t) => {
    const f = await preludeFixture171(t, { prepared: false });
    try {
      const k = await f.make(),
        cold = await f.cold(k),
        c = instrumentPrelude171(k);
      k.clear();
      try {
        const r = await f.raw(k, cold.url);
        assert.equal(r.status, 200);
        assert.equal(r.body.unchanged, true);
        assert.equal(c.accepted.length, 0);
        assert.deepEqual(counts171(k), { metadata: 0, authority: 2, rr: 1, commit: 1 });
      } finally {
        c.restore();
        await k.close();
      }
    } finally {
      await f.close();
    }
  },
);
