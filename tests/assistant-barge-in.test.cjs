const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const moduleSource = (name) =>
  fs.readFileSync(path.join(__dirname, '../src/client/modules', name), 'utf8');
// The VM assimilates host-realm pause promises asynchronously; feed post-pause PCM on the next event-loop turn.
function fixture(settings = { echoCancellation: 'all' }, delivery = {}) {
  const state = { assistantGeneration: 1 },
    events = new Map(),
    trackEvents = new Map(),
    intervals = new Map(),
    timers = new Map();
  const calls = {
    microphone: 0,
    pause: 0,
    resume: 0,
    cancel: 0,
    trackStop: 0,
    close: 0,
    interrupt: 0,
    completed: [],
    errors: [],
    statuses: [],
    timerDelays: [],
    acquisitions: [],
    diagnostics: [],
  };
  const inputRate = delivery.sampleRate || 16000;
  let sequence = 0,
    processor,
    playing = true,
    valid = true,
    phase = 0,
    encoded,
    audioContext;
  const node = () => ({ connect() {}, disconnect() {} });
  const track = {
    getSettings: () => settings,
    stop() {
      calls.trackStop++;
    },
    addEventListener: (event, callback) => trackEvents.set(event, callback),
    removeEventListener: (event) => trackEvents.delete(event),
  };
  const media = { getAudioTracks: () => [track], getTracks: () => [track] };
  class AudioContext {
    constructor(options) {
      calls.contextOptions = options;
      if (options?.sampleRate && delivery.rejectForcedRate)
        throw Object.assign(Error('Synthetic device refuses forced clock'), {
          name: 'NotSupportedError',
        });
      audioContext = this;
      this.sampleRate = inputRate;
      this.state = 'running';
      this.destination = {};
      this.currentTime = 0;
      this.audioWorklet = {
        addModule: async (url) => {
          calls.moduleUrl = url;
          if (delivery.error) throw delivery.error;
          if (delivery.wait) await delivery.wait;
        },
      };
    }
    createMediaStreamSource() {
      if (delivery.sourceError) throw delivery.sourceError;
      return node();
    }

    createGain() {
      return { ...node(), gain: { value: 1 } };
    }
    close() {
      calls.close++;
      return Promise.resolve();
    }
  }
  class AudioWorkletNode {
    constructor() {
      Object.assign(this, node());
      this.port = { onmessage: null, postMessage() {}, close() {} };
      processor = this;
    }
  }
  const context = {
    performance: { now: () => (phase / inputRate) * 1000 },
    document: { querySelector: () => ({ content: '1111111111111111' }) },
    window: {
      AudioContext,
      AudioWorkletNode,
      Float32Array,
      addEventListener: (event, callback) => events.set(event, callback),
      removeEventListener: (event) => events.delete(event),
    },
    navigator: {
      mediaDevices: {
        async getUserMedia(constraints) {
          calls.microphone++;
          calls.constraints = constraints;
          calls.acquisitions.push(constraints);
          if (delivery.acquireError && calls.microphone === 1) {
            delivery.onAcquireFailure?.(state);
            throw delivery.acquireError;
          }
          return media;
        },
      },
    },
    setTimeout: (callback, delay) => {
      calls.timerDelays.push(delay);
      const id = ++sequence;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => {
      const id = ++sequence;
      intervals.set(id, callback);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  };
  const signal = vm.runInNewContext(
    moduleSource('assistant-barge-signal.js') + '\ncreateAssistantBargeSignal',
    context,
  )(state, {});
  const actions = {
    ...signal,
    recordAssistantAudioDiagnostic: (event) => calls.diagnostics.push(event),
    assistantAudioPlaying: () => playing,
    async pauseAssistantAudio() {
      calls.pause++;
      return delivery.pauseWait ? await delivery.pauseWait : true;
    },
    resumeAssistantAudio() {
      calls.resume++;
      return true;
    },
    stopAssistantAudio() {
      calls.cancel++;
      playing = false;
    },
    encodeAssistantWav(buffer) {
      calls.encodedRate = buffer.sampleRate;
      calls.encodedDuration = buffer.duration;
      encoded = Array.from(buffer.getChannelData(0));
      return 'synthetic-pcm';
    },
  };
  const api = vm.runInNewContext(
    moduleSource('assistant-barge-in.js') + '\ncreateAssistantBargeIn',
    context,
  )(state, actions);
  return {
    state,
    context,
    setClock(value) {
      audioContext.currentTime = value;
    },
    setContextState(value) {
      audioContext.state = value;
    },
    trackEnded() {
      trackEvents.get('ended')?.();
    },
    feedFrame(samples, time) {
      processor?.port.onmessage?.({ data: { type: 'pcm', samples, time } });
    },
    setFrameClock(value) {
      phase = Math.round(value * inputRate);
    },
    processorError() {
      processor.onprocessorerror?.();
    },
    calls,
    actions,
    media,
    api,
    timers,
    intervals,
    events,
    setPlaying(value) {
      playing = value;
    },
    setValid(value) {
      valid = value;
    },
    encoded: () => encoded,
    start: (maxSeconds = 30, captureOptions = {}) =>
      api.startAssistantBargeIn(
        (wav, info) => calls.completed.push({ wav, info }),
        (error) => calls.errors.push(error),
        maxSeconds,
        {
          current: () => valid,
          onInterrupt: () => calls.interrupt++,
          onStatus: (value) => calls.statuses.push(value),
          ...captureOptions,
        },
      ),
    feed(count, amplitude = 0.1, frequency = 440) {
      for (let n = 0; n < count; n++) {
        const frame = Float32Array.from(
          { length: 512 },
          () => amplitude * Math.sin((2 * Math.PI * frequency * phase++) / inputRate),
        );
        processor?.port.onmessage?.({
          data: { type: 'pcm', samples: frame, time: phase / inputRate },
        });
      }
    },
  };
}
test('voice barge requires actually enabled echo cancellation and never accepts false capture settings', async () => {
  const f = fixture({ echoCancellation: false });
  const result = await f.start();
  assert.equal(result.ready, false);
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.constraints.audio.echoCancellation.exact, 'all');
  assert.equal(f.calls.constraints.audio.noiseSuppression, true);
  assert.equal(f.calls.constraints.audio.autoGainControl, true);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.completed.length, 0);
  assert.doesNotMatch(result.reason, /Ответить сейчас/);
});

