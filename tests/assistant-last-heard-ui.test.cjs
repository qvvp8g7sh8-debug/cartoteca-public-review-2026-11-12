const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
function fixture(
  t,
  turn = async (body) => ({
    text: 'Синтетический вопрос',
    policyVersion: 1,
    action: null,
    dialogue: body.cancel
      ? null
      : {
          id: 'synthetic-dialogue',
          version: 2,
          step: 'service',
          prompt: 'Какая услуга?',
          input: null,
          options: [],
          fields: [],
          canEdit: [],
        },
  }),
) {
  const w = new JSDOM('<main></main>', {
    url: 'https://synthetic.invalid',
    runScripts: 'outside-only',
  }).window;
  w.AbortController = AbortController;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const scope = {
    enabled: true,
    organizationId: 'synthetic-org',
    policyVersion: 1,
    demo: false,
    limits: {},
  };
  const state = {
    account: { organizationId: scope.organizationId },
    currentView: 'calendar',
    assistantScope: scope,
    assistantReady: true,
    assistantGeneration: 0,
  };
  const requests = [],
    commands = [];
  let open, speechUI;
  const actions = {
    mountAssistantTrigger(callback) {
      open = callback;
    },
    destroyAssistantTrigger() {},
    stopAssistantCapture() {},
    stopAssistantAudio() {},
    discardAssistantDraft() {},
    toast() {},
    applyAssistantScope(value) {
      state.assistantScope = value;
    },
    resetAssistant() {
      state.assistantGeneration++;
    },
    assistantDraftText: () => '',
    assistantActionCaption: () => '',
    runAssistantAction: async (value) => commands.push(value),
    assistantSpeechController(ui) {
      speechUI = ui;
      return {
        voiceEnabled: false,
        stopVoice() {},
        async startVoice() {},
        async capture() {},
        async speak() {},
        async afterReply() {},
      };
    },
    async request(route, options) {
      requests.push({ route, options });
      if (route.endsWith('/scope')) return scope;
      assert.equal(route, '/api/assistant/turn');
      return turn(JSON.parse(options.body));
    },
  };
  const read = (name) =>
    fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8');
  w.eval(read('assistant-conversation'));
  Object.assign(actions, w.eval('createAssistantConversation')());
  w.eval(read('assistant-presentation'));
  Object.assign(actions, w.eval('createAssistantPresentation')());
  w.eval(read('assistant-idle'));
  Object.assign(actions, w.eval('createAssistantIdle')());
  w.eval(read('voice-assistant'));
  const api = w.eval('createVoiceAssistant')(state, actions);
  api.mountVoiceAssistant();
  t.after(() => {
    api.destroyVoiceAssistant();
    w.close();
  });
  return {
    w,
    state,
    api,
    requests,
    commands,
    field: (name) => w.document.querySelector('[data-assistant-' + name + ']'),
    get ui() {
      return speechUI;
    },
    async open() {
      open({ voice: false });
      await flush();
    },
  };
}
test('last-heard feedback starts hidden, escapes transcript text and survives dialogue renders without keeping history', async (t) => {
  const f = fixture(t);
  await f.open();
  assert.ok(f.field('heard'), 'Feedback line exists in the panel');
  assert.equal(f.field('heard').hidden, true);
  assert.equal(f.field('heard').textContent, '');
  assert.equal(f.field('heard').classList.contains('form-hint'), true);
  const text = '<img data-synthetic-transcript src=x onerror=alert(1)> & услуга';
  f.ui.heard(text);
  assert.equal(f.field('heard').hidden, false);
  assert.equal(f.field('heard').textContent, 'Вы сказали: «' + text + '»');
  assert.equal(f.field('heard').querySelector('img'), null);
  await f.ui.sendText('Синтетическая новая запись');
  assert.equal(f.field('heard').textContent, 'Вы сказали: «' + text + '»');
  f.ui.heard('На завтра');
  await f.ui.sendText('На завтра');
  assert.equal(f.field('heard').textContent, 'Вы сказали: «На завтра»');
  assert.equal(f.w.document.querySelectorAll('[data-assistant-heard]').length, 1);
  assert.doesNotMatch(f.field('heard').textContent, /услуга/);
  assert.equal(f.commands.length, 0);
});
test('new-command and close clear last-heard feedback and late callbacks cannot repopulate a closed panel', async (t) => {
  const f = fixture(t);
  await f.open();
  f.ui.heard('Первичная консультация');
  await f.ui.sendText('Синтетическая новая запись');
  f.field('new').click();
  await flush();
  assert.equal(
    f.requests
      .filter((item) => item.route.endsWith('/turn'))
      .at(-1)
      .options.body.includes('"cancel":true'),
    true,
  );
  assert.equal(f.field('heard').hidden, true);
  assert.equal(f.field('heard').textContent, '');
  f.ui.heard('Тридцать минут');
  f.field('close').click();
  assert.equal(f.field('heard').hidden, true);
  assert.equal(f.field('heard').textContent, '');
  f.ui.heard('Поздний ответ');
  assert.equal(f.field('heard').textContent, '');
  await f.open();
  assert.equal(f.field('heard').hidden, true);
  assert.equal(f.field('heard').textContent, '');
});
test('server rejection keeps the last heard phrase visible and clear feedback never enters a turn payload', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    if (++calls === 2) throw Object.assign(Error('Уточните дату'), { status: 400 });
    return {
      text: 'Назовите дату',
      policyVersion: 1,
      action: null,
      dialogue: {
        id: 'synthetic-dialogue',
        version: 1,
        step: 'date',
        prompt: 'Когда?',
        input: { field: 'date', type: 'date' },
        options: [],
        fields: [],
        canEdit: [],
      },
    };
  });
  await f.open();
  await f.ui.sendText('Синтетическая запись');
  f.ui.heard('на завтра');
  await f.ui.sendText('на завтра');
  assert.equal(f.field('heard').textContent, 'Вы сказали: «на завтра»');
  assert.match(f.field('status').textContent, /Уточните дату/);
  assert.ok(
    f.requests.every((item) => !item.options.body || !item.options.body.includes('Вы сказали')),
  );
});
