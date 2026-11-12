const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
function fixture(options = {}) {
  const state = { assistantGeneration: 0 };
  const window = {
    ArrayBuffer,
    DataView,
    Float32Array,
    Float64Array,
    Uint8Array,
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    ...options.window,
  };
  const factory = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window,
    navigator: options.navigator || {},
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...options.globals,
  });
  return { state, api: factory(state, { toast() {}, ...options.actions }) };
}
test('microphone encoder makes bounded mono PCM16 WAV at 16k without any provider call', () => {
  const f = fixture();
  const buffer = {
    duration: 1,
    sampleRate: 48000,
    numberOfChannels: 2,
    getChannelData: () => Float32Array.from({ length: 48000 }, () => 0.5),
  };
  const bytes = Buffer.from(f.api.encodeAssistantWav(buffer), 'base64');
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString(), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.length, 32044);
  assert.equal(bytes.readInt16LE(44), 16384);
  assert.equal(
    Buffer.from(f.api.encodeAssistantWav({ ...buffer, duration: 30.02 }), 'base64').length,
    960044,
  );
  assert.throws(() => f.api.encodeAssistantWav({ ...buffer, duration: 0 }), /Запись пустая/);
});
test('late microphone permission after scope reset immediately stops every track', async () => {
  let resolve,
    stopped = 0;
  const permission = new Promise((yes) => {
    resolve = yes;
  });
  const f = fixture({
    window: { MediaRecorder: class {}, AudioContext: class {} },
    navigator: { mediaDevices: { getUserMedia: () => permission } },
  });
  const pending = f.api.startAssistantCapture(
    () => assert.fail('No transcript after reset'),
    () => assert.fail('No stale error'),
  );
  f.state.assistantGeneration++;
  f.api.stopAssistantCapture(true);
  resolve({
    getTracks: () => [
      {
        stop() {
          stopped++;
        },
      },
    ],
  });
  assert.equal(await pending, false);
  assert.equal(stopped, 1);
});
test('demo and local speech refuse remote Russian voices at the bounded voice deadline', async () => {
  const f = localVoiceFixture([
    { lang: 'ru-RU', localService: false },
    { lang: 'en-US', localService: true },
    { lang: 'ru-RU' },
  ]);
  const pending = f.api.playAssistantAudio({
    audioBase64: null,
    text: 'Synthetic answer',
    local: true,
  });
  const rejected = assert.rejects(pending, /Локальный русский голос недоступен/);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 2000);
  f.expire();
  await rejected;
  assert.equal(f.spoken.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

function localVoiceFixture(initialVoices = []) {
  let voices = initialVoices,
    id = 0;
  const spoken = [],
    listeners = new Set(),
    timers = new Map();
  const f = fixture({
    window: {
      SpeechSynthesisUtterance: class {
        constructor(text) {
          this.text = text;
        }
      },
      speechSynthesis: {
        getVoices: () => voices,
        addEventListener: (name, listener) => {
          assert.equal(name, 'voiceschanged');
          listeners.add(listener);
        },
        removeEventListener: (name, listener) => {
          assert.equal(name, 'voiceschanged');
          listeners.delete(listener);
        },
        speak: (utterance) => spoken.push(utterance),
        cancel() {},
      },
    },
    globals: {
      setTimeout: (callback, delay) => {
        const key = ++id;
        timers.set(key, { callback, delay });
        return key;
      },
      clearTimeout: (key) => timers.delete(key),
    },
  });
  return {
    ...f,
    spoken,
    listeners,
    timers,
    voices(next) {
      voices = next;
      for (const listener of [...listeners]) listener();
    },
    expire() {
      for (const [key, value] of [...timers]) {
        timers.delete(key);
        value.callback();
      }
    },
  };
}
test('local voice preflight waits for voiceschanged without speaking or network and removes its deadline', async () => {
  const f = localVoiceFixture();
  let settled = false;
  const ready = f.api.assistantLocalVoiceReady().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  f.voices([{ lang: 'ru-RU', localService: false }]);
  await Promise.resolve();
  assert.equal(settled, false);
  f.voices([{ lang: 'ru-RU', localService: true, name: 'Synthetic local RU' }]);
  assert.equal(await ready, true);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});
test('delayed Russian local playback waits for its own end before returning completion', async () => {
  const f = localVoiceFixture();
  let completed = false;
  const pending = f.api
    .playAssistantAudio({ audioBase64: null, text: 'Синтетический ответ', local: true })
    .then((value) => {
      completed = true;
      return value;
    });
  const voice = { lang: 'ru-RU', localService: true, name: 'Synthetic local RU' };
  assert.equal(f.spoken.length, 0);
  f.voices([voice]);
  await Promise.resolve();
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].voice, voice);
  assert.equal(f.spoken[0].text, 'Синтетический ответ');
  assert.equal(completed, false);
  f.spoken[0].onend();
  assert.equal(await pending, true);
});
test('stop cancels voice discovery, removes listeners and prevents late voice playback or readiness', async () => {
  const f = localVoiceFixture();
  const playback = f.api.playAssistantAudio({ audioBase64: null, text: 'Синтетический ответ' });
  f.api.stopAssistantAudio();
  assert.equal(await playback, false);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
  const ready = f.api.assistantLocalVoiceReady();
  f.api.stopAssistantAudio();
  f.voices([{ lang: 'ru-RU', localService: true }]);
  assert.equal(await ready, false);
  assert.equal(f.spoken.length, 0);
});
test('voice discovered immediately before stop and changed scope cannot start stale playback', async () => {
  const f = localVoiceFixture();
  const playback = f.api.playAssistantAudio({ audioBase64: null, text: 'Синтетический ответ' });
  f.voices([{ lang: 'ru-RU', localService: true }]);
  f.api.stopAssistantAudio();
  assert.equal(await playback, false);
  assert.equal(f.spoken.length, 0);
  const g = localVoiceFixture();
  const ready = g.api.assistantLocalVoiceReady();
  g.state.assistantGeneration++;
  g.voices([{ lang: 'ru-RU', localService: true }]);
  assert.equal(await ready, false);
  assert.equal(g.spoken.length, 0);
});
test('missing speech synthesis is honest and replacing a pending waiter cannot leave it unresolved', async () => {
  const unavailable = fixture();
  assert.equal(await unavailable.api.assistantLocalVoiceReady(), false);
  await assert.rejects(
    unavailable.api.playAssistantAudio({ audioBase64: null, text: 'Ответ' }),
    /Локальный русский голос/,
  );
  const f = localVoiceFixture();
  const first = f.api.assistantLocalVoiceReady();
  const second = f.api.assistantLocalVoiceReady();
  assert.equal(await first, false);
  assert.equal(f.timers.size, 1);
  f.expire();
  assert.equal(await second, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

function playbackFixture() {
  const audio = [],
    revoked = [],
    spoken = [];
  class Audio {
    constructor(url) {
      this.url = url;
      this.playbackRate = 1;
      this.preservesPitch = false;
      this.playedRates = [];
      audio.push(this);
    }
    play() {
      this.playedRates.push({ rate: this.playbackRate, preservesPitch: this.preservesPitch });
      this.onplaying?.();
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    removeAttribute(name) {
      assert.equal(name, 'src');
      this.detached = true;
    }
    load() {
      this.loads = (this.loads || 0) + 1;
    }
  }
  const f = fixture({
    window: {
      Audio,
      Blob,
      Uint8Array,
      atob: (text) => Buffer.from(text, 'base64').toString('binary'),
      SpeechSynthesisUtterance: class {},
      speechSynthesis: {
        getVoices: () => [{ lang: 'ru-RU', localService: true }],
        speak: (value) => spoken.push(value),
        cancel() {},
      },
    },
    globals: {
      URL: {
        createObjectURL: () => 'blob:synthetic-audio',
        revokeObjectURL: (url) => revoked.push(url),
      },
    },
  });
  return { ...f, audio, revoked, spoken };
}
const encoded = {
  mimeType: 'audio/wav',
  audioBase64: Buffer.from('synthetic-audio').toString('base64'),
};
test('playback resolves only after native ended and explicit stop resolves cancellation without stale callbacks', async () => {
  const f = playbackFixture();
  let settled = false;
  const first = f.api.playAssistantAudio(encoded).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(f.audio[0].playedRates, [{ rate: 1.4, preservesPitch: true }]);
  f.audio[0].onended();
  assert.equal(await first, true);
  assert.deepEqual(f.revoked, ['blob:synthetic-audio']);
  const second = f.api.playAssistantAudio(encoded),
    staleEnd = f.audio[1].onended;
  f.api.stopAssistantAudio();
  assert.equal(await second, false);
  const third = f.api.playAssistantAudio(encoded);
  staleEnd();
  assert.equal(f.audio[2].paused, undefined, 'a stale native event cannot finish the new playback');
  f.audio[2].onended();
  assert.equal(await third, true);
});
test('playback rejects native media failure and local speech waits for its own completion', async () => {
  const f = playbackFixture();
  const failed = f.api.playAssistantAudio(encoded);
  const rejected = assert.rejects(failed, /воспроизвести/);
  f.audio[0].onerror();
  await rejected;
  assert.equal(f.audio[0].paused, true);
  const spoken = f.api.playAssistantAudio({ audioBase64: null, text: 'Синтетический вопрос' });
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].rate, 2);
  f.spoken[0].onend();
  assert.equal(await spoken, true);
  const cancelled = f.api.playAssistantAudio({ audioBase64: null, text: 'Другой вопрос' });
  f.api.stopAssistantAudio();
  assert.equal(await cancelled, false);
});
function monitoredFixture({
  cue = false,
  resumeGate = null,
  cueFailure = false,
  playback = null,
  document = { hidden: false },
} = {}) {
  let now = 0,
    id = 0,
    level = 0,
    stopped = 0;
  const timers = new Map(),
    contexts = [],
    recorders = [],
    completed = [],
    errors = [],
    cues = [],
    streams = [],
    sourceTargets = [];
  const timer = (callback, delay, repeat) => {
    const key = ++id;
    timers.set(key, { callback, delay, due: now + delay, repeat });
    return key;
  };
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  class AudioContext {
    constructor() {
      this.closed = false;
      this.state = resumeGate ? 'suspended' : 'running';
      this.currentTime = 0;
      this.destination = {};
      contexts.push(this);
    }
    createMediaStreamSource() {
      return {
        connect(target) {
          sourceTargets.push(target);
        },
        disconnect() {},
      };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        connect(target) {
          this.target = target;
        },
        getFloatTimeDomainData: (values) => values.fill(level),
        disconnect() {},
      };
    }
    resume() {
      return Promise.resolve(resumeGate).then(() => {
        this.state = 'running';
      });
    }
    decodeAudioData() {
      return Promise.resolve({
        duration: 0.1,
        sampleRate: 16000,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(1600).fill(0.05),
      });
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  if (cue) {
    AudioContext.prototype.createOscillator = function () {
      if (cueFailure) throw Error('Synthetic oscillator unavailable');
      const node = {
        frequency: {
          events: [],
          setValueAtTime(value, at) {
            this.events.push(['set', value, at]);
          },
        },
        stops: [],
        connect(target) {
          this.target = target;
        },
        start() {
          this.started = true;
          this.recordingAtCue = recorders.some((recorder) => recorder.state === 'recording');
        },
        stop(at) {
          this.stops.push(at);
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      cues.push(node);
      return node;
    };
  }
  {
    AudioContext.prototype.createGain = function () {
      return {
        gain: {
          events: [],
          setValueAtTime(value, at) {
            this.events.push(['set', value, at]);
          },
          linearRampToValueAtTime(value, at) {
            this.events.push(['ramp', value, at]);
          },
        },
        connect(target) {
          this.target = target;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
    };
  }
  class MediaRecorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
      this.ondataavailable({ data: new Blob(['synthetic']) });
    }
    stop() {
      this.state = 'inactive';
      void this.onstop?.();
    }
  }
  const f = fixture({
    window: { MediaRecorder, AudioContext, Blob },
    actions: playback ? { assistantPlayback: () => playback } : undefined,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          const track = {
            kind: 'audio',
            readyState: 'live',
            stop() {
              this.readyState = 'ended';
              stopped++;
            },
          };
          const media = {
            getTracks: () => [track],
            getAudioTracks: () => [track],
          };
          streams.push(media);
          return media;
        },
      },
    },
    globals: {
      Date: Clock,
      performance: { now: () => now },
      document,
      setTimeout: (fn, ms) => timer(fn, ms, false),
      clearTimeout: (key) => timers.delete(key),
      setInterval: (fn, ms) => timer(fn, ms, true),
      clearInterval: (key) => timers.delete(key),
    },
  });
  return {
    ...f,
    contexts,
    cues,
    streams,
    sourceTargets,
    recorders,
    completed,
    errors,
    timers,
    start: (options = { silenceStop: true }, maxSeconds = 30) =>
      f.api.startAssistantCapture(
        (audio, info) => completed.push({ audio, info }),
        (error) => errors.push(error),
        maxSeconds,
        options,
      ),
    level(value) {
      level = value;
    },
    stopped: () => stopped,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers]
          .filter(([, value]) => value.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [key, value] = next;
        now = value.due;
        if (value.repeat) value.due += value.delay;
        else timers.delete(key);
        value.callback();
        for (let i = 0; i < 6; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 12; i++) await Promise.resolve();
    },
  };
}
test('voice silence monitor requires sustained speech then1050ms silence and cleans all resources', async () => {
  const f = monitoredFixture();
  assert.equal(await f.start(), true);
  f.level(0.03);
  await f.advance(200);
  f.level(0);
  await f.advance(1800);
  assert.equal(f.completed.length, 0, 'a short noise burst is not speech');
  f.level(0.03);
  await f.advance(250);
  f.level(0);
  await f.advance(1000);
  assert.equal(f.completed.length, 0);
  await f.advance(50);
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].info.stopReason, 'silence');
  assert.equal(
    f.completed[0].info.speechEndedAt,
    2250,
    'VAD endpoint precedes1050ms silence and encoding',
  );
  assert.equal(f.errors.length, 0);
  assert.equal(f.timers.size, 0);
  assert.ok(f.contexts.every((context) => context.closed));
  assert.ok(f.stopped() > 0);
});
test('initial silence discards at8seconds without STT data and explicit discard suppresses late capture', async () => {
  const f = monitoredFixture();
  await f.start();
  await f.advance(8000);
  assert.equal(f.completed.length, 0);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /Речь не обнаружена/);
  assert.equal(f.timers.size, 0);
  assert.ok(f.contexts.every((context) => context.closed));
  await f.start();
  const staleStop = f.recorders.at(-1).onstop;
  f.api.stopAssistantCapture(true);
  await staleStop();
  assert.equal(f.completed.length, 0);
  assert.equal(f.timers.size, 0);
});
test('single capture preserves manual/max-duration behavior and voice speech defaults to a30second ceiling', async () => {
  const single = monitoredFixture();
  await single.start({});
  assert.equal(single.contexts.length, 0, 'one-shot capture never creates a silence analyser');
  await single.advance(8000);
  assert.equal(single.errors.length, 0);
  single.api.stopAssistantCapture();
  await single.advance(0);
  assert.equal(single.completed.length, 1);
  const voice = monitoredFixture();
  await voice.start();
  voice.level(0.03);
  await voice.advance(30000);
  assert.equal(voice.completed.length, 1);
  assert.equal(voice.completed[0].info.stopReason, 'limit');
  assert.equal(voice.completed[0].info.seconds, 30);
  assert.equal(voice.timers.size, 0);
});

