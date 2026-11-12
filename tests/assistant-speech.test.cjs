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
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
function fixture(t) {
  const state = {
    assistantGeneration: 0,
    assistantScope: {
      limits: { maxAudioSeconds: 30 },
      capabilities: { stt: { ready: true, demo: false }, tts: { ready: true } },
    },
  };
  const current = {
    alive: true,
    session: 1,
    busy: false,
    recording: false,
    input: { tagName: 'INPUT', type: 'time', value: 'saved-draft' },
    statuses: [],
    diagnostics: [],
    clock: 0,
    sent: [],
    captures: [],
    requests: [],
    played: [],
    heard: [],
    opened: 0,
    playback: async () => true,
    localVoiceReady: async () => true,
    request: async (route) =>
      route.endsWith('/transcribe')
        ? { text: 'Синтетический ответ' }
        : { audioBase64: 'synthetic' },
  };
  const ui = {
    valid: () => current.alive,
    input: () => current.input,
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
    status: (text) => current.statuses.push(text),
    heard: (text) => current.heard.push(text),
    voiceState: (value) => {
      current.voice = value;
    },
    request: async (route, body) => {
      current.requests.push({ route, body });
      return current.request(route, body);
    },
    sendText: async (text) => current.sent.push(text),
    openResult: async () => {
      current.opened++;
    },
  };
  const actions = {
    recordAssistantAudioDiagnostic: (event, milliseconds) =>
      current.diagnostics.push({ event, milliseconds }),
    startAssistantCapture: async (complete, error, seconds, options) => {
      current.captures.push({ complete, error, seconds, options });
      return true;
    },
    stopAssistantCapture() {
      current.stopped = (current.stopped || 0) + 1;
    },
    stopAssistantAudio() {},
    assistantLocalVoiceReady: async () => {
      current.voiceChecks = (current.voiceChecks || 0) + 1;
      return current.localVoiceReady();
    },
    playAssistantAudio: async (result) => {
      current.played.push(result);
      return current.playback(result);
    },
  };
  const factory = vm.runInNewContext(source + '\ncreateAssistantSpeech', {
    performance: { now: () => current.clock },
  });
  const speechText = fs.readFileSync(
    path.resolve(__dirname, '../src/client/modules/assistant-speech-text.js'),
    'utf8',
  );
  Object.assign(actions, vm.runInNewContext(speechText + '\ncreateAssistantSpeechText', {})());
  const controller = factory(state, actions).assistantSpeechController(ui);
  t.after(() => controller.stopVoice());
  return {
    state,
    current,
    ui,
    actions,
    controller,
    complete: () =>
      current.captures
        .at(-1)
        .complete('synthetic-wav', { autoStopped: true, seconds: 2, stopReason: 'silence' }),
    readyReply() {
      ui.activity(false, false);
    },
  };
}
test('local voice preflight holds the microphone until ready and rejects a duplicate start', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.state.assistantScope.capabilities.tts.local = true;
  f.current.localVoiceReady = () => gate.promise;
  const started = f.controller.startVoice();
  assert.equal(f.current.voiceChecks, 1);
  assert.equal(f.current.busy, true);
  assert.equal(f.current.captures.length, 0);
  assert.equal(await f.controller.startVoice(), false);
  assert.equal(f.current.voiceChecks, 1);
  gate.resolve(true);
  assert.equal(await started, true);
  assert.equal(f.current.captures.length, 1);
});

test('accepted STT reports last heard text before automatic send and also for a manual capture', async (t) => {
  for (const automatic of [false, true]) {
    const f = fixture(t),
      order = [];
    f.ui.heard = (text) => {
      f.current.heard.push(text);
      order.push('heard');
    };
    f.ui.sendText = async (text) => {
      f.current.sent.push(text);
      order.push('send');
    };
    f.current.request = async () => ({ text: '  Первичная консультация  ' });
    if (automatic) await f.controller.startVoice();
    else await f.controller.capture();
    await f.complete();
    assert.deepEqual(f.current.heard, ['Первичная консультация']);
    assert.equal(f.current.input.value, 'Первичная консультация');
    assert.deepEqual(order, automatic ? ['heard', 'send'] : ['heard']);
  }
});

test('automatic initial capture forwards a prepared availability reply and manual capture stays transcription-only', async (t) => {
  for (const automatic of [true, false]) {
    const f = fixture(t);
    const prepared = { intent: 'availability', action: null };
    const sent = [];
    f.ui.captureAvailabilityMode = () => 'plain';
    f.ui.sendText = async (text, _trace, reply) => sent.push([text, reply]);
    f.current.request = async () => ({ text: 'Свободное время', availabilityReply: prepared });
    if (automatic) await f.controller.startVoice();
    else await f.controller.capture();
    await f.complete();
    assert.equal(f.current.requests[0].body.availabilityTurn, automatic ? 'plain' : undefined);
    assert.deepEqual(sent, automatic ? [['Свободное время', prepared]] : []);
  }
});

test('late, empty and failed STT cannot replace last-heard feedback after scope, session or stop changes', async (t) => {
  for (const change of [
    (f) => f.controller.stopVoice(),
    (f) => f.state.assistantGeneration++,
    (f) => f.current.session++,
  ]) {
    const f = fixture(t),
      gate = deferred();
    await f.controller.startVoice();
    f.current.heard.push('Предыдущий ответ');
    f.current.request = () => gate.promise;
    const complete = f.complete();
    change(f);
    gate.resolve({ text: 'Поздний ответ' });
    await complete;
    assert.deepEqual(f.current.heard, ['Предыдущий ответ']);
  }
  for (const request of [
    async () => ({ text: '  ' }),
    async () => {
      throw Error('Synthetic STT failure');
    },
  ]) {
    const f = fixture(t);
    await f.controller.capture();
    f.current.request = request;
    await f.complete();
    assert.deepEqual(f.current.heard, []);
  }
});

test('confirmed voice interruption reuses its prearmed PCM capture and submits STT once without a second microphone', async (t) => {
  const f = fixture(t),
    audio = deferred();
  let barge;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, options) => {
    barge = { complete, error, seconds, options };
    return { ready: true };
  };
  f.actions.stopAssistantBargeIn = () => {
    f.current.bargeStops = (f.current.bargeStops || 0) + 1;
  };
  f.actions.stopAssistantAudio = () => audio.resolve(false);
  await f.controller.startVoice();
  await f.complete();
  f.current.playback = () => audio.promise;
  const reply = f.controller.afterReply(question());
  await flush();
  assert.ok(barge);
  barge.options.onInterrupt();
  audio.resolve(false);
  await reply;
  assert.equal(
    f.current.captures.length,
    1,
    'confirmed barge-in continues its existing PCM stream',
  );
  assert.equal(f.current.recording, true);
  await barge.complete('synthetic-prebuffer-wav', {
    interrupted: true,
    autoStopped: true,
    stopReason: 'silence',
  });
  assert.equal(f.current.sent.length, 2);
  assert.equal(f.current.requests.filter((item) => item.route.endsWith('/transcribe')).length, 2);
  assert.equal(f.controller.voiceEnabled, true);
});

test('unavailable voice interruption preserves normal TTS then microphone and rejects late prearmed completion', async (t) => {
  const f = fixture(t),
    audio = deferred();
  let barge;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, options) => {
    barge = { complete, error, options };
    options.onStatus({
      ready: false,
      phase: 'unavailable',
      reason: 'Strict AEC unavailable; answer after playback.',
    });
    return { ready: false, reason: 'strict AEC unavailable' };
  };
  f.actions.stopAssistantBargeIn = () => {};
  await f.controller.startVoice();
  await f.complete();
  f.current.playback = () => audio.promise;
  const reply = f.controller.afterReply(question());
  await flush();
  assert.ok(f.current.statuses.includes('Strict AEC unavailable; answer after playback.'));
  assert.ok(f.current.statuses.every((value) => typeof value === 'string'));
  audio.resolve(true);
  await reply;
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.current.recording, true);
  await barge.complete('stale-prearmed-wav');
  assert.equal(f.current.sent.length, 1);
  f.controller.stopVoice();
  assert.equal(barge.options.current(), false);
});

test('voice interruption callbacks after stop, session replacement or closure cannot accept PCM or advance the dialogue', async (t) => {
  for (const change of [
    (f) => f.controller.stopVoice(),
    (f) => {
      f.current.session++;
    },
    (f) => {
      f.current.alive = false;
    },
    (f) => {
      f.state.assistantGeneration++;
    },
  ]) {
    const f = fixture(t),
      audio = deferred();
    let barge;
    f.actions.startAssistantBargeIn = async (complete, error, seconds, options) => {
      barge = { complete, error, options };
      return { ready: true };
    };
    f.actions.stopAssistantBargeIn = () => {};
    await f.controller.startVoice();
    await f.complete();
    f.current.playback = () => audio.promise;
    const reply = f.controller.afterReply(question());
    await flush();
    assert.ok(barge);
    change(f);
    barge.options.onInterrupt();
    await barge.complete('late-pcm');
    audio.resolve(false);
    await reply;
    assert.equal(f.current.sent.length, 1);
    assert.equal(f.current.captures.length, 1);
  }
});

test('scope change during barge-in permission never starts stale TTS playback and plain result speech has no listener', async (t) => {
  const f = fixture(t),
    permission = deferred();
  let armed = 0,
    stopped = 0;
  f.actions.startAssistantBargeIn = () => {
    armed++;
    return permission.promise;
  };
  f.actions.stopAssistantBargeIn = () => {
    stopped++;
  };
  await f.controller.startVoice();
  await f.complete();
  const reply = f.controller.afterReply(question());
  await flush();
  assert.equal(armed, 1);
  f.state.assistantGeneration++;
  permission.resolve({ ready: true });
  await reply;
  assert.equal(f.current.played.length, 0);
  assert.ok(stopped > 0);
  const plain = fixture(t);
  plain.actions.startAssistantBargeIn = () =>
    assert.fail('No answer capture for a final non-dialogue result');
  await plain.controller.startVoice();
  await plain.complete();
  await plain.controller.afterReply({ text: 'Готово', action: null, dialogue: null });
  assert.equal(plain.current.captures.length, 1);
});

