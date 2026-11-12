const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { createTransport } = require('../src/server/infrastructure/postgres/transport.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const { storeCatalog } = require('../src/server/infrastructure/postgres/catalog-postgres.cjs');
const { createReadVersion } = require('../src/server/infrastructure/read-version.cjs');
const { KEYS } = require('../src/server/infrastructure/postgres/lock-intents.cjs');

test(
  'actual PostgreSQL lock intents isolate queue RMW while retaining policy, maintenance and tenant barriers',
  { timeout: 120000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      transports = [];
    const platform = { kind: 'platform', storeId: randomUUID() },
      a = { kind: 'cabinet', storeId: randomUUID() },
      b = { kind: 'cabinet', storeId: randomUUID() };
    t.after(async () => {
      try {
        for (const x of transports) await x.close();
      } finally {
        try {
          await admin.end();
        } finally {
          await runtime.close();
        }
      }
    });
    await admin.connect();
    const cabinetCatalog = canonicalSqliteSchema({ kind: 'cabinet', version: 1 }),
      platformCatalog = canonicalSqliteSchema({ kind: 'platform', version: 19 });
    await admin.query('BEGIN');
    try {
      await preparePostgresSchema(admin, {
        ...a,
        source: cabinetCatalog,
        applicationRole: runtime.application.user,
      });
      await storeCatalog(admin, { ...b, source: cabinetCatalog });
      await preparePostgresSchema(admin, {
        ...platform,
        source: platformCatalog,
        applicationRole: runtime.application.user,
      });
      await admin.query(
        'INSERT INTO cartoteca_platform.organizations(_store_id,id,value,slug,created_at) VALUES($1,$2,$3,$4,0),($1,$5,$3,$6,0)',
        [
          platform.storeId,
          a.storeId,
          Buffer.from('synthetic'),
          'synthetic-a',
          b.storeId,
          'synthetic-b',
        ],
      );
      await admin.query('COMMIT');
    } catch (e) {
      await admin.query('ROLLBACK');
      throw e;
    }
    async function connection() {
      const x = createTransport({ connection: runtime.application, timeoutMs: 5000 });
      transports.push(x);
      await x.ready();
      return x;
    }
    const first = await connection(),
      second = await connection(),
      third = await connection(),
      fourth = await connection();
    const begin = (x, scope, mode) => x.request({ op: 'begin', scope, mode });
    const end = (x, scope, rollback = false) =>
      x.request({ op: rollback ? 'rollback' : 'commit', scope });
    const sql = (x, scope, text, values = [], effect = 'read') =>
      x.request(
        {
          op: 'execute',
          scope,
          plan: { text, values, effect },
          method: 'all',
          mutating: effect === 'write',
        },
        { mutating: effect === 'write' },
      );
    const roleWrite = (x, value) =>
      sql(
        x,
        platform,
        'INSERT INTO cartoteca_platform.telegram_runtime(key,value) VALUES($1,$2)',
        ['application-process-roles', Buffer.from(value)],
        'write',
      );
    const busyBefore = (error) =>
      error.code === 'POSTGRES_BUSY' &&
      error.retryableBeforeBegin === true &&
      error.transactionOpen === false &&
      !error.channelPoisoned &&
      !error.outcomeUnknown;

    await t.test(
      'queue, MVCC reads and clinical commits overlap, while revoke/default platform writes wait',
      () => {
        begin(first, platform, 'QUEUE');
        roleWrite(first, 'one');
        begin(second, platform, 'READONLY');
        assert.equal(
          sql(second, platform, "SELECT current_setting('transaction_read_only') AS value").rows[0]
            .value,
          'on',
        );
        assert.equal(
          sql(second, platform, 'SELECT key FROM cartoteca_platform.telegram_runtime').rows.length,
          0,
        );
        begin(third, platform, 'SHARED');
        third.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_1' });
        sql(
          third,
          a,
          'INSERT INTO cartoteca_cabinet.patients(id,value) VALUES($1,$2)',
          ['patient-a', Buffer.from('synthetic')],
          'write',
        );
        third.request({ op: 'release', scope: a, name: 'ct_sp_1' });
        assert.throws(() => begin(fourth, platform, 'IMMEDIATE'), busyBefore);
        end(first, platform);
        assert.throws(
          () => begin(fourth, platform, 'IMMEDIATE'),
          busyBefore,
          'clinical fresh-ACL fence still protects commit',
        );
        assert.equal(
          sql(second, platform, 'SELECT key FROM cartoteca_platform.telegram_runtime').rows.length,
          0,
          'read snapshot stays consistent across queue commit',
        );
        end(second, platform);
        end(third, platform);
        begin(fourth, platform, 'IMMEDIATE');
        end(fourth, platform);
      },
    );

    await t.test(
      'platform queue writers serialize before callback and never lose an encrypted RMW update',
      () => {
        begin(first, platform, 'QUEUE');
        assert.equal(
          sql(
            first,
            platform,
            'SELECT value FROM cartoteca_platform.telegram_runtime',
          ).rows[0].value.toString(),
          'one',
        );
        assert.throws(() => begin(second, platform, 'QUEUE'), busyBefore);
        sql(
          first,
          platform,
          'UPDATE cartoteca_platform.telegram_runtime SET value=$1 WHERE key=$2',
          [Buffer.from('two'), 'application-process-roles'],
          'write',
        );
        end(first, platform);
        begin(second, platform, 'QUEUE');
        assert.equal(
          sql(
            second,
            platform,
            'SELECT value FROM cartoteca_platform.telegram_runtime',
          ).rows[0].value.toString(),
          'two',
        );
        sql(
          second,
          platform,
          'UPDATE cartoteca_platform.telegram_runtime SET value=$1 WHERE key=$2',
          [Buffer.from('three'), 'application-process-roles'],
          'write',
        );
        end(second, platform);
      },
    );

    await t.test(
      'restricted SQL/key guards reject disguised writes, policy changes and nested upgrades without aborting a queue',
      () => {
        begin(first, platform, 'QUEUE');
        for (const [scope, text, values, effect] of [
          [
            platform,
            'UPDATE cartoteca_platform.organizations SET value=$1',
            [Buffer.from('forbidden')],
            'write',
          ],
          [
            platform,
            'UPDATE cartoteca_platform.accounts SET value=$1',
            [Buffer.from('forbidden')],
            'read',
          ],
          [a, 'DELETE FROM cartoteca_cabinet.patients', [], 'write'],
          [
            platform,
            'DELETE FROM cartoteca_platform.telegram_runtime WHERE key=$1 OR key=$2',
            ['application-process-roles', 'offset'],
            'write',
          ],
          [platform, 'SELECT cartoteca_catalog.provision_store($1,$2,$3,$4,$5)', [], 'read'],
        ])
          assert.throws(() => sql(first, scope, text, values, effect), {
            code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN',
          });
        assert.throws(
          () => first.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_2' }),
          { code: 'POSTGRES_QUEUE_WRITE_FORBIDDEN' },
        );
        first.request({ op: 'savepoint', scope: a, mode: 'READONLY', name: 'ct_sp_3' });
        assert.throws(
          () =>
            sql(
              first,
              platform,
              'DELETE FROM cartoteca_platform.telegram_runtime WHERE key=$1',
              ['application-process-roles'],
              'write',
            ),
          { code: 'POSTGRES_QUERY_ONLY' },
        );
        first.request({ op: 'rollbackTo', scope: a, name: 'ct_sp_3' });
        first.request({ op: 'release', scope: a, name: 'ct_sp_3' });
        sql(
          first,
          platform,
          'UPDATE cartoteca_platform.telegram_runtime SET value=$1 WHERE key=$2',
          [Buffer.from('four'), 'application-process-roles'],
          'write',
        );
        end(first, platform);
      },
    );

    await t.test(
      'read-only statement errors require whole-snapshot rollback and cannot leak an upgraded intent',
      () => {
        begin(first, platform, 'READONLY');
        assert.throws(
          () => first.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_4' }),
          { code: 'POSTGRES_QUERY_ONLY' },
        );
        assert.throws(
          () =>
            sql(first, platform, 'DELETE FROM cartoteca_platform.telegram_runtime', [], 'write'),
          { code: 'POSTGRES_QUERY_ONLY' },
        );
        assert.throws(() => sql(first, platform, 'SELECT 1/0 AS value'), { code: '22012' });
        assert.throws(() => sql(first, platform, 'SELECT 1 AS value'), { code: '25P02' });
        end(first, platform, true);
        assert.equal(sql(first, platform, 'SELECT 1 AS value').rows[0].value, 1);
      },
    );

    await t.test(
      'rollback releases newly acquired tenant locks and default statement recovery still works',
      () => {
        begin(first, platform, 'SHARED');
        first.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_5' });
        first.request({ op: 'rollbackTo', scope: a, name: 'ct_sp_5' });
        first.request({ op: 'release', scope: a, name: 'ct_sp_5' });
        begin(second, platform, 'SHARED');
        second.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_6' });
        assert.throws(
          () => first.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_7' }),
          (error) => error.code === 'POSTGRES_BUSY' && !error.retryableBeforeBegin,
        );
        second.request({ op: 'release', scope: a, name: 'ct_sp_6' });
        end(second, platform);
        end(first, platform);
        begin(first, platform, 'IMMEDIATE');
        first.request({ op: 'savepoint', scope: a, mode: 'IMMEDIATE', name: 'ct_sp_8' });
        assert.throws(
          () =>
            sql(
              first,
              a,
              'INSERT INTO cartoteca_cabinet.patients(id,value) VALUES($1,$2)',
              ['patient-a', Buffer.from('duplicate')],
              'write',
            ),
          { code: '23505' },
        );
        first.request({ op: 'release', scope: a, name: 'ct_sp_8' });
        sql(
          first,
          platform,
          'UPDATE cartoteca_platform.telegram_runtime SET value=$1 WHERE key=$2',
          [Buffer.from('five'), 'application-process-roles'],
          'write',
        );
        end(first, platform);
      },
    );

    await t.test(
      'the original native backup barrier excludes every new transaction mode, including budget scope',
      async () => {
        await admin.query('SELECT pg_advisory_lock($1::bigint)', [KEYS.maintenance]);
        try {
          for (const [scope, mode] of [
            [platform, 'QUEUE'],
            [platform, 'IMMEDIATE'],
            [platform, 'READONLY'],
            [a, 'IMMEDIATE'],
            [{ kind: 'budget', storeId: randomUUID() }, 'IMMEDIATE'],
          ])
            assert.throws(() => begin(first, scope, mode), busyBefore);
        } finally {
          await admin.query('SELECT pg_advisory_unlock($1::bigint)', [KEYS.maintenance]);
        }
        begin(first, platform, 'QUEUE');
        end(first, platform);
      },
    );

    await t.test(
      'fresh revision tokens see local and foreign queue commits while an existing RR snapshot stays pinned',
      async () => {
        const owner = createPostgresCoordinator({
          allowBlocking: true,
          transport: first,
          catalog: platformCatalog,
        });
        const p = owner.open(platform),
          read = createReadVersion(p),
          original = read();
        assert.equal(original[1], original[2]);
        p.transaction(
          () =>
            p
              .prepare('UPDATE telegram_runtime SET value=? WHERE key=?')
              .run(Buffer.from('six'), 'application-process-roles'),
          'QUEUE',
        );
        const local = read();
        assert.ok(local[1] > original[1]);
        assert.equal(local[1], local[2]);
        p.exec('BEGIN READONLY');
        const snapshot = read();
        begin(second, platform, 'QUEUE');
        sql(
          second,
          platform,
          'UPDATE cartoteca_platform.telegram_runtime SET value=$1 WHERE key=$2',
          [Buffer.from('seven'), 'application-process-roles'],
          'write',
        );
        end(second, platform);
        assert.deepEqual(read(), snapshot);
        p.exec('COMMIT');
        const foreign = read();
        assert.ok(foreign[1] > snapshot[1]);
        assert.equal(foreign[1], foreign[2]);
        assert.equal(foreign[0], original[0]);
      },
    );

    await t.test(
      'missing-store provisioning is denied inside either restricted intent but existing lazy scopes remain inspectable',
      () => {
        const existing = {
          ...a,
          allowCreate: true,
          schemaVersion: 1,
          platformStoreId: platform.storeId,
        };
        for (const mode of ['QUEUE', 'READONLY']) {
          begin(first, platform, mode);
          assert.equal(
            first.request({
              op: 'inspect',
              scope: a,
              allowCreate: true,
              version: 1,
              platformStoreId: platform.storeId,
            }).exists,
            true,
          );
          assert.throws(
            () =>
              first.request({
                op: 'inspect',
                scope: { kind: 'cabinet', storeId: randomUUID() },
                allowCreate: true,
                version: 1,
                platformStoreId: platform.storeId,
              }),
            { code: 'POSTGRES_PROVISION_INTENT_FORBIDDEN' },
          );
          end(first, platform, true);
        }
      },
    );
  },
);
