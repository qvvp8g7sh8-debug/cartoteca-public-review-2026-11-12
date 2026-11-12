const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture(t) {
  const state = {
      assistantGeneration: 1,
      account: { id: 'owner', organizationId: 'org', role: 'owner' },
    },
    activation = { isActive: false },
    elements = [],
    revoked = [],
    blobs = [],
    timers = new Map();
  let next = 0;
  class Audio {
    constructor(url) {
      this.paused = true;
      this.sources = [];
      this.calls = [];
      this.loads = [];
      elements.push(this);
      if (url) this.src = url;
    }
    set src(value) {
      this.url = value;
      this.sources.push(value);
    }
    get src() {
      return this.url || '';
    }
    setAttribute() {}
    removeAttribute() {
      this.url = '';
    }
    load() {
      this.loads.push(this.url || '');
      // Clearing the resource must not silently preserve a gesture lease in the fixture.
      if (!this.url) this.allowed = false;
    }
    pause() {
      this.paused = true;
      this.onpause?.();
    }
    play() {
      this.calls.push({ active: activation.isActive, url: this.url });
      if (activation.isActive) this.allowed = true;
      if (!this.allowed)
        return Promise.reject(Object.assign(Error('policy'), { name: 'NotAllowedError' }));
      this.paused = false;
      this.onplaying?.();
      if (this.nextPlay) {
        const value = this.nextPlay;
        this.nextPlay = null;
        return value;
      }
      return Promise.resolve();
    }
  }
  const window = {
    Audio,
    ArrayBuffer,
    DataView,
    Float32Array,
    Uint8Array,
    Blob,
    atob: (v) => Buffer.from(v, 'base64').toString('binary'),
    btoa: (v) => Buffer.from(v, 'binary').toString('base64'),
  };
  const api = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window,
    navigator: { userActivation: activation },
    URL: {
      createObjectURL(blob) {
        blobs.push(blob);
        return 'blob:quiet-' + blobs.length;
      },
      revokeObjectURL: (u) => revoked.push(u),
    },
    document: { hidden: false },
    setTimeout(fn) {
      timers.set(++next, fn);
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval() {
      assert.fail('output must not poll');
    },
    clearInterval() {},
    console: { warn() {} },
  })(state, {});
  t.after(() => api.releaseAssistantAudio());
  return {
    api,
    state,
    activation,
    elements,
    revoked,
    blobs,
    timers,
    gesture() {
      activation.isActive = true;
      const promise = api.unlockAssistantAudio();
      activation.isActive = false;
      return promise;
    },
  };
}
const speech = (letter) => ({
  streamUrl:
    '/api/assistant/speak-audio?ticket=' +
    letter.repeat(43) +
    '&accountContext=owner&organizationContext=org',
  mimeType: 'audio/mpeg',
});
test('trusted prime starts inside gesture and async stream replies reuse that same permitted media element', async (t) => {
  const f = fixture(t);
  assert.equal(f.elements.length, 0);
  assert.equal(await f.gesture(), true);
  assert.equal(f.elements.length, 1);
  assert.equal(f.elements[0].calls[0].active, true);
  const bytes = Buffer.from(await f.blobs[0].arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(
    bytes.subarray(44).some((v) => v !== 0),
    false,
  );
  await flush();
  const first = f.api.playAssistantAudio(speech('a'));
  assert.equal(f.elements.length, 1);
  assert.equal(f.elements[0].src, speech('a').streamUrl);
  assert.equal(f.elements[0].calls.at(-1).active, false);
  f.elements[0].onended();
  assert.equal(await first, true);
  const second = f.api.playAssistantAudio(speech('b'));
  assert.equal(f.elements.length, 1);
  assert.equal(f.elements[0].src, speech('b').streamUrl);
  f.elements[0].onended();
  assert.equal(await second, true);
  assert.ok(f.revoked.includes('blob:quiet-1'));
  assert.equal(f.elements[0].playbackRate, 1.4);
});
test('a finished primer retains its valid local source until speech replaces it, then releases it', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const media = f.elements[0],
    primeUrl = media.src,
    finished = media.onended;
  finished();
  assert.equal(media.src, primeUrl);
  assert.equal(media.paused, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.revoked.includes(primeUrl), false);
  assert.equal(media.loads.includes(''), false);
  const speaking = f.api.playAssistantAudio(speech('a'));
  assert.equal(media.src, speech('a').streamUrl);
  assert.equal(f.revoked.filter((url) => url === primeUrl).length, 1);
  media.onended();
  assert.equal(await speaking, true);
  assert.equal(media.src, speech('a').streamUrl);
  assert.equal(media.loads.includes(''), false);
  f.api.releaseAssistantAudio();
  assert.equal(media.src, '');
  assert.equal(media.loads.at(-1), '');
  assert.equal(f.timers.size, 0);
});
test('releasing before speech clears and revokes the retained primer without leaving a timer', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const media = f.elements[0],
    primeUrl = media.src;
  media.onended();
  f.api.releaseAssistantAudio();
  assert.equal(media.src, '');
  assert.equal(media.paused, true);
  assert.equal(f.revoked.filter((url) => url === primeUrl).length, 1);
  assert.equal(f.timers.size, 0);
});
test('late priming event and rejected old playback cannot end a newer streamed reply on reused element', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const media = f.elements[0],
    stalePrime = media.onended;
  let rejectOld;
  media.nextPlay = new Promise((_, reject) => (rejectOld = reject));
  const first = f.api.playAssistantAudio(speech('a')),
    staleEnd = media.onended;
  f.api.stopAssistantAudio();
  assert.equal(await first, false);
  const second = f.api.playAssistantAudio(speech('b'));
  let done = false;
  second.then(() => (done = true));
  stalePrime();
  staleEnd();
  rejectOld(Object.assign(Error('interrupted'), { name: 'AbortError' }));
  await flush();
  assert.equal(done, false);
  assert.equal(media.src, speech('b').streamUrl);
  assert.equal(f.api.assistantAudioPlaying(), true);
  media.onended();
  assert.equal(await second, true);
});
test('preload on a primed element consumes only the current one-use ticket and barge pause/resume retains permission', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const prepared = f.api.prepareAssistantAudio(speech('c'));
  const media = f.elements[0];
  assert.equal(media.sources.filter((v) => v === speech('c').streamUrl).length, 1);
  const playing = prepared.play();
  assert.equal(await f.api.pauseAssistantAudio(), true);
  assert.equal(f.api.resumeAssistantAudio(), true);
  assert.equal(f.elements.length, 1);
  assert.equal(media.sources.filter((v) => v === speech('c').streamUrl).length, 1);
  media.onended();
  assert.equal(await playing, true);
  prepared.cancel();
});
test('scope changes release the old lease and no-user-activation cannot create a replacement', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const old = f.elements[0];
  f.state.account = { id: 'other', organizationId: 'other-org', role: 'owner' };
  f.state.assistantGeneration++;
  assert.equal(await f.api.unlockAssistantAudio(), false);
  assert.equal(f.elements.length, 1);
  assert.equal(await f.gesture(), true);
  assert.equal(f.elements.length, 2);
  assert.equal(old.src, '');
  f.api.releaseAssistantAudio();
  assert.equal(f.timers.size, 0);
  assert.equal(f.elements[1].src, '');
});
test('a rejected mobile autoplay has an actionable resume message rather than silently reporting completion', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.api.playAssistantAudio(speech('a')),
    (error) => error.code === 'ASSISTANT_AUDIO_GESTURE_REQUIRED' && /Озвучить/.test(error.message),
  );
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(f.elements.length, 1);
});
test('a blocked warmed media lease retries play inside the next manual gesture', async (t) => {
  const f = fixture(t);
  await f.gesture();
  const media = f.elements[0];
  media.allowed = false;
  await assert.rejects(
    f.api.playAssistantAudio(speech('a')),
    (error) => error.code === 'ASSISTANT_AUDIO_GESTURE_REQUIRED',
  );
  const beforeRetry = media.calls.length;
  assert.equal(await f.gesture(), true);
  assert.equal(media.calls.length, beforeRetry + 1);
  assert.equal(media.calls.at(-1).active, true);
  assert.equal(f.elements.length, 1);
  const retry = f.api.playAssistantAudio(speech('b'));
  assert.equal(media.calls.at(-1).active, false);
  media.onended();
  assert.equal(await retry, true);
});