test('direct capture retries only unsupported all echo mode with exact true and reports its verified setting honestly', async () => {
  const error = Object.assign(Error('private device diagnostic'), {
    name: 'OverconstrainedError',
    constraint: 'echoCancellation',
  });
  const f = fixture({ echoCancellation: true }, { acquireError: error });
  const ready = await f.start();
  assert.equal(ready.ready, true);
  assert.equal(ready.echoCancellation, true);
  assert.equal(f.calls.microphone, 2);
  assert.equal(f.calls.acquisitions[0].audio.echoCancellation.exact, 'all');
  assert.equal(f.calls.acquisitions[1].audio.echoCancellation.exact, true);
  assert.equal(f.api.assistantBargeInState().echoCancellation, true);
  f.api.stopAssistantBargeIn(true);
});

test('false missing and remote-only echo settings never arm even after a compatibility retry', async () => {
  for (const echoCancellation of [false, undefined, 'remote-only']) {
    const f = fixture(
      { echoCancellation },
      {
        acquireError: Object.assign(Error('synthetic'), {
          name: 'OverconstrainedError',
          constraint: 'echoCancellation',
        }),
      },
    );
    const ready = await f.start();
    assert.equal(ready.ready, false);
    assert.equal(f.calls.microphone, 2);
    assert.equal(f.calls.trackStop, 1);
    assert.equal(f.calls.completed.length, 0);
  }
});

test('direct permission errors other constraints and revoked sessions never retry capture', async () => {
  for (const delivery of [
    { acquireError: Object.assign(Error('synthetic'), { name: 'NotAllowedError' }) },
    {
      acquireError: Object.assign(Error('synthetic'), {
        name: 'OverconstrainedError',
        constraint: 'channelCount',
      }),
    },
    {
      acquireError: Object.assign(Error('synthetic'), {
        name: 'OverconstrainedError',
        constraint: 'echoCancellation',
      }),
      onAcquireFailure: (state) => state.assistantGeneration++,
    },
  ]) {
    const f = fixture({ echoCancellation: true }, delivery);
    assert.equal((await f.start()).ready, false);
    assert.equal(f.calls.microphone, 1);
    assert.equal(f.calls.completed.length, 0);
  }
});
test('silence and speech before actual playback cannot interrupt or produce a transcription payload', async () => {
  const f = fixture();
  f.setPlaying(false);
  await f.start();
  f.feed(40);
  f.feed(40, 0);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.completed.length, 0);
  f.api.stopAssistantBargeIn();
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.intervals.size, 0);
});
test('assistant echo that disappears during confirmed pause resumes playback without STT or a takeover', async () => {
  const f = fixture();
  await f.start();
  f.feed(2);
  await new Promise(setImmediate);
  f.feed(10, 0);
  assert.equal(f.calls.pause, 1);
  assert.equal(f.calls.resume, 1);
  assert.deepEqual(f.calls.diagnostics, ['bargePause', 'bargeFalsePause']);
  assert.equal(f.calls.cancel, 0);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  f.api.stopAssistantBargeIn();
});
test('verified PCM echo ends ducking after the tail and leaves subsequent interruption armed', async () => {
  const f = fixture({ echoCancellation: true }, { pauseWait: Promise.resolve('ducked') });
  let verifiedEcho = false;
  f.actions.assistantOutputReference = () => ({ stream: {}, current: () => true });
  f.actions.assistantEchoProof = () => ({ feed() {}, echo: () => verifiedEcho, close() {} });
  assert.equal((await f.start()).ready, true);

  for (let probe = 1; probe <= 2; probe++) {
    verifiedEcho = false;
    f.feed(2);
    await new Promise(setImmediate);
    verifiedEcho = true;
    f.feed(4);
    assert.equal(f.calls.resume, probe - 1, 'the 120 ms tail remains in force');
    f.feed(1);
    assert.equal(f.calls.resume, probe);
    assert.equal(f.api.assistantBargeInState().phase, 'listening');
  }
  verifiedEcho = false;
  f.feed(2);
  await new Promise(setImmediate);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  assert.equal(f.calls.cancel, 1);
  f.api.stopAssistantBargeIn();
});
test('a bounded PCM refit leaves the original takeover prefix available to the normal probe', async () => {
  const f = fixture({ echoCancellation: true }, { pauseWait: Promise.resolve('ducked') });
  let retrying = true;
  f.actions.assistantOutputReference = () => ({
    stream: f.media,
    current: () => true,
    playbackId: () => 7,
  });
  f.actions.assistantEchoProof = () => ({
    feed() {},
    echo: () => false,
    deferProbe: () => retrying,
    close() {},
  });
  assert.equal((await f.start()).ready, true);
  f.feed(3);
  assert.equal(f.calls.pause, 0);
  retrying = false;
  f.feed(1);
  await new Promise(setImmediate);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  f.feed(45, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.ok(Math.abs(f.encoded()[1] - 0.1 * Math.sin((2 * Math.PI * 440) / 16000)) < 1e-6);
});
test('a short 320ms spoken stop survives onset and pause confirmation with its first samples in the same-stream prebuffer', async () => {
  const f = fixture();
  await f.start();
  f.feed(2);
  await new Promise(setImmediate);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  assert.equal(f.calls.cancel, 1);
  assert.deepEqual(f.calls.diagnostics, ['bargePause', 'bargeInterrupt']);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  assert.equal(f.calls.completed.length, 0);
  f.feed(45, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.stopReason, 'silence');
  assert.equal(f.calls.completed[0].info.interrupted, true);
  assert.equal(
    f.calls.completed[0].info.speechEndedAt,
    320,
    'last voiced frame survives the endpoint silence',
  );
  assert.equal(f.calls.microphone, 1);
  assert.ok(Math.abs(f.encoded()[1] - 0.1 * Math.sin((2 * Math.PI * 440) / 16000)) < 1e-6);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.errors.length, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timers.size, 0);
});
test('session generation and pagehide discard buffered audio, stop tracks and fence late pause completion', async () => {
  for (const reason of ['generation', 'pagehide']) {
    const f = fixture();
    await f.start();
    f.feed(2);
    if (reason === 'generation') {
      f.state.assistantGeneration++;
      for (const callback of [...f.intervals.values()]) callback();
    } else f.events.get('pagehide')();
    await new Promise(setImmediate);
    f.feed(80);
    assert.equal(f.calls.interrupt, 0);
    assert.equal(f.calls.completed.length, 0);
    assert.equal(f.calls.trackStop, 1);
    assert.equal(f.calls.close, 1);
    assert.equal(f.intervals.size, 0);
  }
});
test('repeated residual echo blocks only the current chunk and the same microphone recovers at the next boundary', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: true });
  for (let n = 0; n < 2; n++) {
    f.feed(2);
    await new Promise(setImmediate);
    f.feed(10, 0);
  }
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.calls.resume, 2);
  assert.equal(f.calls.trackStop, 0);
  assert.equal(f.api.assistantBargeInState().ready, false);
  assert.match(f.api.assistantBargeInState().reason, /эхо/);
  f.feed(20);
  assert.equal(f.calls.pause, 2, 'blocked chunk cannot retry more than its echo budget');
  f.setPlaying(false);
  f.setClock(1.408);
  assert.equal(ready.wait(), true);
  assert.equal(ready.continuePlayback(), true);
  f.setPlaying(true);
  assert.equal(ready.playbackStarted(), true);
  f.feed(2);
  await new Promise(setImmediate);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  f.feed(19, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.trackStop, 1);
});