test('ready cue is voice-only, audible880Hz140ms and microphone is never connected to speakers', async () => {
  const single = monitoredFixture({ cue: true });
  await single.start({});
  assert.equal(single.cues.length, 0);
  single.api.stopAssistantCapture(true);
  const voice = monitoredFixture({ cue: true });
  await voice.start();
  assert.equal(voice.cues.length, 1);
  const tone = voice.cues[0];
  assert.equal(tone.frequency.value, 880);
  assert.equal(tone.target.gain.value, 0.08);
  assert.equal(tone.stops[0], 0.14);
  assert.equal(tone.target.target, voice.contexts[0].destination);
  assert.ok(voice.sourceTargets.every((target) => target !== voice.contexts[0].destination));
  voice.level(0.03);
  await voice.advance(140);
  voice.level(0);
  await voice.advance(1700);
  assert.equal(voice.completed.length, 0, 'a140ms acoustic cue cannot count as250ms speech');
  assert.equal(tone.disconnected, true);
  assert.equal(tone.target.disconnected, true);
  voice.api.stopAssistantCapture(true);
  assert.equal(voice.timers.size, 0);
  assert.equal(tone.onended, null);
});
test('first-command ready cue is distinct and starts only with the recorder ready', async () => {
  const first = monitoredFixture({ cue: true });
  await first.start({ silenceStop: true, initialCommand: true });
  assert.equal(first.cues.length, 1);
  const tone = first.cues[0];
  assert.equal(tone.recordingAtCue, true);
  assert.equal(tone.type, 'sine');
  assert.equal(tone.frequency.value, 523.25);
  assert.deepEqual(tone.frequency.events, [['set', 659.25, 0.12 * 0.45]]);
  assert.equal(tone.target.gain.value, 0.075);
  assert.equal(tone.stops[0], 0.12);
  assert.deepEqual(tone.target.gain.events, [
    ['set', 0, 0],
    ['ramp', 0.075, 0.018],
    ['ramp', 0, 0.12 * 0.45],
    ['ramp', 0.06, 0.12 * 0.56],
    ['ramp', 0, 0.12],
  ]);
  first.level(0.03);
  await first.advance(220);
  first.level(0);
  await first.advance(1700);
  assert.equal(first.completed.length, 0, 'the ready cue alone cannot be a spoken command');
  first.api.stopAssistantCapture(true);
  assert.equal(first.timers.size, 0);
  assert.equal(tone.disconnected, true);
  const short = monitoredFixture({ cue: true });
  await short.start({ silenceStop: true, initialCommand: true, shortAnswer: true });
  assert.equal(short.cues[0].stops[0], 0.06, 'a short reply keeps the short acoustic cue');
  assert.equal(short.cues[0].target.gain.value, 0.08);
  short.api.stopAssistantCapture(true);
});

