const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { patientCapsulePGFixture197 } = require('./helpers/postgres-patient-capsule197-fixture.cjs');
const base = '../src/server/infrastructure/postgres/';
const { prepareCatalogImage199 } = require(base + 'catalog-image-prepare199.cjs');
const { verifyCatalogImage199 } = require(base + 'catalog-image-schema199.cjs');
const { META, variants199, catalogImagePredicate199 } = require(base + 'catalog-image-sql199.cjs');
const { verifyHotMetadata169 } = require(base + 'hot-metadata-component169.cjs');
const { verifyDirectoryState196 } = require(base + 'directory-state-schema196.cjs');
const { prepareDirectoryState196 } = require(base + 'directory-state-prepare196.cjs');
const { verifyPatientCapsule197 } = require(base + 'patient-capsule-schema197.cjs');
const { preparePatientCapsule197 } = require(base + 'patient-capsule-prepare197.cjs');
const { prepareDirectory164 } = require(base + 'directory-component164.cjs');
const { createReadOperationClient } = require(base + 'read-operation-client145.cjs');
const { createHotMetadataQuery169, parseHotMetadata169 } = require(
  base + 'hot-metadata-query169.cjs',
);
const { createHotDirectoryQuery196, parseHotDirectory196 } = require(
  base + 'hot-directory-query196.cjs',
);
const { createPatientCapsuleQuery197, parsePatientCapsule197 } = require(
  base + 'patient-capsule-query197.cjs',
);
const { KEYS } = require(base + 'lock-intents.cjs');
const { digest } = require(base + 'catalog-sqlite.cjs');
const { readCatalogImageAnchors199 } = require(base + 'catalog-image-anchors199.cjs');
const bad = (e) => e?.status === 503 && e.code === 'POSTGRES_CATALOG_IMAGE_COMPONENT_INVALID199';

