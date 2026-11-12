const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const source = fs.readFileSync(
  require('node:path').join(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
function fixture(realObserver = false) {
  let clock = 0;
  const performance = { now: () => clock };
  const instances = [],
    observations = [],
    utterances = [];
  const state = {
    assistantGeneration: 1,
    multiUser: true,
    account: { id: 'actor', organizationId: 'org', role: 'owner' },
  };
  class Audio {
    constructor() {
      instances.push(this);
      this.paused = true;
    }
    load() {}
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.onpause?.();
    }
    removeAttribute() {}
  }
  let pcm = {
    stop() {},
    playing: () => false,
    supported: () => false,
    observe(result, format) {
      const o = { format, starts: 0, events: [], finishes: [], done: false };
      observations.push(o);
      return {
        started() {
          if (!o.starts) o.starts++;
        },
        event(name, ms = 0) {
          if (!o.done) o.events.push({ name, ms });
        },
        finish(completed, error) {
          if (o.done) return;
          o.done = true;
          o.finishes.push({ completed, error: !!error });
        },
      };
    },
  };
  const w = {
    Audio,
    Blob,
    Uint8Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    atob: (x) => Buffer.from(x, 'base64').toString('binary'),
    btoa: (x) => Buffer.from(x, 'binary').toString('base64'),
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    speechSynthesis: {
      getVoices: () => [{ localService: true, lang: 'ru-RU' }],
      speak: (u) => utterances.push(u),
      cancel() {},
      resume() {},
    },
  };
  let shared;
  if (realObserver) {
    const text = fs.readFileSync(
      require('node:path').join(__dirname, '../src/client/modules/assistant-playback.js'),
      'utf8',
    );
    shared = vm.runInNewContext(text + '\ncreateAssistantPlayback', {
      window: w,
      document: { hidden: false },
      performance,
      setTimeout,
      clearTimeout,
    })(state, {});
    pcm = shared.assistantPlayback();
  }
  const api = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window: w,
    navigator: {},
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: { hidden: false },
    performance,
  })(state, { assistantPlayback: () => pcm });
  return {
    api,
    state,
    instances,
    observations,
    utterances,
    shared,
    setClock: (value) => {
      clock = value;
    },
  };
}
const ticket = () => ({
  mimeType: 'audio/mpeg',
  text: 'Synthetic',
  streamUrl:
    '/api/assistant/speak-audio?ticket=' +
    'a'.repeat(43) +
    '&accountContext=actor&organizationContext=org',
  voiceOwner: { epoch: 1, session: 1, generation: 1 },
});
test('native preload handle transfers once; resume playing never reports a second start', async () => {
  const f = fixture(),
    prepared = f.api.prepareAssistantAudio(ticket()),
    o = f.observations[0],
    media = f.instances[0];
  assert.equal(f.observations.length, 1);
  media.onwaiting();
  const done = prepared.play();
  f.setClock(123);
  media.onplaying();
  media.onwaiting();
  media.onstalled();
  assert.equal(await f.api.pauseAssistantAudio(), true);
  assert.equal(f.api.resumeAssistantAudio(), true);
  f.setClock(500);
  media.onplaying();
  assert.equal(o.starts, 1);
  assert.deepEqual(
    o.events.filter((x) => x.name === 'startupWait').map((x) => x.ms),
    [123],
  );
  assert.equal(f.observations.length, 1);
  media.onended();
  assert.equal(await done, true);
  assert.deepEqual(
    o.events.filter((x) => x.name !== 'startupWait').map((x) => x.name),
    ['mediaWaiting', 'mediaWaiting', 'mediaStalled'],
  );
  assert.deepEqual(o.finishes, [{ completed: true, error: false }]);
  assert.equal(media.onwaiting, null);
});
test('unused prepared native request cancels once, cannot play or report a late event', async () => {
  const f = fixture(),
    p = f.api.prepareAssistantAudio(ticket()),
    m = f.instances[0],
    late = m.onwaiting;
  p.cancel();
  p.cancel();
  late();
  assert.equal(await p.play(), false);
  assert.deepEqual(f.observations[0].finishes, [{ completed: false, error: false }]);
  assert.equal(f.observations[0].events.length, 0);
});
test('preload error finalizes failed observation before later cleanup', async () => {
  const f = fixture(),
    p = f.api.prepareAssistantAudio(ticket());
  f.instances[0].onerror({});
  p.cancel();
  assert.deepEqual(f.observations[0].finishes, [{ completed: false, error: true }]);
});
test('native active stop and stale generation end do not leave observation pending', async () => {
  const f = fixture(),
    p = f.api.prepareAssistantAudio(ticket()),
    done = p.play();
  f.instances[0].onplaying();
  f.state.assistantGeneration++;
  f.instances[0].onended();
  assert.equal(await done, false);
  assert.equal(f.observations[0].finishes.length, 1);
});
test('local speech receives format3 and one onstart observation', async () => {
  const f = fixture(),
    done = f.api.playAssistantAudio({ text: 'Synthetic', audioBase64: null, mimeType: null }),
    u = f.utterances[0];
  u.onstart();
  u.onstart();
  assert.equal(f.observations[0].format, 3);
  assert.equal(f.observations[0].starts, 1);
  u.onend();
  assert.equal(await done, true);
  assert.equal(f.observations[0].finishes.length, 1);
});
test('other native encoded media uses format2 and ordinary end', async () => {
  const f = fixture(),
    done = f.api.playAssistantAudio({
      text: 'Synthetic',
      mimeType: 'audio/wav',
      audioBase64: 'AAAA',
    }),
    m = f.instances[0];
  assert.equal(f.observations[0].format, 2);
  m.onplaying();
  m.onended();
  assert.equal(await done, true);
});

test('actual shared observer works while PCM unsupported, emits native format and preserves first summary', async () => {
  const f = fixture(true);
  assert.equal(f.shared.assistantPlayback().supported(), false);
  const first = f.api.prepareAssistantAudio(ticket()),
    done = first.play(),
    m = f.instances[0];
  m.onplaying();
  m.onwaiting();
  f.shared.recordAssistantAudioDiagnostic('bargePause');
  f.shared.recordAssistantAudioDiagnostic('bargeFalsePause');
  m.onended();
  await done;
  const a = Array.from(f.shared.takeAssistantPlaybackSummary());
  assert.equal(a.length, 24);
  assert.equal(a[0], 2);
  assert.equal(a[2], 1);
  assert.equal(a[20], 2);
  assert.equal(a[6], 1);
  assert.equal(a[7], 1);
  assert.equal(a[18], 1);
  assert.ok(a[22] >= 1);
  assert.ok(a[23] >= 1);
  assert.equal(a[9], 0, 'no native AudioContext state fabricated');
  assert.equal(f.shared.takeAssistantPlaybackSummary(), null);
  const next = f.api.prepareAssistantAudio(ticket()),
    later = next.play(),
    n = f.instances[1];
  n.onplaying();
  n.onended();
  await later;
  assert.equal(f.shared.takeAssistantPlaybackSummary()[2], 0);
});
