const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.resolve(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(t) {
  let next = 0;
  const audios = [],
    timers = new Map(),
    events = new Map();
  const window = {
    Audio: class {
      constructor(url) {
        this.url = url;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.loadCalls = 0;
        this.paused = false;
        this.resumePromise = new Promise((resolve, reject) => {
          this.resolveResume = resolve;
          this.rejectResume = reject;
        });
        audios.push(this);
      }
      play() {
        this.playCalls++;
        this.paused = false;
        if (this.playCalls === 1) {
          this.onplaying?.();
          return Promise.resolve();
        }
        return this.resumePromise;
      }
      pause() {
        this.pauseCalls++;
        this.paused = true;
        this.onpause?.();
      }
      removeAttribute(name) {
        assert.equal(name, 'src');
        this.url = '';
      }
      load() {
        this.loadCalls++;
      }
    },
    addEventListener(type, fn) {
      events.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (events.get(type) === fn) events.delete(type);
    },
  };
  const state = { assistantGeneration: 1 };
  const factory = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window,
    navigator: {},
    URL,
    setTimeout(fn) {
      timers.set(++next, fn);
      return next;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval() {
      throw Error('Playback must not allocate microphone polling');
    },
    clearInterval() {},
  });
  const api = factory(state, {});
  // Audio resources belong to the panel/host; model that existing pagehide stop
  // without asserting that this leaf audio factory registers a global handler.
  const leave = () => {
    state.assistantGeneration++;
    api.stopAssistantAudio();
  };
  window.addEventListener('pagehide', leave);
  t.after(() => {
    api.stopAssistantAudio();
    window.removeEventListener('pagehide', leave);
    for (const audio of audios) audio.resolveResume();
  });
  const start = () =>
    api.playAssistantAudio({
      streamUrl:
        '/api/assistant/speak-audio?ticket=' +
        'a'.repeat(43) +
        '&accountContext=&organizationContext=',
      text: 'Синтетический вопрос',
      mimeType: 'audio/mpeg',
    });
  return { api, audios, timers, start, pagehide: () => events.get('pagehide')?.() };
}

for (const outcome of ['reject', 'resolve']) {
  test(`late ${outcome} from resumed audio A cannot stop replacement playback B`, async (t) => {
    const f = fixture(t),
      first = f.start(),
      a = f.audios[0];
    assert.equal(f.api.resumeAssistantAudio(), true);
    const second = f.start(),
      b = f.audios[1];
    assert.equal(await first, false);
    let secondDone = false;
    const observed = second.then((value) => {
      secondDone = true;
      return value;
    });
    if (outcome === 'reject') a.rejectResume(Error('Synthetic old resume rejected'));
    else a.resolveResume();
    await flush();
    assert.equal(f.api.assistantAudioPlaying(), true);
    assert.equal(secondDone, false);
    assert.equal(b.pauseCalls, 0);
    assert.equal(b.loadCalls, 0);
    b.onended();
    assert.equal(await observed, true);
    assert.equal(f.api.assistantAudioPlaying(), false);
    assert.equal(f.timers.size, 0);
  });
}

test('explicit stop followed by a late resume rejection stays idle and allocates no replacement audio', async (t) => {
  const f = fixture(t),
    played = f.start(),
    a = f.audios[0];
  f.api.resumeAssistantAudio();
  f.api.stopAssistantAudio();
  assert.equal(await played, false);
  const cleanup = { pause: a.pauseCalls, load: a.loadCalls };
  a.rejectResume(Error('Synthetic stopped resume rejected'));
  await flush();
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(f.audios.length, 1);
  assert.deepEqual({ pause: a.pauseCalls, load: a.loadCalls }, cleanup);
  assert.equal(f.timers.size, 0);
});

test('pagehide owner cleanup fences an old resume before a later playback begins', async (t) => {
  const f = fixture(t),
    first = f.start(),
    a = f.audios[0];
  f.api.resumeAssistantAudio();
  f.pagehide();
  assert.equal(await first, false);
  const second = f.start(),
    b = f.audios[1];
  a.rejectResume(Error('Synthetic old page resume rejected'));
  await flush();
  assert.equal(f.api.assistantAudioPlaying(), true);
  assert.equal(b.pauseCalls, 0);
  b.onended();
  assert.equal(await second, true);
  assert.equal(f.timers.size, 0);
});

test('a current playback resume failure still ends that playback while an older resume settles later', async (t) => {
  const f = fixture(t),
    first = f.start(),
    a = f.audios[0];
  f.api.resumeAssistantAudio();
  const second = f.start(),
    b = f.audios[1];
  assert.equal(await first, false);
  f.api.resumeAssistantAudio();
  b.rejectResume(Error('Synthetic current resume rejected'));
  assert.equal(await second, false);
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(b.pauseCalls, 1);
  assert.equal(b.loadCalls, 1);
  a.resolveResume();
  await flush();
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(b.pauseCalls, 1);
  assert.equal(f.timers.size, 0);
});