test(
  '199 exact current catalog anchors are optional, reversible and preserve all three parent protocols',
  { timeout: 180000 },
  async (t) => {
    const f = await patientCapsulePGFixture197(t),
      role = f.runtime.application.user;
    const app = new Client(f.runtime.application),
      marker = f.identity.lineage;
    let connected = false;
    async function parents() {
      return {
        hotMetadata169: await verifyHotMetadata169(f.admin, role, { marker }),
        directory196: await verifyDirectoryState196(f.admin, role),
        patient197: await verifyPatientCapsule197(f.admin, role),
      };
    }
    async function options() {
      return { marker, parents: await parents(), offline: true };
    }
    async function transition(extra = {}) {
      await f.admin.query('BEGIN');
      try {
        const result = await prepareCatalogImage199(f.admin, role, {
          ...(await options()),
          ...extra,
        });
        await f.admin.query('COMMIT');
        return result;
      } catch (e) {
        await f.admin.query('ROLLBACK');
        throw e;
      }
    }
    async function fingerprint() {
      return (
        await f.admin
          .query(`SELECT md5(COALESCE(string_agg(md5(row_to_json(x)::text),'' ORDER BY md5(row_to_json(x)::text)),'')) hash FROM (
      SELECT _store_id,id,value FROM cartoteca_cabinet.patients UNION ALL
      SELECT _store_id,key,value FROM cartoteca_cabinet.meta UNION ALL
      SELECT _store_id,id,value FROM cartoteca_cabinet.cabinet_patient_records) x`)
      ).rows[0].hash;
    }
    async function oldDefinitions() {
      return (
        await f.admin.query(
          `SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='cartoteca_catalog' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
          [Object.values(variants199).map((v) => v.oldFunction.split('.')[1])],
        )
      ).rows;
    }
    function alias(variant, plan, capability, token = capability) {
      const v = variants199[variant],
        prefix = 'SELECT * FROM ' + v.oldFunction + '(';
      assert.ok(plan.text.startsWith(prefix));
      return {
        ...plan,
        text:
          'SELECT * FROM ' +
          v.functionName +
          plan.text.slice(prefix.length - 1, -1) +
          `,$${plan.values.length + 1},$${plan.values.length + 2})`,
        values: [...plan.values, token.epoch, token.digest],
      };
    }
    async function packet(plan) {
      await app.query(
        "SELECT set_config('cartoteca.kind','platform',false),set_config('cartoteca.store_id',$1,false)",
        [f.platform.storeId],
      );
      await app.query('SELECT pg_advisory_lock_shared($1::bigint)', [KEYS.maintenance]);
      await app.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        return (await app.query(plan.text, plan.values)).rows;
      } finally {
        await app.query('ROLLBACK');
        await app.query('SELECT pg_advisory_unlock_shared($1::bigint)', [KEYS.maintenance]);
      }
    }
    try {
      await app.connect();
      connected = true;
      await f.prepare({ capsule: false });
      const cipherBefore = await fingerprint(),
        old169 = await oldDefinitions();
      await t.test(
        'missing component falls back; 169-only install supports outer rollback and inverse',
        async () => {
          assert.equal(await verifyCatalogImage199(app, role, await options()), null);
          const original = (
            await f.admin.query(
              'SELECT catalog_hash,metadata FROM cartoteca_catalog.templates WHERE kind=\'cabinet\' AND version=2 ORDER BY catalog_hash COLLATE "C" LIMIT 1',
            )
          ).rows[0];
          const alternate = structuredClone(original.metadata);
          const table = Object.keys(alternate.tables).find(
            (name) =>
              typeof alternate.tables[name].sql === 'string' &&
              alternate.tables[name].sql.includes('('),
          );
          assert.ok(table, 'canonical SQLite table SQL');
          alternate.tables[table].sql = alternate.tables[table].sql.replace('(', '(\n');
          const object = alternate.objects.find((o) => o.type === 'table' && o.name === table);
          assert.ok(object);
          object.sql = alternate.tables[table].sql;
          const alternateHash = digest(alternate);
          assert.notEqual(alternateHash, original.catalog_hash);
          await f.admin.query(
            "INSERT INTO cartoteca_catalog.templates(kind,version,catalog_hash,metadata) VALUES('cabinet',2,$1,$2)",
            [alternateHash, alternate],
          );
          assert.equal(
            Number(
              (
                await f.admin.query(
                  "SELECT count(*) n FROM cartoteca_catalog.templates WHERE kind='cabinet' AND version=2",
                )
              ).rows[0].n,
            ),
            2,
          );
          const selected = await readCatalogImageAnchors199(f.admin);
          assert.equal(
            selected['cabinet:2'].hash,
            original.catalog_hash,
            'registered stores outrank unused valid historical hash',
          );
          await f.admin.query('BEGIN');
          try {
            await f.admin.query(
              "UPDATE cartoteca_catalog.stores SET metadata=$1,catalog_hash=$2 WHERE kind='cabinet' AND version=2",
              [alternate, alternateHash],
            );
            assert.equal(
              (await readCatalogImageAnchors199(f.admin))['cabinet:2'].hash,
              alternateHash,
              'current store usage changes the selected anchor',
            );
          } finally {
            await f.admin.query('ROLLBACK');
          }
          const alternateText = JSON.stringify(alternate);
          const legacyFallback = (
            await f.admin.query(
              `SELECT ${catalogImagePredicate199('cabinet')} matches FROM (SELECT $1::jsonb metadata)s CROSS JOIN(SELECT $1::jsonb metadata)t CROSS JOIN(SELECT NULL::jsonb v_c_anchor199)v`,
              [alternateText],
            )
          ).rows[0];
          assert.equal(
            legacyFallback.matches,
            true,
            'nonselected valid hash retains original semantic equality',
          );
          await f.admin.query('BEGIN');
          try {
            assert.equal(
              (await prepareCatalogImage199(f.admin, role, await options())).prepared,
              true,
            );
          } finally {
            await f.admin.query('ROLLBACK');
          }
          assert.equal(await verifyCatalogImage199(app, role, await options()), null);
          const made = await transition(),
            cap = await verifyCatalogImage199(app, role, await options());
          assert.equal(made.prepared, true);
          assert.deepEqual(cap.variants, {
            metadata169: true,
            directory196: false,
            patient197: false,
          });
          assert.equal((await transition()).changed, false);
          assert.equal(await fingerprint(), cipherBefore);
          assert.deepEqual(await oldDefinitions(), old169);
          assert.equal((await transition({ rollback: true })).changed, true);
          assert.equal(await verifyCatalogImage199(app, role, await options()), null);
        },
      );
      await f.admin.query('BEGIN');
      const fixtureKey = fs.readFileSync(path.join(f.dir, 'encryption.key'));
      try {
        await prepareDirectory164(f.admin, role, {
          stores: [
            {
              storeId: f.cabinets[0].storeId,
              ciphers: {
                encode: f.storage.encode,
                decode: f.storage.decode,
                hash: (value) => createHmac('sha256', fixtureKey).update(value).digest('hex'),
              },
            },
          ],
        });
        await prepareDirectoryState196(f.admin, role, { stores: f.cabinets });
        await preparePatientCapsule197(f.admin, role);
        await f.admin.query('COMMIT');
      } catch (e) {
        await f.admin.query('ROLLBACK');
        throw e;
      } finally {
        fixtureKey.fill(0);
      }
      const oldAll = await oldDefinitions(),
        allBefore = await fingerprint();
      await transition();
      const cap = await verifyCatalogImage199(app, role, await options());
      assert.deepEqual(cap.variants, { metadata169: true, directory196: true, patient197: true });
      await t.test(
        'real read-operation startup primes the verified aliases without a clinical read',
        async () => {
          const seen = new Set();
          let engine;
          try {
            engine = await createReadOperationClient(
              { dataDir: f.dir, postgres: f.runtime.application },
              {
                createClient(options) {
                  const client = new Client(options),
                    query = client.query.bind(client);
                  client.query = (input, ...args) => {
                    const text = typeof input === 'string' ? input : input.text;
                    const variant = Object.entries(variants199).find(([, v]) =>
                      text.startsWith('SELECT * FROM ' + v.functionName + '('),
                    )?.[0];
                    const result = query(input, ...args);
                    return variant
                      ? result.then((response) => {
                          seen.add(variant);
                          if (variant === 'patient197') {
                            assert.ok(
                              response.rows.every(
                                (r) =>
                                  r.section197 !== 'body197' &&
                                  r.cipher197 == null &&
                                  r.account197 == null &&
                                  r.session197 == null,
                              ),
                            );
                            const h = response.rows.find(
                              (r) => r.section197 === 'guard197',
                            )?.payload197;
                            assert.ok(h && ['authority', 'dependency'].includes(h.reason));
                            assert.equal(h.locked, true);
                            assert.equal(h.released, true);
                          } else {
                            assert.equal(response.rows.length, 1);
                            assert.equal(response.rows[0].id, null);
                            assert.equal(response.rows[0].account_value, null);
                            assert.equal(response.rows[0].session_value, null);
                          }
                          return response;
                        })
                      : result;
                  };
                  return client;
                },
              },
            );
            assert.deepEqual([...seen].sort(), Object.keys(variants199).sort());
          } finally {
            await engine?.close();
          }
        },
      );
      const actor = f.actors[0],
        session = (
          await f.admin.query(
            'SELECT id FROM cartoteca_platform.platform_sessions WHERE _store_id=$1 AND token_hash=$2',
            [f.platform.storeId, createHash('sha256').update(actor.token).digest('hex')],
          )
        ).rows[0];
      const p = (
        await f.admin.query(
          "SELECT version,catalog_hash FROM cartoteca_catalog.stores WHERE kind='platform' AND store_id=$1",
          [f.platform.storeId],
        )
      ).rows[0];
      const caps = await parents(),
        common = {
          marker,
          capability: caps.hotMetadata169,
          platformTemplate: { version: Number(p.version), hash: p.catalog_hash },
        };
      const input = {
        claimedAccountId: actor.accountId,
        claimedOrganizationId: actor.organizationId,
        tokenHash: createHash('sha256').update(actor.token).digest('hex'),
      };
      const hot = createHotMetadataQuery169(common)(input);
      const directory = createHotDirectoryQuery196({
        ...common,
        directoryState196: caps.directory196,
      })({ ...input, selectedIds: ['empty'], audience: '*' });
      const patient = createPatientCapsuleQuery197({ ...common, capability: caps.patient197 })({
        scope: { ...f.cabinets[0], kind: 'cabinet', organizationId: actor.organizationId },
        current: { ...actor, sessionId: session.id, globalAdmin: false },
        token: actor.token,
        selection: {
          kind: 'card',
          id: 'live',
          audience: '*',
          cursor: { visit: 0, outcome: 0, upcoming: 0 },
        },
      });
      await t.test(
        '169 and 196 aliases return byte-identical current authority, clocks and selected ciphers',
        async () => {
          for (const [key, plan, parse] of [
            ['metadata169', hot, parseHotMetadata169],
            ['directory196', directory, parseHotDirectory196],
          ]) {
            const original = (await app.query(plan.text, plan.values)).rows;
            const replacement = (await app.query(alias(key, plan, cap))).rows;
            assert.deepEqual(replacement, original, key);
            assert.equal(parse(replacement, plan.expected).eligible, true);
          }
        },
      );
      await t.test(
        '197 alias preserves nonempty future history and the held session fence/owning RR',
        async () => {
          const original = await packet(patient),
            replacement = await packet(alias('patient197', patient, cap));
          assert.deepEqual(replacement, original);
          const parsed = parsePatientCapsule197(replacement, patient.expected);
          assert.equal(parsed.supported, true);
          assert.ok(replacement.some((r) => Buffer.isBuffer(r.cipher197)));
        },
      );
      await t.test(
        'stale component token never authorizes current metadata or clinical body',
        async () => {
          const stale = { ...cap, digest: '0'.repeat(64) };
          const h = alias('metadata169', hot, cap, stale);
          const hotRows = (await app.query(h)).rows;
          assert.throws(() => parseHotMetadata169(hotRows, hot.expected));
          const rows = await packet(alias('patient197', patient, cap, stale));
          assert.ok(rows.every((r) => r.cipher197 === null));
          assert.throws(() => parsePatientCapsule197(rows, patient.expected));
        },
      );
      await t.test(
        'anchor shortcut retains semantic fallback, numeric equivalence, NULL and fresh two-sided mismatches',
        async () => {
          const cases = [
            ['{"n":1}', '{"n":1}', '{"n":1}'],
            ['{"n":1}', '{"n":1.0}', '{"n":1}'],
            ['{"n":2}', '{"n":2}', '{"n":1}'],
            ['{"n":1}', '{"n":2}', '{"n":1}'],
            ['{"n":2}', '{"n":1}', '{"n":1}'],
            [null, null, '{"n":1}'],
            [null, '{"n":1}', '{"n":1}'],
          ];
          for (const values of cases) {
            const r = (
              await app.query(
                `SELECT s.metadata=t.metadata old, ${catalogImagePredicate199('platform')} new FROM (SELECT $1::jsonb metadata) s CROSS JOIN (SELECT $2::jsonb metadata) t CROSS JOIN (SELECT $3::jsonb v_p_anchor199) v`,
                values,
              )
            ).rows[0];
            assert.equal(r.new, r.old);
          }
          for (const table of ['stores', 'templates']) {
            await f.admin.query('BEGIN');
            try {
              await f.admin.query(
                `UPDATE cartoteca_catalog.${table} SET metadata=metadata||'{"catalogTamper199":true}'::jsonb WHERE kind='platform' AND version=$1` +
                  (table === 'stores' ? ' AND store_id=$2' : ''),
                table === 'stores' ? [p.version, f.platform.storeId] : [p.version],
              );
              const fresh = (await f.admin.query(alias('metadata169', hot, cap))).rows;
              assert.equal(fresh[0].p_catalog_matches169, false, table);
            } finally {
              await f.admin.query('ROLLBACK');
            }
          }
        },
      );
      await t.test(
        'bounded real-function per-call benchmark includes anchor assignment and all unchanged parent work',
        async () => {
          const replacement = alias('metadata169', hot, cap),
            timings = [];
          const literal = (v) =>
            typeof v === 'number' ? String(v) : "'" + v.replaceAll("'", "''") + "'";
          const notice = (message) => {
            if (/^CATALOG199_BENCH [0-9.]+$/.test(message.message))
              timings.push(Number(message.message.split(' ')[1]));
          };
          app.on('notice', notice);
          try {
            for (const plan of [hot, replacement, replacement, hot]) {
              const text = plan.text
                .replace(/^SELECT \*/, 'PERFORM *')
                .replace(/\$(\d+)/g, (_, n) => literal(plan.values[Number(n) - 1]));
              await app.query(`DO $benchmark$ DECLARE i integer;started timestamptz;BEGIN started:=clock_timestamp();
            FOR i IN 1..64 LOOP ${text}; END LOOP;
            RAISE NOTICE 'CATALOG199_BENCH %',extract(epoch FROM(clock_timestamp()-started))*1000;END $benchmark$;`);
            }
          } finally {
            app.removeListener('notice', notice);
          }
          assert.equal(timings.length, 4);
          assert.ok(timings.every((n) => Number.isFinite(n) && n > 0 && n < 10000));
          t.diagnostic(
            JSON.stringify({
              benchmark: 'server-wall-only',
              callsPerPhase: 64,
              order: ['old', 'anchor', 'anchor', 'old'],
              elapsedMs: timings,
              anchorsAssignedPerInvocation: true,
              retainedCurrentCatalogValues: false,
              cpuMeasurement: false,
              capacityAcceptance: false,
            }),
          );
        },
      );
      await t.test(
        'partial aliases, PUBLIC grants, metadata tamper and parent generation drift fail closed',
        async () => {
          for (const sql of [
            `DROP FUNCTION ${variants199.patient197.functionName}(${variants199.patient197.argTypes})`,
            `GRANT EXECUTE ON FUNCTION ${variants199.metadata169.functionName}(${variants199.metadata169.argTypes}) TO PUBLIC`,
            `UPDATE ${META} SET digest=repeat('0',64)`,
          ]) {
            await f.admin.query('BEGIN');
            try {
              await f.admin.query(sql);
              await assert.rejects(verifyCatalogImage199(f.admin, role, await options()), bad);
            } finally {
              await f.admin.query('ROLLBACK');
            }
          }
          const supplied = await options();
          supplied.parents.hotMetadata169 = {
            ...supplied.parents.hotMetadata169,
            epoch: '00000000-0000-0000-0000-000000000000',
          };
          await assert.rejects(verifyCatalogImage199(app, role, supplied), bad);
          await assert.rejects(
            app.query(`UPDATE ${META} SET digest=digest`),
            (e) => e.code === '42501',
          );
        },
      );
      await t.test(
        'inverse removes only 199 aliases and retains exact old definitions and ciphertext',
        async () => {
          assert.equal(await fingerprint(), allBefore);
          assert.deepEqual(await oldDefinitions(), oldAll);
          await transition({ rollback: true });
          assert.equal(await verifyCatalogImage199(app, role, await options()), null);
          assert.equal(await fingerprint(), allBefore);
          assert.deepEqual(await oldDefinitions(), oldAll);
        },
      );
    } finally {
      if (connected) await app.end();
      await f.close();
    }
  },
);