test('stop while local voices load cannot start the microphone after a late ready result', async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.state.assistantScope.capabilities.tts.local = true;
  f.current.localVoiceReady = () => gate.promise;
  const started = f.controller.startVoice();
  f.controller.stopVoice();
  gate.resolve(true);
  assert.equal(await started, false);
  assert.equal(f.current.captures.length, 0);
  assert.equal(f.controller.voiceEnabled, false);
});
test('missing local voice leaves the dialog usable on screen without capturing audio', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.capabilities.tts.local = true;
  f.current.localVoiceReady = async () => false;
  assert.equal(await f.controller.startVoice(), false);
  assert.equal(f.current.captures.length, 0);
  assert.equal(f.current.busy, false);
  assert.equal(f.controller.voiceEnabled, false);
  assert.match(f.current.statuses.at(-1), /русский голос/);
  assert.match(f.current.statuses.at(-1), /продолжите на экране/);
});
test('scope and session replacement during local voice preflight cannot record into a new dialog', async (t) => {
  for (const change of [(f) => f.state.assistantGeneration++, (f) => f.current.session++]) {
    const f = fixture(t),
      gate = deferred();
    f.state.assistantScope.capabilities.tts.local = true;
    f.current.localVoiceReady = () => gate.promise;
    const started = f.controller.startVoice();
    change(f);
    gate.resolve(true);
    assert.equal(await started, false);
    assert.equal(f.current.captures.length, 0);
  }
});
const question = () => ({
  text: 'Выберите услугу специалиста или введите её точное название.',
  action: null,
  dialogue: {
    id: 'synthetic-dialogue',
    version: 1,
    step: 'service',
    input: null,
    prompt: 'Выберите услугу специалиста или введите её точное название.',
    options: [{ id: 'opaque-service-id', label: 'Чистка' }],
    fields: [],
    canEdit: [],
  },
});
test('one-shot microphone keeps transcript review and does not silently enter the voice loop', async (t) => {
  const f = fixture(t);
  await f.controller.capture();
  assert.equal(f.current.captures[0].options.silenceStop, false);
  await f.complete();
  assert.equal(f.current.input.value, 'Синтетический ответ');
  assert.equal(f.current.input.type, 'text');
  assert.deepEqual(f.current.sent, []);
  assert.equal(f.controller.voiceEnabled, false);
  assert.match(f.current.statuses.at(-1), /Проверьте/);
});
test('voice capture submits STT once automatically and opts into bounded silence stopping', async (t) => {
  const f = fixture(t);
  assert.equal(await f.controller.startVoice(), true);
  assert.equal(f.current.captures[0].options.silenceStop, true);
  assert.equal(f.current.captures[0].options.initialCommand, true);
  assert.equal(f.current.captures[0].seconds, 30);
  await f.complete();
  assert.deepEqual(f.current.sent, ['Синтетический ответ']);
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 1);
  assert.ok(!f.current.statuses.some((text) => text.includes('Проверьте его')));
});
test('voice asks for a service without reading its menu and waits for TTS before the next answer', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const playback = deferred();
  f.current.playback = () => playback.promise;
  const reply = question();
  reply.text = reply.dialogue.prompt;
  reply.dialogue.options = [
    { id: 'opaque-service-1', label: 'Первичная консультация · 30 мин' },
    { id: 'opaque-service-2', label: 'Чистка · 60 мин' },
  ];
  const before = JSON.stringify(reply);
  const next = f.controller.afterReply(reply);
  await flush();
  assert.equal(f.current.captures.length, 1);
  const spoken = f.current.requests.find((row) => row.route.endsWith('/speak')).body.text;
  assert.equal(spoken, 'Какую услугу?');
  assert.doesNotMatch(spoken, /Вариант|номер|Консультация|Чистка|[·×]|opaque-service/iu);
  assert.equal(JSON.stringify(reply), before);
  playback.resolve(true);
  await next;
  assert.equal(f.current.captures.length, 2);
  f.current.input = null;
  f.current.request = async (route) =>
    route.endsWith('/transcribe') ? { text: 'Первый вариант' } : { audioBase64: 'synthetic' };
  await f.complete();
  assert.deepEqual(f.current.sent, ['Синтетический ответ', 'Первый вариант']);
});
test('stopping voice while STT is pending fences a late transcript without an extra command', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  const stt = deferred();
  f.current.request = () => stt.promise;
  const pending = f.complete();
  await flush();
  f.controller.stopVoice();
  stt.resolve({ text: 'Поздняя команда' });
  await pending;
  assert.deepEqual(f.current.sent, []);
  assert.equal(f.current.input.value, 'saved-draft');
  assert.equal(f.controller.voiceEnabled, false);
});
test('session, generation and closed-panel changes fence late TTS before playback or rearming', async (t) => {
  for (const change of [
    (f) => {
      f.current.session++;
    },
    (f) => {
      f.state.assistantGeneration++;
    },
    (f) => {
      f.current.alive = false;
    },
  ]) {
    const f = fixture(t);
    await f.controller.startVoice();
    await f.complete();
    const tts = deferred();
    f.current.request = () => tts.promise;
    const pending = f.controller.afterReply(question());
    await flush();
    change(f);
    tts.resolve({ audioBase64: 'late-synthetic' });
    await pending;
    assert.equal(f.current.played.length, 0);
    assert.equal(f.current.captures.length, 1);
    assert.equal(f.current.opened, 0);
  }
});
test('explicit question playback cancellation never rearms capture or opens a prepared form', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const playback = deferred();
  f.current.playback = () => playback.promise;
  const pending = f.controller.afterReply(question());
  await flush();
  f.controller.stopVoice();
  playback.resolve(false);
  await pending;
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
});
test('STT and playback failures stop the loop while preserving visible fields for manual fallback', async (t) => {
  const stt = fixture(t);
  await stt.controller.startVoice();
  stt.current.request = async () => {
    throw Error('Синтетический сбой STT');
  };
  await stt.complete();
  assert.equal(stt.controller.voiceEnabled, false);
  assert.equal(stt.current.input.value, 'saved-draft');
  assert.deepEqual(stt.current.sent, []);
  const tts = fixture(t);
  await tts.controller.startVoice();
  await tts.complete();
  tts.current.playback = async () => {
    throw Error('Синтетический сбой аудио');
  };
  await tts.controller.afterReply(question());
  assert.equal(tts.controller.voiceEnabled, false);
  assert.equal(tts.current.input.value, 'Синтетический ответ');
  assert.equal(tts.current.captures.length, 1);
  assert.match(tts.current.statuses.at(-1), /сбой аудио/);
});
test('confirmed booking delegates the action before completion speech and missing capabilities do not start a loop', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  let options;
  f.ui.openResult = async (value) => {
    options = value;
    f.current.opened++;
  };
  await f.controller.afterReply({
    text: 'Подготовлена форма',
    dialogue: null,
    action: { type: 'prepareAppointment' },
  });
  assert.equal(f.current.opened, 1);
  assert.equal(options.voice, true);
  assert.equal(
    f.current.requests.filter((item) => item.route.endsWith('/speak')).length,
    0,
    'the owned handoff announces success only after actual action completion',
  );
  for (const capability of ['stt', 'tts']) {
    const unavailable = fixture(t);
    unavailable.state.assistantScope.capabilities[capability].ready = false;
    assert.equal(await unavailable.controller.startVoice(), false);
    assert.equal(unavailable.current.captures.length, 0);
    assert.equal(unavailable.controller.voiceEnabled, false);
    assert.match(unavailable.current.statuses.at(-1), /нужно подключить/);
  }
});

test('duplicate completion and late error callbacks for one capture cannot duplicate STT or command submission', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  const stt = deferred();
  f.current.request = () => stt.promise;
  const capture = f.current.captures[0];
  const first = capture.complete('synthetic-first-wav');
  const duplicate = capture.complete('synthetic-duplicate-wav');
  await flush();
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 1);
  assert.deepEqual(f.current.sent, []);
  stt.resolve({ text: 'Запиши Анну завтра' });
  await Promise.all([first, duplicate]);
  await capture.complete('synthetic-late-duplicate');
  capture.error(Error('Synthetic late microphone error'));
  await flush();
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 1);
  assert.deepEqual(f.current.sent, ['Запиши Анну завтра']);
  assert.equal(f.controller.voiceEnabled, true);
  assert.ok(!f.current.statuses.some((text) => text.includes('Synthetic late microphone error')));
});

function longQuestion() {
  const reply = question();
  reply.dialogue.step = 'staff';
  reply.text = reply.dialogue.prompt = 'Выберите доступного специалиста.';
  reply.dialogue.options = Array.from({ length: 12 }, (_, index) => ({
    id: 'opaque-service-' + index,
    label: 'Подробное описание процедуры и услуги '.repeat(4) + 'КОНЕЦ' + (index + 1),
  }));
  return reply;
}
test('short voice menus retain three concrete suggestions, respect the TTS limit and rearm only after all audio', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  await f.complete();
  const first = deferred(),
    second = deferred();
  let plays = 0;
  f.current.playback = () => (++plays === 1 ? first.promise : second.promise);
  const pending = f.controller.afterReply(longQuestion());
  await flush();
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/speak')).length, 1);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.busy, true);
  first.resolve(true);
  await flush();
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/speak')).length, 2);
  assert.equal(f.current.captures.length, 1);
  f.current.playback = async () => {
    assert.equal(f.current.captures.length, 1);
    assert.equal(f.current.busy, true);
    return true;
  };
  second.resolve(true);
  await pending;
  const calls = f.current.requests.filter((row) => row.route.endsWith('/speak'));
  assert.ok(calls.length > 2);
  assert.ok(calls.every((row) => row.body.text.length > 0 && row.body.text.length <= 100));
  const spoken = calls.map((row) => row.body.text).join(' ');
  assert.ok(spoken.length > 400);
  for (let number = 1; number <= 3; number++) assert.ok(spoken.includes('КОНЕЦ' + number));
  assert.doesNotMatch(spoken, /Вариант|КОНЕЦ(?:[4-9]|1[0-2])/u);
  assert.doesNotMatch(spoken, /opaque-service-/);
  assert.equal(f.current.played.length, calls.length);
  assert.equal(f.current.captures.length, 2);
});
test('stop, session, generation and closure fence remaining TTS portions after a completed first portion', async (t) => {
  for (const change of [
    (f) => f.controller.stopVoice(),
    (f) => {
      f.current.session++;
    },
    (f) => {
      f.state.assistantGeneration++;
    },
    (f) => {
      f.current.alive = false;
    },
  ]) {
    const f = fixture(t);
    f.state.assistantScope.limits.maxReplyChars = 100;
    await f.controller.startVoice();
    await f.complete();
    const playback = deferred();
    f.current.playback = () => playback.promise;
    const pending = f.controller.afterReply(longQuestion());
    await flush();
    change(f);
    playback.resolve(true);
    await pending;
    assert.equal(f.current.requests.filter((row) => row.route.endsWith('/speak')).length, 1);
    assert.equal(f.current.captures.length, 1);
    assert.equal(f.current.opened, 0);
  }
});
test('a late second TTS response after stop cannot play, request another portion or rearm capture', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  await f.complete();
  const second = deferred();
  let requests = 0;
  f.current.request = async () =>
    ++requests === 1 ? { audioBase64: 'first-synthetic' } : second.promise;
  const pending = f.controller.afterReply(longQuestion());
  await flush();
  assert.equal(requests, 2);
  assert.equal(f.current.played.length, 1);
  f.controller.stopVoice();
  second.resolve({ audioBase64: 'late-synthetic' });
  await pending;
  assert.equal(requests, 2);
  assert.equal(f.current.played.length, 1);
  assert.equal(f.current.captures.length, 1);
});
test('failure of a later TTS portion stops voice without another portion, microphone or form handoff', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  await f.complete();
  let requests = 0;
  f.current.request = async () => {
    if (++requests === 2)
      throw Object.assign(Error('Synthetic TTS budget exhausted'), { status: 429 });
    return { audioBase64: 'first-synthetic' };
  };
  await f.controller.afterReply(longQuestion());
  assert.equal(requests, 2);
  assert.equal(f.current.played.length, 1);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.input.value, 'Синтетический ответ');
  assert.match(f.current.statuses.at(-1), /budget exhausted/);
});
test('manual speech shares bounded sequential delivery at default, minimum and maximum policy limits', async (t) => {
  for (const limit of [undefined, 100, 1000]) {
    const f = fixture(t);
    if (limit !== undefined) f.state.assistantScope.limits.maxReplyChars = limit;
    const text = 'Полезный ответ без обрезания слов. '.repeat(180).trim();
    assert.equal(await f.controller.speak(text), true);
    const calls = f.current.requests.filter((row) => row.route.endsWith('/speak'));
    assert.ok(calls.length > 1);
    assert.ok(calls.every((row) => row.body.text.length <= (limit || 600)));
    assert.equal(calls.map((row) => row.body.text).join(' '), text);
    assert.equal(f.current.played.length, calls.length);
    assert.ok(f.current.played.every((value) => value.voiceOwner === undefined));
    assert.equal(f.current.captures.length, 0);
    assert.equal(f.current.busy, false);
  }
});
test('an oversized unbroken label is split without losing text or cutting a Unicode surrogate pair', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  const text = 'Я'.repeat(99) + '😀' + 'Ё'.repeat(140);
  assert.equal(await f.controller.speak(text), true);
  const chunks = f.current.requests.map((row) => row.body.text);
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
  assert.ok(chunks.every((chunk) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/u.test(chunk)));
  assert.equal(chunks.join(''), text);
});

test('voice retains the server warning and speaks an already included prompt only once', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const reply = question();
  reply.dialogue.step = 'availability';
  reply.dialogue.prompt = 'Выберите другое свободное окно.';
  reply.text = 'Желаемое время уже занято. ' + reply.dialogue.prompt;
  await f.controller.afterReply(reply);
  const spoken = f.current.requests
    .filter((row) => row.route.endsWith('/speak'))
    .map((row) => row.body.text)
    .join(' ');
  assert.ok(spoken.includes('Желаемое время уже занято.'));
  assert.equal(spoken.split(reply.dialogue.prompt).length - 1, 1);
  assert.ok(spoken.indexOf('Желаемое время уже занято.') < spoken.indexOf(reply.dialogue.prompt));
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.current.opened, 0);
});

