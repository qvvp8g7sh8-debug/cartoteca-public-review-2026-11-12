const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.resolve(__dirname, '../src/client/modules/assistant-speech.js'),
  'utf8',
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function microphone(allEcho = false) {
  const streams = [];
  function media(root = false) {
    const listeners = new Map();
    let echo = true;
    const track = {
      readyState: 'live',
      stops: 0,
      constraints: [],
      stop() {
        this.stops++;
        this.readyState = 'ended';
      },
      getSettings: () => ({ echoCancellation: echo }),
      getCapabilities: () => ({ echoCancellation: allEcho ? [true, false, 'all'] : [true, false] }),
      async applyConstraints(value) {
        this.constraints.push(value);
        echo = 'all';
      },
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
      },
      removeEventListener(name, callback) {
        listeners.get(name)?.delete(callback);
      },
      muted: false,
      setMuted(value) {
        this.muted = value;
        for (const callback of listeners.get(value ? 'mute' : 'unmute') || []) callback();
      },
      revoke() {
        this.readyState = 'ended';
        for (const callback of listeners.get('ended') || []) callback();
      },
    };
    const stream = {
      root,
      track,
      getTracks: () => [track],
      getAudioTracks: () => [track],
      clone: () => media(),
    };
    streams.push(stream);
    return stream;
  }
  return { root: media(true), streams };
}
function fixture(t, acquire) {
  const state = {
    assistantGeneration: 0,
    assistantScope: {
      limits: { maxAudioSeconds: 30 },
      capabilities: { stt: { ready: true }, tts: { ready: true } },
    },
  };
  const current = {
    alive: true,
    session: 1,
    busy: false,
    recording: false,
    statuses: [],
    captures: [],
    barges: [],
    requests: [],
    sent: [],
  };
  const document = { hidden: false };
  let activeCapture, activeBarge;
  const stop = (media) => media?.getTracks().forEach((track) => track.stop());
  const ui = {
    valid: () => current.alive,
    get speechContext() {
      return current.speechContext;
    },
    get session() {
      return current.session;
    },
    get busy() {
      return current.busy;
    },
    get recording() {
      return current.recording;
    },
    activity(busy, recording) {
      current.busy = busy;
      current.recording = recording;
    },
    status(message) {
      current.statuses.push(message);
    },
    input: () => ({ tagName: 'TEXTAREA', value: '' }),
    async request(route) {
      current.requests.push(route);
      return route.endsWith('/transcribe') ? { text: 'На завтра' } : { audioBase64: 'synthetic' };
    },
    async sendText(text) {
      current.sent.push(text);
      current.busy = current.recording = false;
    },
  };
  const calls = [];
  const actions = {
    async startAssistantCapture(complete, error, seconds, options) {
      const capture = { complete, error, options };
      current.captures.push(capture);
      capture.media = await options.acquireMedia();
      activeCapture = capture.media;
      return true;
    },
    stopAssistantCapture() {
      stop(activeCapture);
      activeCapture = null;
    },
    async startAssistantBargeIn(complete, error, seconds, options) {
      const barge = { complete, error, options };
      current.barges.push(barge);
      barge.media = await options.acquireMedia();
      activeBarge = barge.media;
      const echo = barge.media.track.getSettings().echoCancellation;
      if (echo !== 'all' && echo !== true) {
        stop(activeBarge);
        activeBarge = null;
        return { ready: false };
      }
      return { ready: true, playbackStarted() {}, listen: () => true };
    },
    stopAssistantBargeIn() {
      stop(activeBarge);
      activeBarge = null;
    },
    stopAssistantAudio() {},
    playAssistantAudio: async () => true,
  };
  const factory = vm.runInNewContext(source + '\ncreateAssistantSpeech', {
    document,
    navigator: {
      mediaDevices: {
        getUserMedia(options) {
          calls.push(options);
          return acquire();
        },
      },
    },
  });
  const controller = factory(state, actions).assistantSpeechController(ui);
  t.after(() => controller.stopVoice());
  return {
    state,
    current,
    document,
    actions,
    controller,
    calls,
    async complete() {
      const capture = current.captures.at(-1);
      actions.stopAssistantCapture();
      await capture.complete('synthetic-wav');
    },
    async completeBarge() {
      const barge = current.barges.at(-1);
      actions.stopAssistantBargeIn();
      await barge.complete('synthetic-wav');
    },
  };
}

