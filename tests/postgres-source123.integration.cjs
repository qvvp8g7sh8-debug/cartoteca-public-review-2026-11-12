const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { nativeIsolatedFixture } = require('./helpers/native-isolated-fixture.cjs');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { migratePostgresData } = require('../src/server/infrastructure/postgres/migration.cjs');
test(
  'actual PostgreSQL import rolls back an external source key-byte change before COMMIT and assets publication',
  { timeout: 120000 },
  async (t) => {
    const source = await nativeIsolatedFixture(t);
    const closeSource = source.platform.close;
    let sourceClosed = false;
    source.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        closeSource();
      }
    };
    source.platform.close();
    const runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      destination = path.join(runtime.root, 'assets');
    let injected = false;
    const queries = [];
    try {
      await admin.connect();
      const guarded = {
        query: async (...args) => {
          const sql = args[0];
          queries.push(sql);
          const result = await admin.query(...args);
          if (
            !injected &&
            typeof sql === 'string' &&
            sql.startsWith('INSERT INTO cartoteca_catalog.asset_profiles')
          ) {
            const file = path.join(source.directory, 'platform', 'platform.key'),
              bytes = fs.readFileSync(file);
            bytes[0] ^= 1;
            fs.writeFileSync(file, bytes);
            injected = true;
          }
          return result;
        },
      };
      await assert.rejects(
        migratePostgresData({
          source: source.directory,
          destination,
          client: guarded,
          offline: true,
          dryRun: false,
        }),
        (error) => error.code === 'POSTGRES_SOURCE_CHANGED',
      );
      assert.equal(
        injected,
        true,
        'the external change must occur after native rows and asset lineage were staged',
      );
      assert.ok(queries.includes('ROLLBACK'));
      assert.ok(!queries.includes('COMMIT'));
      assert.equal(fs.existsSync(destination), false);
      assert.equal(
        (
          await admin.query(
            "SELECT 1 FROM pg_namespace WHERE nspname IN ('cartoteca_platform','cartoteca_cabinet','cartoteca_catalog')",
          )
        ).rows.length,
        0,
        'native schemas, rows and migration receipt must all roll back',
      );
    } finally {
      await admin.end();
      await runtime.close();
    }
  },
);

test(
  'actual PostgreSQL import preserves a committed uncheckpointed WAL after the last writer exits',
  { timeout: 120000 },
  async (t) => {
    const { spawnSync } = require('node:child_process');
    const { assetHash } = require('../src/server/infrastructure/postgres/migration-assets.cjs');
    const source = await nativeIsolatedFixture(t),
      closeSource = source.platform.close;
    let sourceClosed = false;
    source.platform.close = () => {
      if (!sourceClosed) {
        sourceClosed = true;
        closeSource();
      }
    };
    source.platform.close();
    const filename = path.join(source.directory, 'platform', 'platform.sqlite'),
      beforeWriter = assetHash(filename);
    const writer = spawnSync(
      process.execPath,
      [
        '-e',
        [
          "const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');",
          'const db=new DatabaseSync(process.argv[1]);',
          "if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal')throw Error('Synthetic source must already be WAL mode');",
          "db.exec('PRAGMA wal_autocheckpoint=0');",
          "db.prepare('INSERT INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)').run('synthetic-retained-wal',7,0,0);",
          "fs.writeSync(1,'synthetic-wal-committed\\n');",
          // Abrupt, synchronous termination deliberately bypasses sqlite3_close and its
          // automatic final checkpoint. No writer remains when the parent imports.
          "process.kill(process.pid,'SIGKILL');",
        ].join(''),
        filename,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 4096,
      },
    );
    assert.equal(writer.error, undefined);
    assert.match(writer.stdout, /synthetic-wal-committed/);
    assert.ok(
      writer.signal === 'SIGKILL' || writer.status !== 0,
      'writer must exit without a clean SQLite close',
    );
    assert.equal(
      assetHash(filename),
      beforeWriter,
      'the committed scalar must not already be in the main database',
    );
    const wal = filename + '-wal';
    assert.ok(fs.statSync(wal).size > 32, 'committed WAL must remain after the writer exits');
    const primaryHash = assetHash(filename),
      walHash = assetHash(wal),
      runtime = await startPostgresTestRuntime(),
      admin = new Client(runtime.admin),
      destination = path.join(runtime.root, 'assets');
    try {
      await admin.connect();
      const result = await migratePostgresData({
        source: source.directory,
        destination,
        client: admin,
        offline: true,
        dryRun: false,
      });
      assert.equal(result.sourceUnchanged, true);
      const profile = JSON.parse(
        fs.readFileSync(path.join(destination, 'postgresql-runtime.json'), 'utf8'),
      );
      const copied = (
        await admin.query(
          "SELECT failures FROM cartoteca_platform.login_limits WHERE _store_id=$1 AND key='synthetic-retained-wal'",
          [profile.platformStoreId],
        )
      ).rows;
      assert.equal(copied.length, 1);
      assert.equal(
        Number(copied[0].failures),
        7,
        'native target must include the transaction committed only in WAL',
      );
      assert.equal(assetHash(filename), primaryHash);
      assert.equal(assetHash(wal), walHash);
    } finally {
      await admin.end();
      await runtime.close();
    }
  },
);