test('resuming an existing short-answer dialogue keeps a distinct ready cue below its speech threshold', async () => {
  const f = monitoredFixture({ cue: true });
  await f.start({ silenceStop: true, shortAnswer: true, startCue: true });
  assert.equal(f.cues[0].recordingAtCue, true);
  assert.equal(f.cues[0].frequency.value, 523.25);
  assert.equal(f.cues[0].target.gain.value, 0.075);
  assert.equal(f.cues[0].stops[0], 0.06);
  assert.deepEqual(f.cues[0].frequency.events, [['set', 659.25, 0.06 * 0.45]]);
  assert.deepEqual(f.cues[0].target.gain.events, [
    ['set', 0, 0],
    ['ramp', 0.075, 0.015],
    ['ramp', 0, 0.06 * 0.45],
    ['ramp', 0.06, 0.06 * 0.56],
    ['ramp', 0, 0.06],
  ]);
  f.level(0.03);
  await f.advance(60);
  f.level(0);
  await f.advance(7940);
  assert.equal(f.completed.length, 0);
  assert.equal(f.errors[0].code, 'ASSISTANT_NO_INPUT');
  assert.equal(f.timers.size, 0);
});

test('ready cue waits for resume, does not survive cancellation and cue failure leaves capture running', async () => {
  let resumed;
  const gate = new Promise((resolve) => {
    resumed = resolve;
  });
  const stopped = monitoredFixture({ cue: true, resumeGate: gate });
  const stoppedStart = stopped.start();
  await stopped.advance(0);
  assert.equal(stopped.cues.length, 0);
  stopped.api.stopAssistantCapture(true);
  assert.equal(await stoppedStart, false);
  resumed();
  await stopped.advance(0);
  assert.equal(stopped.cues.length, 0);
  assert.equal(stopped.timers.size, 0);
  let ready;
  const delayed = monitoredFixture({
    cue: true,
    resumeGate: new Promise((resolve) => {
      ready = resolve;
    }),
  });
  const delayedStart = delayed.start();
  await delayed.advance(0);
  assert.equal(delayed.cues.length, 0);
  ready();
  assert.equal(await delayedStart, true);
  await delayed.advance(0);
  assert.equal(delayed.cues.length, 1);
  delayed.api.stopAssistantCapture(true);
  assert.equal(delayed.timers.size, 0);
  const broken = monitoredFixture({ cue: true, cueFailure: true });
  assert.equal(await broken.start(), true);
  assert.equal(broken.errors.length, 0);
  assert.equal(broken.recorders[0].state, 'recording');
  broken.api.stopAssistantCapture(true);
  assert.equal(broken.timers.size, 0);
});