test('voice review reads the six selected labels and values before confirmation and waits for all bounded audio', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  await f.complete();
  const reply = question();
  reply.dialogue.step = 'review';
  reply.dialogue.prompt = 'Проверьте данные записи.';
  reply.text = reply.dialogue.prompt;
  reply.dialogue.fields = [
    {
      key: 'client',
      label: 'Клиент',
      value: 'Зоя Синтетическая',
      patientId: 'opaque-patient-sentinel',
    },
    { key: 'staff', label: 'Специалист', value: 'Вера Тестовая', staffId: 'opaque-staff-sentinel' },
    {
      key: 'service',
      label: 'Услуга',
      value: 'Тестовая консультация',
      serviceId: 'opaque-service-sentinel',
    },
    { key: 'date', label: 'Дата', value: '2026-10-20' },
    { key: 'time', label: 'Время', value: '14:30' },
    { key: 'duration', label: 'Длительность', value: '45 мин' },
  ];
  reply.dialogue.options = [{ id: 'opaque-ready-sentinel', label: 'Подготовить форму записи' }];
  const firstAudio = deferred();
  let plays = 0;
  f.current.playback = () => (++plays === 1 ? firstAudio.promise : Promise.resolve(true));
  const pending = f.controller.afterReply(reply);
  await flush();
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
  firstAudio.resolve(true);
  await pending;
  const calls = f.current.requests.filter((row) => row.route.endsWith('/speak'));
  const spoken = calls.map((row) => row.body.text).join(' ');
  assert.ok(calls.length > 1);
  assert.ok(calls.every((row) => row.body.text.length > 0 && row.body.text.length <= 100));
  const confirmation = spoken.indexOf('Скажите «открой форму»');
  assert.ok(confirmation >= 0);
  for (const field of reply.dialogue.fields) {
    const expected =
      field.key === 'date'
        ? '20 октября 2026 года'
        : field.key === 'time'
          ? '14 часов 30 минут'
          : field.value;
    assert.equal(spoken.split(field.label + ': ' + expected).length - 1, 1);
    assert.ok(spoken.indexOf(field.label + ': ' + expected) < confirmation);
  }
  assert.equal(spoken.split(reply.dialogue.prompt).length - 1, 1);
  assert.doesNotMatch(spoken, /opaque-(?:patient|staff|service|ready)-sentinel/);
  assert.equal(f.current.played.length, calls.length);
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.current.opened, 0, 'Review narration must not open or save the form');
});

test('free-window speech announces concrete natural dates and intervals without copying UI arithmetic separators', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const reply = question();
  reply.dialogue.step = 'availability';
  reply.dialogue.options = [
    { id: 'opaque-slot-first', label: '2026-10-17 · 09:00–09:30 · Вера Тестовая' },
    { id: 'opaque-slot-second', label: '2026-10-18 · 14:30–15:00 · Вера Тестовая' },
  ];
  const before = JSON.stringify(reply);
  await f.controller.afterReply(reply);
  const spoken = f.current.requests
    .filter((row) => row.route.endsWith('/speak'))
    .map((row) => row.body.text)
    .join(' ');
  assert.ok(
    spoken.includes(
      '17 октября 2026 года, с 9 часов до 9 часов 30 минут, специалист Вера Тестовая',
    ),
  );
  assert.ok(
    spoken.includes(
      '18 октября 2026 года, с 14 часов 30 минут до 15 часов, специалист Вера Тестовая',
    ),
  );
  assert.doesNotMatch(spoken, /Вариант|[·×–]|opaque-slot|2026-10-17|09:00/u);
  assert.equal(
    JSON.stringify(reply),
    before,
    'Visible labels and opaque choice IDs remain unchanged',
  );
  assert.equal(f.current.captures.length, 2);
});

test('voice review narrates at most eight fields using only their labels and values', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const reply = question();
  reply.dialogue.step = 'review';
  reply.dialogue.fields = Array.from({ length: 9 }, (_, index) => ({
    key: 'PRIVATE_KEY_' + index,
    label: 'Поле' + index,
    value: 'Значение' + index,
    internalId: 'PRIVATE_ID_' + index,
  }));
  await f.controller.afterReply(reply);
  const spoken = f.current.requests
    .filter((row) => row.route.endsWith('/speak'))
    .map((row) => row.body.text)
    .join(' ');
  for (let index = 0; index < 8; index++)
    assert.ok(spoken.includes('Поле' + index + ': Значение' + index));
  assert.doesNotMatch(spoken, /Поле8|Значение8|PRIVATE_KEY_|PRIVATE_ID_|opaque-service-id/);
  assert.equal(f.current.opened, 0);
});

test('read-only free windows are naturally narrated within the TTS limit and finish without choices, a form or another capture', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  await f.complete();
  const reply = {
    text: 'Расписание может измениться. Это только просмотр.',
    action: null,
    dialogue: null,
    readOnlySlots: [
      {
        date: '2030-01-02',
        time: '09:00',
        endTime: '09:30',
        duration: 30,
        staffName: 'Вера Синтетическая',
        staffId: 'DO-NOT-SPEAK-STAFF',
        id: 'DO-NOT-SPEAK-SLOT',
      },
      {
        date: '2030-01-03',
        time: '14:30',
        endTime: '15:00',
        duration: 30,
        staffName: 'Зоя Тестовая',
      },
    ],
  };
  const before = JSON.stringify(reply),
    first = deferred();
  let plays = 0;
  f.current.playback = () => (++plays === 1 ? first.promise : Promise.resolve(true));
  const pending = f.controller.afterReply(reply);
  await flush();
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
  first.resolve(true);
  await pending;
  const calls = f.current.requests.filter((row) => row.route.endsWith('/speak'));
  const spoken = calls.map((row) => row.body.text).join(' ');
  assert.match(spoken, /Расписание может измениться/);
  assert.match(spoken, /Просмотр свободных окон\. Запись не подготовлена/);
  assert.ok(
    spoken.includes(
      'Свободно: 2 января 2030 года, с 9 часов до 9 часов 30 минут, специалист Вера Синтетическая',
    ),
  );
  assert.ok(
    spoken.includes(
      'Свободно: 3 января 2030 года, с 14 часов 30 минут до 15 часов, специалист Зоя Тестовая',
    ),
  );
  assert.doesNotMatch(spoken, /Вариант|номер|открой форму|DO-NOT-SPEAK|[·×–]/u);
  assert.ok(calls.length > 1);
  assert.ok(calls.every((row) => row.body.text.length <= 100));
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(JSON.stringify(reply), before);
});

test('read-only voice reads three concrete windows and ignores technical DTO fields', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const readOnlySlots = Array.from({ length: 13 }, (_, index) => ({
    date: '2030-01-02',
    time: '09:00',
    endTime: '09:30',
    duration: 30,
    staffName: index === 12 ? 'OVERFLOW-NAME' : 'Сотрудник ' + (index + 1),
    staffId: 'PRIVATE_STAFF_' + index,
    notes: 'PRIVATE_NOTES',
    patientName: 'PRIVATE_PATIENT',
    id: 'PRIVATE_ID_' + index,
  }));
  await f.controller.afterReply({ text: 'Только просмотр.', action: null, readOnlySlots });
  const spoken = f.current.requests
    .filter((row) => row.route.endsWith('/speak'))
    .map((row) => row.body.text)
    .join(' ');
  assert.equal(spoken.split('Свободно:').length - 1, 3);
  assert.match(spoken, /Сотрудник 3/);
  assert.doesNotMatch(spoken, /Сотрудник (?:[4-9]|1[0-2])/u);
  assert.doesNotMatch(spoken, /OVERFLOW-NAME|PRIVATE_|Вариант|номер/u);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
});

test('stopping read-only window speech during a later portion does not continue the list or resume listening', async (t) => {
  const f = fixture(t),
    second = deferred();
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  await f.complete();
  let calls = 0;
  f.current.request = async () => (++calls === 2 ? second.promise : { audioBase64: 'synthetic' });
  const pending = f.controller.afterReply({
    text: 'Только просмотр.',
    action: null,
    readOnlySlots: [
      {
        date: '2030-01-02',
        time: '09:00',
        endTime: '09:30',
        duration: 30,
        staffName: 'Синтетический специалист',
      },
      {
        date: '2030-01-03',
        time: '10:00',
        endTime: '10:30',
        duration: 30,
        staffName: 'Другой специалист',
      },
    ],
  });
  await flush();
  assert.equal(calls, 2);
  f.controller.stopVoice();
  second.resolve({ audioBase64: 'late-synthetic' });
  await pending;
  assert.equal(calls, 2);
  assert.equal(f.current.played.length, 1);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.opened, 0);
});

test('manual result speech narrates read-only windows without enabling voice or starting capture', async (t) => {
  const f = fixture(t);
  const reply = {
    text: 'Только просмотр.',
    action: null,
    readOnlySlots: [
      {
        date: '2030-01-02',
        time: '09:00',
        endTime: '09:30',
        duration: 30,
        staffName: 'Синтетический специалист',
        id: 'PRIVATE_SLOT',
      },
    ],
  };
  assert.equal(await f.controller.speakReply(reply), true);
  const spoken = f.current.requests.map((row) => row.body.text).join(' ');
  assert.match(spoken, /Просмотр свободных окон\. Запись не подготовлена/);
  assert.ok(
    spoken.includes(
      'Свободно: 2 января 2030 года, с 9 часов до 9 часов 30 минут, специалист Синтетический специалист',
    ),
  );
  assert.doesNotMatch(spoken, /PRIVATE_SLOT|Вариант|назовите номер|открой форму/iu);
  assert.equal(f.current.captures.length, 0);
  assert.equal(f.current.opened, 0);
  assert.equal(f.controller.voiceEnabled, false);
});

test('manual result speech shares review warnings, natural fields, concrete choices and bounded chunks without preparing a form', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  const reply = {
    text: 'Проверьте, что выбрана нужная Анна.',
    action: null,
    dialogue: {
      id: 'PRIVATE_DIALOGUE',
      version: 8,
      step: 'review',
      prompt: 'Проверьте данные.',
      fields: [
        { key: 'client', label: 'Клиент', value: 'Анна Синтетическая' },
        { key: 'date', label: 'Дата', value: '2030-01-02' },
        { key: 'time', label: 'Время', value: '14:30' },
      ],
      options: [{ id: 'PRIVATE_READY', label: 'Подготовить форму записи' }],
    },
  };
  const before = JSON.stringify(reply);
  assert.equal(await f.controller.speakReply(reply), true);
  const spoken = f.current.requests.map((row) => row.body.text).join(' ');
  assert.match(spoken, /Проверьте, что выбрана нужная Анна/);
  assert.match(spoken, /Клиент: Анна Синтетическая/);
  assert.match(spoken, /Дата: 2 января 2030 года/);
  assert.match(spoken, /Время: 14 часов 30 минут/);
  assert.match(spoken, /Подготовить форму записи/);
  assert.match(spoken, /нажмите «Подготовить форму записи»/);
  assert.doesNotMatch(spoken, /Скажите|Назовите номер|Вариант/);
  assert.doesNotMatch(spoken, /PRIVATE_|запись сохранена/iu);
  assert.ok(f.current.requests.every((row) => row.body.text.length <= 100));
  assert.equal(f.current.captures.length, 0);
  assert.equal(f.current.opened, 0);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(JSON.stringify(reply), before);
});

test('manual result speech keeps a plain calendar response unchanged and never executes its action', async (t) => {
  const f = fixture(t),
    text = 'Расписание готово для просмотра. Записи не изменялись.';
  assert.equal(
    await f.controller.speakReply({
      text,
      action: { type: 'calendar', date: '2030-01-02', mode: 'week' },
    }),
    true,
  );
  assert.equal(f.current.requests.length, 1);
  assert.equal(f.current.requests[0].body.text, text);
  assert.equal(f.current.captures.length, 0);
  assert.equal(f.current.opened, 0);
  assert.equal(f.controller.voiceEnabled, false);
});

