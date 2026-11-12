const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/assistant-audio.js'),
  'utf8',
);
function fixture(confirmPause) {
  const timers = new Map();
  let id = 0,
    current;
  const calls = { pause: 0, resume: 0, cancel: 0 };
  const window = {
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    speechSynthesis: {
      getVoices: () => [{ localService: true, lang: 'ru-RU' }],
      speak: (value) => {
        current = value;
      },
      pause() {
        calls.pause++;
        if (confirmPause) current.onpause?.();
      },
      resume() {
        calls.resume++;
      },
      cancel() {
        calls.cancel++;
      },
    },
  };
  const factory = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window,
    navigator: {},
    URL,
    setTimeout: (callback) => {
      const value = ++id;
      timers.set(value, callback);
      return value;
    },
    clearTimeout: (value) => timers.delete(value),
    setInterval,
    clearInterval,
  });
  return {
    api: factory({ assistantGeneration: 1 }, {}),
    calls,
    timers,
    start: () => current.onstart?.(),
  };
}
test('native TTS pause is acknowledged by its pause event and cancel fences an unresolved barge pause', async () => {
  const f = fixture(true),
    played = f.api.playAssistantAudio({ text: 'Синтетический вопрос', audioBase64: null });
  assert.equal(f.api.assistantAudioPlaying(), false);
  f.start();
  assert.equal(f.api.assistantAudioPlaying(), true);
  assert.equal(await f.api.pauseAssistantAudio(), true);
  assert.equal(f.api.resumeAssistantAudio(), true);
  f.api.stopAssistantAudio();
  assert.equal(await played, false);
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(f.calls.pause, 1);
  assert.equal(f.calls.resume, 1);
  assert.equal(f.timers.size, 0);
  const g = fixture(false),
    other = g.api.playAssistantAudio({ text: 'Вопрос', audioBase64: null });
  g.start();
  const pending = g.api.pauseAssistantAudio();
  g.api.stopAssistantAudio();
  assert.equal(await pending, false);
  assert.equal(await other, false);
  assert.equal(g.timers.size, 0);
});
test('an unacknowledged native pause times out and resumes instead of treating echoed speech as a takeover', async () => {
  const f = fixture(false),
    played = f.api.playAssistantAudio({ text: 'Вопрос', audioBase64: null });
  f.start();
  const pending = f.api.pauseAssistantAudio();
  for (const callback of [...f.timers.values()]) callback();
  assert.equal(await pending, false);
  assert.equal(f.calls.resume, 1);
  assert.equal(f.api.assistantAudioPlaying(), true);
  f.api.stopAssistantAudio();
  assert.equal(await played, false);
});

