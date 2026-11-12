const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const source = fs.readFileSync(
  process.env.ASSISTANT_PCM_PLAYBACK_SOURCE || 'src/client/modules/assistant-playback.js',
  'utf8',
);
function fixture() {
  let now = 0;
  const state = {
    assistantGeneration: 1,
    account: { id: 'synthetic-a', organizationId: 'synthetic-o', role: 'owner' },
  };
  const factory = vm.runInNewContext(source + '\ncreateAssistantPlayback', {
    window: {},
    document: { hidden: false },
    performance: { now: () => now },
    Number,
    Math,
    JSON,
  });
  const api = factory(state, {}).assistantPlayback();
  return {
    state,
    api,
    at: (n) => (now = n),
    result: { voiceOwner: { epoch: 1, session: 1, generation: 1 } },
  };
}
test('observer works without PCM support/session and captures cross-format first voice once', () => {
  const f = fixture();
  assert.equal(f.api.supported(), false);
  const a = f.api.observe(f.result, 2);
  a.started();
  a.finish(true);
  let v = f.api.takeSummary();
  assert.equal(v.length, 24);
  assert.equal(v[0], 2);
  assert.equal(v[2], 1);
  assert.equal(v[20], 2);
  const b = f.api.observe(f.result, 3);
  b.started();
  b.finish(true);
  v = f.api.takeSummary();
  assert.equal(v[2], 0);
  assert.equal(v[20], 3);
  assert.equal(f.api.takeSummary(), null);
});
test('native owner receives shared barge events and idempotent poststart offsets', () => {
  const f = fixture(),
    a = f.api.observe(f.result, 3);
  a.event('mediaWaiting');
  f.at(100);
  a.started();
  f.at(210);
  a.started();
  f.api.recordDiagnostic('bargePause');
  f.at(500);
  f.api.recordDiagnostic('bargeFalsePause');
  a.event('mediaStalled');
  a.event('underrun');
  f.at(700);
  a.event('bargePause');
  a.event('contextInterrupted');
  a.finish(true);
  const v = f.api.takeSummary();
  assert.equal(v[6], 2);
  assert.equal(v[7], 1);
  assert.equal(v[8], 290);
  assert.equal(v[18], 1);
  assert.equal(v[19], 1);
  assert.equal(v[21], 401);
  assert.equal(v[22], 111);
  assert.equal(v[23], 401);
});
test('one pending first snapshot survives later format and stale owner callbacks', () => {
  const f = fixture(),
    a = f.api.observe(f.result, 2);
  a.started();
  a.event('bargePause');
  a.finish(false);
  const b = f.api.observe(f.result, 1);
  a.event('bargePause');
  a.finish(true);
  b.started();
  b.finish(true);
  const v = f.api.takeSummary();
  assert.equal(v[2], 1);
  assert.equal(v[20], 2);
  assert.equal(v[1], 1);
  assert.equal(v[6], 1);
});
test('actor and generation reset discard pending/live observations before event or take', () => {
  for (const change of [(s) => (s.account.id = 'other'), (s) => s.assistantGeneration++]) {
    const f = fixture(),
      a = f.api.observe(f.result, 2);
    a.started();
    a.finish(true);
    change(f.state);
    assert.equal(f.api.takeSummary(), null);
    a.event('bargePause');
    a.finish(true);
    assert.equal(f.api.takeSummary(), null);
    const b = f.api.observe({}, 3);
    b.started();
    b.finish(false, Error('synthetic'));
    const v = f.api.takeSummary();
    assert.equal(v[2], 0);
    assert.equal(v[1], 2);
  }
});
test('prestart error/cancel retains zero offsets; new voice starts fresh and values remain bounded', () => {
  const f = fixture(),
    a = f.api.observe(f.result, 2);
  a.event('bargePause');
  a.event('mediaStalled');
  a.finish(false, Error('synthetic'));
  let v = f.api.takeSummary();
  assert.equal(v[1], 2);
  assert.equal(v[22], 0);
  assert.equal(v[23], 0);
  const b = f.api.observe({ ...f.result, voiceOwner: { epoch: 2, session: 1, generation: 1 } }, 3);
  b.started();
  f.at(999999);
  for (let n = 0; n < 105; n++) b.event('contextSuspended');
  b.event('underrun');
  b.event('bargePause');
  b.finish(false);
  v = f.api.takeSummary();
  assert.equal(v[2], 1);
  assert.equal(v[16], 100);
  assert.equal(v[21], 150001);
  assert.equal(v[22], 150001);
  assert.equal(v[23], 150001);
  assert.ok(v.every(Number.isSafeInteger));
});
test('actual first start replaces unsent no-start first attempt for the same voice', () => {
  for (const error of [null, Error('synthetic pre-start failure')]) {
    const f = fixture(),
      failed = f.api.observe(f.result, 2);
    failed.finish(false, error);
    const started = f.api.observe(f.result, 1);
    started.started();
    started.event('bargePause');
    started.finish(true);
    const v = f.api.takeSummary();
    assert.equal(v[2], 1);
    assert.equal(v[1], 0);
    assert.equal(v[20], 1);
    assert.equal(v[6], 1);
    const later = f.api.observe(f.result, 3);
    later.started();
    later.finish(true);
    assert.equal(f.api.takeSummary()[2], 0);
  }
});
test('first-start latch survives take and benign PCM stop/release across native formats', () => {
  const f = fixture(),
    a = f.api.observe(f.result, 2);
  a.started();
  a.finish(true);
  assert.equal(f.api.takeSummary()[2], 1);
  f.api.stop();
  f.api.release();
  const b = f.api.observe(f.result, 1);
  b.started();
  b.finish(true);
  assert.equal(f.api.takeSummary()[2], 0);
  f.api.stop();
  f.api.release();
  const c = f.api.observe(f.result, 3);
  c.started();
  c.finish(true);
  assert.equal(f.api.takeSummary()[2], 0);
});