test('interrupted speech honors the configured sixty second sample bound', async () => {
  const f = fixture();
  await f.start(60);
  f.feed(2);
  await new Promise(setImmediate);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  f.feed(950);
  assert.equal(f.calls.completed.length, 0, 'recording must continue after thirty seconds');
  f.feed(950);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.stopReason, 'limit');
  assert.equal(f.calls.completed[0].info.seconds, 60);
  assert.equal(f.encoded().length, 60 * 16000);
  assert.equal(f.intervals.size, 0);
});

test('AudioWorklet is versioned, unavailable feature never requests microphone and module failures clean up', async () => {
  const absent = fixture();
  delete absent.context.window.AudioWorkletNode;
  assert.equal((await absent.start()).ready, false);
  assert.equal(absent.calls.microphone, 0);
  const failed = fixture({ echoCancellation: 'all' }, { error: Error('Synthetic module failure') });
  assert.equal((await failed.start()).ready, false);
  assert.match(failed.calls.moduleUrl, /assistant-capture-worklet.js\?v=1111111111111111/);
  assert.equal(failed.calls.trackStop, 1);
  assert.equal(failed.calls.close, 1);
  assert.equal(failed.intervals.size, 0);
  assert.equal(failed.timers.size, 0);
});
test('cancel and timeout during module loading fence late completion and release capture', async () => {
  for (const mode of ['cancel', 'timeout']) {
    let resolve;
    const wait = new Promise((done) => {
      resolve = done;
    });
    const f = fixture({ echoCancellation: 'all' }, { wait }),
      pending = f.start();
    await new Promise(setImmediate);
    if (mode === 'cancel') f.api.stopAssistantBargeIn();
    else [...f.timers.values()][0]();
    assert.equal((await pending).ready, false);
    resolve();
    await new Promise(setImmediate);
    assert.equal(f.calls.trackStop, 1);
    assert.equal(f.calls.close, 1);
    assert.equal(f.calls.interrupt, 0);
    assert.equal(f.calls.completed.length, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timers.size, 0);
  }
});
test('queued pre-pause PCM cannot confirm a false barge and processor errors stop capture', async () => {
  const f = fixture();
  await f.start();
  f.setClock(10);
  f.feed(2);
  await new Promise(setImmediate);
  f.feed(10);
  assert.equal(f.calls.interrupt, 0);
  f.setFrameClock(10.1);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  f.processorError();
  assert.equal(f.calls.errors.length, 1);
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.close, 1);
});

