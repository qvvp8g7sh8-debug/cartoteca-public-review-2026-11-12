const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const moduleSource = fs.readFileSync(
  process.env.ASSISTANT_PCM_PLAYBACK_SOURCE ||
    path.join(__dirname, '../src/client/modules/assistant-playback.js'),
  'utf8',
);
const workletSource = fs.readFileSync(
  process.env.ASSISTANT_PCM_WORKLET_SOURCE ||
    path.join(__dirname, '../src/client/worklets/assistant-playback-worklet.js'),
  'utf8',
);
const flush = async (count = 30) => {
  for (let i = 0; i < count; i++) await Promise.resolve();
};
const parameter = (value = 0) => ({
  value,
  events: [],
  setValueAtTime(next, at) {
    this.events.push(['set', next, at]);
  },
  linearRampToValueAtTime(next, at) {
    this.events.push(['ramp', next, at]);
  },
});
const microphone = (kind = 'audio', readyState = 'live') => ({
  getAudioTracks: () => [{ kind, readyState }],
});
const pcm = (count, value = 16384) => {
  const bytes = new Uint8Array(count * 2),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) view.setInt16(i * 2, value, true);
  return bytes;
};
const reply = (letter = 'a') => ({
  streamUrl:
    '/api/assistant/speak-audio?ticket=' +
    letter.repeat(43) +
    '&accountContext=owner&organizationContext=org',
  mimeType: 'audio/pcm',
  sampleRate: 24000,
  channels: 1,
  sampleFormat: 's16le',
  playbackRate: 1,
});
function response(chunks, change = {}) {
  let index = 0,
    reads = 0,
    cancelled = 0;
  const headers = {
    'content-type': 'audio/pcm',
    'x-audio-sample-rate': '24000',
    'x-audio-channels': '1',
    'x-audio-sample-format': 's16le',
    ...change.headers,
  };
  return {
    ok: true,
    ...change,
    headers: { get: (name) => headers[name] ?? null },
    body: {
      getReader: () => ({
        async read() {
          reads++;
          return index < chunks.length ? { value: chunks[index++], done: false } : { done: true };
        },
        async cancel() {
          cancelled++;
        },
      }),
    },
    reads: () => reads,
    cancelled: () => cancelled,
  };
}
function fixture(t, opts = {}) {
  const state = {
      assistantGeneration: 1,
      assistantBundleId: 'a'.repeat(64),
      account: { id: 'owner', organizationId: 'org', role: 'owner' },
    },
    activation = { isActive: false },
    contexts = [],
    elements = [],
    nodes = [],
    fetches = [],
    redirects = [],
    document = {
      hidden: false,
      querySelector: () => ({ content: opts.buildVersion ?? '0123456789abcdef' }),
      body: {
        appendChild: (media) => {
          media.attached = true;
        },
      },
    };
  let answer = response([pcm(1024)]),
    moduleResolve;
  class BaseNode {
    constructor() {
      this.connections = [];
    }
    connect(target) {
      this.connections.push(target);
      return target;
    }
    disconnect() {
      this.connections.length = 0;
    }
  }
  class Context {
    constructor() {
      contexts.push(this);
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.oscillators = [];
      this.gains = [];
      this.audioWorklet = {
        addModule: (url) => {
          this.moduleUrl = url;
          if (url !== '/assistant-playback-worklet.js?v=0123456789abcdef')
            return Promise.reject(Error('Synthetic stale build409'));
          return opts.delayedModule
            ? new Promise((resolve) => {
                moduleResolve = resolve;
              })
            : Promise.resolve();
        },
      };
    }
    resume() {
      this.resumeActivation = activation.isActive;
      this.state = 'running';
      return Promise.resolve();
    }
    async close() {
      this.closed = true;
      this.state = 'closed';
    }
    createMediaStreamDestination() {
      const node = new BaseNode();
      node.stream = { output: this };
      this.destination = node;
      return node;
    }
    createGain() {
      const node = new BaseNode();
      node.gain = parameter(1);
      this.gains.push(node);
      return node;
    }
    createOscillator() {
      const node = new BaseNode();
      node.frequency = parameter();
      node.type = 'sine';
      node.stops = [];
      node.start = () => {
        node.started = true;
      };
      node.stop = (at) => {
        node.stops.push(at);
        if (at !== undefined && !opts.delayedCue) queueMicrotask(() => node.onended?.());
      };
      this.oscillators.push(node);
      return node;
    }
  }
  class Audio {
    constructor() {
      elements.push(this);
      this.paused = true;
      this.plays = [];
    }
    setAttribute() {}
    play() {
      this.plays.push(activation.isActive);
      if (activation.isActive) this.allowed = true;
      if (!this.allowed || opts.blockAudio || (opts.waitForMic && !this.micReady))
        return Promise.reject(Object.assign(Error('gesture'), { name: 'NotAllowedError' }));
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    remove() {
      this.attached = false;
    }
  }
  class WorkletNode extends BaseNode {
    constructor(context) {
      super();
      nodes.push(this);
      this.context = context;
      this.messages = [];
      const client = this;
      this.port = {
        onmessage: null,
        close() {
          client.closed = true;
        },
        postMessage(data) {
          client.messages.push(data);
          queueMicrotask(() => client.processor.port.onmessage?.({ data }));
        },
      };
      class Processor {
        constructor() {
          this.port = {
            onmessage: null,
            postMessage(data) {
              queueMicrotask(() => client.port.onmessage?.({ data }));
            },
          };
        }
      }
      let Implementation;
      vm.runInNewContext(workletSource, {
        AudioWorkletProcessor: Processor,
        sampleRate: context.sampleRate,
        Float32Array,
        Int16Array,
        Number,
        registerProcessor(name, value) {
          assert.equal(name, 'assistant-playback');
          Implementation = value;
        },
      });
      this.processor = new Implementation();
    }
    tick(count = 1) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const frame = new Float32Array(128);
        this.processor.process([], [[frame]]);
        this.context.currentTime += 128 / this.context.sampleRate;
        out.push(...frame);
      }
      return out;
    }
  }
  const window = {
    TextDecoder,
    AudioContext: Context,
    AudioWorkletNode: WorkletNode,
    Audio,
    Uint8Array,
    Int16Array,
    DataView,
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return typeof answer === 'function' ? answer() : answer;
    },
  };
  const api = vm
    .runInNewContext(moduleSource + '\ncreateAssistantPlayback', {
      window,
      navigator: { userActivation: activation },
      document,
      location: { replace: (target) => redirects.push(target) },
      AbortController,
      setTimeout,
      clearTimeout,
      encodeURIComponent,
      console,
    })(state, {})
    .assistantPlayback();
  t.after(() => api.release());
  return {
    api,
    state,
    activation,
    document,
    contexts,
    elements,
    nodes,
    fetches,
    redirects,
    window,
    setResponse: (value) => {
      answer = value;
    },
    resolveModule: () => moduleResolve(),
    async gesture() {
      activation.isActive = true;
      const promise = api.unlock();
      activation.isActive = false;
      return promise;
    },
    async drain(frames = 300) {
      for (let i = 0; i < frames; i++) {
        nodes[0]?.tick();
        await flush(3);
      }
    },
  };
}
test('PCM output has no idle resources; its real context and stream element start inside the gesture', async (t) => {
  const f = fixture(t);
  assert.equal(f.api.supported(), true);
  assert.equal(await f.api.unlock(), false);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.fetches.length, 0);
  assert.equal(await f.gesture(), true);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].resumeActivation, true);
  assert.equal(f.elements[0].plays[0], true);
  assert.equal(f.elements[0].srcObject, f.contexts[0].destination.stream);
  assert.equal(f.contexts[0].moduleUrl, '/assistant-playback-worklet.js?v=0123456789abcdef');
  assert.notEqual(f.state.assistantBundleId, '0123456789abcdef');
  assert.equal(f.elements[0].src, undefined);
  assert.equal(f.fetches.length, 0);
});
test('ready cue uses the same output context and permanent stream as later PCM replies', async (t) => {
  const f = fixture(t);
  await f.gesture();
  assert.equal(await f.api.cue({ initialCommand: true }), true);
  assert.equal(f.contexts.length, 1);
  const tone = f.contexts[0].oscillators[0];
  const gain = f.contexts[0].gains[1].gain;
  assert.equal(tone.started, true);
  assert.equal(tone.type, 'sine');
  assert.equal(tone.frequency.value, 523.25);
  assert.deepEqual(tone.frequency.events, [['set', 659.25, 0.12 * 0.45]]);
  assert.equal(gain.value, 0.075);
  assert.deepEqual(gain.events, [
    ['set', 0, 0],
    ['ramp', 0.075, 0.018],
    ['ramp', 0, 0.12 * 0.45],
    ['ramp', 0.06, 0.12 * 0.56],
    ['ramp', 0, 0.12],
  ]);
  assert.equal(tone.stops[0], 0.12);
  assert.equal(f.elements.length, 1);
  assert.equal(f.fetches.length, 0);
});