test('service speech preserves the current error and keeps manual playback concise without mutating screen choices', async (t) => {
  for (const answerable of [false, true]) {
    const f = fixture(t),
      reply = question();
    reply.dialogue.prompt = 'Выберите услугу специалиста или введите её точное название.';
    reply.text = 'Такой услуги у специалиста нет. ' + reply.dialogue.prompt;
    reply.dialogue.options = [
      { id: 'service-a', label: 'Первичная консультация · 30 мин' },
      { id: 'service-b', label: 'Чистка · 60 мин' },
    ];
    const before = JSON.stringify(reply);
    assert.equal(await f.controller.speakReply(reply, answerable), true);
    const spoken = f.current.requests
      .filter((row) => row.route.endsWith('/speak'))
      .map((row) => row.body.text)
      .join(' ');
    assert.match(spoken, /Такой услуги у специалиста нет/);
    assert.match(
      spoken,
      answerable ? /Назовите услугу/ : /Выберите услугу на экране или введите название/,
    );
    assert.doesNotMatch(spoken, /Первичная консультация|Чистка|Вариант|номер|[·×]|service-[ab]/u);
    assert.equal(JSON.stringify(reply), before);
    assert.equal(f.current.captures.length, 0);
  }
});

test('service semantic400 keeps an error copied into both reply text and prompt in automatic and manual speech', async (t) => {
  for (const answerable of [false, true]) {
    const f = fixture(t),
      reply = question(),
      clarification = 'Такого номера нет. Назовите номер из текущих вариантов.';
    reply.text = reply.dialogue.prompt = clarification;
    reply.dialogue.options = [{ id: 'service-a', label: 'Первичная консультация · 30 мин' }];
    assert.equal(await f.controller.speakReply(reply, answerable), true);
    const spoken = f.current.requests
      .filter((row) => row.route.endsWith('/speak'))
      .map((row) => row.body.text)
      .join(' ');
    assert.equal(spoken.split(clarification).length - 1, 1);
    assert.doesNotMatch(spoken, /Первичная консультация|Вариант 1|[·×]|service-a/u);
    assert.equal(f.current.captures.length, 0);
  }
});

test('a single suggested client is spoken with identity and yes/no confirmation instead of a number instruction', async (t) => {
  const f = fixture(t),
    reply = {
      text: 'Нашёл похожего клиента. Это нужный человек?',
      dialogue: {
        step: 'client',
        prompt: 'Нашёл похожего клиента. Это нужный человек?',
        options: [{ id: 'PRIVATE_CLIENT_CHOICE', label: 'Анна Неволина · …1234' }],
        fields: [],
      },
    };
  const before = JSON.stringify(reply);
  assert.equal(await f.controller.speakReply(reply, true), true);
  const spoken = f.current.requests
    .filter((row) => row.route.endsWith('/speak'))
    .map((row) => row.body.text)
    .join(' ');
  assert.equal(spoken, 'Анна Неволина, верно?');
  assert.doesNotMatch(spoken, /1234|Скажите|Наш[её]л/u);
  assert.doesNotMatch(spoken, /Назовите номер|PRIVATE_|[·×]/u);
  assert.equal(f.current.opened, 0);
  assert.equal(JSON.stringify(reply), before);
});

test('STT sends opaque dialogue metadata only when local or contextual hints are supported', async (t) => {
  for (const [local, contextHints] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const f = fixture(t);
    f.state.assistantScope.capabilities.stt.local = local;
    f.state.assistantScope.capabilities.stt.contextHints = contextHints;
    f.current.speechContext = {
      dialogueId: 'opaque-current-dialogue',
      dialogueVersion: 7,
      step: 'client',
      optionCount: 1,
    };
    await f.controller.startVoice();
    await f.complete();
    const request = f.current.requests.find((row) => row.route.endsWith('/transcribe')).body;
    assert.equal(request.dialogueId, local || contextHints ? 'opaque-current-dialogue' : undefined);
    assert.equal(request.dialogueVersion, local || contextHints ? 7 : undefined);
    assert.equal(request.step, undefined);
    assert.equal(request.optionCount, undefined);
    assert.equal(f.current.captures[0].options.shortAnswer, true);
  }
});
test('short-answer onset is opt-in for actual numbered choices and single-client confirmation', async (t) => {
  for (const [step, optionCount, expected] of [
    ['client', 1, true],
    ['availability', 3, true],
    ['date', 0, false],
    ['date', 1, true],
    ['review', 1, false],
  ]) {
    const f = fixture(t);
    f.current.speechContext = { dialogueId: 'opaque', dialogueVersion: 1, step, optionCount };
    await f.controller.startVoice();
    assert.equal(f.current.captures[0].options.shortAnswer, expected);
    assert.equal(f.current.captures[0].options.initialCommand, false);
  }
});
test('silence exits voice once without provider calls, a reprompt or a microphone loop', async (t) => {
  const f = fixture(t);
  let exits = 0;
  f.ui.idle = () => exits++;
  const before = f.current.input.value;
  await f.controller.startVoice();
  await f.current.captures[0].error(
    Object.assign(Error('No input'), { code: 'ASSISTANT_NO_INPUT' }),
  );
  assert.equal(exits, 1);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.recording, false);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.requests.length, 0);
  assert.equal(f.current.played.length, 0);
  assert.deepEqual(f.current.sent, []);
  assert.equal(f.current.input.value, before);
});

test('an empty transcript returns to idle without automatically reopening the microphone', async (t) => {
  const f = fixture(t);
  let exits = 0;
  f.ui.idle = () => exits++;
  f.current.request = async () => ({ text: '   ' });
  await f.controller.startVoice();
  await f.complete();
  assert.equal(exits, 1);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.recording, false);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.requests.length, 1);
  assert.deepEqual(f.current.sent, []);
  assert.deepEqual(f.current.heard, []);
});

test('late capture completion after an idle exit cannot send a command or rearm listening', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.current.captures[0].error(
    Object.assign(Error('No input'), { code: 'ASSISTANT_NO_INPUT' }),
  );
  await f.current.captures[0].complete('late-wav', { autoStopped: true });
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.requests.length, 0);
});

test('permission, revoke and stale-context errors remain terminal and cannot trigger no-input retries', async (t) => {
  for (const error of [
    Object.assign(Error('Microphone denied'), { name: 'NotAllowedError' }),
    Object.assign(Error('Revoked'), { status: 403 }),
    Object.assign(Error('Stale dialogue'), { status: 409 }),
    Object.assign(Error('Invalid WAV'), { status: 400 }),
  ]) {
    const f = fixture(t);
    await f.controller.startVoice();
    await f.current.captures[0].error(error);
    assert.equal(f.controller.voiceEnabled, false);
    assert.equal(f.current.captures.length, 1);
    assert.equal(f.current.requests.length, 0);
  }
});

test('personal recording and text limits reach automatic speech without a fixed 2000 character truncation', async (t) => {
  for (const [textLimit, expected] of [
    [4000, 2500],
    [2000, 2000],
  ]) {
    const f = fixture(t);
    f.state.assistantScope.limits = { maxAudioSeconds: 60, maxTextChars: textLimit };
    f.current.request = async () => ({ text: 'а'.repeat(2500) });
    await f.controller.startVoice();
    assert.equal(f.current.captures[0].seconds, 60);
    await f.complete();
    assert.equal(f.current.sent[0].length, expected);
    assert.equal(f.current.heard[0].length, expected);
  }
});

for (const streaming of [true, false, undefined])
  test(
    'speech requests progressive audio only when scope explicitly advertises streaming=' +
      String(streaming),
    async (t) => {
      const f = fixture(t);
      if (streaming !== undefined) f.state.assistantScope.capabilities.tts.streaming = streaming;
      f.current.request = async () =>
        streaming
          ? { streamUrl: '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43) }
          : { audioBase64: null, text: 'Вопрос' };
      assert.equal(await f.controller.speak('Вопрос'), true);
      assert.equal(f.current.requests.length, 1);
      assert.equal(f.current.requests[0].body.stream, streaming === true ? true : undefined);
      assert.equal(f.current.played.length, 1);
    },
  );
test('barge preparation and the same TTS request overlap while playback still waits for readiness and receives the short-answer fence', async (t) => {
  const f = fixture(t),
    tts = deferred(),
    barge = deferred(),
    order = [];
  f.state.assistantScope.capabilities.tts.streaming = true;
  f.current.speechContext = {
    dialogueId: 'opaque',
    dialogueVersion: 1,
    step: 'service',
    optionCount: 1,
  };
  let options;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, value) => {
    options = value;
    order.push('barge');
    return barge.promise;
  };
  f.actions.stopAssistantBargeIn = () => {};
  f.current.request = async (route) => {
    if (route.endsWith('/transcribe')) return { text: 'Синтетическое начало' };
    order.push('tts');
    return tts.promise;
  };
  await f.controller.startVoice();
  await f.complete();
  assert.deepEqual(
    f.current.sent,
    ['Синтетическое начало'],
    'the initial capture genuinely completed before the question',
  );
  const pending = f.controller.afterReply({
    text: 'PRX-T33?',
    dialogue: { step: 'service', phase: 'serviceChoice', prompt: 'PRX-T33?' },
  });
  assert.deepEqual(order, ['barge', 'tts']);
  assert.equal(options.shortAnswer, true);
  assert.equal(f.current.requests.find((row) => row.route.endsWith('/speak')).body.stream, true);
  f.current.clock = 900;
  tts.resolve({ streamUrl: '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43) });
  await flush();
  assert.equal(f.current.played.length, 0);
  f.current.clock = 965;
  barge.resolve({ ready: true });
  await pending;
  assert.equal(f.current.played.length, 1);
  assert.deepEqual(
    f.current.diagnostics.find((event) => event.event === 'bargeReadyWait'),
    { event: 'bargeReadyWait', milliseconds: 65 },
  );
  assert.equal(f.current.captures.length, 2);
});

test('cancelling parallel microphone preparation and TTS suppresses late playback and capture rearming', async (t) => {
  const f = fixture(t),
    tts = deferred(),
    barge = deferred();
  let options,
    stopped = 0;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, value) => {
    options = value;
    return barge.promise;
  };
  f.actions.stopAssistantBargeIn = () => {
    stopped++;
  };
  f.current.request = async () => tts.promise;
  await f.controller.startVoice();
  f.readyReply();
  const pending = f.controller.afterReply({
    text: 'Вопрос',
    dialogue: { step: 'client', prompt: 'Вопрос' },
  });
  const before = stopped;
  f.controller.stopVoice();
  assert.ok(stopped > before);
  assert.equal(options.current(), false);
  tts.resolve({ streamUrl: '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43) });
  barge.resolve({ ready: true });
  await pending;
  assert.equal(f.current.played.length, 0);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.controller.voiceEnabled, false);
});
test('a failed TTS request tears down only its parallel watcher and cannot announce or submit a new command', async (t) => {
  const f = fixture(t),
    barge = deferred();
  let options;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, value) => {
    options = value;
    return barge.promise;
  };
  f.actions.stopAssistantBargeIn = () => {};
  f.current.request = async () => {
    throw Error('Synthetic TTS failure');
  };
  await f.controller.startVoice();
  f.readyReply();
  await f.controller.afterReply({ text: 'Вопрос', dialogue: { step: 'client', prompt: 'Вопрос' } });
  assert.equal(options.current(), false);
  barge.resolve({ ready: true });
  await flush();
  assert.equal(f.current.played.length, 0);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.sent.length, 0);
});

for (const answerable of [false, true])
  test(
    'generic date speech remains exactly cacheable and never appends changing UI dates; answerable=' +
      answerable,
    async (t) => {
      const f = fixture(t);
      for (const prompt of [
        'На какую дату?',
        'На какую дату подготовить запись?',
        'На какую дату перенести?',
        'На какую дату запись?',
      ]) {
        for (const month of ['01', '02']) {
          const reply = {
            text: prompt,
            dialogue: {
              step: 'date',
              phase: 'date',
              prompt,
              options: [
                { id: 'opaque-first-date', label: 'Сегодня · 2030-' + month + '-02' },
                { id: 'opaque-second-date', label: 'Завтра · 2030-' + month + '-03' },
              ],
              fields: [{ key: 'client', label: 'Клиент', value: 'Анна Синтетическая' }],
            },
          };
          const before = JSON.stringify(reply),
            sent = f.current.requests.length;
          assert.equal(await f.controller.speakReply(reply, answerable), true);
          const requests = f.current.requests.slice(sent);
          assert.equal(requests.length, 1);
          assert.equal(requests[0].body.text, prompt);
          assert.equal(
            JSON.stringify(reply),
            before,
            'all date choices and fields remain available on screen',
          );
        }
      }
    },
  );