for (const mode of ['interrupted', 'postQuestion'])
  test(`a long clarification retains its mid-phrase pause in ${mode} capture`, async () => {
    const f = fixture(),
      ready = await f.start(30, { shortAnswer: true, shortSilence: false });
    if (mode === 'interrupted') {
      f.feed(2);
      await new Promise(setImmediate);
      f.feed(8);
      assert.equal(f.calls.interrupt, 1, 'post-pause echo proof is still required');
    } else {
      f.setPlaying(false);
      f.setClock(1.024);
      assert.equal(ready.listen(), true);
      f.feed(36);
      assert.equal(f.api.assistantBargeInState().phase, 'capturing');
      assert.equal(f.calls.interrupt, 0);
    }
    f.feed(23, 0);
    assert.equal(f.calls.completed.length, 0, '736ms may be inside a full name or service');
    f.feed(10);
    f.feed(32, 0);
    assert.equal(f.calls.completed.length, 0);
    f.feed(1, 0);
    assert.equal(f.calls.completed.length, 1);
    assert.equal(f.calls.completed[0].info.stopReason, 'silence');
    assert.equal(f.calls.errors.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
  });

for (const [shortAnswer, quietFrames] of [
  [true, 18],
  [false, 32],
])
  test(
    'confirmed barge capture uses ' +
      (shortAnswer ? '600' : '1050') +
      'ms silence without weakening onset or post-pause echo proof',
    async () => {
      const f = fixture();
      await f.start(30, { shortAnswer });
      f.feed(2);
      await new Promise(setImmediate);
      assert.equal(f.calls.interrupt, 0, 'onset alone is not a confirmed takeover');
      f.feed(8);
      assert.equal(f.calls.interrupt, 1);
      f.feed(quietFrames, 0);
      assert.equal(f.calls.completed.length, 0);
      f.feed(1, 0);
      assert.equal(f.calls.completed.length, 1);
      assert.equal(f.calls.completed[0].info.stopReason, 'silence');
      assert.equal(f.calls.completed[0].info.interrupted, true);
      assert.equal(f.calls.trackStop, 1);
      assert.equal(f.calls.errors.length, 0);
      assert.equal(f.intervals.size, 0);
      assert.equal(f.timers.size, 0);
    },
  );

// Prepared for the end-of-question handoff regression; deliberately not executed here.
test('the existing worklet accepts a short post-question answer without another microphone and excludes queued playback PCM', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: true });
  assert.equal(typeof ready.listen, 'function');
  assert.equal(ready.listen(), false, 'playback has not ended');
  f.setPlaying(false);
  f.setClock(1.024);
  assert.equal(ready.listen(), true);
  assert.equal(ready.listen(), false, 'the same handle cannot extend its no-input deadline');
  f.feed(32);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  f.feed(3);
  assert.equal(
    f.api.assistantBargeInState().phase,
    'listening',
    '96ms is below the 100ms short-answer proof',
  );
  f.feed(1);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  f.feed(15, 0);
  assert.equal(
    f.calls.completed.length,
    0,
    '480ms at the worklet frame boundary still retains the answer',
  );
  f.feed(3, 0);
  assert.equal(f.calls.completed.length, 0, '576ms does not end a short answer');
  f.feed(1, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.interrupted, false);
  assert.equal(f.calls.completed[0].info.stopReason, 'silence');
  assert.equal(f.encoded().length, (4 + 19) * 512);
  assert.ok(
    Math.abs(f.encoded()[1] - 0.1 * Math.sin((2 * Math.PI * 440 * (32 * 512 + 1)) / 16000)) < 1e-6,
  );
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.calls.cancel, 0);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
});

test('a frame crossing actual playback completion keeps its fresh suffix without admitting its speaker prefix', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: true });
  f.setPlaying(false);
  f.setClock(0.016);
  assert.equal(ready.listen(), true);
  const crossing = Float32Array.from({ length: 512 }, (_, i) =>
    i < 256 ? 0.7 : 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16000),
  );
  f.feedFrame(crossing, 0.032);
  f.setFrameClock(0.032);
  f.feed(2);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  f.feed(1);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  f.feed(19, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.deepEqual(f.encoded().slice(0, 256), Array.from(crossing.slice(256)));
  assert.equal(f.encoded().length, 256 + 3 * 512 + 19 * 512);
  assert.equal(f.calls.interrupt, 0);
});

test('post-question listening resets only its detector noise and keeps the ordinary 250ms and 1050ms gates', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: false });
  f.setPlaying(false);
  f.feed(200, 0.5, 40);
  f.setClock(6.4);
  assert.equal(ready.listen(), true);
  f.feed(7, 0.03);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  f.feed(1, 0.03);
  assert.equal(
    f.api.assistantBargeInState().phase,
    'capturing',
    'fresh noise baseline must admit the quiet answer',
  );
  f.feed(32, 0);
  assert.equal(f.calls.completed.length, 0);
  f.feed(1, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.interrupted, false);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.calls.microphone, 1);
});

test('post-question silence is bounded to eight seconds and never emits an empty WAV or a stale callback', async () => {
  const f = fixture(),
    ready = await f.start(60, { shortAnswer: true });
  f.setPlaying(false);
  assert.equal(ready.listen(), true);
  f.feed(20, 0);
  assert.equal(f.calls.timerDelays.at(-1), 8000);
  assert.equal(f.timers.size, 1);
  const deadline = [...f.timers.values()][0];
  deadline();
  assert.equal(f.calls.errors.length, 1);
  assert.equal(f.calls.errors[0].code, 'ASSISTANT_NO_INPUT');
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.encoded(), undefined);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
  assert.equal(ready.listen(), false);
  deadline();
  assert.equal(f.calls.errors.length, 1);
});

