const test = require('node:test');
const assert = require('node:assert/strict');
const { hotDirectoryFixture170 } = require('./helpers/postgres-hot-directory170-fixture.cjs');
const {
  createReadOperationClient,
} = require('../src/server/infrastructure/postgres/read-operation-client145.cjs');
const {
  projectionKey,
  compact,
} = require('../src/server/infrastructure/cabinet-directory-projection164.cjs');

const preview = ({ text }) => text.includes(' AS cipher_bytes') && text.includes(' AS ready');
const cohort = ({ text }) => text.includes("'summary'::text AS kind,value");
const legacy = ({ text }) => /\bcabinet_summaries\s+s\s+LEFT\s+JOIN\s+LATERAL\b/.test(text);
const selected = ({ text }) => /patient_id\s*=\s*ANY\(\$\d+::text\[\]\)/.test(text);

test(
  '189 actual PG bounded cohorts preserve directory bytes and remove per-patient scalar/LATERAL work',
  { timeout: 300000 },
  async (t) => {
    const f = await hotDirectoryFixture170(t);
    const db = f.a.c[0],
      patient = 'patient',
      matched = projectionKey(patient, '*'),
      orphan = projectionKey('orphan-synthetic189', '*');
    const original = Buffer.from(
      db.prepare('SELECT value FROM meta WHERE key=?').get(matched).value,
    );
    const insert = (key, value) =>
      db
        .prepare(
          'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(key, value);
    async function readers(task) {
      f.config.nativeDirectorySnapshots180 = false;
      const old = await f.make();
      f.config.nativeDirectorySnapshots180 = true;
      const next = await f.make();
      try {
        return await task(old, next);
      } finally {
        await old.close();
        await next.close();
      }
    }
    function accepted(k) {
      assert.equal(k.trace.filter(preview).length, 1, 'one metadata-only preview');
      assert.equal(k.trace.filter(cohort).length, 1, 'one independent two-cohort SELECT');
      assert.equal(k.trace.filter(legacy).length, 0, 'no per-patient LATERAL SELECT');
      assert.equal(
        k.trace.some(({ text }) => text.includes('AND (SELECT 1 FROM cartoteca_cabinet.meta m')),
        false,
        'no per-patient missing-projection scalar probe',
      );
      assert.ok(
        k.trace.some(({ text }) => text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
      );
      assert.equal(k.operations.ownerStats166().borrowed, 0);
    }
    try {
      await t.test(
        'complete fresh cohorts are byte-identical to legacy after bounded admission',
        async () => {
          await readers(async (old, next) => {
            const baseline = await f.raw(old);
            assert.equal(baseline.status, 200);
            assert.equal(old.trace.filter(legacy).length, 1);
            const upgrades = [];
            const reply = await next.kernel.run(f.metadata(f.directoryUrl), null, {
              memoryClass: 'query-probe',
              requestMemoryClass: async (kind) => upgrades.push(kind),
            });
            assert.equal(reply.status, 200);
            assert.deepEqual(Buffer.from(reply.body), baseline.bytes);
            assert.deepEqual(upgrades, ['query']);
            accepted(next);
            assert.equal(next.trace.filter(selected).length, 0);
            assert.equal(next.operations.viewStats().entries, 0);
            assert.equal(next.operations.viewStats().directorySnapshots180.entries, 1);
            assert.ok(next.trace.some(({ text }) => text === 'COMMIT'));
          });
        },
      );
      await t.test(
        'picker and unsupported search keep the original path without cohort work',
        async () => {
          for (const [url, status] of [
            [f.directoryUrl + '&picker=1', 200],
            [f.directoryUrl.replace('q=Synthetic', 'q=' + 'x'.repeat(161)), 400],
          ]) {
            await readers(async (old, next) => {
              const baseline = await f.raw(old, url),
                reply = await f.raw(next, url);
              assert.equal(baseline.status, status);
              assert.equal(reply.status, status);
              assert.deepEqual(reply.bytes, baseline.bytes);
              assert.equal(next.trace.filter(preview).length, 0);
              assert.equal(next.trace.filter(cohort).length, 0);
              assert.equal(next.trace.filter(selected).length, 0);
              assert.equal(
                next.trace.some(({ text }) => text.startsWith("SELECT 'summary'::text AS bucket")),
                false,
              );
              assert.equal(next.operations.viewStats().directorySnapshots180.entries, 0);
              assert.equal(next.operations.ownerStats166().borrowed, 0);
            });
          }
        },
      );
      await t.test(
        'one missing projection consumes its current full row without a second full SELECT',
        async () => {
          db.prepare('DELETE FROM meta WHERE key=?').run(matched);
          try {
            await readers(async (old, next) => {
              const baseline = await f.raw(old),
                reply = await f.raw(next);
              assert.equal(baseline.status, 200);
              assert.equal(reply.status, 200);
              assert.deepEqual(reply.bytes, baseline.bytes);
              accepted(next);
              assert.equal(next.trace.filter(selected).length, 0);
              assert.equal(next.operations.viewStats().directorySnapshots180.entries, 0);
            });
          } finally {
            insert(matched, original);
          }
        },
      );
      await t.test(
        'bounded malformed orphan ciphertext is ignored exactly as in the legacy join',
        async () => {
          insert(orphan, Buffer.alloc(48, 0x19));
          try {
            await readers(async (old, next) => {
              const baseline = await f.raw(old),
                reply = await f.raw(next);
              assert.equal(baseline.status, 200);
              assert.equal(reply.status, 200);
              assert.deepEqual(reply.bytes, baseline.bytes);
              accepted(next);
              assert.equal(next.operations.viewStats().directorySnapshots180.entries, 1);
            });
          } finally {
            db.prepare('DELETE FROM meta WHERE key=?').run(orphan);
          }
        },
      );
      await t.test(
        'matching projection corruption is still fail-closed before private publication',
        async () => {
          const summary = f.storage.decode(
            db
              .prepare("SELECT value FROM cabinet_summaries WHERE patient_id=? AND audience='*'")
              .get(patient).value,
          );
          insert(
            matched,
            f.storage.encode({
              version: 1,
              id: patient,
              audience: '*',
              sourceHash: '0'.repeat(64),
              row: compact(summary),
            }),
          );
          try {
            await readers(async (old, next) => {
              const baseline = await f.raw(old),
                reply = await f.raw(next);
              assert.equal(baseline.status, 503);
              assert.equal(reply.status, 503);
              assert.equal(reply.body.directory, undefined);
              accepted(next);
              assert.equal(next.operations.viewStats().directorySnapshots180.entries, 0);
            });
          } finally {
            insert(matched, original);
          }
        },
      );
      await t.test(
        'oversize preview declines before broad registration and keeps the original164 path',
        async () => {
          insert(orphan, Buffer.alloc(2 * 1024 * 1024 + 1, 0x39));
          try {
            await readers(async (old, next) => {
              const baseline = await f.raw(old),
                reply = await f.raw(next);
              assert.equal(baseline.status, 200);
              assert.equal(reply.status, 200);
              assert.deepEqual(reply.bytes, baseline.bytes);
              assert.equal(next.trace.filter(preview).length, 1);
              assert.equal(
                next.trace.filter(cohort).length,
                0,
                'no bounded cohort read after decline',
              );
              assert.equal(
                next.trace.filter(legacy).length,
                1,
                'original scalar/LATERAL path remains',
              );
              const at = next.trace.findIndex(preview),
                legacyAt = next.trace.findIndex(legacy);
              assert.ok(at >= 0 && legacyAt > at);
              assert.equal(next.operations.ownerStats166().borrowed, 0);
            });
          } finally {
            db.prepare('DELETE FROM meta WHERE key=?').run(orphan);
          }
        },
      );
      await t.test(
        '1500-row metadata preview stays bounded and grants no clinical SELECT capability',
        async () => {
          const store = f.cabinets[0].storeId;
          const before = Number(
            db.prepare("SELECT count(*) AS n FROM cabinet_summaries WHERE audience='*'").get().n,
          );
          const added = 1500 - before;
          assert.ok(added > 0);
          // Copies only temporary synthetic cipher sizes. Their embedded IDs are
          // deliberately not decoded: this case exercises metadata admission only.
          async function scoped(task) {
            await f.admin.query('BEGIN');
            try {
              await f.admin.query(
                "SELECT set_config('cartoteca.kind','cabinet',true),set_config('cartoteca.store_id',$1,true)",
                [store],
              );
              await task();
              await f.admin.query('COMMIT');
            } catch (error) {
              await f.admin.query('ROLLBACK');
              throw error;
            }
          }
          let client;
          try {
            await scoped(async () => {
              await f.admin.query(
                `WITH seed AS MATERIALIZED (
 SELECT value FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND audience='*' ORDER BY octet_length(value) LIMIT 1
)
INSERT INTO cartoteca_cabinet.cabinet_summaries(_store_id,patient_id,audience,value)
SELECT $1,'cohort189-bound-'||n,'*',seed.value FROM generate_series(1,$2::integer) n CROSS JOIN seed`,
                [store, added],
              );
              // Drain actual164 summary invalidation before inserting projections.
              await f.admin.query(
                `WITH projection AS MATERIALIZED (
 SELECT value FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key LIKE 'directory164:%' AND right(key,2)=':*' ORDER BY octet_length(value) LIMIT 1
)
INSERT INTO cartoteca_cabinet.meta(_store_id,key,value)
SELECT $1,'directory164:'||encode(sha256(convert_to('cohort189-bound-'||n,'UTF8')),'hex')||':*',projection.value FROM generate_series(1,$2::integer) n CROSS JOIN projection`,
                [store, added],
              );
            });
            client = await createReadOperationClient(f.config);
            let upgrades = 0;
            await client.run(
              {
                scope: f.cabinets[0],
                assertActive() {},
                probeClass: true,
                async requestMemoryClass() {
                  upgrades++;
                },
              },
              async (op) => {
                const bound = await op.previewDirectoryCohort189('*');
                assert.ok(bound);
                assert.equal(bound.summary.rows, 1500);
                assert.equal(bound.projection.rows, 1500);
                assert.ok(bound.summary.bytes > 0 && bound.projection.bytes > 0);
                const cipherBytes = bound.summary.cipherBytes + bound.projection.cipherBytes;
                assert.ok(cipherBytes > 0 && cipherBytes <= 2 * 1024 * 1024);
                await assert.rejects(op.selectDirectory164('index', { audience: '*' }), {
                  code: 'POSTGRES_READ_OPERATION_PROBE_REQUIRED',
                });
                await assert.rejects(op.selectDirectoryCohort189('*'), {
                  code: 'POSTGRES_DIRECTORY_COHORT_MEMORY',
                });
                assert.throws(() => op.directoryCohortFull189({}), {
                  code: 'POSTGRES_DIRECTORY_COHORT_CONTEXT',
                });
                t.diagnostic(
                  JSON.stringify({
                    summaryRows: bound.summary.rows,
                    projectionRows: bound.projection.rows,
                    cipherBytes,
                    estimatedSourceBytes: bound.summary.bytes + bound.projection.bytes,
                  }),
                );
              },
            );
            assert.equal(upgrades, 0, 'numeric preview never acquires clinical admission');
          } finally {
            await client?.close();
            await scoped(async () => {
              await f.admin.query(
                "DELETE FROM cartoteca_cabinet.cabinet_summaries WHERE _store_id=$1 AND patient_id=ANY(ARRAY(SELECT 'cohort189-bound-'||n FROM generate_series(1,$2::integer) n))",
                [store, added],
              );
              await f.admin.query(
                "DELETE FROM cartoteca_cabinet.meta WHERE _store_id=$1 AND key=ANY(ARRAY(SELECT 'directory164:'||encode(sha256(convert_to('cohort189-bound-'||n,'UTF8')),'hex')||':*' FROM generate_series(1,$2::integer) n))",
                [store, added],
              );
            });
            assert.equal(
              Number(
                db.prepare("SELECT count(*) AS n FROM cabinet_summaries WHERE audience='*'").get()
                  .n,
              ),
              before,
            );
          }
        },
      );
    } finally {
      original.fill(0);
      await f.close();
    }
  },
);