test('one voice session reuses one microphone across utterances and barge monitoring, then releases every track', async (t) => {
  const m = microphone(true),
    f = fixture(t, async () => m.root);
  await f.controller.startVoice();
  await f.complete();
  assert.equal(m.root.track.readyState, 'live');
  assert.equal(f.current.captures[0].media.track.readyState, 'ended');
  await f.controller.speak('На какую дату?', true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.current.barges[0].media.track.getSettings().echoCancellation, 'all');
  await f.completeBarge();
  await f.controller.capture();
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.current.captures[1].media, f.current.captures[0].media);
  assert.equal(m.root.track.readyState, 'live');
  f.controller.stopVoice();
  assert.ok(m.streams.every((media) => media.track.readyState === 'ended'));
  assert.equal(f.controller.voiceEnabled, false);
});

test('verified boolean echo cancellation keeps one microphone when the all mode is unsupported', async (t) => {
  const m = microphone(false),
    f = fixture(t, async () => m.root);
  await f.controller.startVoice();
  await f.complete();
  await f.controller.speak('Во сколько?', true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.current.barges[0].media.track.readyState, 'live');
  assert.equal(f.current.barges[0].media.track.getSettings().echoCancellation, true);
  assert.equal(f.current.barges[0].media.track.constraints.length, 0);
  assert.equal(m.root.track.readyState, 'live');
  await f.controller.capture();
  assert.equal(f.calls.length, 1);
});

test('concurrent consumers share the pending permission request and closing before permission resolves releases late media', async (t) => {
  const gate = deferred(),
    m = microphone(),
    f = fixture(t, () => gate.promise);
  const starting = f.controller.startVoice();
  const consumer = f.current.captures[0].options.acquireMedia();
  assert.equal(f.calls.length, 1);
  gate.resolve(m.root);
  const media = await consumer;
  await starting;
  assert.notEqual(media, f.current.captures[0].media);
  f.controller.stopVoice();
  assert.ok(m.streams.every((stream) => stream.track.readyState === 'ended'));

  const lateGate = deferred(),
    late = microphone(),
    g = fixture(t, () => lateGate.promise);
  const pending = g.controller.startVoice();
  g.controller.stopVoice();
  lateGate.resolve(late.root);
  await pending;
  assert.equal(g.calls.length, 1);
  assert.equal(late.root.track.readyState, 'ended');
  assert.equal(g.controller.voiceEnabled, false);
  assert.deepEqual(g.current.requests, []);
});

test('revocation ends the session without automatic reacquisition and an explicit new session gets a fresh microphone', async (t) => {
  const first = microphone(),
    second = microphone(),
    queue = [first.root, second.root];
  const f = fixture(t, async () => queue.shift());
  await f.controller.startVoice();
  first.root.track.revoke();
  assert.equal(f.controller.voiceEnabled, false);
  assert.ok(first.streams.every((media) => media.track.readyState === 'ended'));
  assert.match(f.current.statuses.at(-1), /Микрофон отключён/);
  assert.equal(f.calls.length, 1);
  await f.controller.startVoice();
  assert.equal(f.calls.length, 2);
  assert.equal(second.root.track.readyState, 'live');
  f.controller.stopVoice();
  assert.equal(second.root.track.readyState, 'ended');
});

test('a late permission result cannot outlive a hidden page or changed account generation', async (t) => {
  for (const change of ['hidden', 'generation']) {
    const gate = deferred(),
      m = microphone(),
      f = fixture(t, () => gate.promise);
    const starting = f.controller.startVoice();
    if (change === 'hidden') f.document.hidden = true;
    else f.state.assistantGeneration++;
    gate.resolve(m.root);
    await starting;
    await flush();
    assert.equal(m.root.track.readyState, 'ended');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.current.requests, []);
  }
});

test('blocked output resumes the question with the same live microphone and no repeated command', async (t) => {
  const m = microphone(),
    f = fixture(t, async () => m.root);
  await f.controller.startVoice();
  await f.complete();
  const sent = [...f.current.sent];
  f.actions.playAssistantAudio = async () => {
    throw Object.assign(Error('blocked'), {
      code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED',
    });
  };
  await f.controller.afterReply({
    text: 'На какую дату?',
    dialogue: { phase: 'date', step: 'date', prompt: 'На какую дату?', options: [] },
  });
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.controller.voicePaused, true);
  assert.equal(m.root.track.readyState, 'live');
  assert.equal(f.calls.length, 1);
  f.actions.playAssistantAudio = async () => true;
  await f.controller.startVoice();
  assert.equal(f.controller.voicePaused, false);
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.current.recording, true);
  assert.deepEqual(f.current.sent, sent);
  f.controller.stopVoice();
  assert.ok(m.streams.every((media) => media.track.readyState === 'ended'));
});