test('ordinary answer capture retains its sixty-second hard sample bound and its original first word', async () => {
  const f = fixture(),
    ready = await f.start(60, { shortAnswer: true });
  f.setPlaying(false);
  assert.equal(ready.listen(), true);
  f.feed(950);
  assert.equal(f.calls.completed.length, 0);
  f.feed(950);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.stopReason, 'limit');
  assert.equal(f.calls.completed[0].info.seconds, 60);
  assert.equal(f.calls.completed[0].info.interrupted, false);
  assert.equal(f.encoded().length, 60 * 16000);
  assert.ok(Math.abs(f.encoded()[1] - 0.1 * Math.sin((2 * Math.PI * 440) / 16000)) < 1e-6);
  assert.equal(f.calls.microphone, 1);
});

test('a late pending pause cannot overwrite the end-of-question answer mode', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: true });
  f.feed(2);
  assert.equal(f.calls.pause, 1);
  f.setPlaying(false);
  f.setClock(0.064);
  assert.equal(ready.listen(), true);
  await new Promise(setImmediate);
  f.feed(4);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  assert.equal(f.calls.interrupt, 0);
  f.feed(24, 0);
  assert.equal(f.calls.completed[0].info.interrupted, false);
  assert.equal(f.calls.cancel, 0);
});

test('unexpected track or processor failure terminates the primary answer listener instead of leaving recording active', async () => {
  for (const reason of ['track', 'processor', 'context']) {
    const f = fixture(),
      ready = await f.start(30, { shortAnswer: true });
    f.setPlaying(false);
    assert.equal(ready.listen(), true);
    if (reason === 'track') f.trackEnded();
    else if (reason === 'processor') f.processorError();
    else {
      f.setContextState('closed');
      for (const callback of [...f.intervals.values()]) callback();
    }
    assert.equal(f.calls.errors.length, 1);
    assert.equal(f.calls.completed.length, 0);
    assert.equal(f.calls.trackStop, 1);
    assert.equal(f.calls.close, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(ready.listen(), false);
  }
});

test('pagehide cancellation and session revocation discard a post-question listener without retrying it', async () => {
  for (const reason of ['pagehide', 'generation', 'valid', 'stop']) {
    const f = fixture(),
      ready = await f.start(30, { shortAnswer: true });
    f.setPlaying(false);
    assert.equal(ready.listen(), true);
    f.feed(2);
    if (reason === 'pagehide') f.events.get('pagehide')();
    else if (reason === 'stop') f.api.stopAssistantBargeIn(true);
    else {
      if (reason === 'generation') f.state.assistantGeneration++;
      else f.setValid(false);
      for (const callback of [...f.intervals.values()]) callback();
    }
    f.feed(60);
    assert.equal(f.calls.errors.length, 0);
    assert.equal(f.calls.completed.length, 0);
    assert.equal(f.calls.trackStop, 1);
    assert.equal(f.calls.close, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(ready.listen(), false);
  }
});

test('closed or suspended audio contexts refuse a handoff so the controller can use its cold-capture fallback', async () => {
  for (const state of ['closed', 'suspended']) {
    const f = fixture(),
      ready = await f.start();
    f.setPlaying(false);
    f.setContextState(state);
    assert.equal(ready.listen(), false);
    assert.equal(f.calls.completed.length, 0);
    f.api.stopAssistantBargeIn(true);
    assert.equal(f.calls.trackStop, 1);
  }
});

test('a pause refused by natural native EOF retains the same microphone until successful end-of-question handoff', async () => {
  let resolvePause;
  const pauseWait = new Promise((resolve) => {
    resolvePause = resolve;
  });
  const f = fixture({ echoCancellation: 'all' }, { pauseWait });
  const ready = await f.start(30, { shortAnswer: true });
  f.feed(2);
  assert.equal(f.calls.pause, 1);
  f.setPlaying(false);
  f.setClock(0.064);
  resolvePause(false);
  await new Promise(setImmediate);
  assert.equal(f.calls.trackStop, 0);
  assert.equal(f.calls.close, 0);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.calls.errors.length, 0);
  assert.equal(ready.listen(), true);
  f.feed(4);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  f.feed(24, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.interrupted, false);
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.calls.trackStop, 1);
});

test('an explicitly cancelled playback cannot transfer its old microphone when its pending pause later resolves false', async () => {
  let resolvePause;
  const pauseWait = new Promise((resolve) => {
    resolvePause = resolve;
  });
  const f = fixture({ echoCancellation: 'all' }, { pauseWait });
  const ready = await f.start(30, { shortAnswer: true });
  f.feed(2);
  f.setPlaying(false);
  f.api.stopAssistantBargeIn(true);
  resolvePause(false);
  await new Promise(setImmediate);
  assert.equal(ready.listen(), false);
  f.feed(60);
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.calls.errors.length, 0);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
});

// BARGE-WARM-37 — prepared only; execution belongs to the ordered root batch.
test('a delayed acknowledged pause retains the complete first word beyond the old 400ms ring', async () => {
  let acknowledge;
  const pauseWait = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const f = fixture({ echoCancellation: 'all' }, { pauseWait });
  await f.start(30, { shortAnswer: true });
  f.feed(2);
  f.feed(18);
  assert.equal(f.calls.interrupt, 0);
  acknowledge(true);
  await new Promise(setImmediate);
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  f.feed(19, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.ok(f.encoded().length >= 28 * 512);
  const prefix = Float32Array.from(
    { length: 1024 },
    (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16000),
  );
  assert.deepEqual(f.encoded().slice(0, 1024), Array.from(prefix));
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.cancel, 1);
  assert.equal(f.calls.completed[0].info.interrupted, true);
  assert.equal(f.timers.size, 0);
});

