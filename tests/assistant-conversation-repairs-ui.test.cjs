const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const modules = path.join(__dirname, '../src/client/modules');
const source = (name) => fs.readFileSync(path.join(modules, name + '.js'), 'utf8');
const flush = async () => {
  for (let count = 0; count < 20; count++) await Promise.resolve();
};
function fixture(t) {
  const w = new JSDOM('<main></main>', {
    url: 'https://synthetic.invalid',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  }).window;
  w.eval(source('assistant-conversation'));
  const api = w.eval('createAssistantConversation')();
  const panel = w.document.createElement('div');
  panel.innerHTML = api.assistantPanelHtml();
  w.document.body.append(panel);
  const cleanup = [];
  t.after(() => {
    for (const callback of cleanup) callback();
    w.close();
  });
  return {
    w,
    cleanup,
    api,
    panel,
    field: (name) => panel.querySelector('[data-assistant-' + name + ']'),
    render: (reply, presentation) => api.renderAssistantConversation(panel, reply, presentation),
  };
}
function dialogue(step = 'review', input = null) {
  return {
    id: 'synthetic-dialogue',
    version: 3,
    step,
    prompt: 'Проверьте данные и выберите действие.',
    input,
    options: [{ id: 'opaque-option', label: 'Подготовить форму записи' }],
    fields: [{ key: 'time', label: 'Время', value: '14:30' }],
    canEdit: ['time'],
    expiresAt: 4102444800000,
  };
}
test('review exposes a correction field while retaining explicit form preparation and edit choices', (t) => {
  const f = fixture(t);
  const value = dialogue();
  const before = JSON.stringify(value);
  let submits = 0;
  f.panel.addEventListener('submit', () => submits++);
  f.render({ dialogue: value, action: null });
  assert.equal(f.field('input-wrap').hidden, false);
  assert.equal(f.field('send').hidden, false);
  assert.equal(f.field('input').type, 'text');
  assert.equal(f.field('prompt').textContent, 'Ответ или исправление');
  assert.match(f.field('input').placeholder, /второй вариант/);
  assert.match(f.field('input').placeholder, /на полчаса позже/);
  assert.equal(
    f.panel.querySelector('[data-assistant-choice]').dataset.assistantChoice,
    'opaque-option',
  );
  assert.equal(f.panel.querySelector('[data-assistant-edit]').dataset.assistantEdit, 'time');
  assert.equal(f.field('action').hidden, true);
  assert.equal(submits, 0);
  assert.equal(JSON.stringify(value), before, 'Renderer does not replace semantic input:null');
});
test('availability and choice-only client, staff and service steps accept local text corrections', (t) => {
  const f = fixture(t);
  for (const step of ['availability', 'client', 'staff', 'service']) {
    f.render({ dialogue: dialogue(step), action: null });
    assert.equal(f.field('input-wrap').hidden, false, step);
    assert.equal(f.field('send').hidden, false, step);
    f.field('input').value = 'второй вариант';
    assert.equal(f.field('input').reportValidity(), true, step);
    assert.equal(f.field('new').hidden, false, step);
    assert.equal(f.field('example').hidden, true, step);
    assert.ok(f.panel.querySelector('[data-assistant-choice]'), step);
  }
});
test('correction field follows the existing voice focus guard and is cleared between versions', (t) => {
  const f = fixture(t);
  const external = f.w.document.createElement('button');
  f.w.document.body.append(external);
  external.focus();
  f.render({ dialogue: dialogue() }, { voice: true });
  assert.equal(f.w.document.activeElement, external);
  f.render({ dialogue: dialogue() });
  assert.equal(f.w.document.activeElement, f.field('input'));
  f.field('input').value = 'на полчаса позже';
  f.render({ dialogue: { ...dialogue(), version: 4 } });
  assert.equal(f.field('input').value, '');
});
test('date, time and duration DTOs allow natural corrections without native input validation', (t) => {
  const f = fixture(t);
  for (const [field, type, correction, placeholder] of [
    ['date', 'date', 'нет, завтра', /завтра/],
    ['time', 'time', 'на полчаса позже', /утром, с 10 до 12/],
    ['duration', 'number', 'полчаса', /45 минут/],
  ]) {
    const value = dialogue(field, { field, type });
    f.render({ dialogue: value });
    const input = f.field('input');
    assert.equal(input.type, 'text');
    assert.equal(input.inputMode, 'text');
    assert.equal(input.min, '');
    assert.equal(input.max, '');
    assert.equal(input.step, '');
    assert.match(input.placeholder, placeholder);
    input.value = correction;
    assert.equal(input.value, correction, 'Natural text is retained for the server parser');
    assert.equal(input.reportValidity(), true);
    assert.equal(f.field('prompt').textContent, value.prompt);
    assert.equal(value.input.type, type, 'Semantic server field is not replaced');
  }
});
test('natural correction rendering leaves native fields in an ordinary appointment form unchanged', (t) => {
  const f = fixture(t);
  const form = f.w.document.createElement('form');
  form.innerHTML =
    '<input name="date" type="date"><input name="time" type="time"><input name="duration" type="number" min="5" max="1440" step="5">';
  f.w.document.body.append(form);
  f.render({ dialogue: dialogue('time', { field: 'time', type: 'time' }) });
  assert.equal(form.elements.date.type, 'date');
  assert.equal(form.elements.time.type, 'time');
  assert.equal(form.elements.duration.type, 'number');
  assert.equal(form.elements.duration.min, '5');
  assert.equal(form.elements.duration.max, '1440');
  assert.equal(form.elements.duration.step, '5');
});
test('read-only availability does not gain dialogue editing or booking choices', (t) => {
  const f = fixture(t);
  f.render({
    action: null,
    readOnlySlots: [
      {
        date: '2030-01-02',
        time: '14:30',
        endTime: '15:00',
        duration: 30,
        staffName: 'Синтетический специалист',
      },
    ],
  });
  assert.equal(f.field('input-wrap').hidden, true);
  assert.equal(f.field('command-label').hidden, false);
  assert.equal(f.field('new').hidden, true);
  assert.equal(f.panel.querySelector('[data-assistant-choice]'), null);
  assert.equal(f.panel.querySelector('[data-assistant-edit]'), null);
  assert.match(f.field('conversation').textContent, /Подготовка записи помощником недоступна/);
});
test('controller submits corrections from input:null with the current dialogue version and never saves', async (t) => {
  const f = fixture(t);
  f.panel.remove();
  f.w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  f.w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  f.w.AbortController = AbortController;
  const scope = { enabled: true, organizationId: 'org', policyVersion: 1, demo: true, limits: {} };
  const state = {
    account: { id: 'staff', organizationId: 'org' },
    currentView: 'calendar',
    assistantScope: scope,
    assistantReady: true,
    assistantGeneration: 0,
  };
  const sent = [],
    opened = [];
  let trigger, speechUI;
  const actions = {
    ...f.api,
    mountAssistantTrigger(callback) {
      trigger = callback;
    },
    destroyAssistantTrigger() {},
    stopAssistantCapture() {},
    stopAssistantAudio() {},
    discardAssistantDraft() {},
    applyAssistantScope(value) {
      state.assistantScope = value;
    },
    resetAssistant() {
      state.assistantGeneration++;
    },
    toast() {},
    assistantDraftText: () => '',
    assistantActionCaption: () => '',
    runAssistantAction: async (action) => opened.push(action),
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
      if (route.endsWith('/scope')) return scope;
      sent.push(JSON.parse(options.body));
      return { text: 'Синтетический вопрос', policyVersion: 1, dialogue: dialogue(), action: null };
    },
  };
  f.w.eval(source('assistant-presentation'));
  Object.assign(actions, f.w.eval('createAssistantPresentation')());
  f.w.eval(source('assistant-idle'));
  Object.assign(actions, f.w.eval('createAssistantIdle')());
  f.w.eval(source('voice-assistant'));
  const controller = f.w.eval('createVoiceAssistant')(state, actions);
  f.cleanup.push(() => controller.destroyVoiceAssistant());
  controller.mountVoiceAssistant();
  trigger({ voice: false });
  await flush();
  const panel = f.w.document.querySelector('dialog');
  const get = (name) => panel.querySelector('[data-assistant-' + name + ']');
  const submit = () =>
    panel
      .querySelector('form')
      .dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  get('text').value = 'Подготовь запись';
  submit();
  await flush();
  assert.equal(speechUI.input(), get('input'), 'Controller targets the fallback field');
  get('input').value = 'на полчаса позже';
  submit();
  await flush();
  assert.deepEqual(sent[1], {
    dialogueId: 'synthetic-dialogue',
    dialogueVersion: 3,
    text: 'на полчаса позже',
    policyVersion: 1,
  });
  await speechUI.sendText('второй вариант');
  assert.equal(sent[2].text, 'второй вариант');
  assert.equal(sent[2].dialogueId, 'synthetic-dialogue');
  assert.deepEqual(opened, []);
});
