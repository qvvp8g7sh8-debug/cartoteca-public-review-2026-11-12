const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  fixture: voiceFixture,
  flush,
  reply,
} = require('./helpers/assistant-voice-booking-fixture.cjs');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-timing.js'),
  'utf8',
);
function fixture() {
  let clock = 100;
  const state = {
    account: { id: 'private-account', organizationId: 'private-org', role: 'owner' },
    assistantGeneration: 1,
  };
  const api = vm.runInNewContext(source + '\ncreateAssistantTiming', {
    performance: { now: () => clock },
  })(state);
  return {
    state,
    ...api,
    clock: (value) => {
      clock = value;
    },
  };
}
test('turn timing bounds history, retains first marks and fixed numeric server metrics without content', () => {
  const f = fixture(),
    record = f.assistantTurnTiming;
  const turn = record('begin', 0, 20);
  record('captureReady', turn);
  f.clock(150);
  record('captureReady', turn);
  record(
    'turnServer',
    turn,
    'ct_request;dur=30.4, ct_domain;dur=5, ct_private_name;dur=100, ct_access;dur=-5, ct_settlement;dur=99999999',
  );
  for (const value of ['private-transcript', '__proto__', {}, null])
    record(value, turn, 'private-token');
  const row = f.assistantTurnDiagnostics()[0];
  assert.equal(row.captureReadyMs, 80);
  assert.equal(row.vadOrigin, 1);
  assert.equal(row.turnServer_requestMs, 30);
  assert.equal(row.turnServer_settlementMs, 150000);
  assert.ok(Object.isFrozen(row));
  assert.ok(Object.values(row).every(Number.isSafeInteger));
  assert.doesNotMatch(JSON.stringify(row), /private|token|transcript|account|organization/);
  for (let i = 0; i < 30; i++) record('begin');
  assert.equal(f.assistantTurnDiagnostics().length, 20);
  assert.equal(record('pcmRenderStart', turn), 0, 'evicted callback cannot change another turn');
});
test('account, generation and explicit session resets discard rows and late callbacks', () => {
  const f = fixture();
  for (const change of [
    () => {
      f.state.account.organizationId = 'different';
    },
    () => {
      f.state.account = { ...f.state.account };
    },
    () => {
      f.state.assistantGeneration++;
    },
    () => f.assistantTurnTiming('reset'),
  ]) {
    const old = f.assistantTurnTiming('begin');
    change();
    assert.equal(f.assistantTurnDiagnostics().length, 0);
    const next = f.assistantTurnTiming('begin');
    assert.notEqual(next, old);
    f.assistantTurnTiming('pcmRenderStart', old);
    assert.equal(f.assistantTurnDiagnostics()[0].pcmRenderStartMs, undefined);
  }
  f.clock(NaN);
  assert.equal(f.assistantTurnTiming('begin'), 0);
});
test('audio starvation and refill diagnostics belong to the affected turn only', () => {
  const f = fixture(),
    record = f.assistantTurnTiming;
  const first = record('begin');
  record('audioUnderrun', first);
  record('audioRefill', first, 120.4);
  record('audioUnderrun', first);
  record('audioRefill', first, 39.6);
  for (const bad of [-1, Infinity, 150001, 'private-audio']) record('audioRefill', first, bad);
  const next = record('begin');
  record('audioStarted', next);
  const rows = f.assistantTurnDiagnostics();
  assert.equal(rows[0].audioUnderruns, 2);
  assert.equal(rows[0].audioRefills, 2);
  assert.equal(rows[0].audioRefillMs, 160);
  assert.equal(rows[1].audioUnderruns, undefined);
  assert.ok(Object.values(rows[0]).every(Number.isSafeInteger));
});
test('one voice turn correlates VAD, STT, turn, action, handoff TTS and render callback without request identifiers', async (t) => {
  const f = voiceFixture(t);
  let clock = 100;
  Object.defineProperty(f.w.performance, 'now', { value: () => clock });
  f.w.eval(source);
  Object.assign(f.actions, f.w.eval('createAssistantTiming')(f.state));
  f.control.stt = async (body, options) => {
    clock = 200;
    options.assistantTiming('ct_request;dur=80, ct_provider_complete;dur=60');
    return { text: 'Синтетическая команда', policyVersion: 1 };
  };
  f.control.turn = async (body, options) => {
    clock = 300;
    options.assistantTiming('ct_request;dur=90, ct_data_read;dur=15');
    return { text: 'Готово', policyVersion: 1, action: { type: 'calendar', date: '2030-01-01' } };
  };
  f.actions.runAssistantAction = async () => {
    clock = 350;
    return true;
  };
  f.control.speak = async (body, options) => {
    clock = 400;
    options.assistantTiming('ct_request;dur=40');
    return { audioBase64: 'synthetic', mimeType: 'audio/wav', policyVersion: 1 };
  };
  await f.hold();
  const pending = f.captures[0].complete('synthetic-wav', {
    speechEndedAt: 20,
    autoStopped: true,
    stopReason: 'silence',
  });
  await flush();
  assert.equal(f.played.length, 1);
  const output = f.played[0].result;
  for (const [event, at] of [
    ['pcmFetchStart', 410],
    ['pcmHeaders', 450],
    ['pcmFirstByte', 480],
    ['pcmRenderStart', 510],
  ]) {
    clock = at;
    output.onTiming(event);
  }
  output.onTiming('pcmServer', 'ct_request;dur=35, ct_tts_cache_wait;dur=20');
  output.onStarted();
  await f.finishSpeech();
  await pending;
  const row = f.actions.assistantTurnDiagnostics()[0];
  assert.equal(f.actions.assistantTurnDiagnostics().length, 1);
  for (const [name, expected] of Object.entries({
    captureReadyMs: 80,
    sttStartMs: 80,
    sttEndMs: 180,
    turnStartMs: 180,
    turnEndMs: 280,
    actionStartMs: 280,
    actionEndMs: 330,
    speakStartMs: 330,
    speakEndMs: 380,
    pcmFirstByteMs: 460,
    pcmRenderStartMs: 490,
    audioStartedMs: 490,
    turnServer_data_readMs: 15,
    pcmServer_tts_cache_waitMs: 20,
  }))
    assert.equal(row[name], expected, name);
  for (const call of f.calls)
    assert.equal(Object.hasOwn(call.body || {}, 'assistantTiming'), false);
  assert.ok(Object.values(row).every(Number.isSafeInteger));
});

test('a spoken clarification and its next captured answer retain separate correlated traces', async (t) => {
  const f = voiceFixture(t);
  let clock = 100;
  Object.defineProperty(f.w.performance, 'now', { value: () => clock });
  f.w.eval(source);
  Object.assign(f.actions, f.w.eval('createAssistantTiming')(f.state));
  f.control.turn = async () => reply(1);
  await f.hold();
  for (let index = 0; index < 2; index++) {
    const pending = f.captures.at(-1).complete('synthetic-wav', {
      speechEndedAt: clock - 50,
      autoStopped: true,
      stopReason: 'silence',
    });
    await flush();
    const output = f.played.at(-1).result;
    clock += 40;
    output.onTiming('pcmRenderStart');
    output.onStarted();
    await f.finishSpeech();
    await pending;
    clock += 200;
  }
  const rows = f.actions.assistantTurnDiagnostics();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].turn, rows[1].turn);
  for (const row of rows) {
    assert.equal(row.sttRequests, 1);
    assert.equal(row.turnRequests, 1);
    assert.equal(row.speakRequests, 1);
    assert.equal(row.pcmRenderStartMs, 90);
    assert.equal(row.audioStartedMs, 90);
  }
});