test('delayed startup accepts only a live audio capture and still respects the browser playback refusal', async (t) => {
  const f = fixture(t);
  for (const capture of [
    null,
    {},
    { getAudioTracks: () => null },
    {
      getAudioTracks: () => {
        throw Error('Synthetic invalid capture');
      },
    },
    { getAudioTracks: () => [] },
    microphone('video'),
    microphone('audio', 'ended'),
  ]) {
    assert.equal(await f.api.unlock(capture), false);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.elements.length, 0);
  }
  assert.equal(await f.api.unlock(microphone()), true);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.contexts[0].resumeActivation, false);
  assert.ok(f.elements[0].plays.every((active) => active === false));
  assert.equal(f.nodes.length, 1);
  await assert.rejects(f.api.cue({ initialCommand: true }), {
    code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED',
  });
  assert.equal(
    f.contexts[0].oscillators.length,
    0,
    'a live microphone is not proof of audible output',
  );
  assert.equal(f.fetches.length, 0);
});

test('PCM continuation and short-answer cues retain their shorter speech-safe durations', async (t) => {
  const f = fixture(t);
  await f.gesture();
  for (const [options, initial, duration] of [
    [{}, false, 0.14],
    [{ initialCommand: true, shortAnswer: true }, false, 0.06],
    [{ startCue: true, shortAnswer: true }, true, 0.06],
  ]) {
    assert.equal(await f.api.cue(options), true);
    const tone = f.contexts[0].oscillators.at(-1);
    const gain = f.contexts[0].gains.at(-1).gain;
    assert.equal(tone.frequency.value, initial ? 523.25 : 880);
    assert.equal(gain.value, initial ? 0.075 : 0.08);
    assert.equal(tone.stops[0], duration);
    assert.deepEqual(tone.frequency.events, initial ? [['set', 659.25, duration * 0.45]] : []);
    assert.equal(f.fetches.length, 0);
  }
});

