const test = require('node:test');
const assert = require('node:assert/strict');
const { createWriteBatch, LIMIT } = require('../src/server/infrastructure/write-batch155.cjs');
test('155 bounds batches and preserves statement order on SQLite and large single values', () => {
  const seen = [],
    batches = [];
  const prepare = (sql) => ({ run: (...args) => seen.push([sql, args[0]]) });
  const entries = Array.from({ length: 70 }, (_, n) => ({ sql: 'WRITE' + n, args: [n] }));
  createWriteBatch({ db: {}, prepare })(entries);
  assert.deepEqual(
    seen.map((x) => x[1]),
    entries.map((_, n) => n),
  );
  seen.length = 0;
  createWriteBatch({ db: { executeWriteBatch: (rows) => batches.push(rows) }, prepare })(entries);
  assert.deepEqual(
    batches.map((rows) => rows.length),
    [32, 32, 6],
  );
  assert.equal(seen.length, 0);
  createWriteBatch({
    db: { executeWriteBatch: () => assert.fail('large value was batched') },
    prepare,
  })([{ sql: 'LARGE', args: [Buffer.alloc(LIMIT)] }]);
  assert.equal(seen.at(-1)[0], 'LARGE');
});
test('155 a failed native batch is never replayed through a statement fallback', () => {
  let calls = 0;
  const run = createWriteBatch({
    db: {
      executeWriteBatch() {
        calls++;
        throw Error('unknown after forward');
      },
    },
    prepare: () => ({ run: () => assert.fail('automatic replay') }),
  });
  assert.throws(
    () =>
      run([
        { sql: 'A', args: [] },
        { sql: 'B', args: [] },
      ]),
    /unknown after forward/,
  );
  assert.equal(calls, 1);
});
