const test = require('node:test');
const assert = require('node:assert/strict');
const { createDialogueStore } = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const { createPendingDialogueReads } = require('../src/server/modules/assistant/dialogue/dialogue-pending-reads.cjs');
const { readSteps } = require('../src/server/modules/assistant/read-steps.cjs');
const { informationTurn, baseResponse } = require('../src/server/modules/assistant/dialogue/dialogue-control-turn.cjs');
const gate = () => { let release; return { promise: new Promise(r => { release = r; }), release: () => release() }; };
function fixture() {
  const memory = createDialogueStore();
  const c = { current: { accountId: 'owner', organizationId: 'org', sessionId: 'session', role: 'owner' } };
  const member = { membershipId: 'membership' }, state = { revision: 1 };
  const ticket = memory.beginCommand(c, member, state);
  const entry = memory.create(c, member, state, ticket, { client: 'original' });
  const get = () => memory.get(c, member, state, entry.id);
  return { memory, c, member, state, entry, get };
}
test('read steps preserve sync contract and propagate awaited rejection through finally', async () => {
  const work = readSteps(function* (input) { return (yield input) + 1; });
  assert.equal(work(2), 3);
  assert.equal(await work(Promise.resolve(3)), 4);
  let finished = false;
  const reject = readSteps(function* () {
    try { yield Promise.reject(Error('failed read')); }
    finally { finished = true; }
  });
  await assert.rejects(reject(), /failed read/);
  assert.equal(finished, true);
});
test('pending edits remain invisible; failed turns leave original data and version', async () => {
  const f = fixture(), pending = gate(), started = gate();
  const work = f.memory.runIsolated(async () => {
    const draft = f.get();
    draft.data.client = 'pending'; draft.version++;
    started.release(); await pending.promise;
    throw Error('read unavailable');
  });
  await started.promise;
  assert.equal(f.get().data.client, 'original');
  assert.equal(f.get().version, 0);
  pending.release();
  await assert.rejects(work, /read unavailable/);
  assert.equal(f.get(), f.entry);
});
test('cancel commits independently and an older async turn cannot restore the cancelled draft', async () => {
  const f = fixture(), pending = gate(), started = gate();
  const work = f.memory.runIsolated(async () => {
    const draft = f.get(); draft.data.client = 'pending';
    started.release(); await pending.promise;
    f.memory.assertIsolated(); draft.version++;
  });
  await started.promise;
  await f.memory.runIsolated(async () => {
    const draft = f.get(); draft.cancelled = true; draft.data = {};
  });
  pending.release();
  await assert.rejects(work, { status: 409 });
  assert.equal(f.get().cancelled, true);
  assert.deepEqual(f.get().data, {});
});
test('logout/new command fences pending and newly staged dialogues before commit', async () => {
  for (const invalidate of ['clearSession', 'clearAccount']) {
    const f = fixture(), pending = gate(), started = gate();
    const work = f.memory.runIsolated(async () => {
      f.get().data.client = 'pending'; started.release(); await pending.promise;
    });
    await started.promise;
    f.memory[invalidate](invalidate === 'clearSession' ? 'session' : 'owner');
    pending.release();
    await assert.rejects(work, { status: 409 });
    assert.throws(f.get, { status: 409 });
  }
});
test('information replay keeps the original question across isolated turns', async () => {
  const f = fixture();
  const base = { text: 'Question', action: null, dialogue: { prompt: 'Question', options: [], version: 0, fields: [] } };
  f.entry.response = base;
  await f.memory.runIsolated(async () => {
    informationTurn(f.get(), 'repeat', { refresh: () => base, clock: { date: '2099-01-01' }, limit: 200, hash: 'first' });
  });
  const reply = f.get().response;
  await f.memory.runIsolated(async () => {
    assert.deepEqual(baseResponse(f.get().response), baseResponse(reply));
  });
});
test('an in-place execution receipt cannot be overwritten by an older async clone', async () => {
  const f = fixture(), pending = gate(), started = gate();
  const work = f.memory.runIsolated(async () => {
    f.get().data.client = 'pending'; started.release(); await pending.promise;
  });
  await started.promise;
  f.entry.executionSaved = { saved: true };
  pending.release();
  await assert.rejects(work, { status: 409 });
  assert.deepEqual(f.get().executionSaved, { saved: true });
});
test('newly staged creation is fenced by a newer accepted command', async () => {
  const f = fixture(), pending = gate(), started = gate();
  const work = f.memory.runIsolated(async () => {
    const ticket = f.memory.beginCommand(f.c, f.member, f.state);
    f.memory.create(f.c, f.member, f.state, ticket, { client: 'pending' });
    started.release(); await pending.promise;
  });
  await started.promise;
  f.memory.beginCommand(f.c, f.member, f.state);
  pending.release();
  await assert.rejects(work, { status: 409 });
  assert.equal(f.memory.stats().dialogues.active, 0);
});
test('duplicate continuations share one operation, different text is rejected, cancel remains available', async () => {
  const f = fixture(), pending = gate(), started = gate();
  const coordinator = createPendingDialogueReads({ scope() {}, fingerprint: f.memory.fingerprint });
  const body = { dialogueId: f.entry.id, dialogueVersion: 0, policyVersion: 1, text: 'reply' };
  let calls = 0;
  const first = coordinator.run(f.c, body, async () => { calls++; started.release(); await pending.promise; return { text: 'done' }; });
  await started.promise;
  const duplicate = coordinator.run(f.c, body, () => { throw Error('duplicate dispatch'); });
  await assert.rejects(coordinator.run(f.c, { ...body, text: 'other' }, () => {}), { status: 429 });
  assert.equal(await coordinator.run(f.c, { ...body, cancel: true, text: undefined }, () => 'cancelled'), 'cancelled');
  pending.release();
  assert.deepEqual(await first, await duplicate);
  assert.equal(calls, 1);
});
test('first waiter disconnect does not cancel a shared read while its duplicate stays connected', async () => {
  const f = fixture(), pending = gate(), started = gate(), abort = new AbortController();
  const coordinator = createPendingDialogueReads({ scope() {}, fingerprint: f.memory.fingerprint });
  const body = { dialogueId: f.entry.id, dialogueVersion: 0, policyVersion: 1, text: 'reply' };
  let sharedSignal;
  const first = coordinator.run({ ...f.c, transportAbortSignal: abort.signal }, body, async (c) => {
    sharedSignal = c.transportAbortSignal;
    started.release(); await pending.promise;
    assert.equal(sharedSignal.aborted, false);
    return { text: 'done' };
  });
  await started.promise;
  const duplicate = coordinator.run(f.c, body, () => assert.fail('duplicate dispatch'));
  abort.abort();
  await assert.rejects(first, { code: 'ASSISTANT_REQUEST_ABORTED' });
  assert.equal(sharedSignal.aborted, false);
  pending.release();
  assert.deepEqual(await duplicate, { text: 'done' });
});