test('the shared PCM ready cue waits for startup using the already granted live microphone', async () => {
  let unlockReady;
  const unlocked = [],
    cues = [],
    playback = {
      supported: () => true,
      stop() {},
      unlock(media) {
        unlocked.push(media);
        return new Promise((resolve) => {
          unlockReady = resolve;
        });
      },
      cue(options) {
        cues.push(options);
        return Promise.resolve(true);
      },
    },
    f = monitoredFixture({ playback });
  assert.equal(await f.start({}), true);
  const options = { initialCommand: true },
    pending = f.api.playAssistantReadyCue(options);
  assert.deepEqual(unlocked, [f.streams[0]]);
  assert.equal(unlocked[0].getAudioTracks()[0].readyState, 'live');
  assert.equal(cues.length, 0, 'the cue cannot race asynchronous output startup');
  assert.equal(f.streams.length, 1, 'output startup does not request another microphone');
  unlockReady(true);
  assert.equal(await pending, true);
  assert.deepEqual(cues, [options]);
  f.api.stopAssistantCapture(true);
  assert.equal(f.timers.size, 0);
});

test('PCM startup cannot emit a stale cue after capture, identity, visibility or live-track changes', async () => {
  for (const change of ['cancel', 'replacement', 'generation', 'account', 'hidden', 'ended']) {
    let unlockReady,
      cues = 0;
    const document = { hidden: false },
      playback = {
        supported: () => true,
        stop() {},
        unlock: () =>
          new Promise((resolve) => {
            unlockReady = resolve;
          }),
        cue: async () => {
          cues++;
          return true;
        },
      },
      f = monitoredFixture({ playback, document });
    await f.start({});
    const pending = f.api.playAssistantReadyCue({ startCue: true });
    assert.equal(typeof unlockReady, 'function');
    if (change === 'cancel' || change === 'replacement') f.api.stopAssistantCapture(true);
    if (change === 'replacement') await f.start({});
    if (change === 'generation') f.state.assistantGeneration++;
    if (change === 'account') f.state.account = { id: 'other', organizationId: 'other-org' };
    if (change === 'hidden') document.hidden = true;
    if (change === 'ended') f.streams[0].getAudioTracks()[0].readyState = 'ended';
    unlockReady(true);
    assert.equal(await pending, false, change);
    assert.equal(cues, 0, change);
    if (change === 'replacement')
      assert.equal(f.recorders[1].state, 'recording', 'a stale cue cannot cancel the new capture');
    f.api.stopAssistantCapture(true);
    assert.equal(f.timers.size, 0, change);
  }
});

