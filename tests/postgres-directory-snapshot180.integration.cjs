const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hotDirectoryFixture170,
  hotSQL169,
  bounded169,
} = require('./helpers/postgres-hot-directory170-fixture.cjs');
const rr = (k) =>
  k.trace.some((row) => row.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
function oneMetadata(k) {
  assert.equal(k.trace.length, 1);
  assert.ok(hotSQL169(k.trace[0].text));
}
test(
  '180 real PG snapshot publishes every summary only after accepted tail and serves unseen query with fresh metadata',
  { timeout: 240000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    f.config.nativeDirectorySnapshots180 = true;
    try {
      await t.test(
        'cold build requests full query once; unseen q and cursor need only metadata',
        async () => {
          const k = await f.make(),
            upgrades = [];
          try {
            const raw = await k.kernel.run(f.metadata(f.directoryUrl), null, {
              memoryClass: 'query-probe',
              requestMemoryClass: async (kind) => {
                upgrades.push(kind);
              },
            });
            assert.equal(raw.status, 200);
            assert.deepEqual(upgrades, ['query']);
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 1);
            k.clear();
            const changed = await f.raw(k, f.directoryUrl.replace('q=Synthetic', 'q=Gamma'));
            assert.equal(changed.status, 200);
            assert.equal(changed.body.directory.length, 1);
            assert.match(changed.body.directory[0].name, /Gamma/);
            oneMetadata(k);
            k.clear();
            const first = await f.raw(k, f.directoryUrl.replace('limit=100', 'limit=1'));
            assert.ok(first.body.nextCursor);
            oneMetadata(k);
            k.clear();
            const second = await f.raw(
              k,
              f.directoryUrl.replace('limit=100', 'limit=1') +
                '&cursor=' +
                encodeURIComponent(first.body.nextCursor),
            );
            assert.equal(second.status, 200);
            oneMetadata(k);
            assert.notEqual(second.body.directory[0].id, first.body.directory[0].id);
            assert.equal(k.operations.ownerStats166().borrowed, 0);
          } finally {
            await k.close();
          }
        },
      );
      await t.test(
        'revocation before fresh post-COMMIT authority prevents snapshot publication',
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
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 0);
            f.a.p
              .prepare(
                "UPDATE memberships SET status='inactive' WHERE organization_id=? AND account_id=?",
              )
              .run(f.organizations[0], f.actors[0].accountId);
            gate.release();
            const reply = await running;
            assert.equal(reply.status, 401);
            assert.equal(reply.body.directory, undefined);
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
      await t.test(
        'a legacy COMMIT without fresh167 tail cannot publish snapshot claims',
        async () => {
          const k = await f.make(),
            borrow = k.operations.borrow166;
          k.operations.borrow166 = () => {
            const owned = borrow();
            if (!owned) return owned;
            return {
              ...owned,
              run(context, execution) {
                const weak = { ...context };
                delete weak.assertFreshAfterCommit167;
                return owned.run(weak, execution);
              },
            };
          };
          try {
            assert.equal((await f.raw(k)).status, 200);
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 0);
            k.operations.borrow166 = borrow;
            k.clear();
            assert.equal(
              (await f.raw(k, f.directoryUrl.replace('q=Synthetic', 'q=Gamma'))).status,
              200,
            );
            assert.ok(rr(k), 'no hot snapshot after a weaker publisher');
          } finally {
            k.operations.borrow166 = borrow;
            await k.close();
          }
        },
      );
      await t.test(
        'any committed cabinet change invalidates snapshot; rollback preserves its stamp',
        async () => {
          const k = await f.make();
          try {
            await f.warm(k);
            f.a.c[0].exec('BEGIN');
            f.a.c[0]
              .prepare(
                "UPDATE cabinet_summaries SET value=value WHERE patient_id='patient' AND audience='*'",
              )
              .run();
            f.a.c[0].exec('ROLLBACK');
            k.clear();
            assert.equal(
              (await f.raw(k, f.directoryUrl.replace('q=Synthetic', 'q=Gamma'))).status,
              200,
            );
            oneMetadata(k);
            f.a.c[0]
              .prepare(
                "UPDATE cabinet_summaries SET value=value WHERE patient_id='patient' AND audience='*'",
              )
              .run();
            k.clear();
            assert.equal(
              (await f.raw(k, f.directoryUrl.replace('q=Synthetic', 'q=Бета'))).status,
              200,
            );
            assert.ok(rr(k));
            assert.equal(k.operations.viewStats().directorySnapshots180.entries, 1);
          } finally {
            await k.close();
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