test('generic service and empty generic date text use exact short questions without mutating UI data', async (t) => {
  const f = fixture(t),
    service = question(),
    original = JSON.stringify(service);
  for (const answerable of [false, true]) {
    const sent = f.current.requests.length;
    assert.equal(await f.controller.speakReply(service, answerable), true);
    assert.equal(f.current.requests[sent].body.text, 'Какую услугу?');
    assert.equal(f.current.requests.length, sent + 1);
  }
  assert.equal(JSON.stringify(service), original);
  const sent = f.current.requests.length;
  await f.controller.speakReply(
    {
      text: '',
      dialogue: {
        step: 'date',
        phase: 'date',
        prompt: 'На какую дату?',
        options: [{ id: 'opaque', label: '2030-01-02' }],
      },
    },
    true,
  );
  assert.equal(f.current.requests[sent].body.text, 'На какую дату?');
});
test('short generic questions cannot hide date or service errors closed-day warnings or a concrete nearest-time offer', async (t) => {
  const f = fixture(t);
  for (const reply of [
    {
      text: 'Эта дата уже прошла. На какую дату?',
      dialogue: { step: 'date', phase: 'date', prompt: 'На какую дату?', options: [] },
    },
    {
      text: 'В этот день график закрыт. Продолжить?',
      dialogue: {
        step: 'date',
        phase: 'closedDay',
        prompt: 'В этот день график закрыт. Продолжить?',
        options: [],
      },
    },
    {
      text: 'Такой услуги у специалиста нет. Выберите услугу специалиста или введите её точное название.',
      dialogue: {
        step: 'service',
        prompt: 'Выберите услугу специалиста или введите её точное название.',
        options: [],
      },
    },
    {
      text: 'Ближайшее свободное время — в 12:30. Подойдёт?',
      dialogue: {
        step: 'time',
        phase: 'slots',
        prompt: 'Ближайшее свободное время — в 12:30. Подойдёт?',
        options: [{ id: 'opaque-slot', label: '2030-01-02 · 12:30–13:00 · Тестовый специалист' }],
      },
    },
  ]) {
    const before = JSON.stringify(reply),
      sent = f.current.requests.length;
    await f.controller.speakReply(reply, true);
    const text = f.current.requests
      .slice(sent)
      .map((row) => row.body.text)
      .join(' ');
    assert.ok(text.includes(reply.text.split('. ')[0]));
    assert.notEqual(text, 'На какую дату?');
    assert.notEqual(text, 'Какую услугу?');
    assert.equal(JSON.stringify(reply), before);
  }
});
test('concrete serviceChoice names remain audible instead of being replaced with the generic service question', async (t) => {
  const f = fixture(t),
    prompt = 'Вы имеете в виду «Пилинг PRX-T33»?';
  await f.controller.speakReply(
    {
      text: prompt,
      dialogue: {
        step: 'service',
        phase: 'serviceChoice',
        prompt,
        options: [{ id: 'opaque', label: 'Пилинг PRX-T33 · 60 мин' }],
      },
    },
    true,
  );
  assert.equal(f.current.requests.length, 1);
  assert.equal(f.current.requests[0].body.text, prompt);
});

function installAnswerHandoff(f) {
  const watchers = [],
    stops = [];
  let active = null;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, options) => {
    const watcher = {
      complete,
      error,
      seconds,
      options,
      listening: false,
      stopped: false,
      listens: 0,
      waits: 0,
      continues: 0,
    };
    active = watcher;
    watchers.push(watcher);
    return {
      ready: true,
      listen() {
        if (watcher.stopped || !options.current()) return false;
        watcher.listens++;
        watcher.listening = true;
        return true;
      },
      wait() {
        if (watcher.stopped || !options.current()) return false;
        watcher.waits++;
        watcher.listening = true;
        return true;
      },
      continuePlayback() {
        if (watcher.stopped || !options.current() || watcher.refuseContinuation) return false;
        watcher.continues++;
        return true;
      },
      playbackStarted() {
        if (watcher.stopped || !options.current()) return false;
        watcher.listening = false;
        return true;
      },
    };
  };
  f.actions.stopAssistantBargeIn = (discard) => {
    stops.push(discard);
    if (active) active.stopped = true;
    active = null;
  };
  return { watchers, stops };
}

test('completed question hands its owned microphone to an ordinary answer and sends STT once without cold capture', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    audio = deferred();
  f.current.speechContext = {
    dialogueId: 'synthetic-dialogue',
    dialogueVersion: 7,
    step: 'service',
    optionCount: 1,
  };
  await f.controller.startVoice();
  f.readyReply();
  f.current.playback = () => audio.promise;
  f.current.request = async (route) =>
    route.endsWith('/transcribe') ? { text: 'Да' } : { audioBase64: 'synthetic' };
  const pending = f.controller.afterReply({
    text: 'PRX-T33?',
    dialogue: { step: 'service', phase: 'serviceChoice', prompt: 'PRX-T33?' },
  });
  await flush();
  const watcher = handoff.watchers[0];
  assert.equal(
    watcher.listens,
    0,
    'normal answer mode cannot start before actual native playback completion',
  );
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.recording, false);
  audio.resolve(true);
  await pending;
  assert.equal(watcher.listens, 1);
  assert.equal(watcher.stopped, false);
  assert.equal(watcher.options.shortAnswer, true);
  assert.equal(f.current.recording, true);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.statuses.at(-1), 'Слушаю ваш ответ…');
  await watcher.complete('synthetic-short-yes', {
    autoStopped: true,
    interrupted: false,
    stopReason: 'silence',
  });
  await watcher.complete('duplicate-short-yes', { interrupted: false });
  await watcher.error(Error('Late callback'));
  assert.deepEqual(f.current.sent, ['Да']);
  assert.deepEqual(f.current.heard, ['Да']);
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 1);
  assert.equal(f.current.recording, false);
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.current.opened, 0);
});

test('one owned microphone spans every question chunk and only final EOF enters ordinary answer mode', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    first = deferred(),
    second = deferred();
  f.state.assistantScope.limits.maxReplyChars = 100;
  await f.controller.startVoice();
  f.readyReply();
  f.current.playback = () => (f.current.played.length === 1 ? first.promise : second.promise);
  const pending = f.controller.afterReply({
    text: 'а'.repeat(100) + '\n' + 'б'.repeat(50),
    dialogue: { step: 'date', phase: 'date', prompt: '', options: [] },
  });
  await flush();
  assert.equal(handoff.watchers.length, 1);
  const watcher = handoff.watchers[0];
  assert.equal(watcher.listens, 0);
  first.resolve(true);
  await flush();
  assert.equal(handoff.watchers.length, 1, 'no getUserMedia/worklet gap between chunks');
  assert.equal(watcher.waits, 1);
  assert.equal(watcher.continues, 1);
  assert.equal(watcher.listens, 0);
  assert.equal(watcher.stopped, false);
  assert.equal(f.current.recording, false);
  second.resolve(true);
  await pending;
  assert.equal(watcher.listens, 1);
  assert.equal(watcher.stopped, false);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.recording, true);
});

test('first silence in an active post-question listener pauses its draft without another question', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f);
  let exits = 0;
  f.ui.idle = () => exits++;
  f.current.speechContext = {
    dialogueId: 'opaque-draft',
    dialogueVersion: 2,
    step: 'date',
    optionCount: 0,
  };
  await f.controller.startVoice();
  f.readyReply();
  await f.controller.afterReply(question());
  const before = f.current.requests.length;
  await handoff.watchers[0].error(
    Object.assign(Error('No speech'), { code: 'ASSISTANT_NO_INPUT' }),
  );
  assert.equal(exits, 0);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.controller.voicePaused, true);
  assert.match(f.current.statuses.at(-1), /Продолжить/);
  assert.equal(f.current.input.value, 'saved-draft');
  assert.equal(f.current.recording, false);
  assert.equal(f.current.captures.length, 1);
  assert.equal(handoff.watchers.length, 1);
  assert.equal(f.current.requests.length, before);
  assert.deepEqual(f.current.sent, []);
});

test('a live post-question microphone failure clears recording without a new question or a lost draft', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f);
  await f.controller.startVoice();
  f.readyReply();
  await f.controller.afterReply(question());
  const before = f.current.requests.length;
  await handoff.watchers[0].error(Error('Микрофон отключён. Можно продолжить на экране.'));
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.recording, false);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.requests.length, before);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.input.value, 'saved-draft');
  assert.deepEqual(f.current.sent, []);
});

test('post-question callbacks are fenced after cancellation account/session change or revoked scope', async (t) => {
  for (const change of [
    (f) => f.controller.stopVoice(),
    (f) => {
      f.current.session++;
    },
    (f) => {
      f.current.alive = false;
    },
    (f) => {
      f.state.assistantGeneration++;
    },
  ]) {
    const f = fixture(t),
      handoff = installAnswerHandoff(f);
    await f.controller.startVoice();
    f.readyReply();
    await f.controller.afterReply(question());
    const watcher = handoff.watchers[0],
      before = f.current.requests.length;
    assert.equal(watcher.listening, true);
    change(f);
    await watcher.complete('stale-answer', { interrupted: false });
    await watcher.error(Object.assign(Error('Late no input'), { code: 'ASSISTANT_NO_INPUT' }));
    assert.equal(watcher.options.current(), false);
    assert.equal(f.current.requests.length, before);
    assert.equal(f.current.captures.length, 1);
    assert.deepEqual(f.current.sent, []);
    assert.equal(f.current.input.value, 'saved-draft');
    assert.equal(f.current.opened, 0);
  }
});

test('a refused handoff falls back once to ordinary capture without accepting the discarded listener', async (t) => {
  const f = fixture(t);
  let watcher;
  f.actions.startAssistantBargeIn = async (complete, error, seconds, options) => {
    watcher = { complete, error, options, listens: 0 };
    return {
      ready: true,
      listen() {
        watcher.listens++;
        return false;
      },
    };
  };
  f.actions.stopAssistantBargeIn = () => {};
  await f.controller.startVoice();
  await f.complete();
  const submitted = [...f.current.sent];
  const transcribed = f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length;
  assert.equal(
    transcribed,
    1,
    'the initial capture completes through STT rather than changing only UI flags',
  );
  await f.controller.afterReply(question());
  assert.equal(watcher.listens, 1);
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.current.recording, true);
  await watcher.complete('discarded-pcm', { interrupted: false });
  assert.deepEqual(f.current.sent, submitted, 'discarded watcher never submits another command');
  assert.equal(
    f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length,
    transcribed,
  );
});

test('manual stop of a waiting handed-off microphone stops its owner and does not call the unrelated recorder', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f);
  await f.controller.startVoice();
  f.readyReply();
  await f.controller.afterReply(question());
  const stopped = f.current.stopped || 0;
  await f.controller.capture();
  assert.ok(handoff.stops.includes(false));
  assert.equal(f.current.stopped || 0, stopped);
  assert.equal(f.current.recording, false);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.input.value, 'saved-draft');
  assert.deepEqual(f.current.sent, []);
});

test('stream preload overlaps microphone readiness while actual play and answer handoff remain fenced', async (t) => {
  const f = fixture(t),
    microphone = deferred(),
    audio = deferred(),
    order = [];
  let listens = 0,
    cancellations = 0;
  f.state.assistantScope.capabilities.tts.streaming = true;
  f.actions.startAssistantBargeIn = async () => {
    order.push('microphone-start');
    return microphone.promise;
  };
  f.actions.stopAssistantBargeIn = () => {};
  f.actions.prepareAssistantAudio = (reply) => {
    assert.ok(reply.streamUrl);
    order.push('stream-load');
    return {
      play() {
        order.push('stream-play');
        return audio.promise;
      },
      cancel() {
        cancellations++;
      },
    };
  };
  f.current.request = async () => ({
    streamUrl: '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43),
  });
  await f.controller.startVoice();
  f.readyReply();
  const pending = f.controller.afterReply(question());
  await flush();
  assert.deepEqual(order, ['microphone-start', 'stream-load']);
  assert.equal(f.current.played.length, 0);
  microphone.resolve({
    ready: true,
    listen() {
      listens++;
      return true;
    },
  });
  await flush();
  assert.deepEqual(order, ['microphone-start', 'stream-load', 'stream-play']);
  assert.equal(listens, 0, 'short answers are accepted only after actual native completion');
  audio.resolve(true);
  await pending;
  assert.equal(listens, 1);
  assert.equal(f.current.captures.length, 1, 'retain the prepared microphone for the first yes');
  assert.equal(f.current.recording, true);
  assert.ok(cancellations >= 1);
  assert.equal(f.current.played.length, 0, 'do not issue a second playback or reload the ticket');
});