test('browser refusal of the shared ready cue is propagated and leaves no armed capture', async () => {
  const playback = {
      supported: () => true,
      stop() {},
      unlock: async () => true,
      cue: async () => {
        throw Object.assign(Error('Synthetic browser playback refusal'), {
          code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED',
        });
      },
    },
    f = monitoredFixture({ playback });
  await assert.rejects(
    f.start({ silenceStop: true, readyCue: (options) => f.api.playAssistantReadyCue(options) }),
    { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' },
  );
  assert.equal(f.recorders[0].state, 'inactive');
  assert.equal(f.streams[0].getAudioTracks()[0].readyState, 'ended');
  assert.ok(f.contexts.every((context) => context.closed));
  assert.equal(f.completed.length, 0);
  assert.equal(f.timers.size, 0);
});

test('short-answer capture accepts100ms speech while ordinary capture keeps its250ms noise fence', async () => {
  const short = monitoredFixture();
  await short.start({ silenceStop: true, shortAnswer: true });
  short.level(0.03);
  await short.advance(100);
  short.level(0);
  await short.advance(500);
  assert.equal(short.completed.length, 0, 'a 500ms pause still belongs to the short answer');
  await short.advance(50);
  assert.equal(short.completed.length, 0, 'the short answer is still recorded through 550ms');
  await short.advance(50);
  assert.equal(short.completed.length, 1, '600ms of silence completes the short answer');
  assert.equal(short.errors.length, 0);
  assert.equal(short.completed[0].info.stopReason, 'silence');
  const normal = monitoredFixture();
  await normal.start({ silenceStop: true });
  normal.level(0.03);
  await normal.advance(150);
  normal.level(0);
  await normal.advance(7850);
  assert.equal(normal.completed.length, 0);
  assert.equal(normal.errors[0].code, 'ASSISTANT_NO_INPUT');
});

test('a substantive clarification keeps100ms onset but retains a700ms mid-phrase pause', async () => {
  const f = monitoredFixture();
  await f.start({ silenceStop: true, shortAnswer: true, shortSilence: false });
  f.level(0.03);
  await f.advance(100);
  f.level(0);
  await f.advance(700);
  assert.equal(f.completed.length, 0, 'a name or service can continue after this pause');
  f.level(0.03);
  await f.advance(300);
  f.level(0);
  await f.advance(1000);
  assert.equal(f.completed.length, 0);
  await f.advance(50);
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].info.stopReason, 'silence');
  assert.equal(f.errors.length, 0);
  assert.equal(f.timers.size, 0);
});

