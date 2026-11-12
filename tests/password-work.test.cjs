const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const {
  createPasswordWork,
  passwordWork,
} = require('../src/server/infrastructure/password-work.cjs');
const { createPasswords } = require('../src/server/modules/auth/passwords.cjs');
const constants = require('../src/server/infrastructure/platform-constants.cjs');
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
function manualTimers() {
  const callbacks = new Map();
  let next = 0;
  return {
    callbacks,
    set(fn) {
      callbacks.set(++next, fn);
      return next;
    },
    clear(id) {
      callbacks.delete(id);
    },
  };
}
test('native password work is bounded globally and FIFO without occupying the event loop', async () => {
  const timers = manualTimers(),
    work = createPasswordWork({ concurrency: 2, capacity: 2, timers });
  const gates = Array.from({ length: 4 }, deferred),
    started = [];
  const tasks = gates.map((gate, index) =>
    work.run(
      async () => {
        started.push(index);
        await gate.promise;
        return index;
      },
      { key: 'credential-' + index },
    ),
  );
  await turn();
  assert.deepEqual(started, [0, 1]);
  assert.equal(work.stats().active, 2);
  assert.equal(work.stats().queued, 2);
  await assert.rejects(
    work.run(() => assert.fail('overflow must never start')),
    { status: 503, code: 'AUTH_WORK_CAPACITY', retryAfter: 1 },
  );
  gates[0].resolve();
  assert.equal(await tasks[0], 0);
  await turn();
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve();
  assert.equal(await tasks[1], 1);
  await turn();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve();
  gates[3].resolve();
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3]);
  assert.equal(work.stats().active, 0);
  assert.equal(work.stats().credentialGroups, 0);
  assert.equal(timers.callbacks.size, 0);
});
test('one credential cannot fill the waiting budget for unrelated accounts', async () => {
  const timers = manualTimers(),
    work = createPasswordWork({ concurrency: 1, capacity: 3, timers });
  const gate = deferred();
  const first = work.run(() => gate.promise, { key: 'same-private-salt' });
  const second = work.run(() => 2, { key: 'same-private-salt' });
  await assert.rejects(
    work.run(() => assert.fail('per-credential overflow'), { key: 'same-private-salt' }),
    { status: 503 },
  );
  const other = work.run(() => 3, { key: 'other-private-salt' });
  const encoded = JSON.stringify(work.stats());
  assert.doesNotMatch(encoded, /same-private-salt|other-private-salt|passwordHash|cookie|token/);
  gate.resolve(1);
  assert.deepEqual(await Promise.all([first, second, other]), [1, 2, 3]);
  assert.equal(work.stats().credentialGroups, 0);
});
test('a timed-out queued derivation never starts; the active derivation keeps its permit until settlement', async () => {
  const timers = manualTimers(),
    work = createPasswordWork({ concurrency: 1, capacity: 1, timers });
  const gate = deferred();
  const active = work.run(() => gate.promise, { key: 'active' });
  const queued = work.run(() => assert.fail('expired native task started'), { key: 'queued' });
  const rejected = assert.rejects(queued, { status: 503, retryAfter: 1 });
  const [id, expire] = [...timers.callbacks][0];
  timers.callbacks.delete(id);
  expire();
  await rejected;
  assert.equal(work.stats().queued, 0);
  assert.equal(work.stats().active, 1);
  assert.equal(work.stats().credentialGroups, 1);
  assert.equal(work.stats().timedOut, 1);
  gate.resolve('done');
  assert.equal(await active, 'done');
  assert.equal(work.stats().credentialGroups, 0);
});
test('native failures release admission before the caller retries, without disguising the error', async () => {
  const work = createPasswordWork({ concurrency: 1, capacity: 0 });
  const nativeError = Error('Synthetic native error');
  await assert.rejects(
    work.run(
      () => {
        throw nativeError;
      },
      { key: 'epoch' },
    ),
    (error) => error === nativeError,
  );
  assert.equal(await work.run(() => 'retry', { key: 'epoch' }), 'retry');
  assert.equal(work.stats().failed, 1);
  assert.equal(work.stats().active, 0);
});
test('every derivation retains the exact established scrypt parameters and output', async () => {
  assert.deepEqual(constants.passwordOptions, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  const password = 'Synthetic-password-work-2026',
    salt = '0123456789abcdef0123456789abcdef';
  const expected = await promisify(crypto.scrypt)(password, salt, 64, constants.passwordOptions);
  assert.deepEqual(await constants.scrypt(password, salt, 64, constants.passwordOptions), expected);
  const passwords = createPasswords(constants);
  assert.equal(
    await passwords.verifyPassword({ salt, passwordHash: expected.toString('hex') }, password),
    true,
  );
  assert.equal(
    await passwords.verifyPassword(
      { salt, passwordHash: expected.toString('hex') },
      password + '-wrong',
    ),
    false,
  );
  const fields = await passwords.passwordFields(password);
  assert.match(fields.salt, /^[a-f0-9]{32}$/);
  assert.match(fields.passwordHash, /^[a-f0-9]{128}$/);
  assert.equal(await passwords.verifyPassword(fields, password), true);
  assert.equal(passwordWork.stats().active, 0);
});
test('invalid admission budgets cannot disable the bound', () => {
  for (const values of [
    { concurrency: 0 },
    { concurrency: 5 },
    { capacity: -1 },
    { capacity: 65 },
    { perCredentialCapacity: 0 },
    { waitMs: 0 },
    { waitMs: 5001 },
  ])
    assert.throws(() => createPasswordWork(values), /Invalid/);
});

test('verification and password replacement share one trusted account budget even when salts change', async () => {
  const gates = [deferred(), deferred()];
  const key = 'synthetic-trusted-account';
  const held = gates.map((gate) => passwordWork.run(() => gate.promise, { key }));
  const passwords = createPasswords(constants);
  const account = { salt: '0123456789abcdef0123456789abcdef', passwordHash: '00'.repeat(64) };
  await assert.rejects(passwords.verifyPassword(account, 'Synthetic-password-work-2026', key), {
    code: 'AUTH_WORK_CAPACITY',
  });
  await assert.rejects(passwords.passwordFields('Synthetic-password-work-2026', key), {
    code: 'AUTH_WORK_CAPACITY',
  });
  // The same synthetic hash in another account does not share its account budget.
  const other = passwords.verifyPassword(
    account,
    'Synthetic-password-work-2026',
    'synthetic-other-account',
  );
  assert.equal(passwordWork.stats().queued, 1);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(held);
  assert.equal(await other, false);
  assert.equal(passwordWork.stats().active, 0);
  assert.equal(passwordWork.stats().credentialGroups, 0);
});

test('absolute queued deadline is checked before starting even if its timer was delayed', async () => {
  let instant = 0;
  const timers = manualTimers(),
    work = createPasswordWork({
      concurrency: 1,
      capacity: 3,
      waitMs: 1000,
      timers,
      now: () => instant,
    });
  const gate = deferred();
  const active = work.run(() => gate.promise);
  const expired = work.run(() => assert.fail('delayed timer cannot extend admission'));
  const rejected = assert.rejects(expired, { code: 'AUTH_WORK_CAPACITY' });
  instant = 1000;
  gate.resolve();
  await active;
  await rejected;
  assert.equal(work.stats().active, 0);
  assert.equal(work.stats().queued, 0);
  assert.equal(work.stats().credentialGroups, 0);
  assert.equal(work.stats().timedOut, 1);
  assert.equal(timers.callbacks.size, 0);
});
test('expiring a middle waiter preserves the order and permits of every other credential', async () => {
  const timers = manualTimers(),
    work = createPasswordWork({ concurrency: 1, capacity: 3, timers });
  const gate = deferred(),
    order = [];
  const active = work.run(() => gate.promise, { key: 'active' });
  const first = work.run(() => order.push('first'), { key: 'first' });
  const middle = work.run(() => assert.fail('middle expired'), { key: 'middle' });
  const last = work.run(() => order.push('last'), { key: 'last' });
  const rejected = assert.rejects(middle, { status: 503 });
  const [id, expire] = [...timers.callbacks][1];
  timers.callbacks.delete(id);
  expire();
  await rejected;
  assert.equal(work.stats().queued, 2);
  gate.resolve();
  await Promise.all([active, first, last]);
  assert.deepEqual(order, ['first', 'last']);
  assert.equal(work.stats().credentialGroups, 0);
  assert.equal(timers.callbacks.size, 0);
});
