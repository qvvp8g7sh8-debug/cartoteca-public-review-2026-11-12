const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  managementResponse,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-view.cjs');
const read = (name) =>
  fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8');
const flush = async () => {
  for (let n = 0; n < 45; n++) await Promise.resolve();
};
function fixture(
  t,
  {
    capabilities = [true, false, 'all'],
    initialSetting = true,
    fallbackSetting = true,
    allError = { name: 'OverconstrainedError', constraint: 'echoCancellation' },
  } = {},
) {
  const calls = {
    permissions: 0,
    constraints: [],
    requests: [],
    sent: [],
    paused: 0,
    resumed: 0,
    stoppedAudio: 0,
    statuses: [],
    encoded: null,
  };
  const state = {
    assistantGeneration: 1,
    assistantScope: {
      limits: { maxAudioSeconds: 30 },
      capabilities: { stt: { ready: true, local: true }, tts: { ready: true } },
    },
  };
  let busy = false,
    recording = false,
    capture,
    processor,
    context,
    playing = false,
    finishPlayback,
    samples = 0;
  const streams = [];
  function media(root = false) {
    let echo = initialSetting;
    const track = {
      readyState: 'live',
      kind: 'audio',
      muted: false,
      getSettings: () => ({ echoCancellation: echo }),
      getCapabilities: () => ({ echoCancellation: capabilities }),
      applyConstraints: async (value) => {
        calls.constraints.push(value);
        if (value.echoCancellation?.exact === 'all')
          throw Object.assign(Error('private device detail must never escape'), allError);
        echo = fallbackSetting;
      },
      stop() {
        this.readyState = 'ended';
      },
      addEventListener() {},
      removeEventListener() {},
    };
    const result = {
      root,
      getAudioTracks: () => [track],
      getTracks: () => [track],
      clone: () => media(),
    };
    streams.push(result);
    return result;
  }
  let rootMedia = media(true);
  const node = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    constructor() {
      context = this;
      this.sampleRate = 48000;
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return { ...node(), gain: { value: 0 } };
    }
    async close() {
      this.state = 'closed';
    }
  }
  class AudioWorkletNode {
    constructor() {
      Object.assign(this, node());
      this.port = { postMessage() {}, close() {}, onmessage: null };
      processor = this;
    }
  }
  const realm = {
    window: {
      AudioContext,
      AudioWorkletNode,
      Float32Array,
      addEventListener() {},
      removeEventListener() {},
    },
    document: { hidden: false, querySelector: () => ({ content: '1111111111111111' }) },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          calls.permissions++;
          if (rootMedia.getAudioTracks()[0].readyState !== 'live') rootMedia = media(true);
          return rootMedia;
        },
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: { warn: (...values) => calls.statuses.push(values.join(' ')) },
  };
  const ui = {
    valid: () => true,
    session: 1,
    get busy() {
      return busy;
    },
    get recording() {
      return recording;
    },
    speechContext: {
      dialogueId: 'synthetic-management-voice',
      dialogueVersion: 3,
      step: 'appointment',
      optionCount: 3,
    },
    activity(b, r) {
      busy = b;
      recording = r;
    },
    status: (value) => calls.statuses.push(value),
    input: () => ({ value: '' }),
    request: async (route, body) => {
      calls.requests.push({ route, body });
      return route.endsWith('/transcribe')
        ? { text: 'Запись в пятницу в четырнадцать' }
        : { audioBase64: 'synthetic' };
    },
    sendText: async (text) => {
      calls.sent.push(text);
    },
  };
  const actions = {
    startAssistantCapture: async (complete, error, seconds, options) => {
      capture = { complete, error, options, media: await options.acquireMedia() };
      return true;
    },
    stopAssistantCapture: () => capture?.media.getTracks().forEach((track) => track.stop()),
    assistantAudioPlaying: () => playing,
    playAssistantAudio: async (output) => {
      playing = true;
      output.onStarted?.();
      return new Promise((resolve) => {
        finishPlayback = resolve;
      });
    },
    pauseAssistantAudio: async () => {
      calls.paused++;
      return true;
    },
    resumeAssistantAudio: () => {
      calls.resumed++;
      return true;
    },
    stopAssistantAudio: () => {
      calls.stoppedAudio++;
      playing = false;
      finishPlayback?.(false);
    },
    encodeAssistantWav: (buffer) => {
      calls.encoded = Array.from(buffer.getChannelData(0));
      return 'synthetic-management-prebuffer';
    },
  };
  for (const [name, factory] of [
    ['assistant-speech-text', 'createAssistantSpeechText'],
    ['assistant-barge-signal', 'createAssistantBargeSignal'],
    ['assistant-barge-in', 'createAssistantBargeIn'],
  ])
    Object.assign(actions, vm.runInNewContext(read(name) + '\n' + factory, realm)(state, actions));
  const controller = vm
    .runInNewContext(read('assistant-speech') + '\ncreateAssistantSpeech', realm)(state, actions)
    .assistantSpeechController(ui);
  t.after(() => controller.stopVoice());
  const response = managementResponse(
    {
      id: 'synthetic-management-voice',
      version: 3,
      data: { patient: { label: 'Анна Синтетическая' } },
    },
    {
      step: 'appointment',
      phase: 'appointmentChoice',
      prompt: 'Какую запись?',
      choices: [
        'завтра в 12:00 · Консультация',
        'в пятницу в 14:00 · Повторная консультация',
        'в субботу в 16:00 · Другая консультация',
      ].map((label) => ({ kind: 'appointmentSource', label })),
    },
  );
  return {
    calls,
    controller,
    actions,
    response,
    streams,
    setInitialSetting(value) {
      initialSetting = value;
    },
    async nextQuestion() {
      controller.pauseForChoice();
      const pending = controller.afterReply(response);
      await flush();
      return { pending };
    },
    feed(count, amplitude = 0.12) {
      for (let n = 0; n < count; n++) {
        const frame = Float32Array.from(
          { length: 512 },
          () => amplitude * Math.sin((2 * Math.PI * 440 * samples++) / 48000),
        );
        context.currentTime = samples / 48000;
        processor?.port.onmessage?.({
          data: { type: 'pcm', samples: frame, time: context.currentTime },
        });
      }
    },
    async question() {
      await controller.startVoice();
      actions.stopAssistantCapture();
      busy = recording = false;
      const pending = controller.afterReply(response);
      await flush();
      return { pending };
    },
  };
}