test('a short first answer after delayed microphone readiness is monitored before the cue', async () => {
  let resume;
  const f = monitoredFixture({
    cue: true,
    resumeGate: new Promise((resolve) => {
      resume = resolve;
    }),
  });
  const pending = f.start({ silenceStop: true, shortAnswer: true });
  await f.advance(0);
  assert.equal(
    f.recorders[0].state,
    'inactive',
    'do not record a reply that the detector cannot yet hear',
  );
  assert.equal(f.cues.length, 0);
  resume();
  assert.equal(await pending, true);
  assert.equal(f.contexts[0].state, 'running');
  assert.equal(f.recorders[0].state, 'recording');
  assert.equal(f.cues[0].recordingAtCue, true);
  f.level(0.03);
  await f.advance(100);
  f.level(0);
  await f.advance(600);
  assert.equal(f.completed.length, 1);
  assert.equal(f.errors.length, 0);
  assert.equal(f.completed[0].info.stopReason, 'silence');
});
test('short-answer mode still rejects a60ms cue or background below the existing RMS threshold', async () => {
  const f = monitoredFixture({ cue: true });
  await f.start({ silenceStop: true, shortAnswer: true });
  f.level(0.03);
  await f.advance(60);
  f.level(0.014);
  await f.advance(7940);
  assert.equal(f.completed.length, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, 'ASSISTANT_NO_INPUT');
  assert.equal(f.timers.size, 0);
  assert.ok(f.contexts.every((context) => context.closed));
});

test('configured 60 second PCM bound is honored while the default remains 30 seconds', () => {
  const f = fixture(),
    buffer = {
      duration: 61,
      sampleRate: 16000,
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(61 * 16000),
    };
  assert.equal(Buffer.from(f.api.encodeAssistantWav(buffer, 60), 'base64').length, 60 * 32000 + 44);
  assert.equal(Buffer.from(f.api.encodeAssistantWav(buffer), 'base64').length, 30 * 32000 + 44);
  assert.equal(
    Buffer.from(f.api.encodeAssistantWav(buffer, 600), 'base64').length,
    60 * 32000 + 44,
  );
});

test('configured sixty second capture timer is not cut off at thirty seconds', async () => {
  const f = monitoredFixture();
  await f.start({ silenceStop: true }, 60);
  f.level(0.03);
  await f.advance(30000);
  assert.equal(f.completed.length, 0);
  await f.advance(30000);
  assert.equal(f.completed.length, 1);
  assert.equal(f.completed[0].info.stopReason, 'limit');
  assert.equal(f.completed[0].info.seconds, 60);
  assert.equal(f.timers.size, 0);
});