test('stop during stream preload cancels its handle without late playback or microphone rearming', async (t) => {
  const f = fixture(t),
    microphone = deferred();
  let loads = 0,
    plays = 0,
    cancellations = 0;
  f.actions.startAssistantBargeIn = async () => microphone.promise;
  f.actions.stopAssistantBargeIn = () => {};
  f.actions.prepareAssistantAudio = () => {
    loads++;
    return {
      play() {
        plays++;
        return Promise.resolve(true);
      },
      cancel() {
        cancellations++;
      },
    };
  };
  f.current.request = async () => ({
    streamUrl: '/api/assistant/speak-audio?ticket=' + 'a'.repeat(43),
  });
  await f.controller.startVoice();
  f.readyReply();
  const pending = f.controller.afterReply(question());
  await flush();
  assert.equal(loads, 1);
  f.controller.stopVoice();
  microphone.resolve({ ready: true });
  await pending;
  assert.equal(plays, 0);
  assert.ok(cancellations >= 1);
  assert.equal(f.current.played.length, 0);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.controller.voiceEnabled, false);
});

test('a non-streaming reply falls back to ordinary playback when preload returns no handle', async (t) => {
  const f = fixture(t),
    local = { audioBase64: null, text: 'Локальный вопрос', local: true };
  const prepared = [];
  f.actions.prepareAssistantAudio = (reply) => {
    prepared.push(reply);
    return null;
  };
  f.current.request = async () => local;
  assert.equal(await f.controller.speak('Локальный вопрос'), true);
  assert.equal(f.current.played.length, 1);
  assert.equal(f.current.played[0].audioBase64, null);
  assert.equal(f.current.played[0].text, 'Локальный вопрос');
  assert.ok(
    prepared.length <= 1,
    'buffered and local providers do not need a native stream preloader',
  );
  assert.equal(f.current.captures.length, 0);
});

test('voice phase starts listening after microphone readiness and speaking after actual audio start', async (t) => {
  const f = fixture(t),
    phases = [];
  f.ui.phase = (value) => phases.push(value);
  await f.controller.startVoice();
  assert.ok(phases.includes('starting'));
  assert.equal(phases.at(-1), 'listening');
  assert.ok(f.current.statuses.every((value) => !value.includes('Говорите после сигнала')));
  await f.complete();
  f.readyReply();
  f.current.playback = async (output) => {
    assert.equal(phases.at(-1), 'pending');
    output.onStarted();
    assert.equal(phases.at(-1), 'speaking');
    return true;
  };
  await f.controller.afterReply(question());
  assert.equal(phases.at(-1), 'listening');
});

// CANCEL-EXECUTION-36

test('appointment cancellation confirmation captures the first short yes with current opaque dialogue metadata', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.capabilities.stt.local = true;
  f.current.speechContext = {
    dialogueId: 'opaque-cancel-confirmation',
    dialogueVersion: 4,
    step: 'appointment',
    phase: 'cancelConfirmation',
    optionCount: 2,
  };
  f.current.request = async (route) =>
    route.endsWith('/transcribe') ? { text: 'да' } : { audioBase64: 'synthetic' };
  await f.controller.startVoice();
  assert.equal(f.current.captures[0].options.shortAnswer, true);
  assert.equal(f.current.captures[0].options.initialCommand, false);
  assert.equal(f.current.captures[0].options.startCue, true);
  await f.complete();
  assert.deepEqual(f.current.sent, ['да']);
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 1);
  assert.equal(f.current.requests[0].body.dialogueId, 'opaque-cancel-confirmation');
  assert.equal(f.current.requests[0].body.dialogueVersion, 4);
});

test('cancellation confirmation is spoken as its question without reading option tokens or another action menu', async (t) => {
  const f = fixture(t);
  const reply = {
    text: 'Отменить запись Анны?',
    action: null,
    dialogue: {
      id: 'opaque-cancel',
      version: 1,
      step: 'appointment',
      phase: 'cancelConfirmation',
      prompt: 'Отменить запись Анны?',
      input: { type: 'text', field: 'appointment' },
      options: [
        { id: 'PRIVATE_CANCEL_YES', label: 'Да' },
        { id: 'PRIVATE_CANCEL_NO', label: 'Нет' },
      ],
      fields: [],
      canEdit: [],
    },
  };
  await f.controller.speakReply(reply, true);
  const spoken = f.current.requests
    .filter((row) => row.route.endsWith('/speak'))
    .map((row) => row.body.text)
    .join(' ');
  assert.match(spoken, /Отменить запись Анны/u);
  assert.doesNotMatch(spoken, /PRIVATE_CANCEL|номер|вариант|подготовить форму/iu);
  assert.equal(f.current.opened, 0);
});

test('acknowledged draft cancellation stops voice without requesting speech or reopening capture', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  const text = 'Подготовка записи остановлена.';
  await f.controller.afterReply({ text, draftCancelled: true, dialogue: null, action: null });
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.statuses.at(-1), text);
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/speak')).length, 0);
  assert.equal(f.current.captures.length, 1);
});

test('a cancellation execution action opens its guarded executor without speaking success before commit', async (t) => {
  const f = fixture(t),
    committed = deferred();
  f.ui.openResult = async () => {
    f.current.opened++;
    await committed.promise;
  };
  await f.controller.startVoice();
  await f.complete();
  const pending = f.controller.afterReply({
    text: 'Отменяю.',
    dialogue: null,
    action: { type: 'cancelAppointment', executionId: '20000000-0000-4000-8000-000000000001' },
  });
  await flush();
  assert.equal(f.current.opened, 1);
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/speak')).length, 0);
  assert.equal(f.current.captures.length, 1);
  committed.resolve({
    saved: true,
    cancelled: true,
    operation: 'cancel',
    text: 'Запись отменена.',
  });
  await pending;
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.current.captures.length, 1);
});

test('voice start cue is independent of initial-command pause and is renewed only for a fresh voice start', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  assert.equal(f.current.captures[0].options.startCue, true);
  assert.equal(f.current.captures[0].options.initialCommand, true);
  await f.complete();
  f.readyReply();
  f.current.speechContext = {
    dialogueId: 'opaque-existing',
    dialogueVersion: 1,
    step: 'service',
    optionCount: 1,
  };
  await f.controller.afterReply(question());
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.current.captures[1].options.startCue, false);
  assert.equal(f.current.captures[1].options.initialCommand, false);
  f.controller.stopVoice();
  f.readyReply();
  assert.equal(await f.controller.startVoice(), true);
  assert.equal(f.current.captures.length, 3);
  assert.equal(f.current.captures[2].options.startCue, true);
  assert.equal(f.current.captures[2].options.initialCommand, false);
  assert.equal(f.current.captures[2].options.shortAnswer, true);
});

test('resuming an existing spoken date question gives its first answer capture the fresh start cue', async (t) => {
  const f = fixture(t);
  f.current.speechContext = {
    dialogueId: 'opaque-existing',
    dialogueVersion: 2,
    step: 'date',
    optionCount: 1,
  };
  const reply = question();
  reply.text = 'Двадцатого октября?';
  reply.dialogue = {
    ...reply.dialogue,
    step: 'date',
    phase: 'date',
    prompt: reply.text,
    options: [{ id: 'opaque-month-confirmation', label: 'Двадцатого октября' }],
  };
  assert.equal(await f.controller.startVoice(reply), true);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.current.captures[0].options.startCue, true);
  assert.equal(f.current.captures[0].options.initialCommand, false);
  assert.equal(f.current.captures[0].options.shortAnswer, true);
});

// BARGE-WARM-37 — prepared only; execution belongs to the ordered root batch.
function appointmentQuestion37() {
  return {
    text: 'Какую запись?',
    action: null,
    dialogue: {
      id: 'opaque-management-choice',
      version: 7,
      step: 'appointment',
      phase: 'appointmentChoice',
      prompt: 'Какую запись?',
      options: [
        { id: 'opaque-source-a', label: 'завтра в 12:00 · Консультация' },
        { id: 'opaque-source-b', label: 'в пятницу в 14:00 · Повторная консультация' },
        { id: 'opaque-source-c', label: 'в субботу в 16:00 · Другая консультация' },
      ],
    },
  };
}
function managementSpeechContext37(f) {
  f.state.assistantScope.capabilities.stt.local = true;
  f.state.assistantScope.capabilities.tts.streaming = true;
  f.state.assistantScope.limits.maxReplyChars = 100;
  f.current.speechContext = {
    dialogueId: 'opaque-management-choice',
    dialogueVersion: 7,
    step: 'appointment',
    optionCount: 3,
  };
}
test('an appointmentChoice is barge-answerable in a later streamed chunk and retains its current dialogue identity', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    second = deferred();
  managementSpeechContext37(f);
  f.current.request = async (route) =>
    route.endsWith('/transcribe')
      ? { text: 'В пятницу в четырнадцать' }
      : { streamUrl: '/api/assistant/speak-audio?ticket=' + 'm'.repeat(43) };
  f.current.playback = () =>
    f.current.played.length === 1 ? Promise.resolve(true) : second.promise;
  let stops = 0;
  f.actions.stopAssistantAudio = () => {
    stops++;
    second.resolve(false);
  };
  await f.controller.startVoice();
  f.readyReply();
  const pending = f.controller.afterReply(appointmentQuestion37());
  await flush();
  assert.equal(f.current.played.length, 2);
  assert.equal(handoff.watchers.length, 1);
  const watcher = handoff.watchers[0];
  assert.equal(watcher.options.shortAnswer, true);
  assert.equal(watcher.continues, 1);
  // The native barge controller performs the stop, then announces confirmed takeover.
  f.actions.stopAssistantAudio();
  watcher.options.onInterrupt();
  await pending;
  assert.equal(stops, 1, 'one actual interruption after playback started');
  assert.equal(watcher.stopped, false);
  await watcher.complete('full-selection-pcm', { interrupted: true, autoStopped: true });
  await watcher.complete('duplicate-selection-pcm', { interrupted: true });
  assert.deepEqual(f.current.sent, ['В пятницу в четырнадцать']);
  const stt = f.current.requests.filter((row) => row.route.endsWith('/transcribe'));
  assert.equal(stt.length, 1);
  assert.equal(stt[0].body.audioBase64, 'full-selection-pcm');
  assert.equal(stt[0].body.dialogueId, 'opaque-management-choice');
  assert.equal(stt[0].body.dialogueVersion, 7);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.current.opened, 0);
});

test('speech during an inter-chunk TTS wait stops further playback and submits that full answer once', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    nextTts = deferred();
  managementSpeechContext37(f);
  let tts = 0;
  f.current.request = async (route) =>
    route.endsWith('/transcribe')
      ? { text: 'На завтра в двенадцать' }
      : ++tts === 1
        ? { audioBase64: 'first' }
        : nextTts.promise;
  await f.controller.startVoice();
  f.readyReply();
  const pending = f.controller.afterReply(appointmentQuestion37());
  await flush();
  const watcher = handoff.watchers[0];
  assert.equal(watcher.waits, 1);
  assert.equal(f.current.played.length, 1);
  watcher.options.onInterrupt();
  await watcher.complete('complete-gap-answer', { interrupted: true, autoStopped: true });
  nextTts.resolve({ audioBase64: 'late-next-audio' });
  await pending;
  assert.equal(handoff.watchers.length, 1);
  assert.equal(f.current.played.length, 1);
  assert.equal(f.current.captures.length, 1);
  assert.deepEqual(f.current.sent, ['На завтра в двенадцать']);
  assert.equal(f.controller.voiceEnabled, true);
});