test('a hidden page cannot allocate a PCM session even with live microphone permission', async (t) => {
  const f = fixture(t);
  f.document.hidden = true;
  assert.equal(await f.api.unlock(microphone()), false);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.elements.length, 0);
  assert.equal(f.nodes.length, 0);
  assert.equal(f.fetches.length, 0);
});

test('a microphone-started worklet cannot reappear after release during asynchronous loading', async (t) => {
  const f = fixture(t, { delayedModule: true });
  const opening = f.api.unlock(microphone());
  assert.equal(f.contexts.length, 1);
  f.api.release();
  f.resolveModule();
  assert.equal(await opening, false);
  await flush();
  assert.equal(f.nodes.length, 0);
  assert.equal(f.contexts[0].closed, true);
  assert.equal(f.elements[0].attached, false);
  assert.equal(f.fetches.length, 0);
});
test('PCM one-use ticket is fetched once; started and complete are driven by the actual worklet', async (t) => {
  const f = fixture(t);
  await f.gesture();
  let started = 0;
  const prepared = f.api.prepare({ ...reply(), onStarted: () => started++ });
  await flush();
  assert.equal(f.fetches.length, 1);
  assert.equal(started, 0);
  assert.equal(f.api.playing(), false);
  const done = prepared.play();
  await flush();
  const output = f.nodes[0].tick(2);
  await flush();
  assert.equal(started, 1);
  assert.equal(output[0], 0.5);
  assert.equal(f.api.playing(), true);
  await f.drain(30);
  assert.equal(await done, true);
  assert.equal(f.api.playing(), false);
  assert.equal(f.fetches.length, 1);
  const diagnostic = f.api.diagnostics();
  assert.equal(diagnostic.requests, 1);
  assert.equal(diagnostic.starts, 1);
  assert.equal(diagnostic.completed, 1);
  assert.equal(diagnostic.cancelled, 0);
  assert.ok(Number.isSafeInteger(diagnostic.startupWaitMs));
  assert.ok(Number.isSafeInteger(diagnostic.firstChunkWaitMs));
  assert.equal(f.fetches[0].options.credentials, 'same-origin');
  assert.equal(f.fetches[0].options.redirect, 'error');
  assert.equal(f.fetches[0].options.headers['X-Cartoteca-Account-Id'], 'owner');
  assert.equal(f.fetches[0].options.headers['X-Cartoteca-Organization-Id'], 'org');
  assert.equal(f.elements[0].srcObject, f.contexts[0].destination.stream);
});
test('only the active PCM stream can attach starvation counters to its turn', async (t) => {
  const f = fixture(t),
    events = [];
  await f.gesture();
  const prepared = f.api.prepare({
    ...reply(),
    onTiming: (event, value) => events.push([event, value]),
  });
  await flush();
  const processor = f.nodes[0].processor;
  processor.port.postMessage({ type: 'diagnostic', id: processor.id - 1, event: 'underrun' });
  processor.port.postMessage({ type: 'diagnostic', id: processor.id, event: 'underrun' });
  processor.port.postMessage({ type: 'diagnostic', id: processor.id, event: 'refill', waitMs: 75 });
  processor.port.postMessage({
    type: 'diagnostic',
    id: processor.id,
    event: 'refill',
    waitMs: Infinity,
  });
  await flush();
  assert.deepEqual(
    events.filter(([event]) => event.startsWith('audio')),
    [
      ['audioUnderrun', undefined],
      ['audioRefill', 75],
    ],
  );
  prepared.cancel();
  processor.port.postMessage({ type: 'diagnostic', id: processor.id, event: 'underrun' });
  await flush();
  assert.equal(events.filter(([event]) => event === 'audioUnderrun').length, 1);
});

test('PCM context rejection releases output and never refetches or resumes its one-use ticket', async (t) => {
  const f = fixture(t);
  await f.gesture();
  f.setResponse(response([], { ok: false, status: 428 }));
  const prepared = f.api.prepare(reply());
  const rejected = assert.rejects(prepared.play(), {
    status: 428,
    code: 'AUTH_CONTEXT_CHANGED',
    outcomeUnknown: false,
  });
  await flush();
  await rejected;
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].options.signal.aborted, true);
  assert.deepEqual(f.redirects, ['/']);
  assert.equal(f.contexts[0].closed, true);
  assert.equal(await f.gesture(), false);
  assert.throws(() => f.api.prepare(reply('b')), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.equal(f.fetches.length, 1);
});