test('dialogue analyser is connected to a silent output and resume timeout releases capture', async () => {
  const live = monitoredFixture();
  await live.start();
  const analyser = live.sourceTargets[0];
  assert.equal(analyser.target.gain.value, 0);
  assert.equal(analyser.target.target, live.contexts[0].destination);
  live.api.stopAssistantCapture(true);
  assert.equal(analyser.target.disconnected, true);
  const blocked = monitoredFixture({ resumeGate: new Promise(() => {}) });
  const pending = blocked.start();
  const rejection = assert.rejects(pending, /Не удалось включить обработку микрофона/);
  await blocked.advance(0);
  await blocked.advance(3000);
  await rejection;
  assert.equal(blocked.contexts[0].closed, true);
  assert.equal(blocked.recorders[0].state, 'inactive');
  assert.equal(blocked.timers.size, 0);
});

const streamed = {
  streamUrl:
    '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43) + '&accountContext=&organizationContext=',
  mimeType: 'audio/mpeg',
};
test('same-origin streamed speech starts native progressive playback at1.4 with preserved pitch and waits for native completion', async () => {
  const f = playbackFixture();
  let settled = false;
  const pending = f.api.playAssistantAudio(streamed).then((value) => {
    settled = true;
    return value;
  });
  assert.equal(f.audio.length, 1);
  assert.equal(f.audio[0].url, streamed.streamUrl);
  assert.deepEqual(f.audio[0].playedRates, [{ rate: 1.4, preservesPitch: true }]);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(await f.api.pauseAssistantAudio(), true);
  assert.equal(f.api.resumeAssistantAudio(), true);
  assert.ok(
    f.audio[0].playedRates.every((value) => value.rate === 1.4 && value.preservesPitch === true),
  );
  f.audio[0].onended();
  assert.equal(await pending, true);
  assert.equal(f.audio[0].detached, true);
  assert.equal(f.audio[0].loads, 1);
  assert.deepEqual(f.revoked, [], 'stream tickets are not object URLs');
});
test('stream URLs reject external absolute alternate-path extra-query malformed tickets and mixed payloads before native fetch', () => {
  const f = playbackFixture(),
    ticket = 'a'.repeat(43);
  for (const streamUrl of [
    'https://external.invalid/api/assistant/speak-audio?ticket=' + ticket,
    'https://synthetic.invalid/api/assistant/speak-audio?ticket=' + ticket,
    '//external.invalid/api/assistant/speak-audio?ticket=' + ticket,
    '/api/assistant/other?ticket=' + ticket,
    '/api/assistant/speak-audio?ticket=' + ticket + '&other=1',
    '/api/assistant/speak-audio?ticket=' + ticket + '#fragment',
    '/api/assistant/speak-audio?ticket=' + 'a'.repeat(42),
    '/api/assistant/speak-audio?ticket=' + '%61'.repeat(43),
    'javascript:alert(1)',
  ])
    assert.throws(() => f.api.playAssistantAudio({ streamUrl }), /воспроизвести/);
  assert.throws(
    () => f.api.playAssistantAudio({ ...streamed, audioBase64: encoded.audioBase64 }),
    /воспроизвести/,
  );
  assert.equal(f.audio.length, 0);
  assert.equal(f.spoken.length, 0);
});
test('stream cancellation detaches and reloads native media while stale ended events cannot finish a replacement', async () => {
  const f = playbackFixture(),
    pending = f.api.playAssistantAudio(streamed);
  const prior = f.audio[0],
    staleEnd = prior.onended;
  f.state.assistantGeneration++;
  f.api.stopAssistantAudio();
  assert.equal(await pending, false);
  assert.equal(prior.paused, true);
  assert.equal(prior.detached, true);
  assert.equal(prior.loads, 1);
  const replacement = f.api.playAssistantAudio(streamed);
  staleEnd();
  assert.equal(f.audio[1].detached, undefined);
  f.audio[1].onended();
  assert.equal(await replacement, true);
  assert.deepEqual(f.revoked, []);
});

