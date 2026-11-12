const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
const streamed = (letter = 'a') => ({
  streamUrl:
    '/api/assistant/speak-audio?ticket=' +
    letter.repeat(43) +
    '&accountContext=synthetic-a&organizationContext=synthetic-org',
  mimeType: 'audio/mpeg',
});
function fixture(t, request = async () => ({})) {
  const state = {
    assistantGeneration: 1,
    multiUser: true,
    account: { id: 'synthetic-a', organizationId: 'synthetic-org', role: 'owner' },
  };
  const elements = [],
    spoken = [],
    revoked = [],
    probes = [];
  class Audio {
    constructor(url) {
      this.paused = true;
      this.plays = 0;
      this.resources = [];
      this.loads = 0;
      elements.push(this);
      if (url !== undefined) this.src = url;
    }
    set src(value) {
      this.url = value;
      if (value) this.resources.push(value);
    }
    get src() {
      return this.url || '';
    }
    load() {
      this.loads++;
    }
    play() {
      this.plays++;
      this.onplaying?.();
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.onpause?.();
    }
    removeAttribute(name) {
      assert.equal(name, 'src');
      this.url = '';
      this.detached = true;
    }
  }
  const window = {
    Audio,
    ArrayBuffer,
    DataView,
    Float32Array,
    Uint8Array,
    Blob,
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    speechSynthesis: {
      getVoices: () => [{ localService: true, lang: 'ru-RU' }],
      speak: (value) => spoken.push(value),
      cancel() {},
    },
  };
  const api = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window,
    navigator: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL: {
      createObjectURL: () => 'blob:synthetic-audio',
      revokeObjectURL: (url) => revoked.push(url),
    },
  })(state, {
    request: async (route, options) => {
      probes.push({ route, options, account: { ...state.account } });
      return request(route, options);
    },
  });
  t.after(() => api.stopAssistantAudio());
  return { state, api, elements, spoken, revoked, probes };
}

test('preload starts the current stream once without audible playback and play reuses its media resource', async (t) => {
  const f = fixture(t),
    reply = streamed();
  const prepared = f.api.prepareAssistantAudio(reply);
  assert.equal(f.elements.length, 1);
  const audio = f.elements[0];
  assert.deepEqual(audio.resources, [reply.streamUrl]);
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.loads, 1);
  assert.equal(audio.plays, 0);
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(await f.api.pauseAssistantAudio(), false);
  assert.equal(f.api.resumeAssistantAudio(), false);
  const playing = prepared.play();
  assert.equal(f.elements.length, 1);
  assert.equal(audio.loads, 1, 'play must not reload an already consumed one-use ticket');
  assert.deepEqual(audio.resources, [reply.streamUrl]);
  assert.equal(audio.plays, 1);
  assert.equal(audio.playbackRate, 1.4);
  assert.equal(audio.preservesPitch, true);
  assert.equal(f.api.assistantAudioPlaying(), true);
  audio.onended();
  assert.equal(await playing, true);
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(audio.detached, true);
  assert.deepEqual(f.revoked, []);
});

test('cancel releases an unplayed stream and an obsolete handle cannot stop its replacement', async (t) => {
  const f = fixture(t),
    first = f.api.prepareAssistantAudio(streamed());
  first.cancel();
  assert.equal(f.elements[0].detached, true);
  assert.equal(await first.play(), false);
  assert.equal(f.elements[0].plays, 0);
  const current = f.api.prepareAssistantAudio(streamed('b'));
  const playing = current.play();
  first.cancel();
  assert.equal(f.api.assistantAudioPlaying(), true);
  assert.equal(f.elements[1].detached || false, false);
  f.elements[1].onended();
  assert.equal(await playing, true);
});