test('the warm inter-chunk listener accepts a complete short selection without cancelling pending native audio', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: true });
  f.setPlaying(false);
  assert.equal(ready.wait(), true);
  f.feed(3);
  assert.equal(f.calls.interrupt, 0);
  f.feed(1);
  assert.equal(f.calls.interrupt, 1);
  assert.equal(ready.continuePlayback(), false);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.calls.cancel, 0, 'no pause/stop is sent to a not-yet-started native play');
  f.feed(19, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.interrupted, true);
  assert.ok(Math.abs(f.encoded()[1] - 0.1 * Math.sin((2 * Math.PI * 440) / 16000)) < 1e-6);
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.trackStop, 1);
});

test('a reply prefix immediately before the next native start survives without pre-start pause or weaker echo proof', async () => {
  const f = fixture(),
    ready = await f.start(30, { shortAnswer: true });
  f.setPlaying(false);
  assert.equal(ready.wait(), true);
  f.feed(3);
  assert.equal(ready.continuePlayback(), true);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.calls.interrupt, 0);
  assert.equal(f.timers.size, 1, 'the warm listener remains until native onplaying');
  f.setPlaying(true);
  assert.equal(ready.playbackStarted(), true);
  assert.equal(f.timers.size, 0);
  f.feed(1);
  await new Promise(setImmediate);
  assert.equal(f.calls.interrupt, 0, 'a real post-pause confirmation is still required');
  f.feed(8);
  assert.equal(f.calls.interrupt, 1);
  f.feed(19, 0);
  assert.equal(f.calls.completed.length, 1);
  const prefix = Float32Array.from(
    { length: 3 * 512 },
    (_, i) => 0.1 * Math.sin((2 * Math.PI * 440 * i) / 16000),
  );
  assert.deepEqual(f.encoded().slice(0, 3 * 512), Array.from(prefix));
  assert.equal(f.calls.microphone, 1);
});

test('an inter-chunk wait is bounded and generation or pagehide cannot reuse its buffered answer', async () => {
  for (const reason of ['timeout', 'generation', 'pagehide']) {
    const f = fixture(),
      ready = await f.start(30, { shortAnswer: true });
    f.setPlaying(false);
    assert.equal(ready.wait(), true);
    f.feed(2);
    if (reason === 'timeout') [...f.timers.values()][0]();
    else if (reason === 'pagehide') f.events.get('pagehide')();
    else {
      f.state.assistantGeneration++;
      for (const guard of [...f.intervals.values()]) guard();
    }
    f.feed(20);
    assert.equal(ready.continuePlayback(), false);
    assert.equal(f.calls.completed.length, 0);
    assert.equal(f.calls.cancel, 0);
    assert.equal(f.calls.trackStop, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.calls.errors.length, 0, 'a pending next TTS request is not a missing answer');
  }
});

test('native device clock avoids an unsupported forced16k context and keeps post-question timing at48k', async () => {
  const f = fixture({ echoCancellation: 'all' }, { sampleRate: 48000, rejectForcedRate: true });
  const ready = await f.start(30, { shortAnswer: true });
  assert.equal(ready.ready, true);
  assert.equal(f.calls.contextOptions, undefined);
  assert.equal(f.calls.microphone, 1);
  assert.equal(f.calls.constraints.audio.echoCancellation.exact, 'all');
  f.setPlaying(false);
  assert.equal(ready.listen(), true);
  f.feed(9);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  f.feed(1);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  f.feed(56, 0);
  assert.equal(f.calls.completed.length, 0);
  f.feed(1, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.encodedRate, 48000);
  assert.equal(f.calls.encodedDuration, f.encoded().length / 48000);
  assert.equal(f.calls.trackStop, 1);
  assert.equal(f.calls.close, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
});

test('capture diagnostics expose only a static stage and bounded error classification', async () => {
  for (const [where, error, expected] of [
    [
      'acquire',
      Object.assign(Error('PRIVATE_MESSAGE DEVICE_ID'), {
        name: 'OverconstrainedError',
        constraint: 'echoCancellation',
      }),
      { stage: 'acquire-media', name: 'OverconstrainedError', constraint: 'echoCancellation' },
    ],
    [
      'acquire',
      Object.assign(Error('PRIVATE_MESSAGE'), {
        name: 'OverconstrainedError',
        constraint: 'PRIVATE_DEVICE_ID',
      }),
      { stage: 'acquire-media', name: 'OverconstrainedError' },
    ],
    [
      'module',
      Object.assign(Error('PRIVATE_URL_TOKEN'), { name: 'NetworkError' }),
      { stage: 'worklet-load', name: 'NetworkError' },
    ],
    [
      'source',
      Object.assign(Error('PRIVATE_TRACK_ID'), { name: 'NotSupportedError' }),
      { stage: 'media-source', name: 'NotSupportedError' },
    ],
  ]) {
    const f = fixture(
      { echoCancellation: 'all' },
      where === 'module' ? { error } : where === 'source' ? { sourceError: error } : {},
    );
    const result = await f.start(
      30,
      where === 'acquire'
        ? {
            acquireMedia: async () => {
              throw error;
            },
          }
        : {},
    );
    assert.equal(result.ready, false);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.statuses.at(-1).diagnostic)), expected);
    assert.doesNotMatch(
      JSON.stringify(f.calls.statuses),
      /PRIVATE|stack|message|deviceId|trackId/u,
    );
    assert.equal(f.timers.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.calls.microphone, where === 'acquire' ? 0 : 1);
    if (where !== 'acquire') {
      assert.equal(f.calls.trackStop, 1);
      assert.equal(f.calls.close, 1);
    }
  }
});