test('an unsupported all-mode constraint keeps the same permitted microphone and permits verified true-AEC interruption of three appointments', async (t) => {
  const f = fixture(t);
  const { pending } = await f.question();
  assert.equal(
    f.actions.assistantBargeInState().ready,
    true,
    'Overconstrained all must not disable supported verified boolean AEC',
  );
  assert.equal(f.calls.permissions, 1);
  assert.equal(f.calls.constraints[0].echoCancellation.exact, 'all');
  assert.equal(f.calls.constraints[1].echoCancellation.exact, true);
  f.feed(7);
  await new Promise(setImmediate);
  assert.equal(f.calls.paused, 1);
  assert.equal(f.calls.stoppedAudio, 0, 'onset alone cannot cancel the question');
  f.feed(20);
  assert.equal(f.calls.stoppedAudio, 1);
  await pending;
  f.feed(60, 0);
  await flush();
  assert.equal(
    f.calls.requests.filter((row) => row.route.endsWith('/transcribe')).length,
    0,
    'a substantive appointment answer may continue after a640ms pause',
  );
  f.feed(38, 0);
  assert.equal(f.calls.sent.length, 0, '1045ms remains below the full-phrase endpoint');
  f.feed(1, 0);
  await flush();
  assert.equal(f.calls.requests.filter((row) => row.route.endsWith('/transcribe')).length, 1);
  assert.deepEqual(f.calls.sent, ['Запись в пятницу в четырнадцать']);
  assert.ok(
    f.calls.encoded.length > 26 * 512,
    'the complete first word remains in the takeover buffer',
  );
  assert.ok(Math.abs(f.calls.encoded[1] - 0.12 * Math.sin((2 * Math.PI * 440) / 48000)) < 0.000001);
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.calls.permissions, 1);
});

test('verified true-AEC without all capability arms the same-stream appointment listener without another permission request', async (t) => {
  const f = fixture(t, { capabilities: [true, false] });
  await f.question();
  assert.equal(f.actions.assistantBargeInState().ready, true);
  assert.equal(f.calls.permissions, 1);
});

test('echo-only playback cannot take over under true-AEC without speech that survives the acknowledged pause', async (t) => {
  const f = fixture(t);
  await f.question();
  assert.equal(f.actions.assistantBargeInState().ready, true);
  f.feed(7);
  await new Promise(setImmediate);
  f.feed(40, 0);
  assert.equal(f.calls.paused, 1);
  assert.equal(f.calls.resumed, 1);
  assert.equal(f.calls.stoppedAudio, 0);
  assert.equal(f.calls.requests.filter((row) => row.route.endsWith('/transcribe')).length, 0);
  assert.deepEqual(f.calls.sent, []);
});

test('one dialogue remembers the supported echo fallback while a new permitted dialogue negotiates again', async (t) => {
  const f = fixture(t);
  await f.question();
  assert.equal(
    f.calls.constraints.filter((value) => value.echoCancellation.exact === 'all').length,
    1,
  );
  await f.nextQuestion();
  assert.equal(f.actions.assistantBargeInState().ready, true);
  assert.equal(
    f.calls.constraints.filter((value) => value.echoCancellation.exact === 'all').length,
    1,
  );
  assert.equal(f.calls.permissions, 1);
  f.controller.stopVoice();
  await f.question();
  assert.equal(f.actions.assistantBargeInState().ready, true);
  assert.equal(
    f.calls.constraints.filter((value) => value.echoCancellation.exact === 'all').length,
    2,
  );
  assert.equal(f.calls.permissions, 2);
});

test('a cached echo fallback never accepts a later clone whose actual setting becomes false', async (t) => {
  const f = fixture(t);
  await f.question();
  f.setInitialSetting(false);
  await f.nextQuestion();
  assert.equal(f.actions.assistantBargeInState().ready, false);
  assert.equal(
    f.calls.constraints.filter((value) => value.echoCancellation.exact === 'all').length,
    1,
  );
  assert.equal(f.calls.permissions, 1);
  assert.equal(f.calls.requests.filter((row) => row.route.endsWith('/transcribe')).length, 0);
});

test('a fallback that does not actually enable echo cancellation remains fail closed', async (t) => {
  const f = fixture(t, { fallbackSetting: false });
  await f.question();
  assert.equal(f.actions.assistantBargeInState().ready, false);
  assert.equal(f.calls.permissions, 1);
  assert.equal(f.calls.requests.filter((row) => row.route.endsWith('/transcribe')).length, 0);
});

test('permission and unrelated constraint failures do not enter the true-AEC compatibility fallback', async (t) => {
  for (const allError of [
    { name: 'NotAllowedError' },
    { name: 'OverconstrainedError', constraint: 'channelCount' },
  ]) {
    const f = fixture(t, { allError });
    await f.question();
    assert.equal(f.actions.assistantBargeInState().ready, false);
    assert.equal(f.calls.constraints.length, 1);
    assert.equal(f.calls.permissions, 1);
    assert.equal(f.calls.requests.filter((row) => row.route.endsWith('/transcribe')).length, 0);
  }
});
