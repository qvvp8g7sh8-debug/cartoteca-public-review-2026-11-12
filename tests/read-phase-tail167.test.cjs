const test = require('node:test'),
  assert = require('node:assert/strict');
const { finishRead167 } = require('../src/server/infrastructure/postgres/read-phase-tail167.cjs');
const platform = { kind: 'platform', storeId: '00000000-0000-4000-8000-000000000001' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
function fixture() {
  const calls = [],
    events = [];
  const options = {
    platform,
    currentScope: 'cabinet:other',
    token: 'synthetic-private-token',
    assertActive() {},
    sql(text, values) {
      const gate = deferred();
      calls.push({ text, values, gate });
      return gate.promise;
    },
    onCommitAck() {
      events.push('commitACK');
    },
    onScopeAck() {
      events.push('scopeACK');
    },
    async accept(rows) {
      events.push(['accept', rows]);
    },
  };
  return { calls, events, options };
}
test('167 finish queues ordered commands but cannot accept until COMMIT ACK and every result drained', async () => {
  const f = fixture(),
    rows = [{ id: 'synthetic-current' }];
  const done = finishRead167(f.options);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].text, 'COMMIT');
  assert.match(f.calls[1].text, /set_config/);
  assert.match(f.calls[2].text, /platform_sessions/);
  assert.equal(JSON.stringify(f.calls).includes('synthetic-private-token'), false);
  f.calls[2].gate.resolve({ rows });
  await tick();
  assert.deepEqual(f.events, []);
  f.calls[0].gate.resolve({ command: 'COMMIT' });
  await tick();
  assert.deepEqual(f.events, []);
  f.calls[1].gate.resolve({ rows: [] });
  await done;
  assert.deepEqual(f.events, ['commitACK', 'scopeACK', ['accept', rows]]);
});
test('167 failed COMMIT drains following GUC/auth results and cannot accept or publish', async () => {
  const f = fixture(),
    error = Object.assign(Error('synthetic commit failure'), { code: 'SYNTHETIC_COMMIT' });
  let ended = false,
    published = 0;
  const done = finishRead167(f.options).then(
    () => {
      published++;
    },
    (error) => {
      ended = true;
      return error;
    },
  );
  f.calls[0].gate.reject(error);
  f.calls[1].gate.resolve({ rows: [] });
  await tick();
  assert.equal(ended, false);
  assert.deepEqual(f.events, []);
  f.calls[2].gate.resolve({ rows: [{ id: 'must-not-authorize' }] });
  assert.equal(await done, error);
  assert.equal(published, 0);
  assert.deepEqual(f.events, []);
});
test('167 a later tail failure retains COMMIT ACK evidence but never accepts stale authority', async () => {
  const f = fixture(),
    failure = Error('synthetic postauth failure');
  const done = finishRead167(f.options).catch((error) => error);
  f.calls[0].gate.resolve({ command: 'COMMIT' });
  f.calls[1].gate.resolve({ rows: [] });
  f.calls[2].gate.reject(failure);
  assert.equal(await done, failure);
  assert.deepEqual(f.events, ['commitACK']);
});
test('167 server ROLLBACK tag is not COMMIT ACK even when subsequent authority would pass', async () => {
  const f = fixture(),
    done = finishRead167(f.options).catch((error) => error);
  f.calls[0].gate.resolve({ command: 'ROLLBACK' });
  f.calls[1].gate.resolve({ rows: [] });
  f.calls[2].gate.resolve({ rows: [] });
  assert.equal((await done).code, 'POSTGRES_READ_COMMIT_INVALID167');
  assert.deepEqual(f.events, []);
});
test('167 already-platform tail executes fresh authority on every invocation without a one-shot cache', async () => {
  let reads = 0;
  const seen = [];
  const options = {
    platform,
    currentScope: 'platform:' + platform.storeId,
    token: 'synthetic',
    assertActive() {},
    async sql(text) {
      if (text === 'COMMIT') return { command: 'COMMIT' };
      reads++;
      return { rows: [{ revision: reads }] };
    },
    onCommitAck() {},
    onScopeAck() {},
    async accept(rows) {
      seen.push(rows[0].revision);
    },
  };
  await finishRead167(options);
  await finishRead167(options);
  assert.equal(reads, 2);
  assert.deepEqual(seen, [1, 2]);
});