test('initial PCM recording needs no AEC playback capability, fences the cue and preserves a1300ms thought pause', async () => {
  const f = fixture({ echoCancellation: false });
  f.setPlaying(false);
  const ready = await f.start(30, {
    initialCapture: true,
    initialCommand: true,
    readyCue: async ({ captureMedia, current }) => {
      assert.equal(captureMedia, f.media);
      assert.equal(current(), true);
      assert.equal(f.calls.moduleUrl.includes('assistant-capture-worklet.js'), true);
      f.feed(10, 0.7);
      f.setClock(0.32);
      return true;
    },
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.echoCancellation, null);
  assert.equal(ready.playbackStarted, undefined);
  assert.equal(ready.wait, undefined);
  assert.equal(ready.continuePlayback, undefined);
  assert.equal(ready.listen(), true);
  assert.ok(f.calls.timerDelays.includes(8000));
  f.feedFrame(new Float32Array(512).fill(0.8), 0.32);
  f.feed(7, 0.2);
  assert.equal(f.api.assistantBargeInState().phase, 'listening', '224ms cannot arm speech');
  f.feed(1, 0.2);
  f.feed(41, 0);
  assert.equal(f.calls.completed.length, 0, '1312ms mid-phrase silence must remain open');
  f.feed(10, 0.2);
  f.feed(47, 0);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.completed[0].info.stopReason, 'silence');
  assert.ok(
    f.encoded().every((sample) => Math.abs(sample) < 0.3),
    'cue prefix is excluded',
  );
  const expectedSamples = (8 + 41 + 10) * 512 + 4800;
  assert.ok(
    f.encoded().length >= expectedSamples - 1 && f.encoded().length <= expectedSamples,
    'the whole onset remains; the timestamp fence may conservatively crop one rounding sample',
  );
  f.api.stopAssistantBargeIn(false);
  assert.equal(f.calls.completed.length, 1);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.calls.interrupt, 0);
});

test('initial PCM graph and cue failures allow fallback only before the ready cue and never after cancellation', async () => {
  const graph = fixture({}, { sourceError: Error('synthetic graph failure') });
  assert.equal((await graph.start(30, { initialCapture: true })).fallbackAllowed, true);
  assert.equal(graph.calls.completed.length, 0);
  const cue = fixture({});
  assert.equal(
    (await cue.start(30, { initialCapture: true, readyCue: async () => false })).fallbackAllowed,
    false,
  );
  assert.equal(cue.calls.completed.length, 0);
  assert.equal(cue.calls.trackStop, 1);
  for (const change of ['stop', 'account']) {
    let release;
    const pendingModule = new Promise((resolve) => {
      release = resolve;
    });
    const f = fixture({}, { wait: pendingModule });
    const pending = f.start(30, { initialCapture: true });
    await Promise.resolve();
    if (change === 'stop') f.api.stopAssistantBargeIn(true);
    else f.state.assistantGeneration++;
    release();
    const result = await pending;
    assert.equal(result.ready, false);
    assert.notEqual(result.fallbackAllowed, true);
    assert.equal(f.calls.completed.length, 0);
    assert.equal(f.calls.errors.length, 0);
  }
});

test('automatic cold PCM capture reaches STT once without MediaRecorder or decodeAudioData', async () => {
  const f = fixture({});
  f.setPlaying(false);
  let legacyCalls = 0,
    transcribes = 0,
    sends = 0;
  const rootTrack = {
    readyState: 'live',
    kind: 'audio',
    stop() {
      this.readyState = 'ended';
    },
  };
  const root = {
    getTracks: () => [rootTrack],
    getAudioTracks: () => [rootTrack],
    clone: () => f.media,
  };
  f.context.navigator.mediaDevices.getUserMedia = async () => root;
  f.context.document.hidden = false;
  f.context.window.AudioContext.prototype.decodeAudioData = () => {
    throw Error('legacy decoder must not run');
  };
  Object.defineProperty(f.context, 'MediaRecorder', {
    get() {
      throw Error('legacy recorder must not run');
    },
  });
  Object.assign(f.state, {
    assistantScope: {
      limits: { maxAudioSeconds: 30 },
      capabilities: { stt: { ready: true }, tts: { ready: true } },
    },
  });
  const ui = {
    session: 1,
    busy: false,
    recording: false,
    valid: () => true,
    activity(busy, recording) {
      this.busy = busy;
      this.recording = recording;
    },
    status() {},
    voiceState() {},
    input: () => ({ tagName: 'TEXTAREA', value: '' }),
    async request(route) {
      assert.equal(route, '/api/assistant/transcribe');
      transcribes++;
      return { text: 'Синтетическая команда' };
    },
    async sendText() {
      sends++;
    },
  };
  const text = vm.runInNewContext(
    moduleSource('assistant-speech-text.js') + '\ncreateAssistantSpeechText',
    f.context,
  )();
  const actions = {
    ...f.actions,
    ...f.api,
    ...text,
    assistantAudioFormat: () => 'pcm',
    playAssistantReadyCue: async () => true,
    startAssistantCapture() {
      legacyCalls++;
      throw Error('legacy path must not run');
    },
    stopAssistantCapture() {},
  };
  const controller = vm
    .runInNewContext(moduleSource('assistant-speech.js') + '\ncreateAssistantSpeech', f.context)(
      f.state,
      actions,
    )
    .assistantSpeechController(ui);
  try {
    await controller.startVoice();
    assert.equal(ui.recording, true);
    assert.equal(legacyCalls, 0);
    f.feed(10, 0.2);
    f.feed(47, 0);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(transcribes, 1);
    assert.equal(sends, 1);
    f.api.stopAssistantBargeIn(false);
    assert.equal(transcribes, 1);
  } finally {
    controller.stopVoice();
  }
});

