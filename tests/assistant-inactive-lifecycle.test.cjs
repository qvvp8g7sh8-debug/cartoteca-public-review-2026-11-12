const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  fixture: bookingFixture,
  reply,
  deferred,
  flush,
} = require('./helpers/assistant-voice-booking-fixture.cjs');

function fixture(t, realAudio = false) {
  const f = bookingFixture(t);
  let hidden = false;
  Object.defineProperty(f.w.document, 'hidden', { configurable: true, get: () => hidden });
  const pending = new Set(),
    aborted = [];
  const request = f.actions.request;
  f.actions.request = (route, options) => {
    const entry = { route, signal: options.signal };
    pending.add(entry);
    let interrupt;
    const task = new Promise((resolve, reject) => {
      interrupt = () => {
        aborted.push(entry);
        reject(
          Object.assign(Error('Synthetic request interrupted'), {
            outcomeUnknown: options.method === 'POST',
          }),
        );
      };
      if (options.signal.aborted) return interrupt();
      options.signal.addEventListener('abort', interrupt, { once: true });
      Promise.resolve()
        .then(() => request(route, options))
        .then(resolve, reject);
    });
    return task.finally(() => {
      options.signal.removeEventListener('abort', interrupt);
      pending.delete(entry);
    });
  };
  const audio = realAudio ? installAudio(f) : null;
  return Object.assign(f, {
    audio,
    network: { pending, aborted },
    async hide(value = true) {
      hidden = value;
      f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
      await flush();
    },
    async sendText(text) {
      const input = f.$('[data-assistant-input-wrap]').hidden
        ? f.$('[data-assistant-text]')
        : f.$('[data-assistant-input]');
      input.value = text;
      f.$('.voice-assistant-dialog form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
    },
  });
}

// Exercise the actual capture/playback factory; only the physical devices are synthetic.
function installAudio(f) {
  const w = f.w,
    clock = new Map(),
    recorders = [],
    contexts = [],
    players = [];
  let timerId = 0;
  w.setTimeout = (fn, delay = 0) => {
    clock.set(++timerId, { fn, delay, repeating: false });
    return timerId;
  };
  w.clearTimeout = (id) => clock.delete(id);
  w.setInterval = (fn, delay) => {
    clock.set(++timerId, { fn, delay, repeating: true });
    return timerId;
  };
  w.clearInterval = (id) => clock.delete(id);
  const tracks = [],
    streams = [],
    blobUrls = [],
    revokedUrls = [];
  function microphoneStream() {
    const listeners = new Set();
    const track = {
      kind: 'audio',
      readyState: 'live',
      stopped: false,
      stops: 0,
      stop() {
        this.stopped = true;
        this.stops++;
        this.readyState = 'ended';
      },
      addEventListener(name, callback) {
        if (name === 'ended') listeners.add(callback);
      },
      removeEventListener(name, callback) {
        if (name === 'ended') listeners.delete(callback);
      },
      getSettings: () => ({ echoCancellation: true }),
      getCapabilities: () => ({ echoCancellation: [true, false] }),
    };
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      clone: () => microphoneStream(),
    };
    tracks.push(track);
    streams.push(stream);
    return stream;
  }
  const media = microphoneStream(),
    track = media.getAudioTracks()[0];
  w.URL.createObjectURL = () => {
    const url = 'blob:synthetic-primer-' + (blobUrls.length + 1);
    blobUrls.push(url);
    return url;
  };
  w.URL.revokeObjectURL = (url) => revokedUrls.push(url);
  const permission = { get: async () => media, requests: 0 };
  Object.defineProperty(w.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia() {
        permission.requests++;
        return permission.get();
      },
    },
  });
  w.MediaRecorder = class {
    static isTypeSupported() {
      return true;
    }
    constructor(media) {
      this.media = media;
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      this.starts = 0;
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
      this.starts++;
    }
    stop() {
      this.state = 'inactive';
      this.onstop?.();
    }
  };
  const node = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
  w.AudioContext = class {
    constructor() {
      this.state = 'running';
      this.destination = {};
      contexts.push(this);
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return node();
    }
    createAnalyser() {
      return { ...node(), fftSize: 2048, getFloatTimeDomainData: (values) => values.fill(0) };
    }
    close() {
      this.state = 'closed';
      return Promise.resolve();
    }
  };
  w.Audio = class {
    constructor(url) {
      this.sources = [];
      this.playedSources = [];
      this.src = url || '';
      this.active = false;
      this.loads = 0;
      players.push(this);
    }
    set src(value) {
      this.url = value;
      this.sources.push(value);
    }
    get src() {
      return this.url;
    }
    play() {
      this.active = true;
      this.playedSources.push(this.src);
      this.onplaying?.();
      return Promise.resolve();
    }
    pause() {
      this.active = false;
      this.onpause?.();
    }
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    }
    load() {
      this.loads++;
    }
  };
  w.eval(
    fs.readFileSync(path.resolve(__dirname, '../src/client/modules/assistant-audio.js'), 'utf8'),
  );
  Object.assign(f.actions, w.eval('createAssistantAudio')(f.state, f.actions));
  return {
    clock,
    track,
    tracks,
    streams,
    blobUrls,
    revokedUrls,
    permission,
    recorders,
    contexts,
    players,
    activePlayers: () => players.filter((p) => p.active).length,
    liveContexts: () => contexts.filter((c) => c.state !== 'closed').length,
  };
}
const streamReply = () => ({
  policyVersion: 1,
  streamUrl:
    '/api/assistant/speak-audio?ticket=' +
    'a'.repeat(43) +
    '&accountContext=staff&organizationContext=org',
});
const plainReply = () => ({ policyVersion: 1, text: 'Синтетический вопрос.', action: null });
const calls = (f, route) => f.calls.filter((c) => c.route === '/api/assistant/' + route);
const noSave = (f) => assert.ok(f.calls.every((c) => c.route.startsWith('/api/assistant/')));
async function prepareManualSpeech(f) {
  f.control.turn = async () => plainReply();
  await f.keyboard();
  await f.sendText('Покажи свободное время');
}