test('temporary microphone mute pauses without reacquiring; unmute and explicit continuation reuse root', async (t) => {
  const m = microphone(),
    f = fixture(t, async () => m.root);
  await f.controller.startVoice();
  m.root.track.setMuted(true);
  assert.equal(f.controller.voicePaused, true);
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(m.root.track.readyState, 'live');
  await f.controller.startVoice();
  assert.equal(f.controller.voicePaused, true);
  assert.equal(f.calls.length, 1);
  m.root.track.setMuted(false);
  await f.controller.startVoice();
  assert.equal(f.controller.voicePaused, false);
  assert.equal(f.current.recording, true);
  assert.equal(f.calls.length, 1);
});

test('manual choice while sound is paused discards old question and keeps the voice microphone', async (t) => {
  const m = microphone(),
    f = fixture(t, async () => m.root);
  await f.controller.startVoice();
  await f.complete();
  f.actions.playAssistantAudio = async () => {
    throw Object.assign(Error('output unavailable'), {
      code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
    });
  };
  await f.controller.afterReply({
    text: 'Синтетический выбор?',
    dialogue: {
      phase: 'clientChoice',
      step: 'client',
      prompt: 'Синтетический выбор?',
      options: [],
    },
  });
  assert.equal(f.controller.voicePaused, true);
  f.controller.pauseForChoice();
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.controller.voicePaused, false);
  assert.equal(m.root.track.readyState, 'live');
  f.actions.playAssistantAudio = async () => true;
  await f.controller.afterReply({
    text: 'На какую дату?',
    dialogue: { phase: 'date', step: 'date', prompt: 'На какую дату?', options: [] },
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.current.recording, true);
});

test('pausing an active clarification on silence releases every microphone track until explicit continuation', async (t) => {
  const first = microphone(),
    second = microphone();
  let requests = 0;
  const f = fixture(t, async () => (++requests === 1 ? first.root : second.root));
  f.current.speechContext = {
    dialogueId: 'owned-clarification',
    dialogueVersion: 3,
    step: 'date',
    optionCount: 0,
  };
  await f.controller.startVoice();
  assert.equal(first.root.track.readyState, 'live');
  await f.current.captures[0].error(
    Object.assign(Error('Silence'), { code: 'ASSISTANT_NO_INPUT' }),
  );
  assert.equal(f.controller.voicePaused, true);
  assert.equal(f.controller.voiceEnabled, false);
  assert.ok(first.streams.every((media) => media.track.readyState === 'ended'));
  assert.equal(requests, 1);
  assert.equal(f.current.captures.length, 1);
  assert.deepEqual(f.current.sent, []);
  await f.controller.startVoice();
  assert.equal(requests, 2);
  assert.equal(f.controller.voicePaused, false);
  assert.equal(second.root.track.readyState, 'live');
  f.controller.stopVoice();
  assert.ok(second.streams.every((media) => media.track.readyState === 'ended'));
});

test('initial PCM and pre-start legacy fallback share one granted microphone and release all clones', async (t) => {
  for (const fallback of [false, true]) {
    const m = microphone(),
      f = fixture(t, async () => m.root);
    f.actions.assistantAudioFormat = () => 'pcm';
    const start = f.actions.startAssistantBargeIn;
    f.actions.startAssistantBargeIn = async (...args) => {
      const ready = await start(...args);
      assert.equal(args[3].initialCapture, true);
      if (!fallback) return ready;
      f.actions.stopAssistantBargeIn();
      return { ready: false, fallbackAllowed: true };
    };
    await f.controller.startVoice();
    assert.equal(f.calls.length, 1);
    assert.equal(f.current.captures.length, fallback ? 1 : 0);
    assert.equal(m.root.track.readyState, 'live');
    f.controller.stopVoice();
    assert.ok(m.streams.every((stream) => stream.track.readyState === 'ended'));
  }
});