test('a delayed PCM context rejection from an old actor cannot reload the new actor', async (t) => {
  const f = fixture(t);
  await f.gesture();
  let resolve;
  f.setResponse(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const prepared = f.api.prepare(reply());
  await flush();
  assert.equal(f.fetches.length, 1);
  f.state.account = { id: 'new-owner', organizationId: 'new-org', role: 'owner' };
  f.api.release();
  resolve(response([], { ok: false, status: 428 }));
  await flush();
  assert.equal(await prepared.play(), false);
  assert.deepEqual(f.redirects, []);
  assert.equal(f.fetches.length, 1);
});
test('multiple replies reuse one output graph without an extra browser audio element or silent WAV', async (t) => {
  const f = fixture(t);
  await f.gesture();
  for (const letter of ['a', 'b', 'c']) {
    f.setResponse(response([pcm(512)]));
    const done = f.api.play(reply(letter));
    await flush();
    await f.drain(20);
    assert.equal(await done, true);
  }
  assert.equal(f.contexts.length, 1);
  assert.equal(f.elements.length, 1);
  assert.equal(f.nodes.length, 1);
  assert.equal(f.fetches.length, 3);
  assert.equal(f.elements[0].src, undefined);
});
test('bounded two-second queue applies backpressure before playback and drains without losing long replies', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const input = response([pcm(30000), pcm(30000), pcm(30000)]);
  f.setResponse(input);
  const prepared = f.api.prepare(reply());
  await flush(100);
  assert.ok(f.nodes[0].processor.length > 0);
  assert.ok(f.nodes[0].processor.length <= 48000);
  assert.ok(input.reads() < 4);
  assert.equal(f.api.playing(), false);
  const done = prepared.play();
  await flush();
  for (let i = 0; i < 1600; i++) {
    f.nodes[0].tick();
    assert.ok(f.nodes[0].processor.length <= 48000);
    await flush(3);
  }
  assert.equal(await done, true);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.nodes[0].processor.samples.length, 48000);
});
test('pause is acknowledged by the worklet; false interruption can resume the same queued speech', async (t) => {
  const f = fixture(t);
  await f.gesture();
  f.setResponse(response([pcm(4096)]));
  const done = f.api.play(reply());
  await flush();
  f.nodes[0].tick();
  await flush();
  assert.equal(f.api.playing(), true);
  const paused = f.api.pause();
  await flush();
  assert.equal(await paused, true);
  assert.equal(f.nodes[0].tick(2).some(Boolean), false);
  assert.equal(f.api.playing(), true);
  assert.equal(f.api.resume(), true);
  await flush();
  assert.equal(f.nodes[0].tick().some(Boolean), true);
  f.api.stop();
  assert.equal(await done, false);
  await flush();
  assert.equal(f.nodes[0].processor.length, 0);
  assert.equal(f.fetches[0].options.signal.aborted, true);
  assert.equal(f.contexts[0].closed, undefined);
});
test('stop aborts a pending ticket and stale completion cannot replace the next reply', async (t) => {
  const f = fixture(t);
  await f.gesture();
  let complete;
  f.setResponse(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const old = f.api.play(reply('a'));
  await flush();
  f.api.stop();
  assert.equal(await old, false);
  assert.equal(f.fetches[0].options.signal.aborted, true);
  f.setResponse(response([pcm(1024)]));
  const next = f.api.play(reply('b'));
  complete(response([pcm(2048)]));
  await flush();
  await f.drain(40);
  assert.equal(await next, true);
  assert.equal(f.fetches.length, 2);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.api.diagnostics().cancelled, 1);
  assert.equal(f.api.diagnostics().completed, 1);
  assert.equal(f.api.diagnostics().requests, 2);
});
test('PCM metadata, empty/odd EOF and byte overflow fail before reporting completed playback', async (t) => {
  const f = fixture(t);
  await f.gesture();
  for (const bad of [
    response([], {}),
    response([new Uint8Array([1])]),
    response([new Uint8Array(4 * 1024 * 1024 + 1)]),
    response([pcm(8)], { headers: { 'content-type': 'audio/mpeg' } }),
    response([pcm(8)], { headers: { 'x-audio-sample-rate': '48000' } }),
    response([pcm(8)], { headers: { 'x-audio-channels': '2' } }),
    response([pcm(8)], { headers: { 'x-audio-sample-format': 'f32le' } }),
  ]) {
    f.setResponse(bad);
    await assert.rejects(f.api.play(reply()), { code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE' });
  }
  for (const delta of [
    { mimeType: 'audio/mpeg' },
    { sampleRate: 48000 },
    { channels: 2 },
    { sampleFormat: 'float32' },
    { playbackRate: 1.4 },
    { streamUrl: 'https://other.invalid/audio' },
    { streamUrl: [reply().streamUrl] },
    { audioBase64: 'AAAA' },
  ])
    assert.throws(() => f.api.prepare({ ...reply(), ...delta }), {
      code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
    });
  assert.equal(f.api.playing(), false);
});
test('playback block preserves session resources for manual recovery instead of closing the microphone owner', async (t) => {
  const f = fixture(t, { blockAudio: true });
  assert.equal(await f.gesture(), true);
  await assert.rejects(f.api.cue(), { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' });
  assert.equal(f.contexts[0].closed, undefined);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.api.playing(), false);
});
test('account scope change cannot inherit the previous audio session and release cleans every output resource', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const old = f.contexts[0],
    media = f.elements[0];
  f.state.account = { id: 'other', organizationId: 'other-org', role: 'owner' };
  assert.throws(() => f.api.prepare(reply()), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.equal(await f.gesture(), true);
  assert.equal(old.closed, true);
  assert.equal(media.srcObject, null);
  assert.equal(media.attached, false);
  assert.equal(f.contexts.length, 2);
  f.api.release();
  assert.equal(f.contexts[1].closed, true);
  assert.equal(f.elements[1].srcObject, null);
});
test('closing during asynchronous worklet loading does not create a late output node', async (t) => {
  const f = fixture(t, { delayedModule: true });
  const opening = f.gesture();
  f.api.release();
  f.resolveModule();
  assert.equal(await opening, false);
  await flush();
  assert.equal(f.nodes.length, 0);
  assert.equal(f.contexts[0].closed, true);
  assert.equal(f.elements[0].attached, false);
});

test('PCM URLs retain their issuing actor and reject altered, duplicated or unbound query context before fetching', async (t) => {
  const f = fixture(t);
  await f.gesture();
  for (const streamUrl of [
    reply().streamUrl.replace('accountContext=owner', 'accountContext=other'),
    reply().streamUrl.replace('organizationContext=org', 'organizationContext=other'),
  ])
    assert.throws(() => f.api.prepare({ ...reply(), streamUrl }), { code: 'AUTH_CONTEXT_CHANGED' });
  for (const streamUrl of [
    reply().streamUrl.replace('&accountContext=owner', ''),
    reply().streamUrl + '&accountContext=owner',
    reply().streamUrl + '&organizationContext=org',
    reply().streamUrl + '&extra=1',
    reply().streamUrl + '#fragment',
  ])
    assert.throws(() => f.api.prepare({ ...reply(), streamUrl }), {
      code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE',
    });
  assert.equal(f.fetches.length, 0);
});
test('unsupported platforms do not allocate output resources or claim PCM capability', (t) => {
  const f = fixture(t);
  f.window.AudioWorkletNode = undefined;
  assert.equal(f.api.supported(), false);
  assert.equal(f.contexts.length, 0);
  assert.equal(f.elements.length, 0);
  assert.equal(f.fetches.length, 0);
});

test('an early play rejection does not prevent post-microphone startup on the same real graph', async (t) => {
  const f = fixture(t, { waitForMic: true });
  assert.equal(await f.gesture(), true);
  assert.equal(f.nodes.length, 1);
  assert.ok(
    f.nodes[0].messages.some(
      (row) => row.type === 'buffer' && row.id === 0 && row.samples.length === 2400,
    ),
  );
  await assert.rejects(f.api.cue(), { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' });
  f.elements[0].micReady = true;
  assert.equal(await f.api.cue({ initialCommand: true }), true);
  const done = f.api.play(reply());
  await flush();
  await f.drain(40);
  assert.equal(await done, true);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.elements.length, 1);
  assert.equal(f.nodes.length, 1);
});
test('output interruption, unexpected pause and worklet error abort only current playback promptly', async (t) => {
  for (const kind of ['interrupted', 'pause', 'processor']) {
    const f = fixture(t);
    await f.gesture();
    const done = f.api.play(reply());
    await flush();
    f.nodes[0].tick();
    await flush();
    assert.equal(f.api.playing(), true);
    if (kind === 'interrupted') {
      f.contexts[0].state = 'interrupted';
      f.contexts[0].onstatechange();
    } else if (kind === 'pause') {
      f.elements[0].paused = true;
      f.elements[0].onpause();
    } else f.nodes[0].onprocessorerror();
    await assert.rejects(done, {
      code:
        kind === 'processor'
          ? 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE'
          : 'ASSISTANT_AUDIO_GESTURE_REQUIRED',
    });
    assert.equal(f.fetches[0].options.signal.aborted, true);
    assert.equal(f.contexts[0].closed, undefined);
    assert.equal(f.api.playing(), false);
    f.api.release();
    assert.equal(f.contexts[0].onstatechange, null);
    assert.equal(f.nodes[0].onprocessorerror, null);
    assert.equal(f.elements[0].onpause, null);
  }
});
test('PCM reader joins odd network chunks without changing signed samples or consuming another ticket', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const bytes = pcm(24, -16384);
  f.setResponse(response([bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)]));
  const done = f.api.play(reply());
  await flush();
  const values = f.nodes[0].tick();
  await flush();
  assert.equal(values[0], -0.5);
  await f.drain(8);
  assert.equal(await done, true);
  assert.equal(f.fetches.length, 1);
});

test('PCM timing separates fetch, first bytes and real worklet render acknowledgement; observer failure is harmless', async (t) => {
  const f = fixture(t);
  await f.gesture();
  f.setResponse(response([pcm(24)], { headers: { 'Server-Timing': 'ct_request;dur=12' } }));
  const observed = [];
  const done = f.api.play({
    ...reply(),
    onTiming: (event, value) => {
      observed.push([event, value]);
      if (event === 'pcmFirstByte') throw Error('optional observer failed');
    },
  });
  await flush();
  assert.deepEqual(
    observed.map(([event]) => event),
    ['pcmFetchStart', 'pcmHeaders', 'pcmServer', 'pcmFirstByte'],
  );
  assert.equal(observed[2][1], 'ct_request;dur=12');
  f.nodes[0].tick();
  await flush();
  assert.ok(observed.some(([event]) => event === 'pcmRenderStart'));
  assert.equal(observed.at(-1)[0], 'pcmRenderEnd');
  assert.equal(
    observed.some(([event]) => event === 'pcmDrainEnd'),
    false,
  );
  await f.drain(8);
  assert.equal(await done, true);
  assert.equal(observed.filter(([event]) => event === 'pcmRenderStart').length, 1);
  assert.equal(observed.at(-1)[0], 'pcmDrainEnd');
});

test('an interrupted ready cue rejects immediately and cannot falsely arm voice capture', async (t) => {
  const f = fixture(t, { delayedCue: true });
  await f.gesture();
  const cue = f.api.cue({ initialCommand: true });
  await flush();
  assert.equal(f.contexts[0].oscillators.length, 1);
  f.contexts[0].state = 'interrupted';
  f.contexts[0].onstatechange();
  await assert.rejects(cue, { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' });
  assert.equal(f.contexts[0].closed, undefined);
  assert.equal(f.fetches.length, 0);
  assert.equal(f.contexts[0].oscillators[0].connections.length, 0);
});

test('worklet uses the current HTTP build marker and fails closed for absent or stale assets', async (t) => {
  for (const buildVersion of ['', 'a'.repeat(64), 'wrong']) {
    const f = fixture(t, { buildVersion });
    assert.equal(await f.gesture(), false);
    await assert.rejects(f.api.cue(), { code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE' });
    assert.equal(f.contexts.length, 0);
    assert.equal(f.fetches.length, 0);
  }
  const stale = fixture(t, { buildVersion: '0000000000000000' });
  assert.equal(await stale.gesture(), false);
  await assert.rejects(stale.api.cue(), { code: 'ASSISTANT_AUDIO_OUTPUT_UNAVAILABLE' });
  assert.equal(stale.nodes.length, 0);
  assert.equal(stale.fetches.length, 0);
});

// Prepared for the separately authorized verification stage; no live provider involved.
const directReply = () => {
  const value = reply();
  delete value.streamUrl;
  return {
    ...value,
    text: 'На какую дату?',
    policyVersion: 7,
    streamRequest: {
      text: 'На какую дату?',
      policyVersion: 7,
      format: 'pcm',
      taskRequestId: 'synthetic-task',
      speechToken: 'p'.repeat(43),
    },
  };
};
const enableDirect = (f) => {
  f.state.assistantScope = {
    policyVersion: 7,
    capabilities: { tts: { directPcm: true } },
    limits: { requestTimeoutMs: 20000 },
  };
};
test('direct PCM sends one protected POST, confirms policy and preserves render output', async (t) => {
  const f = fixture(t);
  enableDirect(f);
  await f.gesture();
  f.setResponse(response([pcm(24)], { headers: { 'x-assistant-policy-version': '7' } }));
  const events = [];
  const done = f.api.play({ ...directReply(), onTiming: (event) => events.push(event) });
  await flush();
  assert.equal(f.fetches.length, 1);
  const { url, options } = f.fetches[0];
  assert.equal(url, '/api/assistant/speak-audio');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['X-Cartoteca-Request'], '1');
  assert.equal(options.headers['X-Cartoteca-Account-Id'], 'owner');
  assert.equal(options.headers['X-Cartoteca-Organization-Id'], 'org');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), directReply().streamRequest);
  assert.ok(events.indexOf('speakStart') < events.indexOf('speakSucceeded'));
  assert.ok(events.includes('pcmFirstByte'));
  await f.drain(8);
  assert.equal(await done, true);
  assert.equal(f.fetches.length, 1);
});
test('direct PCM rejects mixed, unadvertised and stale descriptors before outbound', async (t) => {
  const f = fixture(t);
  await f.gesture();
  assert.throws(() => f.api.prepare(directReply()));
  enableDirect(f);
  assert.throws(() => f.api.prepare({ ...directReply(), streamUrl: reply().streamUrl }));
  assert.throws(() => f.api.prepare({ ...directReply(), policyVersion: 8 }));
  assert.throws(() =>
    f.api.prepare({
      ...directReply(),
      streamRequest: { ...directReply().streamRequest, url: '/other' },
    }),
  );
  assert.equal(f.fetches.length, 0);
});
test('direct PCM refuses changed policy and authorization without synthesis retry', async (t) => {
  for (const change of [
    { headers: { 'x-assistant-policy-version': '8' } },
    { ok: false, status: 403 },
  ]) {
    const f = fixture(t);
    enableDirect(f);
    await f.gesture();
    f.setResponse(response([pcm(24)], change));
    const refused = [],
      events = [];
    await assert.rejects(
      f.api.play({
        ...directReply(),
        onRefused: (status) => refused.push(status),
        onTiming: (event) => events.push(event),
      }),
    );
    assert.equal(f.fetches.length, 1);
    assert.equal(refused[0], change.status || 409);
    assert.equal(events.includes('speakSucceeded'), false);
    assert.equal(events.includes('pcmFirstByte'), false);
  }
});
test('stopping direct PCM aborts its single transport without ticket fallback', async (t) => {
  const f = fixture(t);
  enableDirect(f);
  await f.gesture();
  f.setResponse(() => new Promise(() => {}));
  const done = f.api.play(directReply());
  await flush();
  assert.equal(f.fetches.length, 1);
  f.api.stop();
  assert.equal(await done, false);
  assert.equal(f.fetches[0].options.signal.aborted, true);
  assert.equal(f.fetches.length, 1);
});

test('direct PCM preserves the exact speech-proof refusal without accepting arbitrary error codes', async (t) => {
  for (const code of ['ASSISTANT_SPEECH_PROOF_REQUIRED', 'UNTRUSTED_INTERNAL_CODE']) {
    const f = fixture(t);
    enableDirect(f);
    await f.gesture();
    f.setResponse(
      response([new TextEncoder().encode(JSON.stringify({ error: 'Synthetic refusal', code }))], {
        ok: false,
        status: 403,
      }),
    );
    const refused = [];
    let started = false;
    await assert.rejects(
      f.api.play({
        ...directReply(),
        onRefused: (...args) => refused.push(args),
        onStarted: () => {
          started = true;
        },
      }),
      {
        status: 403,
        code: code === 'ASSISTANT_SPEECH_PROOF_REQUIRED' ? code : 'ASSISTANT_SPEECH_REQUEST_FAILED',
      },
    );
    assert.equal(refused[0][0], 403);
    assert.equal(
      refused[0][1],
      code === 'ASSISTANT_SPEECH_PROOF_REQUIRED' ? code : 'ASSISTANT_SPEECH_REQUEST_FAILED',
    );
    assert.equal(f.fetches.length, 1);
    assert.equal(started, false);
  }
});

test('final PCM keeps its sink alive beyond render EOS before terminal caller release', async (t) => {
  const f = fixture(t);
  await f.gesture();
  f.setResponse(response([pcm(24)]));
  let completed = false,
    tailDelivered = false;
  const events = [];
  const done = f.api.play({ ...reply(), onTiming: (event) => events.push(event) }).then((value) => {
    completed = true;
    f.api.release(); // same terminal lifecycle as stopVoice/openResult.
    return value;
  });
  await flush();
  f.nodes[0].tick(2);
  await flush();
  assert.equal(completed, false, 'render-empty must not close the downstream route');
  const sink = new Promise((resolve) =>
    setTimeout(() => {
      tailDelivered =
        !f.contexts[0].closed && f.elements[0].srcObject != null && !f.elements[0].paused;
      resolve();
    }, 80),
  );
  await sink;
  assert.equal(tailDelivered, true, 'synthetic delayed sink receives its tail');
  assert.equal(await done, true);
  assert.ok(events.includes('pcmRenderEnd'));
  assert.ok(events.includes('pcmDrainEnd'));
  assert.equal(f.contexts[0].closed, true);
});

test('EOF drain is cancelled immediately and never completes a later PCM owner', async (t) => {
  const f = fixture(t);
  await f.gesture();
  f.setResponse(response([pcm(24)]));
  const events = [];
  const first = f.api.play({ ...reply(), onTiming: (event) => events.push(event) });
  await flush();
  f.nodes[0].tick(2);
  await flush();
  f.api.stop();
  assert.equal(await first, false);
  f.setResponse(response([pcm(24)]));
  const next = f.api.play({ ...reply('b'), drainOnEnd: false });
  await flush();
  await f.drain(8);
  assert.equal(await next, true, 'nonfinal chunk does not insert a drain pause');
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(
    events.includes('pcmDrainEnd'),
    false,
    'cancelled timer cannot report normal completion',
  );
});

async function trainRealCarry(f, voiceOwner) {
  let release;
  let read = 0;
  const base = response([]);
  f.setResponse({
    ...base,
    body: {
      getReader: () => ({
        read: async () => {
          if (read++ === 0) return { value: pcm(2880), done: false };
          if (read === 2)
            return new Promise((resolve) => {
              release = resolve;
            });
          return { done: true };
        },
        cancel: async () => {},
      }),
    },
  });
  const done = f.api.play({ ...reply(), voiceOwner, drainOnEnd: false });
  await flush(80);
  // First voice may wait up to180ms before consuming its120ms reserve.
  // Render beyond both so training still observes a real missing block.
  f.nodes[0].tick(125);
  await flush();
  assert.equal(f.nodes[0].processor.bufferTarget, 7200);
  release({ value: pcm(7200), done: false });
  await flush(80);
  await f.drain(250);
  assert.equal(await done, true);
}

test('one finalized voice playback yields one bounded numeric summary, not session totals', async (t) => {
  const f = fixture(t),
    voiceOwner = { epoch: 1, session: 2, generation: 1 };
  await f.gesture();
  f.setResponse(response([pcm(2400)]));
  const done = f.api.play({ ...reply(), voiceOwner, drainOnEnd: false });
  await flush(80);
  f.api.recordDiagnostic('bargePause');
  f.api.recordDiagnostic('bargeFalsePause');
  f.elements[0].onwaiting();
  f.elements[0].onstalled();
  await f.drain(250);
  assert.equal(await done, true);
  const values = f.api.takeSummary();
  assert.equal(values.length, 24);
  assert.ok(values.every((value) => Number.isSafeInteger(value) && value >= 0));
  assert.equal(values[0], 2);
  assert.equal(values[1], 0);
  assert.equal(values[2], 1);
  assert.equal(values[3], 0);
  assert.equal(values[6], 1);
  assert.equal(values[7], 1);
  assert.equal(values[18], 1);
  assert.equal(values[19], 1);
  assert.equal(f.api.takeSummary(), null);
  f.setResponse(response([pcm(2400)]));
  const next = f.api.play({ ...reply('b'), voiceOwner, drainOnEnd: false });
  await flush(80);
  await f.drain(250);
  assert.equal(await next, true);
  const later = f.api.takeSummary();
  assert.equal(later[2], 0, 'successful first output spends only this voice owner cold stage');
  assert.equal(later[6], 0, 'prior pause is not exported cumulatively');
  assert.equal(later[18], 0, 'prior native media event is not exported cumulatively');
});

test(
  'native context interruption is numeric and pending playback is discarded after actor reset',
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      voiceOwner = { epoch: 1, session: 2, generation: 1 };
    await f.gesture();
    f.setResponse(response([pcm(2880)]));
    const done = f.api.play({ ...reply(), voiceOwner, drainOnEnd: false });
    const refused = assert.rejects(done);
    await flush(80);
    f.contexts[0].state = 'interrupted';
    f.contexts[0].onstatechange();
    await refused;
    const values = f.api.takeSummary();
    assert.equal(values[1], 2);
    assert.equal(values[17], 1);
    f.api.release();
    await f.gesture();
    f.setResponse(response([pcm(2400)]));
    const next = f.api.play({ ...reply('b'), voiceOwner, drainOnEnd: false });
    await flush(80);
    f.nodes.at(-1).tick(100);
    await flush(80);
    assert.equal(await next, true);
    f.state.assistantGeneration++;
    assert.equal(f.api.takeSummary(), null);
  },
);

test('later speech chunks cannot overwrite an unsent first-voice snapshot', async (t) => {
  const f = fixture(t),
    voiceOwner = { epoch: 1, session: 2, generation: 1 };
  await f.gesture();
  for (const chunk of [0, 1]) {
    f.setResponse(response([pcm(2400)]));
    const done = f.api.play({ ...reply(chunk === 0 ? 'a' : 'b'), voiceOwner, drainOnEnd: false });
    await flush(80);
    if (chunk === 0) {
      f.api.recordDiagnostic('bargePause');
      f.api.recordDiagnostic('bargeFalsePause');
    }
    await f.drain(250);
    assert.equal(await done, true);
  }
  const values = f.api.takeSummary();
  assert.equal(values[2], 1);
  assert.equal(values[6], 1);
  assert.equal(values[7], 1);
  assert.equal(f.api.takeSummary(), null);
});

test('only real same-voice underrun seeds bounded warm startup and healthy completed audio decays it', async (t) => {
  const f = fixture(t),
    voiceOwner = { epoch: 1, session: 2, generation: 1 };
  await f.gesture();
  await trainRealCarry(f, voiceOwner);
  for (let healthy = 0; healthy < 2; healthy++) {
    f.setResponse(response([pcm(24000)]));
    const prepared = f.api.prepare({ ...reply('b'), voiceOwner, drainOnEnd: false });
    await flush(80);
    assert.equal(f.nodes[0].processor.startupTarget, 7200);
    const done = prepared.play();
    await f.drain(400);
    assert.equal(await done, true);
  }
  f.setResponse(response([pcm(2880)]));
  const prepared = f.api.prepare({ ...reply('c'), voiceOwner });
  await flush(80);
  assert.equal(
    f.nodes[0].processor.startupTarget,
    5400,
    '48k healthy completed source samples decay25%',
  );
  prepared.cancel();
  assert.equal(
    f.fetches.length,
    4,
    'one fetch per explicitly requested response, no synthesis retry',
  );
});

test('changed voice token, missing terminal token, explicit stop and failed playback cannot inherit warm carry', async (t) => {
  const f = fixture(t),
    voiceOwner = { epoch: 1, session: 2, generation: 1 };
  await f.gesture();
  for (const reset of ['epoch', 'session', 'missing', 'stop', 'failure']) {
    await trainRealCarry(f, voiceOwner);
    if (reset === 'stop') f.api.stop();
    if (reset === 'failure') {
      f.setResponse(response([], { ok: false, status: 500 }));
      await assert.rejects(f.api.play({ ...reply('b'), voiceOwner }));
    }
    f.setResponse(response([pcm(2880)]));
    const token =
      reset === 'missing'
        ? undefined
        : {
            ...voiceOwner,
            ...(reset === 'epoch' ? { epoch: 2 } : {}),
            ...(reset === 'session' ? { session: 3 } : {}),
          };
    const prepared = f.api.prepare({ ...reply('c'), voiceOwner: token });
    await flush(80);
    assert.equal(f.nodes[0].processor.startupTarget, 2880, reset);
    prepared.cancel();
  }
});

test('real fallback capture wrapper preserves only completed same-voice carry and clears manual or active cancellation', async (t) => {
  const f = fixture(t),
    voiceOwner = { epoch: 1, session: 2, generation: 1 };
  await f.gesture();
  const node = () => ({ connect() {}, disconnect() {} });
  class CaptureContext {
    constructor() {
      this.state = 'running';
      this.destination = {};
      this.sampleRate = 48000;
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return { ...node(), gain: { value: 0 } };
    }
    createAnalyser() {
      return { ...node(), fftSize: 2048, getFloatTimeDomainData: (samples) => samples.fill(0) };
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  const source = fs.readFileSync(
    path.join(__dirname, '../src/client/modules/assistant-audio.js'),
    'utf8',
  );
  const audio = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window: {
      ...f.window,
      AudioContext: CaptureContext,
      MediaRecorder: Recorder,
      Float32Array,
      Float64Array,
      ArrayBuffer,
      Blob,
    },
    navigator: { mediaDevices: { getUserMedia: async () => media() } },
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  })(f.state, { assistantPlayback: () => f.api });
  const media = () => {
    const track = { kind: 'audio', readyState: 'live', stop() {} };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  for (const mode of ['automatic', 'manual', 'active-cancel']) {
    await trainRealCarry(f, voiceOwner);
    let pending;
    if (mode === 'active-cancel') {
      f.setResponse(response([pcm(2880)]));
      pending = audio.playAssistantAudio({ ...reply('b'), voiceOwner });
      await flush(80);
    }
    const options =
      mode === 'manual' ? {} : { silenceStop: true, voiceOwner, readyCue: async () => true };
    assert.equal(
      await audio.startAssistantCapture(
        () => assert.fail('no synthetic recording submitted'),
        () => {},
        30,
        options,
      ),
      true,
    );
    audio.stopAssistantCapture(true);
    if (pending) assert.equal(await pending, false);
    f.setResponse(response([pcm(2880)]));
    const prepared = audio.prepareAssistantAudio({ ...reply('c'), voiceOwner });
    await flush(80);
    assert.equal(f.nodes[0].processor.startupTarget, mode === 'automatic' ? 7200 : 2880, mode);
    prepared.cancel();
  }
});
