const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assistantBoundariesFixture } = require('./helpers/assistant-boundaries-fixture.cjs');

test('daily attempts are independent for owner, salon administrator and staff and stay exhausted for that membership', async (t) => {
  const f = await assistantBoundariesFixture(t, { dailyRequests: 1 });
  for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
    assert.equal((await f.request('llm', role)).action.type, 'calendar');
    await assert.rejects(f.request('llm', role), { status: 429 });
  }
  const state = f.readState();
  assert.equal(Object.keys(state.daily).length, 3);
  assert.deepEqual(Object.values(state.daily), [1, 1, 1]);
  assert.equal(Object.keys(state.reservations).length, 0);
  assert.equal(f.calls.llm, 3);
  assert.equal(f.admin.view(f.actor).usage.spentRub, 0);
});
test('STT, LLM and TTS share one membership daily limit without disabling another staff member', async (t) => {
  const f = await assistantBoundariesFixture(t, { dailyRequests: 2 });
  await f.request('stt');
  await f.request('llm');
  await assert.rejects(f.request('tts'), { status: 429 });
  await f.request('tts', 'cosmetologist');
  assert.deepEqual(f.calls, { llm: 1, stt: 1, tts: 1 });
  assert.equal(Object.keys(f.readState().reservations).length, 0);
});
test('unavailable local STT rejects before accounting while independent Codex and local TTS remain usable', async (t) => {
  const f = await assistantBoundariesFixture(t);
  f.ports.localSpeech.sttAvailable = false;
  const before = f.readState(),
    scope = f.api.access(f.current('owner'));
  assert.equal(scope.ready, false);
  assert.equal(scope.capabilities.stt.ready, false);
  assert.equal(scope.capabilities.llm.ready, true);
  assert.equal(scope.capabilities.tts.ready, true);
  await assert.rejects(f.request('stt'), { status: 503 });
  assert.deepEqual(f.readState(), before);
  await f.request('llm');
  await f.request('tts');
  assert.deepEqual(f.calls, { llm: 1, stt: 0, tts: 1 });
});
test('malformed input and a busy encrypted state lock cannot reserve budget or invoke a provider', async (t) => {
  const f = await assistantBoundariesFixture(t),
    before = f.readState();
  await assert.rejects(f.request('stt', 'owner', { audioBase64: 'not audio' }), { status: 400 });
  await assert.rejects(f.request('tts', 'owner', { text: '' }), { status: 400 });
  await assert.rejects(f.request('llm', 'owner', { text: '' }), { status: 400 });
  const lock = path.join(f.platformDirectory, 'assistant-state.lock');
  fs.writeFileSync(lock, 'Synthetic busy lock', { flag: 'wx' });
  try {
    await assert.rejects(f.request('llm'), { status: 503 });
  } finally {
    fs.unlinkSync(lock);
  }
  assert.deepEqual(f.readState(), before);
  assert.deepEqual(f.calls, { llm: 0, stt: 0, tts: 0 });
});
test('a stale reservation is reconciled once and never becomes a free or repeatedly charged retry', async (t) => {
  const f = await assistantBoundariesFixture(t),
    state = f.readState(),
    month = new Date().toISOString().slice(0, 7);
  state.reservations[randomUUID()] = {
    month,
    kind: 'llm',
    amount: 1.25,
    createdAt: Date.now() - 120001,
  };
  fs.writeFileSync(path.join(f.platformDirectory, 'assistant-state.enc'), f.database.seal(state));
  await f.request('tts');
  const first = f.readState();
  assert.equal(first.usage[month].spentRub, 1.25);
  assert.equal(first.usage[month].uncertainCalls, 1);
  assert.equal(first.usage[month].calls, 2);
  assert.equal(Object.keys(first.reservations).length, 0);
  await f.request('llm');
  const after = f.readState();
  assert.equal(after.usage[month].spentRub, 1.25);
  assert.equal(after.usage[month].uncertainCalls, 1);
  assert.equal(after.usage[month].calls, 3);
  assert.equal(Object.keys(after.reservations).length, 0);
});