function pendingMediaFixture() {
  const calls = { pause: 0, abort: 0, warnings: [] },
    elements = [];
  let current, resolvePlay, rejectPlay;
  class Audio {
    constructor() {
      current = this;
      elements.push(this);
      this.started = false;
      this.paused = true;
      this.readyState = 1;
      this.networkState = 2;
    }
    play() {
      this.paused = false;
      if (this.started) return Promise.resolve();
      return new Promise((resolve, reject) => {
        resolvePlay = resolve;
        rejectPlay = reject;
      });
    }
    pause() {
      calls.pause++;
      this.paused = true;
      if (!this.started && rejectPlay) {
        calls.abort++;
        const reject = rejectPlay;
        rejectPlay = null;
        reject(Object.assign(Error('Synthetic pending media pause'), { name: 'AbortError' }));
      }
      this.onpause?.();
    }
    removeAttribute() {}
    load() {}
  }
  const factory = vm.runInNewContext(source + '\ncreateAssistantAudio', {
    window: { Audio },
    navigator: {},
    URL,
    document: { hidden: false },
    console: { warn: (...args) => calls.warnings.push(args) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  const api = factory({ assistantGeneration: 1 }, {});
  return {
    api,
    calls,
    elements,
    start() {
      current.started = true;
      current.readyState = 3;
      current.onplaying?.();
      resolvePlay?.();
    },
    end() {
      current.onended?.();
    },
    reject(error) {
      rejectPlay?.(error);
    },
    get media() {
      return current;
    },
  };
}
const stream = {
  streamUrl:
    '/api/assistant/speak-audio?ticket=' + 's'.repeat(43) + '&accountContext=&organizationContext=',
};

test('a pending native play cannot be paused by barge-in before actual audio starts', async () => {
  const f = pendingMediaFixture();
  let earlyError = null;
  const playback = f.api.playAssistantAudio(stream).catch((error) => {
    earlyError = error;
    return false;
  });
  const pause = await f.api.pauseAssistantAudio();
  await Promise.resolve();
  const before = {
    pause,
    abort: f.calls.abort,
    error: earlyError,
    playing: f.api.assistantAudioPlaying(),
  };
  f.start();
  f.end();
  await playback;
  assert.equal(before.error, null, 'an early barge pause must not abort the pending play promise');
  assert.equal(before.abort, 0);
  assert.equal(before.pause, false);
  assert.equal(before.playing, false);
});

test('actual native start retains acknowledged barge pause resume and EOF ownership', async () => {
  const f = pendingMediaFixture();
  const played = f.api.playAssistantAudio(stream);
  f.start();
  assert.equal(f.api.assistantAudioPlaying(), true);
  assert.equal(await f.api.pauseAssistantAudio(), true);
  assert.equal(f.api.resumeAssistantAudio(), true);
  assert.equal(f.calls.abort, 0);
  f.end();
  assert.equal(await played, true);
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(f.calls.warnings.length, 0);
});

test('queued local synthesis is not barge-pausable until its own onstart', async () => {
  const f = fixture(true);
  const played = f.api.playAssistantAudio({ text: 'Синтетический вопрос', audioBase64: null });
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(await f.api.pauseAssistantAudio(), false);
  assert.equal(f.calls.pause, 0);
  assert.equal(f.timers.size, 0);
  f.start();
  assert.equal(f.api.assistantAudioPlaying(), true);
  assert.equal(await f.api.pauseAssistantAudio(), true);
  f.api.stopAssistantAudio();
  assert.equal(await played, false);
});

test('prepared stream play also remains unpausable until native audio starts', async () => {
  const f = pendingMediaFixture();
  const prepared = f.api.prepareAssistantAudio(stream);
  const played = prepared.play();
  assert.equal(f.api.assistantAudioPlaying(), false);
  assert.equal(await f.api.pauseAssistantAudio(), false);
  assert.equal(f.calls.abort, 0);
  f.start();
  assert.equal(f.api.assistantAudioPlaying(), true);
  f.end();
  assert.equal(await played, true);
  assert.equal(f.calls.warnings.length, 0);
});

test('owned native failure warns once with only bounded media states and no private error content', async () => {
  const f = pendingMediaFixture();
  const played = f.api.playAssistantAudio({ ...stream, text: 'PRIVATE_CLIENT_TEXT' });
  const rejected = assert.rejects(played, /Не удалось воспроизвести ответ/);
  f.start();
  f.media.error = {
    code: 3,
    message: 'PRIVATE_MESSAGE /api/assistant/speak-audio?ticket=PRIVATE_TOKEN',
  };
  f.media.currentSrc = '/api/assistant/speak-audio?ticket=PRIVATE_TOKEN';
  const failed = f.media.onerror;
  failed({ name: 'PRIVATE_CLIENT_NAME', message: 'PRIVATE_ACCOUNT' });
  await rejected;
  failed({ name: 'PRIVATE_LATE_EVENT' });
  assert.equal(f.calls.warnings.length, 1);
  const [label, details] = f.calls.warnings[0];
  assert.equal(label, 'assistant-audio-failure');
  assert.deepEqual(JSON.parse(JSON.stringify(details)), {
    stage: 'media-error',
    name: 'MediaError',
    mediaErrorCode: 3,
    readyState: 3,
    networkState: 2,
    started: true,
    hidden: false,
  });
  assert.doesNotMatch(
    JSON.stringify(f.calls.warnings),
    /PRIVATE_|ticket|currentSrc|message|account|text/,
  );
});

test('play rejection keeps an allowlisted error name without logging its raw message', async () => {
  const f = pendingMediaFixture();
  const played = f.api.playAssistantAudio(stream);
  const rejected = assert.rejects(
    played,
    (error) => error.code === 'ASSISTANT_AUDIO_GESTURE_REQUIRED' && /Озвучить/.test(error.message),
  );
  f.reject(Object.assign(Error('PRIVATE_CLIENT_AND_URL'), { name: 'NotAllowedError' }));
  await rejected;
  const details = JSON.parse(JSON.stringify(f.calls.warnings[0][1]));
  assert.equal(f.calls.warnings.length, 1);
  assert.equal(details.stage, 'play-rejection');
  assert.equal(details.name, 'NotAllowedError');
  assert.equal(details.started, false);
  assert.equal(details.mediaErrorCode, null);
  assert.doesNotMatch(JSON.stringify(details), /PRIVATE_|ticket|url/);
});

test('preload failure is reported only at owned play and stop-induced abort stays silent', async () => {
  const f = pendingMediaFixture();
  const prepared = f.api.prepareAssistantAudio(stream);
  f.media.error = { code: 2, message: 'PRIVATE_NETWORK_DATA' };
  f.media.onerror({ name: 'PRIVATE_EVENT' });
  assert.equal(f.calls.warnings.length, 0);
  await assert.rejects(prepared.play(), /Ответ показан текстом/);
  assert.equal(f.calls.warnings.length, 1);
  assert.equal(f.calls.warnings[0][1].stage, 'preload');
  assert.equal(f.calls.warnings[0][1].mediaErrorCode, 2);
  assert.equal(await prepared.play(), false);
  assert.equal(f.calls.warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls.warnings), /PRIVATE_/);
  const g = pendingMediaFixture();
  const playing = g.api.playAssistantAudio(stream),
    staleError = g.media.onerror;
  g.api.stopAssistantAudio();
  assert.equal(await playing, false);
  await Promise.resolve();
  staleError({ name: 'AbortError' });
  assert.equal(g.calls.warnings.length, 0);
});
