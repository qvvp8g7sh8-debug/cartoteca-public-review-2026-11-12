const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPreparedQueries,
  orderedResults,
} = require('../src/server/infrastructure/postgres/prepared-query141.cjs');

test('server plans are bounded, connection-local and bind fresh arguments', () => {
  const query = createPreparedQueries({ maxPlans: 2, maxBytes: 1024 });
  const sql = 'SELECT $1::text AS tenant, $2::bytea AS value';
  const first = ['a', Buffer.from('one')],
    second = ['b', Buffer.from('two')];
  assert.equal(query(sql, first).name, undefined);
  const prepared = query(sql, second);
  assert.ok(prepared.name);
  assert.equal(prepared.values, second);
  assert.equal(query(sql, first).name, prepared.name);
  assert.equal(query(sql, first).values, first);
  assert.equal(createPreparedQueries()(sql, second).name, undefined);
  const other = 'SELECT $1::bigint';
  query(other, [1n]);
  assert.notEqual(query(other, [2n]).name, prepared.name);
  for (let i = 0; i < 3; i++) assert.equal(query('SELECT 3', []).name, undefined);
  const multi = createPreparedQueries();
  multi('SELECT 1; SELECT 2', []);
  assert.equal(multi('SELECT 1; SELECT 2', []).name, undefined);
});

test('ordered pipeline queues commands before waiting and drains later errors before recovery', async () => {
  const events = [],
    pending = [];
  const failure = Object.assign(Error('constraint'), { code: '23505' });
  const call = (name) => () => {
    events.push(name);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  const result = orderedResults([call('statement'), call('release')]);
  assert.deepEqual(events, ['statement', 'release']);
  let settled = false;
  const handled = result.catch((error) => {
    settled = true;
    assert.equal(error, failure);
  });
  pending[0].reject(failure);
  await Promise.resolve();
  assert.equal(settled, false);
  pending[1].reject(Object.assign(Error('aborted'), { code: '25P02' }));
  await handled;
  assert.equal(settled, true);
  assert.deepEqual(
    await orderedResults([() => Promise.resolve(1), () => Promise.resolve(2)]),
    [1, 2],
  );
});

test('a drained capacity fallback cannot hide a later SQL error or its aborted followers', async () => {
  const capacity = Object.assign(Error('capacity'), { code: 'POSTGRES_READ_BATCH_CAPACITY' });
  const sql = Object.assign(Error('division'), { code: '22012' });
  const aborted = Object.assign(Error('aborted'), { code: '25P02' });
  const deferError = (error) => error.code === capacity.code;
  const seen = [];
  const reject = (error) => () => {
    seen.push(error.code);
    return Promise.reject(error);
  };
  await assert.rejects(
    orderedResults([reject(capacity), reject(sql), reject(aborted)], { deferError }),
    (error) => error === sql,
  );
  assert.deepEqual(seen, [capacity.code, sql.code, aborted.code]);
  await assert.rejects(
    orderedResults([reject(capacity), () => Promise.resolve(1)], { deferError }),
    (error) => error === capacity,
  );
});
