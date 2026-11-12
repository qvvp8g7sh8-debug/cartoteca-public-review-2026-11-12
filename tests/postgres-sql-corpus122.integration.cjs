const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');
const { startPostgresTestRuntime } = require('../scripts/postgres-test-runtime.cjs');
const { collectRuntimeSQL, compileCorpus } = require('../scripts/postgres-sql-corpus.cjs');
const { collectBuilderSQL } = require('../scripts/postgres-sql-builders.cjs');
const {
  canonicalSqliteSchema,
} = require('../src/server/infrastructure/postgres/catalog-canonical.cjs');
const {
  preparePostgresSchema,
} = require('../src/server/infrastructure/postgres/schema-prepare.cjs');

// Native EXPLAIN without ANALYZE parses, resolves and plans each source statement;
// it cannot send a notification, insert a booking or execute the compiled DML.
// Dynamic source builders remain separately enumerated, never counted as covered.
test(
  'statically resolved runtime SQL compiles and plans against actual scoped PostgreSQL schemas',
  { timeout: 120000 },
  async (t) => {
    assert.ok(process.env.CARTOTECA_TEST_PG, 'The shared synthetic PostgreSQL harness is required');
    const catalogs = {
      platform: canonicalSqliteSchema({
        kind: 'platform',
        version: 20,
        components: {
          assistantRows: true,
          notificationMaintenance: true,
          bookingPublicLinks: true,
          isolatedReadBudgets: true,
        },
      }),
      cabinet: canonicalSqliteSchema({ kind: 'cabinet', version: 2, components: { patientHistory: true } }),
      budget: canonicalSqliteSchema({ kind: 'budget', version: 1 }),
    };
    const root = path.resolve(__dirname, '..'),
      source = collectRuntimeSQL(root);
    const generated = collectBuilderSQL(root, catalogs.platform);
    source.statements.push(...generated);
    const exercised = (entry) =>
      generated.some(
        (candidate) =>
          candidate.file === entry.file &&
          candidate.line >= entry.line &&
          candidate.line <= entry.endLine,
      );
    const generatedBuilderSites = source.unresolved.filter(exercised);
    source.unresolved = source.unresolved.filter((entry) => !exercised(entry));
    const corpus = compileCorpus(source, catalogs);
    assert.ok(corpus.compiled.length > 700, 'Corpus must not silently become a trivial fixture');
    assert.deepEqual(
      corpus.rejected.map((entry) => ({
        file: entry.file,
        line: entry.line,
        sql: entry.sql,
        errors: entry.errors,
      })),
      [],
      'Every statically resolved runtime statement requires an explicit implementation',
    );
    t.diagnostic(
      JSON.stringify({
        variants: corpus.compiled.length,
        generatedVariants: generated.length,
        exercisedBuilderSites: generatedBuilderSites.length,
        controls: corpus.controls.length,
        unresolvedBuilders: corpus.unresolved.map((entry) => ({
          file: entry.file,
          line: entry.line,
        })),
        excluded: corpus.excluded.length,
      }),
    );
    const runtime = await startPostgresTestRuntime();
    const admin = new Client(runtime.admin),
      app = new Client(runtime.application);
    t.after(async () => {
      try {
        await app.end();
      } finally {
        try {
          await admin.end();
        } finally {
          await runtime.close();
        }
      }
    });
    await admin.connect();
    await admin.query('BEGIN');
    for (const [kind, catalog] of Object.entries(catalogs))
      await preparePostgresSchema(admin, {
        kind,
        source: catalog,
        storeId: '00000000-0000-4000-8000-000000000122',
        applicationRole: runtime.application.user,
      });
    await admin.query('COMMIT');
    await app.connect();
    const before = (
      await admin.query(
        'SELECT kind,store_id,revision FROM cartoteca_catalog.stores ORDER BY kind,store_id',
      )
    ).rows;
    const visited = new Set(),
      failures = [];
    let statements = 0,
      alternatives = 0;
    async function explain(plan) {
      if (plan.control) {
        assert.match(
          plan.control,
          /^(BEGIN( (DEFERRED|IMMEDIATE|SHARED|QUEUE|READONLY))?|COMMIT|ROLLBACK)$/,
        );
        return;
      }
      if (plan.steps) {
        for (const step of plan.steps) await explain(step);
        return;
      }
      const key = plan.text + JSON.stringify(plan.values);
      if (visited.has(key)) return;
      await app.query('EXPLAIN (FORMAT JSON) ' + plan.text, plan.values);
      visited.add(key);
      statements++;
    }
    for (const entry of corpus.compiled) {
      const reasons = [];
      let accepted = false;
      for (const candidate of entry.candidates) {
        await app.query(
          "SELECT set_config('cartoteca.kind',$1,false),set_config('cartoteca.store_id',$2,false)",
          [candidate.kind, candidate.scope.storeId],
        );
        try {
          await explain(candidate.plan);
          accepted = true;
          break;
        } catch (error) {
          reasons.push({ kind: candidate.kind, code: error.code, message: error.message });
        }
      }
      alternatives += Math.max(0, reasons.length);
      if (!accepted) failures.push({ file: entry.file, line: entry.line, sql: entry.sql, reasons });
    }
    assert.deepEqual(
      failures,
      [],
      'Native PostgreSQL must resolve and type every statically compiled source statement',
    );
    assert.deepEqual(
      (
        await admin.query(
          'SELECT kind,store_id,revision FROM cartoteca_catalog.stores ORDER BY kind,store_id',
        )
      ).rows,
      before,
      'EXPLAIN must never execute source mutations',
    );
    t.diagnostic(
      JSON.stringify({
        nativeStatementsPlanned: statements,
        alternativeCatalogsChecked: alternatives,
      }),
    );
  },
);
