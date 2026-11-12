const test = require('node:test');
const assert = require('node:assert/strict');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');
function heldProvider(f, { parallel = false } = {}) {
  let release,
    entered,
    active = false,
    attempts = 0,
    outbound = 0;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.ports.codex.run = async (call) => {
    attempts++;
    if (active && !parallel)
      throw Object.assign(Error('Codex уже обрабатывает команду.'), { status: 429 });
    active = true;
    call.guard();
    call.onOutbound();
    outbound++;
    if (outbound === 1) {
      entered();
      await held;
    }
    call.guard();
    active = false;
    return { text: '{"intent":"calendar"}' };
  };
  return { started, release: () => release(), counts: () => ({ attempts, outbound }) };
}
for (const rejection of ['busy', 'budget'])
  test(`a same-account ${rejection} rejection before outbound preserves its previously accepted command`, async (t) => {
    const f = await assistantBoundariesFixture(t, {
        dailyRequests: rejection === 'budget' ? 1 : 100,
      }),
      provider = heldProvider(f);
    t.after(provider.release);
    const first = f.request('llm');
    await provider.started;
    await assert.rejects(f.request('llm'), { status: 429 });
    provider.release();
    const result = await first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    t.diagnostic(
      JSON.stringify({
        scenario: rejection,
        rejectedStatus: 429,
        firstStatus: result.error?.status || 200,
        provider: provider.counts(),
        dailyAttempts: Object.values(f.readState().daily).reduce((sum, value) => sum + value, 0),
      }),
    );
    assert.equal(
      result.error?.status,
      undefined,
      'A request rejected before outbound must not retire an already accepted command',
    );
    assert.equal(result.value.action.type, 'calendar');
    assert.equal(provider.counts().outbound, 1);
  });
test('pre-outbound rejection cannot restore an accepted command after its access is revoked', async (t) => {
  const f = await assistantBoundariesFixture(t),
    provider = heldProvider(f);
  t.after(provider.release);
  const first = f.request('llm');
  await provider.started;
  await assert.rejects(f.request('llm'), { status: 429 });
  f.grant('owner', false);
  provider.release();
  await assert.rejects(first, { status: 403 });
  assert.equal(provider.counts().outbound, 1);
});
test('a newer actually dispatched command still fences the older provider result', async (t) => {
  const f = await assistantBoundariesFixture(t),
    provider = heldProvider(f, { parallel: true });
  t.after(provider.release);
  const first = f.request('llm');
  await provider.started;
  assert.equal((await f.request('llm')).action.type, 'calendar');
  provider.release();
  await assert.rejects(first, { status: 409 });
  assert.equal(provider.counts().outbound, 2);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('a pending admission cannot create a temporary rejection window for the accepted response', async (t) => {
  const f = await assistantBoundariesFixture(t),
    firstEntered = deferred(),
    firstGate = deferred(),
    secondEntered = deferred(),
    secondGate = deferred();
  t.after(() => {
    firstGate.resolve();
    secondGate.resolve();
  });
  let attempts = 0;
  f.ports.codex.run = async (call) => {
    if (++attempts === 1) {
      call.guard();
      call.onOutbound();
      firstEntered.resolve();
      await firstGate.promise;
      call.guard();
      return { text: '{"intent":"calendar"}' };
    }
    secondEntered.resolve();
    await secondGate.promise;
    throw Object.assign(Error('Synthetic busy before dispatch'), { status: 429 });
  };
  const first = f.request('llm');
  await firstEntered.promise;
  const second = f.request('llm');
  const secondRejected = assert.rejects(second, { status: 429 });
  await secondEntered.promise;
  firstGate.resolve();
  assert.equal((await first).action.type, 'calendar');
  secondGate.resolve();
  await secondRejected;
});
test('a successful provider without an outbound callback still admits its command', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.ports.codex.run = async () => ({ text: '{"intent":"calendar"}' });
  assert.equal((await f.request('llm')).action.type, 'calendar');
  assert.equal(Object.keys(f.readState().reservations).length, 0);
});
test('an older no-outbound result cannot reappear after a newer accepted command', async (t) => {
  const f = await assistantBoundariesFixture(t),
    entered = deferred(),
    gate = deferred();
  t.after(gate.resolve);
  let attempts = 0;
  f.ports.codex.run = async (call) => {
    if (++attempts === 1) {
      entered.resolve();
      await gate.promise;
    } else {
      call.guard();
      call.onOutbound();
    }
    return { text: '{"intent":"calendar"}' };
  };
  const first = f.request('llm');
  const firstRejected = assert.rejects(first, { status: 409 });
  await entered.promise;
  assert.equal((await f.request('llm')).action.type, 'calendar');
  gate.resolve();
  await firstRejected;
});
for (const clear of ['clearAccount', 'clearSession'])
  test(
    clear +
      ' invalidates a pending no-outbound command even while its authenticated session remains active',
    async (t) => {
      const f = await assistantBoundariesFixture(t),
        entered = deferred(),
        gate = deferred();
      t.after(gate.resolve);
      f.ports.codex.run = async () => {
        entered.resolve();
        await gate.promise;
        return { text: '{"intent":"calendar"}' };
      };
      const first = f.request('llm');
      const rejected = assert.rejects(first, { status: 409 });
      await entered.promise;
      const current = f.current('owner');
      f.api[clear](clear === 'clearSession' ? current.sessionId : current.accountId);
      gate.resolve();
      await rejected;
      assert.equal(Object.keys(f.readState().reservations).length, 0);
    },
  );