test('stop or changed assistant generation prevents a prepared stream from playing later', async (t) => {
  for (const change of ['stop', 'generation']) {
    const f = fixture(t),
      prepared = f.api.prepareAssistantAudio(streamed());
    if (change === 'stop') f.api.stopAssistantAudio();
    else f.state.assistantGeneration++;
    assert.equal(await prepared.play(), false, change);
    assert.equal(f.elements[0].plays, 0, change);
    assert.equal(f.elements[0].detached, true, change);
    assert.equal(f.api.assistantAudioPlaying(), false, change);
  }
});

test('a preload error is reported at play and stale native callbacks cannot finish a newer stream', async (t) => {
  const f = fixture(t),
    failed = f.api.prepareAssistantAudio(streamed());
  const oldError = f.elements[0].onerror;
  oldError();
  await assert.rejects(
    Promise.resolve().then(() => failed.play()),
    /воспроизвести/,
  );
  assert.equal(f.elements[0].plays, 0);
  const current = f.api.prepareAssistantAudio(streamed('b'));
  const playing = current.play();
  oldError();
  assert.equal(f.api.assistantAudioPlaying(), true);
  f.elements[1].onended();
  assert.equal(await playing, true);
});

test('preload rejects external or ambiguous stream URLs before creating native media', (t) => {
  const f = fixture(t),
    ticket = 'a'.repeat(43);
  for (const url of [
    'https://external.invalid/api/assistant/speak-audio?ticket=' + ticket,
    '//external.invalid/api/assistant/speak-audio?ticket=' + ticket,
    '/api/assistant/speak-audio?ticket=' + ticket + '&other=1',
    '/api/assistant/speak-audio?ticket=' + ticket + '#fragment',
    '/api/assistant/speak-audio?ticket=' + 'a'.repeat(42),
    streamed().streamUrl + '&extra=1',
    streamed().streamUrl + '&accountContext=synthetic-a',
    streamed().streamUrl + '&organizationContext=synthetic-org',
    streamed().streamUrl + '#fragment',
    streamed().streamUrl.replace('accountContext=synthetic-a', 'accountContext=%'),
    'javascript:alert(1)',
  ])
    assert.throws(() => f.api.prepareAssistantAudio({ streamUrl: url }), /воспроизвести/);
  assert.throws(
    () => f.api.prepareAssistantAudio({ ...streamed(), audioBase64: 'YQ==' }),
    /воспроизвести/,
  );
  assert.equal(f.elements.length, 0);
});

test('local and buffered replies retain their normal playback and never use stream preload', async (t) => {
  const f = fixture(t);
  const local = { audioBase64: null, text: 'Синтетический вопрос', local: true };
  const buffered = { audioBase64: 'YQ==', mimeType: 'audio/wav' };
  assert.equal(f.api.prepareAssistantAudio(local), null);
  assert.equal(f.api.prepareAssistantAudio(buffered), null);
  assert.equal(f.elements.length, 0);
  const voice = f.api.playAssistantAudio(local);
  assert.equal(f.spoken.length, 1);
  f.spoken[0].onend();
  assert.equal(await voice, true);
  const audio = f.api.playAssistantAudio(buffered);
  assert.equal(f.elements.length, 1);
  f.elements[0].onended();
  assert.equal(await audio, true);
  assert.deepEqual(f.revoked, ['blob:synthetic-audio']);
});

