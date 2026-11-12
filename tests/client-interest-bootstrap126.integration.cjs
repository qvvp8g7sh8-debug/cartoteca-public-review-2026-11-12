const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');
const {
  createPostgresCoordinator,
} = require('../src/server/infrastructure/postgres/coordinator.cjs');
const {
  createClientNotificationInterest,
} = require('../src/server/modules/notifications/client-notification-interest.cjs');
const PREFIX = 'client-interest-v1:';

test(
  'actual PG missing-ready 10k client index reconciles pages atomically without rewriting 20k ciphertexts',
  { timeout: 120000 },
  async (t) => {
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      scope = { kind: 'platform', storeId: randomUUID() },
      owners = [];
    t.after(async () => {
      try {
        for (const owner of owners) await owner.close();
      } finally {
        try {
          await admin.end();
        } finally {
          await runtime.close();
        }
      }
    });
    await admin.connect();
    const source = canonicalSqliteSchema({ kind: 'platform', version: 19 });
    const seedStarted = performance.now();
    const progress = (phase, dataset, rows = 0) =>
      process.stderr.write(
        JSON.stringify({
          stage: 'client-interest-fixture126',
          phase,
          dataset,
          rows,
          elapsedMs: Math.round(performance.now() - seedStarted),
        }) + '\n',
      );
    const withSeedTransaction = async (work) => {
      await admin.query('BEGIN');
      try {
        await admin.query(
          "SELECT set_config('cartoteca.kind',$1,true),set_config('cartoteca.store_id',$2,true)",
          [scope.kind, scope.storeId],
        );
        await work();
        await admin.query('COMMIT');
      } catch (error) {
        await admin.query('ROLLBACK');
        throw error;
      }
    };
    progress('started', 'canonicalSchema');
    await withSeedTransaction(() =>
      preparePostgresSchema(admin, {
        ...scope,
        source,
        applicationRole: runtime.application.user,
      }),
    );
    progress('completed', 'canonicalSchema');
    const seed = async (dataset, text, extra = []) => {
      for (let first = 1; first <= 10000; first += 1000) {
        const last = Math.min(10000, first + 999);
        progress('batchStarted', dataset, last - first + 1);
        await withSeedTransaction(() => admin.query(text, [scope.storeId, first, last, ...extra]));
        progress('batchCommitted', dataset, last);
      }
    };
    // Keep seed transactions short as well: the real per-row revision trigger
    // updates one catalog row, whose MVCC chain must not grow across 70k changes
    // in a single artificial preparation transaction. All triggers stay enabled.
    await seed(
      'organizations',
      "INSERT INTO cartoteca_platform.organizations(_store_id,id,value,slug,created_at) SELECT $1,'00000000-0000-4000-8000-'||lpad(n::text,12,'0'),$4,'synthetic-'||n::text,0 FROM generate_series($2::integer,$3::integer)n",
      [Buffer.from('{}')],
    );
    const range =
      "_store_id=$1 AND id>='00000000-0000-4000-8000-'||lpad($2::text,12,'0') AND id<='00000000-0000-4000-8000-'||lpad($3::text,12,'0')";
    await seed(
      'settings',
      'INSERT INTO cartoteca_platform.telegram_settings(_store_id,organization_id,value) SELECT _store_id,id,$4 FROM cartoteca_platform.organizations WHERE ' +
        range,
      [Buffer.from('{"enabled":true,"events":["reminder"]}')],
    );
    await seed(
      'telegramLinks',
      "INSERT INTO cartoteca_platform.telegram_links(_store_id,organization_id,patient_id,chat_hash,value) SELECT _store_id,id,'patient','hash-'||id,$4 FROM cartoteca_platform.organizations WHERE " +
        range,
      [Buffer.from('{}')],
    );
    await seed(
      'maxLinks',
      "INSERT INTO cartoteca_platform.max_client_links(_store_id,organization_id,patient_id,recipient_hash,value) SELECT _store_id,id,'patient','hash-'||id,$4 FROM cartoteca_platform.organizations WHERE " +
        range,
      [Buffer.from('{}')],
    );
    for (const kind of ['all', 'reminder'])
      await seed(
        'markers-' + kind,
        "INSERT INTO cartoteca_platform.telegram_runtime(_store_id,key,value) SELECT _store_id,'client-interest-v1:'||$4::text||':'||id,convert_to('synthetic-marker-'||$4::text||':'||id,'UTF8') FROM cartoteca_platform.organizations WHERE " +
          range,
        [kind],
      );
    await withSeedTransaction(() =>
      admin.query(
        "INSERT INTO cartoteca_platform.telegram_runtime(_store_id,key,value) VALUES($1,'poll-leader',$2)",
        [scope.storeId, Buffer.from('synthetic-unrelated')],
      ),
    );
    progress('completed', 'allSeed', 60001);
    const owner = createPostgresCoordinator({
        allowBlocking: true,
        connection: runtime.application,
      }),
      other = createPostgresCoordinator({ allowBlocking: true, connection: runtime.application });
    owners.push(owner, other);
    await Promise.all([owner.ready(), other.ready()]);
    const p = owner.open({ ...scope, schemaVersion: 19 }),
      p2 = other.open({ ...scope, schemaVersion: 19 });
    const stats = { calls: 0, writes: 0, failReady: false, competition: false },
      seal = (value) => Buffer.from(JSON.stringify(value)),
      open = (value) => JSON.parse(Buffer.from(value).toString());
    const db = {
      get isTransaction() {
        return p.isTransaction;
      },
      prepare(text) {
        const statement = p.prepare(text);
        return Object.fromEntries(
          ['get', 'all', 'run'].map((method) => [
            method,
            (...args) => {
              stats.calls++;
              if (method === 'run') {
                stats.writes++;
                if (stats.failReady && args[0] === PREFIX + 'ready')
                  throw Error('Synthetic ready publication failure');
              }
              if (!stats.competition && method === 'all' && text.includes('candidate_orgs')) {
                stats.competition = true;
                assert.throws(
                  () => p2.exec('BEGIN IMMEDIATE'),
                  (error) =>
                    error.code === 'ERR_SQLITE_ERROR' &&
                    error.postgresCode === 'POSTGRES_BUSY' &&
                    error.retryableBeforeBegin &&
                    error.transactionOpen === false,
                );
              }
              return statement[method](...args);
            },
          ]),
        );
      },
    };
    const context = {
      db,
      seal,
      open,
      transaction: (callback) => p.transaction(callback),
      notificationChannels: { enabled: () => true },
    };
    const interest = createClientNotificationInterest(context),
      org = (index) => '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
    async function markers() {
      return (
        await admin.query(
          "SELECT key,value FROM cartoteca_platform.telegram_runtime WHERE _store_id=$1 AND key<>'client-interest-v1:ready' ORDER BY key",
          [scope.storeId],
        )
      ).rows;
    }
    const digest = (rows) => {
      const hash = createHash('sha256');
      for (const row of rows) {
        hash.update(row.key + '\0');
        hash.update(row.value);
      }
      return hash.digest('hex');
    };
    const before = await markers(),
      began = performance.now();
    assert.equal(interest.has(), true);
    const elapsedMs = performance.now() - began,
      calls = stats.calls;
    assert.ok(calls < 260);
    assert.equal(stats.writes, 1);
    assert.equal(stats.competition, true);
    assert.equal(digest(await markers()), digest(before));
    t.diagnostic(
      JSON.stringify({
        organizations: 10000,
        existingMarkers: 20000,
        bootstrapMilliseconds: elapsedMs,
        logicalSqlCalls: calls,
        logicalMutations: 1,
        competingPolicyOwnerRefusedBeforeBegin: true,
      }),
    );
    // Reconcile changed authoritative settings, then force a failure after all
    // differential changes but before readiness can be published.
    p.transaction(() => {
      p.prepare('DELETE FROM telegram_runtime WHERE key=?').run(PREFIX + 'ready');
      p.prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?').run(
        seal({ events: ['created'] }),
        org(1),
      );
      p.prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?').run(
        seal({ restoredPaused: true }),
        org(2),
      );
      p.prepare('DELETE FROM telegram_runtime WHERE key=?').run(PREFIX + 'all:' + org(3));
    });
    const beforeFailure = digest(await markers());
    stats.failReady = true;
    assert.throws(() => interest.has(), /Synthetic ready publication failure/);
    assert.equal(digest(await markers()), beforeFailure);
    assert.equal(
      p.prepare('SELECT 1 FROM telegram_runtime WHERE key=?').get(PREFIX + 'ready'),
      undefined,
    );
    stats.failReady = false;
    assert.equal(interest.has(org(1)), false);
    assert.equal(interest.has(org(1), ['max'], 'lifecycle'), true);
    assert.equal(interest.has(org(2)), false);
    assert.equal(interest.has(org(3)), true);
    p2.transaction(() => {
      p2.prepare('DELETE FROM telegram_links WHERE organization_id=?').run(org(3));
      p2.prepare('DELETE FROM max_client_links WHERE organization_id=?').run(org(3));
    });
    assert.equal(interest.has(org(3)), false);
    p2.transaction(() => {
      p2.prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?').run(
        seal({ events: [] }),
        org(4),
      );
      createClientNotificationInterest({
        db: p2,
        seal,
        open,
        transaction: (callback) => p2.transaction(callback),
      }).touch(org(4));
    });
    assert.equal(
      interest.has(org(4)),
      false,
      'a second owner mutation updates an already-ready index without stale local caches',
    );
    assert.deepEqual(interest.batch('', 2, ['telegram'], 'reminder'), [org(5), org(6)]);
    assert.deepEqual(
      Buffer.from(
        p.prepare('SELECT value FROM telegram_runtime WHERE key=?').get('poll-leader').value,
      ),
      Buffer.from('synthetic-unrelated'),
    );
  },
);