test('initial PCM keeps its eight-second no-input deadline and hard sample limit with no playback takeover', async () => {
  const empty = fixture({});
  empty.setPlaying(false);
  const waiting = await empty.start(30, { initialCapture: true, initialCommand: true });
  assert.equal(waiting.listen(), true);
  empty.feed(20, 0);
  assert.equal(empty.calls.timerDelays.at(-1), 8000);
  const deadline = [...empty.timers.values()][0];
  deadline();
  deadline();
  assert.equal(empty.calls.errors.length, 1);
  assert.equal(empty.calls.errors[0].code, 'ASSISTANT_NO_INPUT');
  assert.equal(empty.calls.completed.length, 0);
  assert.equal(empty.encoded(), undefined);
  assert.equal(empty.timers.size, 0);
  const limited = fixture({});
  limited.setPlaying(false);
  const capture = await limited.start(1, { initialCapture: true, initialCommand: true });
  assert.equal(capture.listen(), true);
  limited.feed(40, 0.2);
  assert.equal(limited.calls.completed.length, 1);
  assert.equal(limited.calls.completed[0].info.stopReason, 'limit');
  assert.equal(limited.encoded().length, 16000);
  assert.equal(limited.calls.interrupt, 0);
  assert.equal(limited.calls.pause, 0);
});

test('recording-only warm fallback preserves short-answer onset and the explicit full-phrase pause', async () => {
  const f = fixture({});
  f.setPlaying(false);
  const ready = await f.start(30, {
    initialCapture: true,
    initialCommand: false,
    shortAnswer: true,
    shortSilence: false,
  });
  assert.equal(ready.listen(), true);
  f.feed(4, 0.2);
  assert.equal(f.api.assistantBargeInState().phase, 'capturing');
  f.feed(32, 0);
  assert.equal(f.calls.completed.length, 0);
  f.feed(1, 0);
  assert.equal(f.calls.completed.length, 1);
});

for (const rate of [16000, 44100, 48000]) {
  test(`recording-only onset preserves a phrase with short internal gaps at ${rate}Hz`, async () => {
    const f = fixture({}, { sampleRate: rate });
    f.setPlaying(false);
    const ready = await f.start(30, { initialCapture: true, initialCommand: true });
    assert.equal(ready.listen(), true);
    const voiceFrames = Math.floor((rate * 0.192) / 512),
      gapFrames = Math.floor((rate * 0.085) / 512);
    f.feed(7, 0);
    for (let segment = 0; segment < 6; segment++) {
      f.feed(voiceFrames, 0.1);
      f.feed(gapFrames, 0);
    }
    assert.equal(f.api.assistantBargeInState().phase, 'capturing');
    f.feed(Math.ceil((rate * 1.5) / 512), 0);
    assert.equal(f.calls.completed.length, 1);
    assert.equal(f.calls.completed[0].info.stopReason, 'silence');
    const firstFrame = Float32Array.from(
      { length: 512 },
      (_, index) => 0.1 * Math.sin((2 * Math.PI * 440 * (index + 7 * 512)) / rate),
    );
    const speechStart = f.encoded().findIndex((value) => Math.abs(value) > 0.00001);
    assert.deepEqual(f.encoded().slice(speechStart, speechStart + 512), Array.from(firstFrame));
    const samples = f.encoded();
    const finalNonzero = samples.findLastIndex((value) => value !== 0);
    assert.ok(samples.length - finalNonzero - 1 >= Math.ceil(rate * 0.3));
    assert.ok(samples.length - finalNonzero - 1 < Math.ceil(rate * 0.3) + 512);
    assert.equal(f.calls.pause, 0);
    assert.equal(f.calls.interrupt, 0);
  });
}

test('initial capture preserves low nonzero endings and trims only following digital silence', async () => {
  const f = fixture({});
  f.setPlaying(false);
  const ready = await f.start(30, { initialCapture: true, initialCommand: true });
  assert.equal(ready.listen(), true);
  f.feed(12, 0.1);
  f.feed(6, 0.0005);
  f.feed(40, 0);
  assert.equal(f.calls.completed.length, 0, 'The normal end-of-speech deadline still applies');
  f.feed(1, 0);
  assert.equal(f.calls.completed.length, 1);
  const samples = f.encoded();
  assert.ok(samples.slice(12 * 512, 18 * 512).some((value) => Math.abs(value) > 0.0001));
  assert.equal(samples.length, 18 * 512 + 4800);
});

test('recording-only onset rejects separated clicks, long gaps and bounded background noise', async () => {
  const f = fixture({}, { sampleRate: 48000 });
  f.setPlaying(false);
  const ready = await f.start(30, { initialCapture: true, initialCommand: true });
  assert.equal(ready.listen(), true);
  for (let click = 0; click < 20; click++) {
    f.feed(1, 0.1);
    f.feed(8, 0);
  }
  for (let word = 0; word < 4; word++) {
    f.feed(18, 0.1);
    f.feed(10, 0);
  }
  f.feed(150, 0.005);
  assert.equal(f.api.assistantBargeInState().phase, 'listening');
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.encoded(), undefined);
  const noInput = [...f.timers.values()].at(-1);
  noInput();
  assert.equal(f.calls.completed.length, 0);
  assert.equal(f.calls.errors[0].code, 'ASSISTANT_NO_INPUT');
});
