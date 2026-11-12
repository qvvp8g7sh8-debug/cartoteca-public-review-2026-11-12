const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path');
const { JSDOM } = require('jsdom');
const read = (name) =>
  fs.readFileSync(path.resolve(__dirname, '../../src/client/modules', name + '.js'), 'utf8');
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const reply = (version, step = 'service', input = null) => ({
  policyVersion: 1,
  demo: false,
  text: 'Уточните запись',
  action: null,
  dialogue: {
    id: 'synthetic-dialogue',
    version,
    step,
    prompt: step === 'review' ? 'Проверьте запись' : 'Выберите услугу',
    input,
    options: [
      {
        id: 'opaque-option-' + version,
        label: step === 'review' ? 'Подготовить форму записи' : 'Чистка',
      },
    ],
    fields: [
      { key: 'client', label: 'Клиент', value: 'Анна Синтетическая' },
      { key: 'date', label: 'Дата', value: '2030-01-02' },
    ],
    canEdit: ['client', 'date'],
  },
});
function fixture(t, configuration = {}) {
  const w = new JSDOM(
    '<main><div class="calendar-booking-tools"><button id="calendar-new" type="button">Добавить запись</button></div><div id="form-content"></div></main>',
    { url: 'https://synthetic.invalid', runScripts: 'outside-only', pretendToBeVisual: true },
  ).window;
  let now = 0,
    timerId = 0;
  const timers = new Map();
  w.setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.AbortController = AbortController;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const scope = {
    enabled: true,
    organizationId: 'org',
    policyVersion: 1,
    demo: false,
    limits: { maxTextChars: 2000, maxAudioSeconds: 30 },
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false } },
    ...configuration.scope,
  };
  const state = {
    account: { id: 'staff', organizationId: 'org' },
    currentView: 'calendar',
    assistantScope: scope,
    assistantReady: true,
    assistantGeneration: 0,
    editorMode: null,
  };
  const calls = [],
    captures = [],
    played = [],
    opened = [],
    toasts = [],
    stops = [];
  let api,
    activePlayback = null;
  const control = {
    stt: async () => ({ text: 'Синтетическая команда', policyVersion: 1 }),
    turn: async () => reply(1),
    speak: async () => ({
      audioBase64: 'synthetic-audio',
      mimeType: 'audio/wav',
      policyVersion: 1,
    }),
    permission: async () => true,
  };
  const actions = {
    toast: (text) => toasts.push(text),
    $: (selector) => w.document.querySelector(selector),
    applyAssistantScope: (value) => {
      state.assistantScope = value;
    },
    resetAssistant() {
      state.assistantGeneration++;
      api.destroyVoiceAssistant();
    },
    discardAssistantDraft() {},
    startAssistantCapture: async (complete, error, seconds, options) => {
      captures.push({ complete, error, seconds, options });
      return control.permission();
    },
    stopAssistantCapture: (discard) => stops.push(discard),
    stopAssistantAudio() {
      activePlayback?.resolve(false);
      activePlayback = null;
    },
    playAssistantAudio: (result) => {
      const gate = deferred();
      played.push({ result, gate });
      activePlayback = gate;
      return gate.promise;
    },
    clientRecords: () => [{ id: 'synthetic-patient', name: 'Анна Синтетическая' }],
    servicesForStaff: () => [{ id: 'synthetic-service', name: 'Чистка', duration: 30 }],
    accountId: () => state.account.id,
    serviceSnapshot: (value) => ({ ...value }),
    formatDate: (value) => value,
    mountAppointmentTimePicker() {},
    async openAppointmentForm(draft, origin) {
      opened.push({ draft, origin });
      state.editorMode = { kind: 'appointment', id: null, source: origin };
      actions.$('#form-content').innerHTML = '<input name="date"><input name="time">';
    },
    save: () => assert.fail('Voice must never save an appointment'),
    saveCabinet: () => assert.fail('Voice must never save a cabinet'),
    async request(route, options) {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ route, body, options });
      if (route === '/api/assistant/scope') return scope;
      if (route === '/api/assistant/transcribe') return control.stt(body, options);
      if (route === '/api/assistant/turn') return control.turn(body, options);
      if (route === '/api/assistant/speak') return control.speak(body, options);
      assert.fail('Unexpected non-assistant request ' + route);
    },
  };
  for (const [name, factory] of [
    ['assistant-trigger', 'createAssistantTrigger'],
    ['assistant-conversation', 'createAssistantConversation'],
    ['assistant-presentation', 'createAssistantPresentation'],
    ['assistant-speech-text', 'createAssistantSpeechText'],
    ['assistant-speech', 'createAssistantSpeech'],
    ['assistant-commands', 'createAssistantCommands'],
  ]) {
    w.eval(read(name));
    Object.assign(actions, w.eval(factory)(state, actions));
  }
  w.eval(read('assistant-idle'));
  Object.assign(actions, w.eval('createAssistantIdle')());
  w.eval(read('voice-assistant'));
  api = w.eval('createVoiceAssistant')(state, actions);
  api.mountVoiceAssistant();
  t.after(async () => {
    api.destroyVoiceAssistant();
    await flush();
    w.close();
  });
  const pointer = (type) => {
    const event = new w.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: 10,
      clientY: 10,
    });
    for (const [key, value] of Object.entries({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    }))
      Object.defineProperty(event, key, { value });
    actions.$('#calendar-new').dispatchEvent(event);
  };
  const advance = (ms) => {
    const end = now + ms;
    for (let i = 0; i < 100; i++) {
      const entry = [...timers]
        .filter(([, value]) => value.due <= end)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) {
        now = end;
        return;
      }
      const [id, value] = entry;
      now = value.due;
      timers.delete(id);
      value.callback();
    }
    throw Error('Synthetic timer did not settle');
  };
  return {
    w,
    state,
    scope,
    api,
    actions,
    control,
    calls,
    captures,
    played,
    opened,
    toasts,
    stops,
    $: actions.$,
    async hold() {
      pointer('pointerdown');
      advance(599);
      await flush();
      assert.equal(captures.length, 0);
      advance(1);
      pointer('pointerup');
      await flush();
    },
    async keyboard() {
      actions.$('#calendar-new').dispatchEvent(
        new w.KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await flush();
    },
    transcript(text) {
      control.stt = async () => ({ text, policyVersion: 1 });
      return captures
        .at(-1)
        .complete('synthetic-wav', { autoStopped: true, seconds: 2, stopReason: 'silence' });
    },
    async finishSpeech(value = true) {
      played.at(-1).gate.resolve(value);
      activePlayback = null;
      await flush();
    },
    turns: () => calls.filter((call) => call.route === '/api/assistant/turn'),
  };
}

module.exports = { fixture, reply, deferred, flush };