test('inter-chunk cancellation session replacement and revoked scope fence late PCM and late TTS', async (t) => {
  for (const change of [
    (f) => f.controller.stopVoice(),
    (f) => f.current.session++,
    (f) => f.state.assistantGeneration++,
    (f) => {
      f.current.alive = false;
    },
  ]) {
    const f = fixture(t),
      handoff = installAnswerHandoff(f),
      nextTts = deferred();
    managementSpeechContext37(f);
    let tts = 0;
    f.current.request = async () => (++tts === 1 ? { audioBase64: 'first' } : nextTts.promise);
    await f.controller.startVoice();
    f.readyReply();
    const pending = f.controller.afterReply(appointmentQuestion37());
    await flush();
    const watcher = handoff.watchers[0];
    assert.equal(watcher.waits, 1);
    change(f);
    watcher.options.onInterrupt();
    await watcher.complete('stale-gap-answer', { interrupted: true });
    nextTts.resolve({ audioBase64: 'stale-tts' });
    await pending;
    assert.equal(f.current.played.length, 1);
    assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 0);
    assert.deepEqual(f.current.sent, []);
    assert.equal(f.current.opened, 0);
  }
});

test('a warm watcher that becomes unavailable does not truncate the remaining spoken question', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    nextTts = deferred();
  managementSpeechContext37(f);
  await f.controller.startVoice();
  // Complete the real initial PCM owner; readyReply alone changes only UI flags.
  await f.complete();
  f.readyReply();
  let tts = 0;
  f.current.request = async () => (++tts === 1 ? { audioBase64: 'first' } : nextTts.promise);
  const pending = f.controller.afterReply(appointmentQuestion37());
  await flush();
  handoff.watchers[0].refuseContinuation = true;
  nextTts.resolve({ audioBase64: 'remaining' });
  await pending;
  assert.equal(handoff.watchers.length, 1);
  assert.ok(f.current.played.length > 1);
  assert.equal(f.current.captures.length, 2, 'one bounded cold fallback after complete question');
  assert.equal(f.controller.voiceEnabled, true);
});

test('a complete answer during pending native startup cancels only after actual onStarted and sends one reply', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    native = deferred();
  managementSpeechContext37(f);
  let output,
    stops = 0;
  f.current.request = async (route) =>
    route.endsWith('/transcribe')
      ? { text: 'В пятницу в четырнадцать' }
      : { audioBase64: 'synthetic' };
  f.current.playback = (value) => {
    if (f.current.played.length === 1) {
      value.onStarted?.();
      return Promise.resolve(true);
    }
    output = value;
    return native.promise;
  };
  f.actions.stopAssistantAudio = () => {
    stops++;
    native.resolve(false);
  };
  await f.controller.startVoice();
  f.readyReply();
  const pending = f.controller.afterReply(appointmentQuestion37());
  await flush();
  const watcher = handoff.watchers[0];
  assert.equal(watcher.waits, 1);
  watcher.options.onInterrupt();
  assert.equal(stops, 0, 'barge does not pause/abort a not-yet-started native play');
  output.onStarted();
  assert.equal(stops, 1, 'the now-started stale question is immediately stopped');
  await pending;
  await watcher.complete('full-pending-start-answer', { interrupted: true });
  assert.deepEqual(f.current.sent, ['В пятницу в четырнадцать']);
  assert.equal(f.current.captures.length, 1);
  assert.equal(f.controller.voiceEnabled, true);
});

test('a slow next TTS request may expire only its warm watcher then finish speech and use one cold answer fallback', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f),
    nextTts = deferred();
  managementSpeechContext37(f);
  await f.controller.startVoice();
  // Complete the real initial PCM owner; readyReply alone changes only UI flags.
  await f.complete();
  f.readyReply();
  let requests = 0;
  f.current.request = async () => (++requests === 1 ? { audioBase64: 'first' } : nextTts.promise);
  const pending = f.controller.afterReply(appointmentQuestion37());
  await flush();
  const watcher = handoff.watchers[0];
  assert.equal(watcher.waits, 1);
  // The native watcher owns the bounded 8s timer; expiry is quiet, not a no-input error.
  watcher.stopped = true;
  assert.equal(f.controller.voiceEnabled, true);
  nextTts.resolve({ audioBase64: 'remaining' });
  await pending;
  assert.ok(f.current.played.length > 1);
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.controller.voiceEnabled, true);
  assert.ok(f.current.statuses.every((text) => !text.includes('Не услышал')));
});

test('a failed next TTS request immediately releases its warm microphone even for direct speech callers', async (t) => {
  const f = fixture(t),
    handoff = installAnswerHandoff(f);
  managementSpeechContext37(f);
  let requests = 0;
  f.current.request = async () => {
    if (++requests === 1) return { audioBase64: 'first' };
    throw Error('Synthetic next chunk failure');
  };
  await f.controller.startVoice();
  f.readyReply();
  await assert.rejects(
    f.controller.speak('а'.repeat(100) + '\n' + 'б'.repeat(50), true),
    /next chunk failure/,
  );
  assert.equal(handoff.watchers.length, 1);
  assert.equal(handoff.watchers[0].waits, 1);
  assert.equal(handoff.watchers[0].stopped, true);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.recording, false);
  assert.equal(f.current.requests.filter((row) => row.route.endsWith('/transcribe')).length, 0);
});

test('blocked voice playback directs to Continue rather than the stop microphone', async (t) => {
  const f = fixture(t);
  f.current.playback = async () => {
    throw Object.assign(Error('Нажмите «Озвучить».'), { code: 'ASSISTANT_AUDIO_GESTURE_REQUIRED' });
  };
  await f.controller.startVoice({
    text: 'На какую дату?',
    dialogue: { phase: 'date', step: 'date', prompt: 'На какую дату?', options: [] },
  });
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.controller.voicePaused, true);
  assert.equal(f.current.statuses.at(-1), 'Браузер заблокировал звук. Нажмите «Продолжить».');
});

test('PCM is negotiated only for a supported output and advertised streaming provider', async (t) => {
  for (const streaming of [true, false]) {
    const f = fixture(t);
    f.state.assistantScope.capabilities.tts.streaming = streaming;
    f.actions.assistantAudioFormat = () => 'pcm';
    await f.controller.speak('На какую дату?');
    const request = f.current.requests.find((row) => row.route.endsWith('/speak'));
    assert.equal(request.body.stream, streaming ? true : undefined);
    assert.equal(request.body.format, streaming ? 'pcm' : undefined);
  }
});

test('an active clarification survives a failed transcript without an automatic retry or lost input', async (t) => {
  const f = fixture(t);
  let exits = 0;
  f.ui.idle = () => exits++;
  f.current.speechContext = {
    dialogueId: 'opaque-draft',
    dialogueVersion: 5,
    step: 'service',
    optionCount: 0,
  };
  f.current.request = async () => {
    throw Object.assign(Error('Синтетическая ошибка распознавания'), { status: 502 });
  };
  await f.controller.startVoice();
  await f.complete();
  assert.equal(exits, 0);
  assert.equal(f.controller.voiceEnabled, false);
  assert.equal(f.controller.voicePaused, true);
  assert.equal(f.current.input.value, 'saved-draft');
  assert.equal(f.current.requests.length, 1);
  assert.deepEqual(f.current.sent, []);
  assert.equal(f.current.captures.length, 1);
  await f.controller.startVoice();
  assert.equal(f.controller.voiceEnabled, true);
  assert.equal(f.controller.voicePaused, false);
  assert.equal(f.current.captures.length, 2, 'only an explicit Continue reacquires capture');
  assert.equal(f.current.requests.length, 1, 'Continue does not resubmit the failed command');
});

test('a pending server operation prevents no-input from discarding the session before a dialogue snapshot exists', async (t) => {
  const f = fixture(t);
  let exits = 0;
  f.ui.idle = () => exits++;
  f.ui.pendingOperation = true;
  await f.controller.startVoice();
  await f.current.captures[0].error(
    Object.assign(Error('Silence'), { code: 'ASSISTANT_NO_INPUT' }),
  );
  assert.equal(exits, 0);
  assert.equal(f.controller.voicePaused, true);
  assert.equal(f.current.recording, false);
  assert.equal(f.current.busy, false);
  assert.equal(f.current.requests.length, 0);
  assert.deepEqual(f.current.sent, []);
});

test('a client identity question without a phase is spoken once instead of enumerating it again', async (t) => {
  const f = fixture(t),
    reply = {
      text: 'Анна Синтетическая, верно?',
      dialogue: {
        step: 'client',
        prompt: 'Анна Синтетическая, верно?',
        options: [{ id: 'PRIVATE_CHOICE', label: 'Анна Синтетическая · …1001' }],
      },
    };
  assert.equal(await f.controller.speakReply(reply, true), true);
  const spoken = f.current.requests
    .filter((x) => x.route.endsWith('/speak'))
    .map((x) => x.body.text)
    .join(' ');
  assert.equal(spoken, 'Анна Синтетическая, верно?');
  assert.doesNotMatch(spoken, /1001|Скажите|PRIVATE/u);
});

test('live barge failure diagnostics are logged without speech or a stale attempt', async (t) => {
  const f = fixture(t),
    warnings = [];
  // A separate controller realm has a deliberately bounded console sink.
  const factory = vm.runInNewContext(source + '\ncreateAssistantSpeech', {
    console: { warn: (...args) => warnings.push(args) },
  });
  let bargeOptions;
  f.actions.startAssistantBargeIn = async (_complete, _error, _seconds, options) => {
    bargeOptions = options;
    options.onStatus({
      reason: 'Ответьте после озвучивания.',
      diagnostic: { stage: 'worklet-load', name: 'NetworkError' },
    });
    return { ready: false };
  };
  f.actions.stopAssistantBargeIn = () => {};
  const controller = factory(f.state, f.actions).assistantSpeechController(f.ui);
  t.after(() => controller.stopVoice());
  await controller.startVoice();
  f.readyReply();
  await controller.afterReply({
    text: 'На какую дату?',
    dialogue: { step: 'date', phase: 'date', prompt: 'На какую дату?' },
  });
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0].length,
    1,
    'The browser log reader must receive the safe diagnostic as text',
  );
  assert.match(warnings[0][0], /^assistant-barge-in-failure \{/u);
  assert.deepEqual(JSON.parse(warnings[0][0].slice('assistant-barge-in-failure '.length)), {
    stage: 'worklet-load',
    name: 'NetworkError',
  });
  controller.stopVoice();
  bargeOptions.onStatus({
    reason: 'Late',
    diagnostic: { stage: 'media-source', name: 'NotSupportedError' },
  });
  assert.equal(warnings.length, 1);
});

test('cancellation confirmation speaks only the server question once and keeps listening without narrating the affirmative button', async (t) => {
  const f = fixture(t);
  await f.controller.startVoice();
  await f.complete();
  f.readyReply();
  const sentBeforeReply = [...f.current.sent];
  f.current.speechContext = {
    dialogueId: 'synthetic-cancel-dialogue',
    dialogueVersion: 4,
    step: 'appointment',
    optionCount: 1,
  };
  const reply = {
    text: 'Отменить запись Анны Синтетической завтра в 18:00?',
    action: null,
    dialogue: {
      id: 'synthetic-cancel-dialogue',
      version: 4,
      step: 'appointment',
      phase: 'cancelConfirmation',
      prompt: 'Отменить завтра в 18:00?',
      options: [{ id: 'opaque-cancel-confirm', label: 'Да, отменить запись' }],
      fields: [{ key: 'client', label: 'Клиент', value: 'Анна Синтетическая' }],
    },
  };
  const before = JSON.stringify(reply);
  await f.controller.afterReply(reply);
  const spoken = f.current.requests.filter((row) => row.route.endsWith('/speak'));
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].body.text, reply.dialogue.prompt);
  assert.doesNotMatch(spoken[0].body.text, /Да,|Какой подходит|Анны|Синтетической/u);
  assert.equal(f.current.captures.length, 2);
  assert.equal(f.current.captures[1].options.shortAnswer, true);
  assert.equal(f.controller.voiceEnabled, true);
  assert.deepEqual(f.current.sent, sentBeforeReply);
  assert.equal(f.current.opened, 0);
  assert.equal(JSON.stringify(reply), before);
});