// Expected RED before hidden-lifecycle repair: manual capture is not voiceEnabled.
test('hidden cancels pending manual microphone permission and stops late tracks without recording or STT', async (t) => {
  const f = fixture(t, true),
    permission = deferred();
  f.audio.permission.get = () => permission.promise;
  await f.keyboard();
  f.$('[data-assistant-mic]').click();
  await flush();
  assert.equal(f.audio.permission.requests, 1);
  await f.hide();
  permission.resolve({ getTracks: () => [f.audio.track] });
  await flush();
  assert.equal(f.audio.track.stopped, true);
  assert.equal(
    f.audio.recorders.reduce((n, r) => n + r.starts, 0),
    0,
  );
  assert.equal(calls(f, 'transcribe').length, 0);
  assert.equal(f.audio.clock.size, 0);
  noSave(f);
});

test('hidden discards active manual capture and its deadline instead of transcribing background audio', async (t) => {
  const f = fixture(t, true);
  await f.keyboard();
  f.$('[data-assistant-mic]').click();
  await flush();
  assert.equal(f.audio.recorders[0].state, 'recording');
  await f.hide();
  assert.equal(f.audio.recorders[0].state, 'inactive');
  assert.equal(f.audio.track.stopped, true);
  assert.equal(f.audio.clock.size, 0);
  assert.equal(calls(f, 'transcribe').length, 0);
  assert.equal(f.$('[data-assistant-mic]').getAttribute('aria-pressed'), 'false');
  noSave(f);
});

test('hidden aborts manual TTS and a late response cannot start native audio', async (t) => {
  const f = fixture(t, true),
    gate = deferred();
  await prepareManualSpeech(f);
  f.control.speak = () => gate.promise;
  f.$('[data-assistant-speak]').click();
  await flush();
  const request = calls(f, 'speak')[0];
  assert.ok(request);
  assert.equal(
    f.audio.players.length,
    1,
    'the explicit Speak click primes one local media element',
  );
  const primer = f.audio.players[0];
  const playedBeforeHide = [...primer.playedSources];
  assert.equal(playedBeforeHide.length, 1);
  assert.match(playedBeforeHide[0], /^blob:synthetic-primer-/);
  await f.hide();
  const wasAborted = request.options.signal.aborted;
  assert.equal(f.audio.activePlayers(), 0);
  assert.equal(primer.src, '');
  assert.equal(f.audio.clock.size, 0);
  assert.deepEqual(f.audio.revokedUrls, f.audio.blobUrls);
  gate.resolve(streamReply());
  await flush();
  assert.equal(wasAborted, true);
  assert.equal(f.audio.players.length, 1, 'the late TTS reply must not allocate another player');
  assert.deepEqual(
    primer.playedSources,
    playedBeforeHide,
    'the late TTS reply must never call play',
  );
  assert.equal(
    f.audio.players.some((player) =>
      player.sources.some((src) => /^\/api\/assistant\/speak-audio/.test(src)),
    ),
    false,
    'a late reply must not install a ticket URL or initiate its native media request',
  );
  assert.equal(f.audio.activePlayers(), 0);
  assert.equal(f.audio.clock.size, 0);
  assert.equal(f.network.pending.size, 0);
  assert.equal(calls(f, 'execute').length, 0);
  noSave(f);
});

test('hidden detaches an already playing manual stream and clears playback ownership', async (t) => {
  const f = fixture(t, true);
  await prepareManualSpeech(f);
  f.control.speak = async () => streamReply();
  f.$('[data-assistant-speak]').click();
  await flush();
  assert.equal(f.audio.activePlayers(), 1);
  await f.hide();
  assert.equal(f.audio.activePlayers(), 0);
  assert.equal(f.audio.players[0].src, '');
  assert.ok(f.audio.players[0].loads > 0);
  assert.equal(f.network.pending.size, 0);
  noSave(f);
});