test('a pause shorter than600ms between short-answer words does not split the utterance or shorten the ordinary gate', async () => {
  const short = monitoredFixture();
  await short.start({ silenceStop: true, shortAnswer: true });
  short.level(0.03);
  await short.advance(100);
  short.level(0);
  await short.advance(500);
  assert.equal(short.completed.length, 0);
  short.level(0.03);
  await short.advance(100);
  short.level(0);
  await short.advance(550);
  assert.equal(short.completed.length, 0, 'resumed speech resets the trailing-silence deadline');
  await short.advance(50);
  assert.equal(short.completed.length, 1);
  assert.equal(short.errors.length, 0);
  const ordinary = monitoredFixture();
  await ordinary.start({ silenceStop: true, shortAnswer: false });
  ordinary.level(0.03);
  await ordinary.advance(250);
  ordinary.level(0);
  await ordinary.advance(600);
  assert.equal(
    ordinary.completed.length,
    0,
    'ordinary commands do not inherit short-answer timing',
  );
  await ordinary.advance(400);
  assert.equal(ordinary.completed.length, 0);
  await ordinary.advance(50);
  assert.equal(ordinary.completed.length, 1);
  assert.equal(ordinary.errors.length, 0);
});

test('active microphone reports a bounded visible level and stops reporting after capture cancellation', async () => {
  const f = monitoredFixture(),
    levels = [];
  await f.start({ silenceStop: true, onLevel: (value) => levels.push(value) });
  f.level(0.04);
  await f.advance(50);
  assert.ok(levels.some((value) => value > 0 && value <= 1));
  f.api.stopAssistantCapture(true);
  const count = levels.length;
  await f.advance(1000);
  assert.equal(levels.length, count);
});

test('the initial command tolerates a thought pause without delaying short followups', async () => {
  const first = monitoredFixture();
  await first.start({ silenceStop: true, initialCommand: true });
  first.level(0.03);
  await first.advance(300);
  first.level(0);
  await first.advance(1300);
  assert.equal(first.completed.length, 0, 'the original1050ms gap must not cut the first thought');
  first.level(0.03);
  await first.advance(300);
  first.level(0);
  await first.advance(1450);
  assert.equal(first.completed.length, 0, 'resumed speech resets the deadline');
  await first.advance(50);
  assert.equal(first.completed.length, 1);
  assert.equal(first.completed[0].info.stopReason, 'silence');
  assert.equal(first.timers.size, 0);
  assert.equal(first.errors.length, 0);
  const short = monitoredFixture();
  await short.start({ silenceStop: true, shortAnswer: true, initialCommand: true });
  short.level(0.03);
  await short.advance(100);
  short.level(0);
  await short.advance(600);
  assert.equal(short.completed.length, 1, 'short-answer600ms gate takes precedence');
});

test('voice VAD/no-input starts after the shared output cue while the recorder retains its prefix', async () => {
  const f = monitoredFixture();
  let cueReady;
  const starting = f.start({
    silenceStop: true,
    shortAnswer: true,
    readyCue: () =>
      new Promise((resolve) => {
        cueReady = resolve;
      }),
  });
  await f.advance(0);
  assert.equal(typeof cueReady, 'function');
  assert.equal(f.recorders[0].state, 'recording');
  f.level(0.08);
  await f.advance(3000);
  f.level(0);
  await f.advance(6000);
  assert.equal(f.errors.length, 0);
  assert.equal(f.completed.length, 0);
  assert.equal(f.recorders[0].state, 'recording');
  cueReady(true);
  assert.equal(await starting, true);
  await f.advance(7950);
  assert.equal(f.errors.length, 0);
  assert.equal(f.completed.length, 0);
  await f.advance(50);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, 'ASSISTANT_NO_INPUT');
  assert.equal(f.timers.size, 0);
});

test('PCM recording-only cue unlocks from its owned live input without starting a legacy recorder', async () => {
  for (const cancel of [false, true]) {
    let release,
      cues = 0,
      valid = true;
    const unlocked = [],
      playback = {
        supported: () => true,
        stop() {},
        unlock(media) {
          unlocked.push(media);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        cue: async () => {
          cues++;
          return true;
        },
      },
      f = monitoredFixture({ playback });
    const track = { kind: 'audio', readyState: 'live' },
      captureMedia = { getAudioTracks: () => [track] };
    const pending = f.api.playAssistantReadyCue({
      captureMedia,
      current: () => valid,
      startCue: true,
    });
    assert.deepEqual(unlocked, [captureMedia]);
    assert.equal(f.recorders.length, 0);
    if (cancel) valid = false;
    release(true);
    assert.equal(await pending, !cancel);
    assert.equal(cues, cancel ? 0 : 1);
    assert.equal(f.recorders.length, 0);
  }
});

test('PCM prepare/play resets preserve only benign carry while explicit stop clears it', () => {
  const stopped = [];
  const playback = {
    supported: () => true,
    stop: (preserve) => stopped.push(preserve),
    prepare: () => ({ play: async () => true, cancel() {} }),
    play: async () => true,
  };
  const f = fixture({ actions: { assistantPlayback: () => playback } });
  f.api.prepareAssistantAudio({ mimeType: 'audio/pcm' });
  f.api.playAssistantAudio({ mimeType: 'audio/pcm' });
  f.api.stopAssistantAudio();
  assert.deepEqual(stopped, [true, true, false]);
});
