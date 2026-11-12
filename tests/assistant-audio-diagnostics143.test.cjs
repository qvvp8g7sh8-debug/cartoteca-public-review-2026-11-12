const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function fixture() {
  const state = {
    assistantGeneration: 1,
    account: { id: 'private-account', organizationId: 'private-org', role: 'owner' },
  };
  const summaries = [];
  const actions = vm.runInNewContext(
    source('src/client/modules/assistant-playback.js') + '\ncreateAssistantPlayback',
    {
      document: { hidden: false },
      window: {},
      navigator: {},
      clearTimeout,
      console: { info: (...args) => summaries.push(args) },
    },
  )(state, {});
  return {
    state,
    summaries,
    record: actions.recordAssistantAudioDiagnostic,
    read: actions.assistantAudioDiagnostics,
    api: actions.assistantPlayback(),
  };
}
test('audio diagnostics accept only fixed numeric events, bound totals and return a fresh immutable snapshot', () => {
  const f = fixture();
  assert.equal(f.read().active, false);
  assert.equal(f.record('underrun'), false);
  f.record('sessionStart');
  f.record('playbackRequested');
  f.record('underrun');
  f.record('startupWait', 12.6);
  for (let index = 0; index < 600; index++) f.record('refillWait', 150000);
  for (const input of [
    'private-command-text',
    '__proto__',
    null,
    {},
    {
      toString() {
        throw Error('not consulted');
      },
    },
  ])
    assert.equal(f.record(input, 42), false);
  for (const value of [-1, NaN, Infinity, 'private-audio', {}, null])
    assert.equal(f.record('firstChunkWait', value), false);
  const first = f.read();
  assert.ok(Object.isFrozen(first));
  assert.equal(first.requests, 1);
  assert.equal(first.underruns, 1);
  assert.equal(first.startupWaitMs, 13);
  assert.equal(first.refillWaitMs, 86400000);
  assert.equal(first.refillWaitMaxMs, 150000);
  first.requests = 900;
  assert.notEqual(first, f.read());
  assert.equal(f.read().requests, 1);
  for (const [name, value] of Object.entries(first))
    assert.ok(name === 'active' ? typeof value === 'boolean' : Number.isSafeInteger(value));
  assert.doesNotMatch(JSON.stringify(first), /private|account|organization|text|audio/i);
});
test('release prints one redacted stopped summary, clears retained values, and a new session resets it', () => {
  const f = fixture();
  f.record('sessionStart');
  f.record('bargePause');
  f.record('bargeFalsePause');
  f.record('playbackCancelled');
  f.api.release();
  f.api.release();
  assert.equal(f.summaries.length, 1);
  assert.equal(f.summaries[0][0], 'assistant-audio-summary');
  assert.equal(f.read().active, false);
  assert.equal(f.summaries[0][1].cancelled, 1);
  assert.equal(f.summaries[0][1].bargeFalsePauses, 1);
  assert.equal(f.read().cancelled, 0);
  assert.equal(f.read().bargeFalsePauses, 0);
  assert.equal(f.record('underrun'), false, 'late completion cannot mutate the stopped snapshot');
  f.record('sessionStart');
  assert.equal(f.read().active, true);
  assert.equal(f.read().cancelled, 0);
  assert.equal(f.read().bargeFalsePauses, 0);
  f.record('sessionStop');
  assert.equal(f.summaries.length, 2);
});
test('generation and account changes silently discard old diagnostics before a snapshot or late event', () => {
  for (const change of [
    (s) => s.assistantGeneration++,
    (s) => {
      s.account.id = 'next-private-account';
    },
    (s) => {
      s.account.organizationId = 'next-private-org';
    },
    (s) => {
      s.account.role = 'administrator';
    },
  ]) {
    const f = fixture();
    f.record('sessionStart');
    f.record('playbackRequested');
    f.record('sessionStop');
    change(f.state);
    assert.equal(f.record('bargeInterrupt'), false);
    assert.equal(f.read().requests, 0);
    assert.equal(f.read().active, false);
    assert.equal(f.summaries.length, 1, 'scope change must not print a second old-actor summary');
  }
});
function worklet(rate) {
  let Processor;
  const messages = [];
  vm.runInNewContext(source('src/client/worklets/assistant-playback-worklet.js'), {
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m) };
      }
    },
    Float32Array,
    Int16Array,
    sampleRate: rate,
    registerProcessor: (_, implementation) => {
      Processor = implementation;
    },
  });
  const instance = new Processor();
  const send = (data) => instance.port.onmessage({ data: { id: 1, ...data } });
  const render = (count) => {
    const result = [];
    for (let index = 0; index < count; index += 128) {
      const output = new Float32Array(Math.min(128, count - index));
      instance.process([], [[output]]);
      result.push(...output);
    }
    return result;
  };
  send({ type: 'begin' });
  return {
    instance,
    messages,
    send,
    render,
    buffer: (count) => send({ type: 'buffer', samples: new Int16Array(count).fill(16384) }),
  };
}
for (const rate of [24000, 44100, 48000])
  test(`worklet diagnoses transitions at ${rate} Hz without messages on each waiting render or changed samples`, () => {
    const f = worklet(rate);
    f.buffer(2880);
    f.send({ type: 'resume' });
    const first = f.render(Math.ceil((2880 * rate) / 24000));
    assert.ok(first.every((sample) => sample === 0.5));
    const initial = f.messages.filter((m) => m.type === 'diagnostic');
    assert.equal(initial.length, 1);
    assert.equal(initial[0].event, 'underrun');
    f.render(Math.floor(rate / 5));
    assert.equal(f.messages.filter((m) => m.type === 'diagnostic').length, 1);
    f.buffer(7200);
    assert.ok(f.render(128).every((sample) => sample === 0.5));
    const events = f.messages.filter((m) => m.type === 'diagnostic');
    assert.equal(events.length, 2);
    assert.equal(events[1].event, 'refill');
    assert.ok(Math.abs(events[1].waitMs - 200) < 1);
    assert.equal(f.instance.consumed >= 2880, true);
    f.send({ type: 'begin', id: 2 });
    f.send({ type: 'buffer', id: 1, samples: new Int16Array(48000) });
    assert.equal(f.instance.length, 0, 'stale input cannot create new metrics or new audio');
    assert.equal(f.instance.refillFrames, 0);
    for (const event of events)
      assert.ok(Object.keys(event).every((key) => ['type', 'id', 'event', 'waitMs'].includes(key)));
  });

test('the first preparation after an identity change starts fresh even if the old numeric session was still active', () => {
  const f = fixture();
  f.record('sessionStart');
  f.record('playbackRequested');
  f.record('playbackRequested');
  f.record('bargeFalsePause');
  f.state.account.id = 'next-private-account';
  const result = {
    mimeType: 'audio/pcm',
    sampleRate: 24000,
    channels: 1,
    sampleFormat: 's16le',
    playbackRate: 1,
    streamUrl:
      '/api/assistant/speak-audio?ticket=' +
      's'.repeat(43) +
      '&accountContext=next-private-account&organizationContext=private-org',
  };
  assert.throws(() => f.api.prepare(result), { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' });
  assert.equal(
    f.read().requests,
    1,
    'new-actor setup attempt is counted, not mixed with or lost behind old activity',
  );
  assert.equal(f.read().bargeFalsePauses, 0);
  f.api.release();
  assert.equal(f.summaries.length, 1);
  assert.equal(f.summaries[0][1].requests, 1);
  assert.equal(
    f.read().requests,
    0,
    'release clears the last actor summary as well as live counters',
  );
});