test('hidden aborts in-flight STT rather than merely ignoring its paid response', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.control.stt = () => gate.promise;
  await f.keyboard();
  f.$('[data-assistant-voice]').click();
  await flush();
  const completed = f.captures[0].complete('synthetic-wav', { autoStopped: true });
  await flush();
  const request = calls(f, 'transcribe')[0];
  assert.ok(request);
  await f.hide();
  const wasAborted = request.options.signal.aborted;
  gate.resolve({ text: 'Поздняя синтетическая команда', policyVersion: 1 });
  await completed;
  assert.equal(wasAborted, true);
  assert.equal(f.network.pending.size, 0);
  assert.equal(calls(f, 'turn').length, 0);
  assert.equal(f.opened.length, 0);
  noSave(f);
});

test('hidden turn abort retains the exact dialogue version for one explicit retry and fences its late response', async (t) => {
  const f = fixture(t),
    gate = deferred();
  t.after(() => gate.resolve(reply(99, 'date', { field: 'date' })));
  f.control.turn = async () => reply(7, 'date', { field: 'date' });
  await f.keyboard();
  await f.sendText('Запиши Анну Синтетическую');
  f.control.turn = () => gate.promise;
  f.$('[data-assistant-voice]').click();
  await flush();
  const completed = f.transcript('завтра');
  await flush();
  const interrupted = calls(f, 'turn')[1];
  assert.equal(interrupted.body.dialogueVersion, 7);
  assert.equal(interrupted.body.text, 'завтра');
  await f.hide();
  assert.equal(interrupted.options.signal.aborted, true);
  await completed;
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  assert.match(f.$('[data-assistant-conversation]').textContent, /Анна Синтетическая/);
  await f.hide(false);
  assert.equal(calls(f, 'turn').length, 2, 'visibility itself must never replay a command');
  f.control.turn = async () => reply(8, 'date', { field: 'date' });
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.deepEqual(calls(f, 'turn')[2].body, interrupted.body);
  assert.equal(calls(f, 'transcribe').length, 1);
  gate.resolve(reply(99, 'date', { field: 'date' }));
  await flush();
  assert.ok(f.$('[data-assistant-choice="opaque-option-8"]'));
  assert.equal(f.$('[data-assistant-choice="opaque-option-99"]'), null);
  assert.equal(f.opened.length, 0);
  noSave(f);
});

for (const ending of ['close', 'pagehide', 'destroy']) {
  const end = (f) => {
    if (ending === 'close') f.$('[data-assistant-close]').click();
    else if (ending === 'pagehide') f.w.dispatchEvent(new f.w.Event('pagehide'));
    else f.api.destroyVoiceAssistant();
  };
  test(
    ending + ' stops a late manual getUserMedia result without creating a recorder',
    async (t) => {
      const f = fixture(t, true),
        gate = deferred();
      f.audio.permission.get = () => gate.promise;
      await f.keyboard();
      f.$('[data-assistant-mic]').click();
      await flush();
      end(f);
      gate.resolve({ getTracks: () => [f.audio.track] });
      await flush();
      assert.equal(f.audio.track.stopped, true);
      assert.equal(f.audio.recorders.length, 0);
      assert.equal(f.audio.clock.size, 0);
      assert.equal(f.network.pending.size, 0);
      noSave(f);
    },
  );
  test(
    ending + ' releases the real automatic-capture factory monitor, tracks and timers',
    async (t) => {
      const f = fixture(t, true);
      await f.keyboard();
      f.$('[data-assistant-voice]').click();
      await flush();
      assert.equal(f.audio.liveContexts(), 1);
      assert.equal(f.audio.recorders[0].state, 'recording');
      assert.equal(f.audio.permission.requests, 1);
      assert.equal(f.audio.tracks.length, 2, 'one root track and one independent capture clone');
      assert.notEqual(f.audio.recorders[0].media.getAudioTracks()[0], f.audio.track);
      assert.ok(f.audio.tracks.every((track) => track.readyState === 'live'));
      assert.ok(f.audio.clock.size >= 2, 'silence monitor and capture deadline are active');
      end(f);
      await flush();
      assert.equal(f.audio.liveContexts(), 0);
      assert.equal(f.audio.track.stopped, true);
      assert.ok(
        f.audio.tracks.every((track) => track.stopped && track.readyState === 'ended'),
        'root and every consumer clone must end',
      );
      assert.equal(f.audio.recorders[0].state, 'inactive');
      assert.equal(f.audio.clock.size, 0);
      assert.equal(f.network.pending.size, 0);
      assert.equal(calls(f, 'transcribe').length, 0);
      noSave(f);
    },
  );
}