test('a native ticket remains bound to its issuing account and cannot be rebound after an account switch', async (t) => {
  const f = fixture(t),
    original = streamed();
  const prepared = f.api.prepareAssistantAudio(original);
  assert.equal(f.elements[0].src, original.streamUrl);
  f.state.account = { id: 'synthetic-b', organizationId: 'other-org', role: 'owner' };
  assert.equal(await prepared.play(), false);
  assert.equal(f.elements[0].plays, 0);
  assert.throws(() => f.api.prepareAssistantAudio(original), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.throws(() => f.api.playAssistantAudio(original), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.equal(f.elements.length, 1, 'the old URL must not be assigned to a new media resource');
  assert.equal(f.probes.length, 0);
});

for (const preload of [false, true]) {
  test(`native ${preload ? 'preload' : 'active playback'} failure checks scope once and preserves terminal428 without a new speech request`, async (t) => {
    let rejectProbe;
    const refusal = Object.assign(Error('Synthetic cookie B'), {
      status: 428,
      code: 'AUTH_CONTEXT_CHANGED',
      outcomeUnknown: false,
    });
    const f = fixture(
      t,
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject;
        }),
    );
    const prepared = preload ? f.api.prepareAssistantAudio(streamed()) : null;
    let playing = preload ? null : f.api.playAssistantAudio(streamed());
    const media = f.elements[0],
      failed = media.onerror;
    failed();
    failed();
    if (preload) playing = prepared.play();
    const rejected = assert.rejects(playing, (error) => error === refusal);
    assert.equal(f.probes.length, 1);
    assert.equal(f.probes[0].route, '/api/assistant/scope');
    assert.equal(f.probes[0].options.assistantRequest, true);
    assert.equal(f.probes[0].account.id, 'synthetic-a');
    rejectProbe(refusal);
    await rejected;
    assert.equal(f.elements.length, 1);
    assert.equal(media.plays, preload ? 0 : 1);
    assert.deepEqual(media.resources, [streamed().streamUrl]);
    assert.equal(media.detached, true);
    assert.equal(f.spoken.length, 0);
  });
}

test('a late native error after a local account switch drops old playback without probing or disturbing the new account', async (t) => {
  const f = fixture(t),
    old = f.api.playAssistantAudio(streamed());
  const staleError = f.elements[0].onerror;
  f.state.account = { id: 'synthetic-b', organizationId: 'other-org', role: 'owner' };
  const next = {
    ...streamed('b'),
    streamUrl: streamed('b')
      .streamUrl.replace('accountContext=synthetic-a', 'accountContext=synthetic-b')
      .replace('organizationContext=synthetic-org', 'organizationContext=other-org'),
  };
  const playing = f.api.playAssistantAudio(next);
  staleError();
  assert.equal(await old, false);
  assert.equal(f.probes.length, 0);
  assert.equal(f.api.assistantAudioPlaying(), true);
  f.elements[1].onended();
  assert.equal(await playing, true);
});

test('a slow native failure probe cannot apply its terminal result to a replacement account', async (t) => {
  let rejectProbe;
  const f = fixture(
    t,
    () =>
      new Promise((_resolve, reject) => {
        rejectProbe = reject;
      }),
  );
  const old = f.api.playAssistantAudio(streamed());
  f.elements[0].onerror();
  f.state.account = { id: 'synthetic-b', organizationId: 'other-org', role: 'owner' };
  const current = f.api.playAssistantAudio({
    ...streamed('b'),
    streamUrl: streamed('b')
      .streamUrl.replace('synthetic-a', 'synthetic-b')
      .replace('synthetic-org', 'other-org'),
  });
  rejectProbe(
    Object.assign(Error('Old scope rejected'), { status: 428, code: 'AUTH_CONTEXT_CHANGED' }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await old, false);
  assert.equal(f.api.assistantAudioPlaying(), true);
  f.elements[1].onended();
  assert.equal(await current, true);
  assert.equal(f.probes.length, 1);
});

test('old native completion after a local account switch cannot report a successful current response', async (t) => {
  const f = fixture(t),
    playing = f.api.playAssistantAudio(streamed());
  f.state.account = { id: 'synthetic-b', organizationId: 'other-org', role: 'owner' };
  f.elements[0].onended();
  assert.equal(await playing, false);
  assert.equal(f.probes.length, 0);
});

test('an ordinary native media error makes only a free scope probe and never regenerates speech', async (t) => {
  const f = fixture(t),
    playing = f.api.playAssistantAudio(streamed());
  const rejected = assert.rejects(playing, /воспроизвести/);
  f.elements[0].onerror();
  await rejected;
  assert.deepEqual(
    f.probes.map((call) => call.route),
    ['/api/assistant/scope'],
  );
  assert.equal(f.elements.length, 1);
  assert.equal(f.elements[0].plays, 1);
  assert.equal(f.spoken.length, 0);
});
