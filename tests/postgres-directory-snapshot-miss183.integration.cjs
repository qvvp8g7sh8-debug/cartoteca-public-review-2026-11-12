const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hotDirectoryFixture170,
  bounded169,
} = require('./helpers/postgres-hot-directory170-fixture.cjs');
const selected = (row) => /patient_id\s*=\s*ANY\(\$\d+::text\[\]\)/.test(row.text);

test(
  '183 real PG cold producer removes selected-page SQL and legacy cache without bypassing final authority',
  { timeout: 240000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    try {
      await t.test(
        'complete private cold response equals legacy and omits its selected source/read pair',
        async () => {
          f.config.nativeDirectorySnapshots180 = false;
          const old = await f.make();
          f.config.nativeDirectorySnapshots180 = true;
          const next = await f.make();
          try {
            const baseline = await f.raw(old);
            assert.equal(baseline.status, 200);
            const selectedStatements = old.trace.filter(selected);
            assert.equal(
              selectedStatements.length,
              2,
              'actual legacy selected-byte probe plus selected full SELECT',
            );
            assert.ok(old.operations.viewStats().entries > 0);
            const upgrades = [];
            const result = await next.kernel.run(f.metadata(f.directoryUrl), null, {
              memoryClass: 'query-probe',
              requestMemoryClass: async (kind) => upgrades.push(kind),
            });
            assert.equal(result.status, 200);
            assert.deepEqual(JSON.parse(Buffer.from(result.body).toString()), baseline.body);
            assert.deepEqual(upgrades, ['query']);
            assert.equal(
              next.trace.filter(selected).length,
              0,
              'no selected-page SQL after all-summary proof',
            );
            assert.equal(
              next.operations.viewStats().entries,
              0,
              'no compact base or per-patient full summary cache',
            );
            assert.equal(next.operations.viewStats().directorySnapshots180.entries, 1);
            assert.ok(next.trace.some((row) => row.text === 'COMMIT'));
            assert.equal(next.operations.ownerStats166().borrowed, 0);
          } finally {
            await old.close();
            await next.close();
          }
        },
      );
      await t.test('unsupported picker retains ordinary response and legacy caching', async () => {
        const k = await f.make();
        try {
          const reply = await f.raw(k, f.directoryUrl + '&picker=1');
          assert.equal(reply.status, 200);
          assert.ok(Array.isArray(reply.body.patients));
          assert.equal(reply.body.directory, undefined);
          assert.ok(k.operations.viewStats().entries > 0);
          assert.equal(k.operations.viewStats().directorySnapshots180.entries, 0);
        } finally {
          await k.close();
        }
      });
      await t.test(
        'revocation at fresh post-COMMIT authority discards the staged private page',
        async () => {
          const k = await f.make();
          let auth = 0;
          const gate = k.arm(
            'submit',
            (text) => text.startsWith('WITH auth_guard') && ++auth === 2,
          );
          const running = f.raw(k);
          try {
            await bounded169(gate.entered);
            assert.equal(k.operations.viewStats().entries, 0);
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 0);
            f.a.p
              .prepare(
                "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], f.actors[0].accountId);
            gate.release();
            const result = await running;
            assert.equal(result.status, 401);
            assert.equal(result.body.directory, undefined);
            assert.equal(k.operations.viewStats().entries, 0);
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 0);
          } finally {
            gate.release();
            await running.catch(() => {});
            f.a.p
              .prepare(
                "UPDATE memberships SET status='active' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], f.actors[0].accountId);
            await k.close();
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