test('paid speech uses the server canonical text and preserves its proof for each bounded chunk', async (t) => {
  const f = fixture(t);
  f.state.assistantScope.limits.maxReplyChars = 100;
  const text = 'Точный ответ сервера. '.repeat(12).trim(),
    permit = {
      token: 'synthetic-issued-proof',
      answerableText: text,
      readonlyText: 'Точный короткий ответ сервера.',
      handoffText: '',
    };
  const reply = {
    text: 'Этот локальный текст не должен читаться.',
    speechPermit: permit,
    dialogue: { step: 'review', fields: [{ label: 'Локальное поле', value: 'Не читать' }] },
  };
  assert.equal(await f.controller.speakReply(reply, true), true);
  assert.ok(f.current.requests.length > 1);
  assert.equal(f.current.requests.map(({ body }) => body.text).join(' '), text);
  assert.ok(
    f.current.requests.every(
      ({ body }) => body.speechToken === permit.token && body.text.length <= 100,
    ),
  );
  f.current.requests.length = 0;
  assert.equal(await f.controller.speakReply(reply, false), true);
  assert.equal(f.current.requests[0].body.text, permit.readonlyText);
  assert.equal(f.current.requests[0].body.speechToken, permit.token);
});

for (const step of ['review', 'availability', 'service']) {
  test(`information reply is spoken once at ${step} without re-reading fields or choices`, async (t) => {
    const f = fixture(t);
    const prompt = 'Выбрано: Анна, консультация. На какое время?';
    const reply = {
      text: prompt,
      action: null,
      dialogue: {
        id: 'synthetic-information-dialogue',
        version: 4,
        step,
        information: true,
        prompt,
        options: [{ id: 'opaque-current-choice', label: 'Не читать повторно' }],
        fields: [{ key: 'client', label: 'Клиент', value: 'Не повторять поле' }],
      },
    };
    const before = JSON.stringify(reply);
    assert.equal(await f.controller.speakReply(reply, true), true);
    const calls = f.current.requests.filter((row) => row.route.endsWith('/speak'));
    assert.equal(calls.map((row) => row.body.text).join(' '), prompt);
    assert.equal(f.current.opened, 0);
    assert.deepEqual(f.current.sent, []);
    assert.equal(JSON.stringify(reply), before);
  });
}

test('information fallback never replaces the server-issued speech text or permit', async (t) => {
  const f = fixture(t);
  const reply = {
    text: 'Локальный текст не используется.',
    dialogue: { step: 'review', information: true, prompt: 'Локальный вопрос.' },
    speechPermit: {
      token: 'synthetic-information-proof',
      answerableText: 'Серверное напоминание. На какое время?',
      readonlyText: 'Серверное напоминание.',
      handoffText: '',
    },
  };
  for (const answerable of [true, false]) {
    f.current.requests.length = 0;
    assert.equal(await f.controller.speakReply(reply, answerable), true);
    const calls = f.current.requests.filter((row) => row.route.endsWith('/speak'));
    assert.equal(
      calls.map((row) => row.body.text).join(' '),
      answerable ? reply.speechPermit.answerableText : reply.speechPermit.readonlyText,
    );
    assert.ok(calls.every((row) => row.body.speechToken === reply.speechPermit.token));
  }
});

for (const automatic of [false, true])
  test(`capture limit preserves the draft without transcription or execution, automatic=${automatic}`, async (t) => {
    const f = fixture(t);
    f.current.speechContext = {
      dialogueId: 'synthetic-limit-dialogue',
      dialogueVersion: 8,
      step: 'time',
      optionCount: 2,
      phase: 'slots',
    };
    const before = JSON.stringify(f.current.speechContext);
    if (automatic) await f.controller.startVoice();
    else await f.controller.capture();
    const capture = f.current.captures[0];
    await capture.complete('cutoff-wav', { autoStopped: true, stopReason: 'limit' });
    const messages = f.current.statuses.length;
    await capture.complete('late-wav', { stopReason: 'silence' });
    await capture.error(Error('Late cutoff callback'));
    assert.equal(f.current.requests.length, 0);
    assert.deepEqual(f.current.sent, []);
    assert.deepEqual(f.current.heard, []);
    assert.equal(f.current.input.value, 'saved-draft');
    assert.equal(JSON.stringify(f.current.speechContext), before);
    assert.equal(f.current.recording, false);
    assert.equal(f.current.busy, false);
    assert.equal(f.current.statuses.length, messages);
    assert.match(f.current.statuses.at(-1), /Фраза слишком длинная/);
    if (automatic) {
      assert.equal(f.controller.voicePaused, true);
      assert.equal(await f.controller.startVoice(), true);
      assert.equal(f.current.captures.length, 2);
      await capture.complete('stale-limit-wav', { stopReason: 'limit' });
      assert.equal(f.current.recording, true);
      await f.complete();
      assert.equal(f.current.sent.length, 1, 'only the explicitly repeated phrase is sent');
      assert.equal(f.current.requests[0].route, '/api/assistant/transcribe');
      assert.equal(JSON.stringify(f.current.speechContext), before);
    }
  });

for (const interrupted of [false, true])
  test(`a prearmed answer limit never transcribes or executes, interrupted=${interrupted}`, async (t) => {
    const f = fixture(t),
      handoff = installAnswerHandoff(f);
    await f.controller.startVoice();
    f.readyReply();
    await f.controller.afterReply(question());
    const watcher = handoff.watchers[0];
    if (interrupted) watcher.options.onInterrupt();
    const before = f.current.requests.length;
    await watcher.complete('cutoff-barge-wav', {
      interrupted,
      autoStopped: true,
      stopReason: 'limit',
    });
    await watcher.complete('late-barge-wav', { stopReason: 'silence', interrupted });
    assert.equal(f.current.requests.length, before);
    assert.deepEqual(f.current.sent, []);
    assert.deepEqual(f.current.heard, []);
    assert.equal(f.current.input.value, 'saved-draft');
    assert.equal(f.controller.voicePaused, true);
    assert.equal(f.current.recording, false);
    assert.equal(f.current.captures.length, 1, 'the limit cannot automatically rearm capture');
  });

test('long clarification pauses preserve short-answer onset while bound confirmations keep fast silence', async (t) => {
  for (const [step, count, phase, fast] of [
    ['client', 3, 'clientChoice', false],
    ['service', 1, 'serviceChoice', false],
    ['service', 5, 'serviceChoice', false],
    ['staff', 2, undefined, false],
    ['date', 1, 'date', false],
    ['appointment', 3, 'appointmentChoice', false],
    ['time', 3, 'slots', false],
    ['client', 1, 'clientChoice', true],
    ['time', 1, 'closedDay', true],
    ['appointment', 1, 'cancelConfirmation', true],
  ]) {
    const f = fixture(t);
    f.current.speechContext = {
      dialogueId: 'synthetic-pause-dialogue',
      dialogueVersion: 2,
      step,
      optionCount: count,
      phase,
    };
    await f.controller.startVoice();
    assert.equal(f.current.captures[0].options.shortAnswer, true, step);
    assert.equal(f.current.captures[0].options.shortSilence, fast, `${step}/${phase}`);
    f.controller.stopVoice();
  }
});

test('prearmed and ordinary capture share the same explicit pause profile without sending metadata to STT', async (t) => {
  for (const [step, phase, expected] of [
    ['service', 'serviceChoice', false],
    ['appointment', 'cancelConfirmation', true],
  ]) {
    const f = fixture(t),
      handoff = installAnswerHandoff(f);
    f.current.speechContext = {
      dialogueId: 'synthetic-pause-dialogue',
      dialogueVersion: 2,
      step,
      optionCount: 1,
      phase,
    };
    await f.controller.startVoice();
    f.readyReply();
    await f.controller.afterReply(question());
    const watcher = handoff.watchers[0];
    assert.equal(watcher.options.shortAnswer, true);
    assert.equal(watcher.options.shortSilence, expected);
    await watcher.complete('complete-answer-wav', { stopReason: 'silence' });
    assert.equal(f.current.sent.length, 1);
    const request = f.current.requests.find((row) => row.route.endsWith('/transcribe'));
    assert.equal(request.body.phase, undefined);
    assert.equal(request.body.shortSilence, undefined);
  }
});

test('initial automatic PCM uses its recording watcher; manual and MP3 retain the legacy path', async (t) => {
  for (const mode of ['pcm', 'mp3', 'manual']) {
    const f = fixture(t),
      handoff = installAnswerHandoff(f);
    f.actions.assistantAudioFormat = () => (mode === 'mp3' ? 'mp3' : 'pcm');
    if (mode === 'manual') await f.controller.capture();
    else await f.controller.startVoice();
    assert.equal(f.current.captures.length, mode === 'pcm' ? 0 : 1, mode);
    assert.equal(handoff.watchers.length, mode === 'pcm' ? 1 : 0, mode);
    if (mode === 'pcm') {
      const watcher = handoff.watchers[0];
      assert.equal(watcher.options.initialCapture, true);
      assert.equal(watcher.options.initialCommand, true);
      assert.equal(watcher.options.startCue, true);
      assert.equal(watcher.listens, 1);
      await watcher.complete('pcm-wav', { stopReason: 'silence', seconds: 2 });
      await watcher.complete('pcm-wav', { stopReason: 'silence', seconds: 2 });
      assert.equal(
        f.current.requests.filter((value) => value.route.endsWith('/transcribe')).length,
        1,
      );
      assert.equal(f.current.sent.length, 1);
    }
  }
});

test('automatic PCM falls back once only for an explicit pre-start failure and discards late callbacks', async (t) => {
  for (const fallbackAllowed of [true, false]) {
    const f = fixture(t);
    let complete;
    f.actions.assistantAudioFormat = () => 'pcm';
    f.actions.startAssistantBargeIn = async (done) => {
      complete = done;
      return { ready: false, fallbackAllowed };
    };
    f.actions.stopAssistantBargeIn = () => {};
    await f.controller.startVoice();
    assert.equal(f.current.captures.length, fallbackAllowed ? 1 : 0);
    await complete('late-pcm', { stopReason: 'silence' });
    assert.equal(f.current.requests.length, 0);
    if (fallbackAllowed) {
      await f.complete();
      assert.equal(f.current.sent.length, 1);
    }
  }
  for (const change of [
    (f) => f.controller.stopVoice(),
    (f) => f.state.assistantGeneration++,
    (f) => f.current.session++,
  ]) {
    const f = fixture(t),
      gate = deferred();
    f.actions.assistantAudioFormat = () => 'pcm';
    f.actions.startAssistantBargeIn = () => gate.promise;
    f.actions.stopAssistantBargeIn = () => {};
    const pending = f.controller.startVoice();
    change(f);
    gate.resolve({ ready: false, fallbackAllowed: true });
    await pending;
    assert.equal(f.current.captures.length, 0);
    assert.equal(f.current.requests.length, 0);
  }
});

test('initial PCM permission failure preserves its permission hint and never asks a second time', async (t) => {
  const f = fixture(t);
  f.actions.assistantAudioFormat = () => 'pcm';
  f.actions.startAssistantBargeIn = async () => ({
    ready: false,
    fallbackAllowed: false,
    error: Object.assign(Error('synthetic browser denial'), { name: 'NotAllowedError' }),
  });
  f.actions.stopAssistantBargeIn = () => {};
  await f.controller.startVoice();
  assert.equal(f.current.captures.length, 0);
  assert.equal(f.current.requests.length, 0);
  assert.match(f.current.statuses.at(-1), /Доступ к микрофону закрыт/);
});

test('initial PCM never replays a started recording after a processor failure or a hard duration limit', async (t) => {
  for (const result of ['failure', 'limit']) {
    const f = fixture(t),
      handoff = installAnswerHandoff(f);
    f.actions.assistantAudioFormat = () => 'pcm';
    await f.controller.startVoice();
    const watcher = handoff.watchers[0];
    if (result === 'failure') await watcher.error(Error('synthetic processor failure'));
    else await watcher.complete('bounded-pcm', { stopReason: 'limit', seconds: 30 });
    await watcher.complete('late-pcm', { stopReason: 'silence', seconds: 1 });
    assert.equal(f.current.captures.length, 0);
    assert.equal(f.current.requests.length, 0);
    assert.equal(f.current.sent.length, 0);
    assert.equal(handoff.watchers.length, 1);
  }
});
