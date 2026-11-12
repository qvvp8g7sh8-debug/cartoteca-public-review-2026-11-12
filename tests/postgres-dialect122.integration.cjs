const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');
const {
  compatibilityFunctionsSQL,
} = require('../src/server/infrastructure/postgres/dialect-functions.cjs');
const { compile } = require('../src/server/infrastructure/postgres/dialect.cjs');

// Explicit PostgreSQL stage only: the parent harness owns one temporary cluster.
// This file never starts another server, copies DATA or silently skips missing PG.
test(
  'actual PostgreSQL compatibility helpers agree with native SQLite on application query forms',
  { timeout: 30000 },
  async (t) => {
    assert.ok(
      process.env.CARTOTECA_TEST_PG,
      'The shared synthetic PostgreSQL harness must supply CARTOTECA_TEST_PG',
    );
    const configuration = JSON.parse(process.env.CARTOTECA_TEST_PG);
    const client = new Client(configuration.admin || configuration),
      sqlite = new DatabaseSync(':memory:');
    await client.connect();
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS cartoteca_catalog');
      for (const sql of compatibilityFunctionsSQL) await client.query(sql);
      await t.test(
        'GLOB, literal LIKE backslashes and ASCII case folding preserve comparison semantics',
        async () => {
          const pairs = [
            ['alpha', 'a*'],
            ['Alpha', 'a*'],
            ['line\nend', 'line?end'],
            ['a\n', 'a'],
            ['x', '[a-z]'],
            ['X', '[a-z]'],
            ['a', '[^a]'],
            ['x', '[^a]'],
            [']', '[]x]'],
            ['-', '[a-]'],
            ['[', '['],
            ['Юлия', 'Ю*'],
            ['Юлия', 'ю*'],
            ['abc', 'a%'],
            ['Abc', 'a%'],
            ['А', 'а'],
            ['path\\file', 'path\\%'],
            ['100%', '100%'],
            ['under_score', 'under_score'],
          ];
          for (const operation of ['glob', 'like'])
            for (const [value, pattern] of pairs) {
              const expected = sqlite
                .prepare(`SELECT ? ${operation.toUpperCase()} ? AS matched`)
                .get(value, pattern).matched;
              const actual = await client.query(
                `SELECT cartoteca_catalog.${operation}_match($1,$2) AS matched`,
                [value, pattern],
              );
              assert.equal(
                actual.rows[0].matched == null ? null : Number(actual.rows[0].matched),
                expected,
                operation + ': ' + JSON.stringify([value, pattern]),
              );
            }
          for (const operation of ['lower', 'upper']) {
            const value = 'AZaz-Юлия-Ää';
            const expected = sqlite.prepare(`SELECT ${operation}(?) AS value`).get(value).value;
            assert.equal(
              (
                await client.query(`SELECT cartoteca_catalog.ascii_${operation}($1) AS value`, [
                  value,
                ])
              ).rows[0].value,
              expected,
            );
          }
        },
      );
      await t.test(
        'JSON batch preserves requested order, duplicate IDs, null and exact scoped field extraction',
        async () => {
          const entries = JSON.stringify([
            'second',
            'first',
            'second',
            null,
            { patient: 'p', stamp: 's' },
          ]);
          const expected = sqlite
            .prepare('SELECT key,value FROM json_each(?) ORDER BY key')
            .all(entries);
          const actual = (
            await client.query(
              'SELECT key,value FROM cartoteca_catalog.json_each($1) ORDER BY key',
              [entries],
            )
          ).rows;
          assert.deepEqual(
            actual.map((row) => ({
              key: Number(row.key),
              value: row.value && row.value[0] === '{' ? JSON.parse(row.value) : row.value,
            })),
            expected.map((row) => ({
              key: row.key,
              value:
                typeof row.value === 'string' && row.value[0] === '{'
                  ? JSON.parse(row.value)
                  : row.value,
            })),
          );
          for (const [source, path] of [
            [{ patient: 'p', stamp: 's' }, '$.stamp'],
            [['org', 'account'], '$[0]'],
            [['org', 'account'], '$[1]'],
            [{ targetType: 'account' }, '$.targetType'],
            [{}, '$.missing'],
            [{ stamp: null }, '$.stamp'],
          ]) {
            const body = JSON.stringify(source),
              expected = sqlite.prepare('SELECT json_extract(?,?) AS value').get(body, path).value;
            assert.equal(
              (
                await client.query('SELECT cartoteca_catalog.json_extract($1,$2) AS value', [
                  body,
                  path,
                ])
              ).rows[0].value,
              expected,
            );
          }
          await assert.rejects(
            client.query('SELECT * FROM cartoteca_catalog.json_each($1)', ['{}']),
            { code: '22023' },
          );
          await assert.rejects(
            client.query('SELECT cartoteca_catalog.json_extract($1,$2)', ['{}', '$..unsafe']),
            { code: '22023' },
          );
        },
      );
      await t.test(
        'compiled numeric scalar min/max preserves NULL, numeric ordering and field labels',
        async () => {
          for (const operation of ['min', 'max'])
            for (const values of [
              [2, 10],
              [10, 2],
              [null, 3],
              [3, null],
              [null, null],
              [-1, 0],
              [1.25, 1.5],
            ]) {
              const sql = `SELECT ${operation}(?,?) AS "UpperBound"`;
              const expected = sqlite.prepare(sql).get(...values).UpperBound;
              const plan = compile(
                sql,
                { kind: 'cabinet', storeId: 'synthetic-functions' },
                values,
                'get',
                { tables: {} },
              );
              const actual = (await client.query(plan.text, plan.values)).rows[0].UpperBound;
              assert.equal(
                actual === null ? null : Number(actual),
                expected,
                operation + ': ' + JSON.stringify(values),
              );
            }
        },
      );
      await t.test(
        'JSON validity and CHECK keep syntax, boolean scalars, escaped NUL and huge numeric literals',
        async () => {
          sqlite.exec('CREATE TABLE dialect_json_checks(value TEXT CHECK(json_valid(value)))');
          await client.query(
            'CREATE TEMP TABLE dialect_json_checks(value text CHECK(cartoteca_catalog.json_valid(value)<>0))',
          );
          const entries = [
            null,
            'null',
            'true',
            'false',
            '"hello"',
            '{}',
            '[]',
            '{"x":"\\u0000"}',
            '"\\ud800"',
            '1e1000000',
            '{"same":1,"same":2}',
            '',
            '{bad',
            'true false',
          ];
          let accepted = 0;
          for (const source of entries) {
            const expected = sqlite.prepare('SELECT json_valid(?) AS valid').get(source).valid;
            const actual = (
              await client.query('SELECT cartoteca_catalog.json_valid($1) AS valid', [source])
            ).rows[0].valid;
            assert.equal(actual, expected, JSON.stringify(source));
            if (expected || expected === null) {
              sqlite.prepare('INSERT INTO dialect_json_checks VALUES(?)').run(source);
              await client.query('INSERT INTO dialect_json_checks VALUES($1)', [source]);
              accepted++;
            } else {
              assert.throws(() =>
                sqlite.prepare('INSERT INTO dialect_json_checks VALUES(?)').run(source),
              );
              await assert.rejects(
                client.query('INSERT INTO dialect_json_checks VALUES($1)', [source]),
                { code: '23514' },
              );
            }
          }
          assert.equal(
            Number((await client.query('SELECT COUNT(*) AS n FROM dialect_json_checks')).rows[0].n),
            accepted,
          );
          assert.equal(
            sqlite.prepare('SELECT COUNT(*) AS n FROM dialect_json_checks').get().n,
            accepted,
          );
        },
      );
      await t.test(
        'compiled ON-qualified CROSS batches keep requested order and duplicate identities',
        async () => {
          const sql = `WITH selected(id,payload) AS (VALUES('a',42))
            SELECT selected.payload,requested.key FROM json_each(?) requested
            CROSS JOIN selected ON selected.id=requested.value ORDER BY requested.key`;
          const values = [JSON.stringify(['missing', 'a', 'a'])];
          const expected = sqlite
            .prepare(sql)
            .all(...values)
            .map((row) => ({ ...row }));
          const plan = compile(
            sql,
            { kind: 'cabinet', storeId: 'synthetic-functions' },
            values,
            'all',
            { tables: {} },
          );
          assert.match(plan.text, /INNER JOIN/);
          const actual = (await client.query(plan.text, plan.values)).rows.map((row) => ({
            ...row,
            key: Number(row.key),
          }));
          assert.deepEqual(actual, expected);
        },
      );
      await t.test(
        'public-code type and UTF-8 byte validation and marker INSTR preserve storage semantics',
        async () => {
          const catalog = {
            tables: {
              codes: {
                name: 'codes',
                columns: [{ name: 'code', type: 'TEXT' }],
                primary: ['code'],
                unique: [],
                rowid: true,
              },
            },
          };
          for (const value of ['ascii001', 'Юлия001', 'a\\b:tail', '😀:end', 'no-colon', null]) {
            const sql =
              "SELECT typeof(code) AS kind,length(CAST(code AS BLOB)) AS bytes,instr(code,':') AS separator FROM codes";
            sqlite.exec('CREATE TABLE IF NOT EXISTS codes(code TEXT)');
            sqlite.exec('DELETE FROM codes');
            sqlite.prepare('INSERT INTO codes VALUES(?)').run(value);
            const expected = sqlite.prepare(sql).get();
            const plan = compile(
              sql,
              { kind: 'cabinet', storeId: 'synthetic-functions' },
              [],
              'all',
              catalog,
            );
            // The actual compiled expressions run against an equally typed local CTE;
            // no prepared application table or real code is changed by this fixture.
            const expression = plan.text.slice(0, plan.text.indexOf(' FROM '));
            const actual = (
              await client.query(expression + ' FROM (SELECT $1::text AS code) AS codes', [value])
            ).rows[0];
            assert.deepEqual(actual, { ...expected }, JSON.stringify(value));
          }
          for (const [type, value, expected] of [
            ['bigint', 4, 'integer'],
            ['double precision', 1.25, 'real'],
            ['bytea', Buffer.from('x'), 'blob'],
          ])
            assert.equal(
              (
                await client.query(
                  'SELECT cartoteca_catalog.sqlite_typeof($1::' + type + ') AS kind',
                  [value],
                )
              ).rows[0].kind,
              expected,
            );
          await assert.rejects(client.query('SELECT cartoteca_catalog.sqlite_typeof(true)'), {
            code: '22023',
          });
        },
      );
      await t.test(
        'binary ciphertext header stamps remain bytes rather than text or base64',
        async () => {
          const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 13) % 256));
          sqlite.exec('CREATE TABLE encrypted(value BLOB NOT NULL)');
          sqlite.prepare('INSERT INTO encrypted VALUES(?)').run(bytes);
          await client.query('CREATE TEMP TABLE dialect_encrypted(value bytea NOT NULL)');
          await client.query('INSERT INTO dialect_encrypted VALUES($1)', [bytes]);
          const actual = (
            await client.query('SELECT substr(value,1,28) AS stamp FROM dialect_encrypted')
          ).rows[0].stamp;
          assert.ok(Buffer.isBuffer(actual));
          assert.deepEqual(
            actual,
            Buffer.from(
              sqlite.prepare('SELECT substr(value,1,28) AS stamp FROM encrypted').get().stamp,
            ),
          );
        },
      );
    } finally {
      sqlite.close();
      await client.end();
    }
  },
);
