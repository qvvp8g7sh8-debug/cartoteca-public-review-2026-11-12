const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'src/client/modules', file + '.js'), 'utf8');
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
function fixture(t, turn = null, extraActions = {}) {
  const w = new JSDOM(
    '<main><div class="calendar-booking-tools"><button id="calendar-new" type="button">Добавить запись</button></div></main>',
    {
      url: 'https://synthetic.invalid',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  ).window;
  let now = 0,
    timerId = 0,
    additions = 0;
  const timers = new Map();
  w.setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.document.addEventListener('click', (event) => {
    if (event.target.closest('#calendar-new') && !event.defaultPrevented) additions++;
  });
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
    demo: true,
    limits: { maxTextChars: 2000 },
  };
  let returnedScope = scope;
  const state = {
    account: { id: 'staff', organizationId: 'org' },
    currentView: 'calendar',
    assistantScope: scope,
    assistantReady: true,
    assistantGeneration: 0,
    editorMode: null,
  };
  const requests = [],
    commands = [],
    stopped = [];
  const actions = {
    toast() {},
    stopAssistantCapture() {
      stopped.push(true);
    },
    stopAssistantAudio() {},
    discardAssistantDraft() {},
    applyAssistantScope(value) {
      state.assistantScope = value;
    },
    resetAssistant() {
      state.assistantGeneration++;
      api.destroyVoiceAssistant();
    },
    assistantDraftText: (action) =>
      action?.type === 'prepareAppointment' ? 'Draft requires Save' : '',
    assistantActionCaption: (action) =>
      action?.type === 'prepareAppointment' ? 'Проверить запись в форме' : '',
    runAssistantAction: async (action) => commands.push(action),
    async request(route, options) {
      requests.push({ route, options });
      if (route.endsWith('/scope')) return returnedScope;
      return turn
        ? turn(route, options)
        : {
            text: '<img src=x onerror=alert(1)>',
            policyVersion: 1,
            action: { type: 'prepareAppointment', date: '2030-01-02' },
            demo: true,
          };
    },
  };
  Object.assign(actions, extraActions);
  w.eval(read('assistant-trigger'));
  Object.assign(actions, w.eval('createAssistantTrigger')(state));
  w.eval(read('assistant-conversation'));
  Object.assign(actions, w.eval('createAssistantConversation')());
  w.eval(read('assistant-presentation'));
  Object.assign(actions, w.eval('createAssistantPresentation')());
  w.eval(read('assistant-speech-text'));
  Object.assign(actions, w.eval('createAssistantSpeechText')());
  w.eval(read('assistant-speech'));
  Object.assign(actions, w.eval('createAssistantSpeech')(state, actions));
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
    actions,
    requests,
    commands,
    stopped,
    scope(value) {
      returnedScope = value;
    },
    $: (selector) => w.document.querySelector(selector),
    additions: () => additions,
    open() {
      return w.document.querySelector('#calendar-new').dispatchEvent(
        new w.KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    pointer(type, values = {}, element = w.document.querySelector('#calendar-new')) {
      const event = new w.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: 10,
        clientY: 10,
        ...values,
      });
      for (const [name, value] of Object.entries({
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
      }))
        Object.defineProperty(event, name, { value: values[name] ?? value });
      element.dispatchEvent(event);
      return event;
    },
    click() {
      return w.document.querySelector('#calendar-new').dispatchEvent(
        new w.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          detail: 1,
          button: 0,
        }),
      );
    },
    advance(ms) {
      const end = now + ms;
      for (let count = 0; count < 100; count++) {
        const entry = [...timers]
          .filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) {
          now = end;
          return;
        }
        const [id, timer] = entry;
        now = timer.due;
        timers.delete(id);
        timer.callback();
      }
      throw Error('Synthetic timer loop did not settle');
    },
  };
}
test('panel opens only from calendar; generated answers are text and draft never saves automatically', async (t) => {
  const f = fixture(t);
  assert.equal(f.requests.length, 0);
  f.open();
  await flush();
  assert.equal(f.requests[0].route, '/api/assistant/scope');
  assert.equal(
    f.$('[data-assistant-mic]').hidden,
    true,
    'No paid microphone in explicit demo mode',
  );
  f.$('[data-assistant-text]').value = 'Synthetic command';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.$('.voice-assistant-answer img'), null);
  assert.match(f.$('[data-assistant-answer]').textContent, /<img/);
  const body = JSON.parse(f.requests[1].options.body);
  assert.equal(body.policyVersion, 1);
  f.$('[data-assistant-action]').click();
  await flush();
  assert.equal(f.commands.length, 1);
});
test('closing or destroying the panel aborts late answers, cleans drafts and microphone', async (t) => {
  let resolve;
  const delayed = new Promise((yes) => {
    resolve = yes;
  });
  const f = fixture(t, () => delayed);
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Synthetic command';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.api.destroyVoiceAssistant();
  resolve({ text: 'late answer', policyVersion: 1 });
  await flush();
  assert.equal(f.$('.voice-assistant-dialog'), null);
  assert.ok(f.$('#calendar-new'), 'Ordinary add button remains after assistant cleanup');
  assert.equal(f.$('#calendar-new').classList.contains('assistant-trigger'), false);
  assert.equal(f.$('#calendar-new').getAttribute('title'), null);
  f.open();
  await flush();
  assert.equal(f.$('.voice-assistant-dialog'), null, 'Keyboard binding is removed');
  assert.ok(f.stopped.length > 0);
  assert.equal(f.commands.length, 0);
});
test('appointment action opens ordinary unsaved form with whitelisted fields and no invented date/time', async (t) => {
  const w = new JSDOM(
    '<div id="form-content"><input name="date"><select name="time"><option>10:00</option></select></div>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(read('assistant-commands'));
  let opened;
  const state = { account: { id: 'staff' }, assistantGeneration: 0, editorMode: null };
  const api = w.eval('createAssistantCommands')(state, {
    $: (selector) => w.document.querySelector(selector),
    accountId: () => 'staff',
    servicesForStaff: () => [],
    mountAppointmentTimePicker() {},
    async openAppointmentForm(draft, source) {
      opened = { draft, source };
      state.editorMode = { kind: 'appointment', source };
    },
  });
  await api.runAssistantAction({
    type: 'prepareAppointment',
    id: 'do-not-edit',
    notes: 'do-not-save-model-text',
    patientId: 'synthetic',
  });
  assert.equal(opened.source, 'assistant');
  assert.equal(opened.draft.id, undefined);
  assert.equal(opened.draft.notes, undefined);
  assert.equal(w.document.querySelector('[name="date"]').value, '');
  assert.equal(w.document.querySelector('[name="time"]').value, '');
  assert.equal(state.assistantEditor, state.editorMode);
});

test('fresh capability recheck blocks an old draft after policy change', async (t) => {
  const f = fixture(t);
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Synthetic command';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.scope({ ...f.state.assistantScope, policyVersion: 2 });
  f.$('[data-assistant-action]').click();
  await flush();
  assert.equal(f.requests.at(-1).route, '/api/assistant/scope');
  assert.equal(f.commands.length, 0);
});

test('mixed provider mode keeps microphone hidden when only STT is demonstration', async (t) => {
  const f = fixture(t);
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    capabilities: { stt: { demo: true, ready: true }, llm: { demo: false, ready: true } },
  });
  f.open();
  await flush();
  assert.equal(f.$('[data-assistant-mic]').hidden, true);
  assert.equal(f.requests.length, 1);
});

test('scope cleanup leaves a separately opened unrelated editor intact', (t) => {
  const w = new JSDOM('', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  w.eval(fs.readFileSync(path.join(root, 'src/client/core/editor.js'), 'utf8'));
  const draft = { kind: 'appointment' },
    unrelated = { kind: 'patient' };
  const state = { assistantEditor: draft, editorMode: unrelated };
  w.eval('createEditor')(state, {}).discardAssistantDraft();
  assert.equal(state.editorMode, unrelated);
  assert.equal(state.assistantEditor, null);
});

test('holding add opens the assistant once and suppresses only the trailing add click', async (t) => {
  const f = fixture(t);
  f.pointer('pointerdown');
  f.advance(599);
  await flush();
  assert.equal(f.requests.length, 0, 'a short gesture must remain cold');
  assert.equal(f.$('.voice-assistant-dialog'), null);
  f.advance(1);
  await flush();
  assert.equal(f.requests.filter((request) => request.route.endsWith('/scope')).length, 1);
  assert.equal(f.$('.voice-assistant-session').hidden, false, 'start while the pointer is down');
  f.advance(5000);
  f.pointer('pointerup');
  f.click();
  await flush();
  assert.equal(f.requests.filter((request) => request.route.endsWith('/scope')).length, 1);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.equal(f.additions(), 0);
  f.$('[data-assistant-session-stop]').click();
  f.pointer('pointerdown');
  f.advance(100);
  f.pointer('pointerup');
  f.click();
  assert.equal(f.additions(), 1, 'A fresh short gesture still opens the ordinary form');
});

test('short pointer click and ordinary keyboard activation preserve adding an appointment', async (t) => {
  const f = fixture(t);
  f.pointer('pointerdown');
  f.advance(599);
  f.pointer('pointerup');
  f.click();
  f.advance(1);
  await flush();
  assert.equal(f.additions(), 1);
  assert.equal(f.requests.length, 0);
  const enter = new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  f.$('#calendar-new').dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, false);
  f.$('#calendar-new').click();
  assert.equal(f.additions(), 2);
  assert.equal(f.requests.length, 0);
});

test('pointer cancellation, movement and calendar redraw cancel a pending hold', async (t) => {
  for (const reason of ['cancel', 'move', 'redraw', 'generation']) {
    const f = fixture(t);
    f.pointer('pointerdown');
    f.advance(300);
    if (reason === 'cancel') f.pointer('pointercancel');
    if (reason === 'move') f.pointer('pointermove', { clientX: 21 });
    if (reason === 'redraw') {
      const next = f.w.document.createElement('button');
      next.id = 'calendar-new';
      next.type = 'button';
      next.textContent = 'Добавить запись';
      f.$('#calendar-new').replaceWith(next);
      f.api.mountVoiceAssistant();
    }
    if (reason === 'generation') f.state.assistantGeneration++;
    f.advance(600);
    await flush();
    assert.equal(f.requests.length, 0, reason);
    assert.equal(f.$('.voice-assistant-dialog'), null, reason);
    if (reason === 'cancel' || reason === 'move') {
      f.pointer('pointerup');
      f.click();
      assert.equal(
        f.additions(),
        0,
        'Cancelled pointer gesture must not add an appointment: ' + reason,
      );
    }
  }
});

test('disabled assistant does not intercept the ordinary add button', async (t) => {
  const f = fixture(t);
  f.api.destroyVoiceAssistant();
  f.state.assistantScope = { ...f.state.assistantScope, enabled: false };
  f.api.mountVoiceAssistant();
  f.pointer('pointerdown');
  f.advance(900);
  f.pointer('pointerup');
  f.click();
  await flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.additions(), 1);
  assert.equal(f.$('#calendar-new').classList.contains('assistant-trigger'), false);
  const shifted = new f.w.KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  f.$('#calendar-new').dispatchEvent(shifted);
  assert.equal(shifted.defaultPrevented, false);
});

test('dialogue choices and corrections are explicit, accept natural text and escape server text', async (t) => {
  const replies = [
    {
      text: 'Уточните клиента',
      policyVersion: 1,
      action: null,
      dialogue: {
        id: 'dialogue',
        version: 1,
        step: 'client',
        prompt: 'Кого записать?',
        options: [{ id: 'opaque-one', label: '<img src=x> Тестовый клиент' }],
        fields: [{ key: 'date', label: 'Дата', value: '2030-01-02' }],
        canEdit: ['date'],
        input: { type: 'text', field: 'client' },
      },
    },
    {
      text: 'Уточните дату',
      policyVersion: 1,
      action: null,
      dialogue: {
        id: 'dialogue',
        version: 2,
        step: 'date',
        prompt: 'Дата записи',
        options: [],
        fields: [{ key: 'client', label: 'Клиент', value: 'Тестовый клиент' }],
        canEdit: ['client'],
        input: { type: 'date', field: 'date' },
      },
    },
    { text: 'Подготовка отменена', policyVersion: 1, action: null, dialogue: null },
  ];
  const f = fixture(t, () => replies.shift());
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Запиши клиента';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.$('[data-assistant-conversation] img'), null);
  assert.match(f.$('[data-assistant-choice]').textContent, /<img/);
  f.$('[data-assistant-choice]').click();
  await flush();
  assert.deepEqual(JSON.parse(f.requests[2].options.body), {
    dialogueId: 'dialogue',
    dialogueVersion: 1,
    choice: 'opaque-one',
    policyVersion: 1,
  });
  assert.equal(f.$('[data-assistant-input]').type, 'text');
  f.$('[data-assistant-new]').click();
  await flush();
  assert.equal(JSON.parse(f.requests[3].options.body).cancel, true);
  assert.equal(f.$('[data-assistant-conversation]').hidden, true);
  assert.equal(f.$('[data-assistant-text]').value, '');
  assert.equal(f.commands.length, 0);
});

test('unknown continuation retries the exact frozen body and does not advance locally', async (t) => {
  let turns = 0;
  const f = fixture(t, () => {
    turns++;
    if (turns === 2) throw Object.assign(Error('Unknown outcome'), { outcomeUnknown: true });
    return {
      text: 'Выберите',
      policyVersion: 1,
      action: null,
      dialogue: {
        id: 'dialogue',
        version: turns === 1 ? 1 : 2,
        step: 'client',
        prompt: 'Клиент',
        options: [{ id: 'opaque-client', label: 'Тестовый клиент' }],
        fields: [],
        canEdit: [],
        input: null,
      },
    };
  });
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Запиши';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-choice]').click();
  await flush();
  const frozen = f.requests[2].options.body;
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  assert.equal(f.$('[data-assistant-choice]').disabled, true);
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.equal(f.requests[3].options.body, frozen);
  assert.equal(f.$('[data-assistant-retry]').hidden, true);
  assert.equal(f.commands.length, 0);
});

test('stale dialogue retains its fields and closing prevents their reuse', async (t) => {
  let turns = 0;
  const f = fixture(t, () => {
    if (++turns > 1) throw Object.assign(Error('Stale dialogue'), { status: 409 });
    return {
      text: 'Уточните',
      policyVersion: 1,
      action: null,
      dialogue: {
        id: 'old-dialogue',
        version: 3,
        step: 'time',
        prompt: 'Время',
        options: [],
        fields: [{ key: 'client', label: 'Клиент', value: 'Вымышленный клиент' }],
        canEdit: ['client'],
        input: { type: 'time', field: 'time' },
      },
    };
  });
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Запиши';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-input]').value = '10:00';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.match(f.$('[data-assistant-conversation]').textContent, /Вымышленный клиент/);
  assert.match(f.$('[data-assistant-status]').textContent, /Диалог изменился/);
  assert.equal(f.state.assistantGeneration, 0);
  f.$('[data-assistant-close]').click();
  f.open();
  await flush();
  assert.equal(f.$('[data-assistant-conversation]').hidden, true);
  assert.equal(f.$('[data-assistant-input]').value, '');
});

test('calendar-only permission displays non-clickable free windows without a booking dialogue', async (t) => {
  const f = fixture(t, () => ({
    text: 'Свободное время',
    policyVersion: 1,
    action: null,
    dialogue: null,
    readOnlySlots: [
      {
        date: '2030-01-02',
        time: '10:00',
        endTime: '11:00',
        duration: 60,
        staffName: '<img> Специалист',
      },
    ],
  }));
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Найди свободное окно';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.match(f.$('[data-assistant-read-only-slots]').textContent, /10:00–11:00/);
  assert.equal(f.$('[data-assistant-conversation] img'), null);
  assert.equal(f.$('[data-assistant-conversation] button'), null);
  assert.equal(f.$('[data-assistant-conversation]').hidden, false);
  assert.equal(f.$('[data-assistant-command-label]').hidden, false);
  assert.equal(f.$('[data-assistant-action]').hidden, true);
  assert.equal(f.commands.length, 0);
});

test('date and duration steps retain editable natural speech until explicit submission', async (t) => {
  for (const [type, transcript] of [
    ['date', 'завтра'],
    ['number', 'полчаса'],
  ]) {
    await t.test(type, async (t) => {
      let captured;
      const f = fixture(
        t,
        (route) =>
          route.endsWith('/transcribe')
            ? { text: transcript, policyVersion: 1 }
            : {
                text: 'Уточните поле',
                policyVersion: 1,
                action: null,
                dialogue: {
                  id: 'spoken-dialogue',
                  version: 1,
                  step: type === 'date' ? 'date' : 'duration',
                  prompt: 'Введите значение',
                  options: [],
                  fields: [],
                  canEdit: [],
                  input: { type, field: type === 'date' ? 'date' : 'duration' },
                },
              },
        {
          async startAssistantCapture(deliver) {
            captured = deliver;
            return true;
          },
        },
      );
      f.scope({
        ...f.state.assistantScope,
        demo: false,
        capabilities: { stt: { ready: true, demo: false } },
      });
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Запиши клиента';
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
      assert.equal(f.$('[data-assistant-input]').type, 'text');
      f.$('[data-assistant-mic]').click();
      await flush();
      await captured('synthetic-audio', {});
      await flush();
      assert.equal(f.$('[data-assistant-input]').type, 'text');
      assert.equal(f.$('[data-assistant-input]').value, transcript);
      assert.equal(
        f.requests.filter((item) => item.route.endsWith('/turn')).length,
        1,
        'Transcription never sends the answer automatically',
      );
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
      const turns = f.requests.filter((item) => item.route.endsWith('/turn'));
      assert.equal(JSON.parse(turns[1].options.body).text, transcript);
      assert.equal(
        f.$('[data-assistant-input]').type,
        'text',
        'Next server step keeps natural corrections available',
      );
    });
  }
});

test('new command refreshes scope and exits a stale dialogue after a policy-version conflict', async (t) => {
  let turns = 0;
  const f = fixture(t, () => {
    turns++;
    if (turns === 2 || turns === 3) throw Object.assign(Error('Policy changed'), { status: 409 });
    return turns === 1
      ? {
          text: 'Уточните клиента',
          policyVersion: 1,
          action: null,
          dialogue: {
            id: 'stale-policy-dialogue',
            version: 1,
            step: 'client',
            prompt: 'Клиент',
            options: [],
            fields: [{ key: 'date', label: 'Дата', value: '2030-01-02' }],
            canEdit: ['date'],
            input: { type: 'text', field: 'client' },
          },
        }
      : { text: 'Новая команда принята', policyVersion: 2, action: null, dialogue: null };
  });
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Запиши';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.scope({ ...f.state.assistantScope, policyVersion: 2 });
  f.$('[data-assistant-input]').value = 'Вымышленный клиент';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(
    f.$('[data-assistant-conversation]').hidden,
    false,
    'Ordinary stale step retains its fields',
  );
  f.$('[data-assistant-new]').click();
  await flush();
  assert.equal(f.requests.filter((item) => item.route.endsWith('/scope')).length, 2);
  assert.equal(f.state.assistantScope.policyVersion, 2);
  assert.equal(f.$('[data-assistant-conversation]').hidden, true);
  assert.equal(f.$('[data-assistant-command-label]').hidden, false);
  assert.equal(f.$('[data-assistant-new]').hidden, true);
  f.$('[data-assistant-text]').value = 'Покажи неделю';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  const body = JSON.parse(f.requests.at(-1).options.body);
  assert.equal(body.policyVersion, 2);
  assert.equal(body.text, 'Покажи неделю');
  assert.equal(body.dialogueId, undefined);
  assert.equal(body.cancel, undefined);
});

for (const [label, mutate] of [
  [
    'role',
    (state) => {
      state.account.role = 'cosmetologist';
    },
  ],
  [
    'account',
    (state) => {
      state.account.id = 'other-account';
    },
  ],
  [
    'organization',
    (state) => {
      state.account.organizationId = 'other-org';
    },
  ],
])
  test(
    'late assistant result after in-place ' +
      label +
      ' switch cannot populate the old panel or expose an action',
    async (t) => {
      let release;
      const f = fixture(
        t,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      f.state.account.role = 'owner';
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Синтетический запрос';
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
      mutate(f.state);
      release({
        text: 'Ответ прошлого контекста',
        policyVersion: 1,
        action: {
          type: 'prepareAppointment',
          patientId: 'old-patient',
          staffId: 'old-staff',
          date: '2030-01-02',
          time: '14:30',
          duration: 30,
        },
      });
      await flush();
      assert.equal(f.$('[data-assistant-answer]').textContent, '');
      assert.equal(f.$('[data-assistant-action]').hidden, true);
      assert.deepEqual(f.commands, []);
    },
  );

test('assistant input is locked while a request is pending and an unknown continuation retries the visible frozen answer', async (t) => {
  let count = 0,
    release;
  const dialogue = {
    id: 'synthetic-dialogue',
    version: 1,
    step: 'date',
    prompt: 'На какую дату?',
    input: { field: 'date', type: 'date' },
    options: [],
    fields: [],
    canEdit: [],
  };
  const f = fixture(t, async () => {
    count++;
    if (count === 1) return { text: 'На какую дату?', policyVersion: 1, dialogue, action: null };
    if (count === 2)
      return new Promise((resolve, reject) => {
        release = () =>
          reject(Object.assign(Error('Synthetic unknown response'), { outcomeUnknown: true }));
      });
    return {
      text: 'Уточните время',
      policyVersion: 1,
      dialogue: { ...dialogue, version: 2, step: 'time', input: { field: 'time', type: 'time' } },
      action: null,
    };
  });
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Синтетическая запись';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-input]').value = 'на завтра';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(
    f.$('[data-assistant-input]').disabled,
    true,
    'the answer cannot change while awaiting the server',
  );
  assert.equal(f.$('[data-assistant-text]').disabled, true);
  release();
  await flush();
  assert.equal(
    f.$('[data-assistant-input]').disabled,
    true,
    'unknown-result recovery keeps the frozen answer visible',
  );
  assert.equal(f.$('[data-assistant-input]').value, 'на завтра');
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  f.$('[data-assistant-retry]').click();
  await flush();
  const turns = f.requests.filter((item) => item.route.endsWith('/turn'));
  assert.equal(turns[1].options.body, turns[2].options.body);
  assert.equal(f.$('[data-assistant-input]').disabled, false);
  assert.equal(f.$('[data-assistant-input]').value, '');
  assert.equal(f.$('[data-assistant-retry]').hidden, true);
  assert.deepEqual(f.commands, []);
});

for (const code of [401, 403, 503])
  test(
    'late ' +
      code +
      ' error after a role switch cannot reset the new context or replace its status',
    async (t) => {
      let reject,
        resets = 0;
      const f = fixture(
        t,
        () =>
          new Promise((resolve, no) => {
            reject = no;
          }),
        {
          resetAssistant() {
            resets++;
          },
        },
      );
      f.state.account.role = 'owner';
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Запрос старой роли';
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
      f.state.account.role = 'cosmetologist';
      reject(Object.assign(Error('Ошибка старой роли'), { status: code }));
      await flush();
      assert.equal(resets, 0);
      assert.doesNotMatch(f.$('[data-assistant-status]').textContent, /Ошибка старой роли/);
      assert.deepEqual(f.commands, []);
    },
  );

for (const failure of ['throw', 'false'])
  test(
    'failed ' +
      failure +
      ' action handoff retains the reviewed result for an explicit opening retry without another turn or Save',
    async (t) => {
      let attempts = 0;
      const f = fixture(t, null, {
        async runAssistantAction() {
          if (++attempts === 1) {
            if (failure === 'false') return false;
            throw Error('Не удалось загрузить клиента');
          }
          return true;
        },
      });
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Синтетическая запись';
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
      f.$('[data-assistant-heard]').textContent = 'Вы сказали: «Синтетическая запись»';
      f.$('[data-assistant-heard]').hidden = false;
      f.$('[data-assistant-action]').click();
      await flush();
      assert.equal(f.$('.voice-assistant-dialog').open, true);
      assert.equal(f.$('[data-assistant-action]').hidden, false);
      assert.equal(f.$('[data-assistant-action]').disabled, false);
      assert.match(f.$('[data-assistant-status]').textContent, /не|Не/);
      assert.equal(f.$('[data-assistant-heard]').textContent, 'Вы сказали: «Синтетическая запись»');
      assert.match(f.$('[data-assistant-draft]').textContent, /Draft requires Save/);
      f.$('[data-assistant-action]').click();
      await flush();
      assert.equal(attempts, 2);
      assert.equal(f.requests.filter((item) => item.route.endsWith('/turn')).length, 1);
      assert.equal(f.requests.filter((item) => item.route.endsWith('/scope')).length, 3);
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.deepEqual(f.commands, []);
    },
  );

test('failed delayed handoff never resurrects an old result over a new dialog, editor or organization', async (t) => {
  for (const change of ['dialog', 'editor', 'organization', 'destroy', 'busy']) {
    let reject;
    const f = fixture(t, null, {
      runAssistantAction: () =>
        new Promise((resolve, no) => {
          reject = no;
        }),
    });
    f.open();
    await flush();
    f.$('[data-assistant-text]').value = 'Синтетическая запись';
    f.$('.voice-assistant-form').dispatchEvent(
      new f.w.Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    f.$('[data-assistant-action]').click();
    await flush();
    if (change === 'dialog') {
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Новый несохранённый запрос';
    }
    if (change === 'editor')
      f.state.editorMode = { kind: 'appointment', id: null, source: 'calendar' };
    if (change === 'organization') f.state.account.organizationId = 'other-org';
    if (change === 'destroy') f.api.destroyVoiceAssistant();
    if (change === 'busy') f.state.busy = true;
    reject(Error('Старое открытие не удалось'));
    await flush();
    const panel = f.$('.voice-assistant-dialog');
    if (change === 'dialog') {
      assert.equal(panel.open, true);
      assert.equal(f.$('[data-assistant-text]').value, 'Новый несохранённый запрос');
      assert.equal(f.$('[data-assistant-action]').hidden, true);
    } else assert.equal(panel?.open || false, false);
    if (change === 'editor') assert.equal(f.state.editorMode.source, 'calendar');
    assert.deepEqual(f.commands, []);
  }
});

for (const [label, change] of [
  [
    'role',
    (state) => {
      state.account.role = 'cosmetologist';
    },
  ],
  [
    'account',
    (state) => {
      state.account.id = 'other-account';
    },
  ],
])
  test(
    'a pending hold is cancelled when the ' +
      label +
      ' changes in place and does not start a scope request',
    async (t) => {
      const f = fixture(t);
      f.state.account.role = 'owner';
      f.pointer('pointerdown');
      f.advance(300);
      change(f.state);
      f.advance(300);
      await flush();
      assert.equal(f.requests.length, 0);
      assert.equal(f.$('.voice-assistant-dialog'), null);
      f.pointer('pointerup');
      f.$('#calendar-new').dispatchEvent(
        new f.w.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
      assert.equal(
        f.additions(),
        0,
        'cancelled hold must not fall through to an ordinary appointment',
      );
      assert.deepEqual(f.commands, []);
    },
  );

test('read-only free windows stay non-selectable at the twelve-row display limit even when DTOs contain unrelated metadata', async (t) => {
  const f = fixture(t, () => ({
    text: 'Только просмотр свободного времени.',
    policyVersion: 1,
    action: null,
    readOnlySlots: Array.from({ length: 13 }, (_, index) => ({
      date: '2030-01-02',
      time: '09:00',
      endTime: '09:30',
      duration: 30,
      staffName: index === 12 ? 'OVERFLOW-NAME' : 'Специалист ' + (index + 1),
      id: 'PRIVATE_ID_' + index,
      notes: 'PRIVATE_NOTES',
      patientName: 'PRIVATE_PATIENT',
    })),
  }));
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Покажи окна';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  const list = f.$('[data-assistant-read-only-slots]');
  assert.equal(list.children.length, 12);
  assert.doesNotMatch(list.textContent, /OVERFLOW-NAME|PRIVATE_/);
  assert.equal(f.$('[data-assistant-choice]'), null);
  assert.equal(f.$('[data-assistant-action]').hidden, true);
  assert.deepEqual(f.commands, []);
});

test('automatic synthetic voice narrates calendar-only windows then stops without opening or saving an appointment', async (t) => {
  let complete;
  const spoken = [];
  const f = fixture(
    t,
    (route, options) => {
      if (route.endsWith('/transcribe'))
        return { text: 'Покажи свободное время', policyVersion: 1 };
      if (route.endsWith('/speak')) {
        spoken.push(JSON.parse(options.body).text);
        return { audioBase64: 'synthetic', policyVersion: 1 };
      }
      return {
        text: 'Только просмотр.',
        policyVersion: 1,
        action: null,
        dialogue: null,
        readOnlySlots: [
          {
            date: '2030-01-02',
            time: '09:00',
            endTime: '09:30',
            duration: 30,
            staffName: 'Вера Синтетическая',
          },
        ],
      };
    },
    {
      startAssistantCapture: async (onComplete) => {
        assert.equal(complete, undefined, 'No second microphone after a read-only result');
        complete = onComplete;
        return true;
      },
      playAssistantAudio: async () => true,
    },
  );
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false } },
  });
  f.open();
  await flush();
  f.$('[data-assistant-voice]').click();
  await flush();
  assert.equal(typeof complete, 'function');
  await complete('synthetic-wav', { autoStopped: true });
  await flush();
  assert.ok(
    spoken
      .join(' ')
      .includes(
        'Свободно: 2 января 2030 года, с 9 часов до 9 часов 30 минут, специалист Вера Синтетическая',
      ),
  );
  assert.doesNotMatch(spoken.join(' '), /Вариант|номер|открой форму/u);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
  assert.equal(f.$('[data-assistant-action]').hidden, true);
  assert.equal(f.$('[data-assistant-choice]'), null);
  assert.deepEqual(f.commands, []);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 1);
  assert.ok(f.requests.every((row) => row.route.startsWith('/api/assistant/')));
});

for (const role of ['owner', 'salon_admin'])
  test(
    role + ' duplicate initial submit cannot abort or discard the first accepted response',
    async (t) => {
      let release;
      const f = fixture(
        t,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      f.state.account.role = role;
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Синтетический первоначальный запрос';
      const submit = () =>
        f
          .$('.voice-assistant-form')
          .dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
      submit();
      submit();
      await flush();
      const turns = f.requests.filter((row) => row.route.endsWith('/turn'));
      assert.equal(turns.length, 1);
      assert.equal(turns[0].options.signal.aborted, false);
      release({ text: 'Первый ответ принят', policyVersion: 1, action: null });
      await flush();
      assert.equal(f.$('[data-assistant-answer]').textContent, 'Первый ответ принят');
      assert.equal(f.$('[data-assistant-text]').disabled, false);
      assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 1);
      assert.deepEqual(f.commands, []);
    },
  );

test('owner client-card handoff uses the actual fresh-load action and never opens a denied patient or a fallback current card', async (t) => {
  const f = fixture(t, () => ({
    text: 'Найдена карточка',
    policyVersion: 1,
    action: { type: 'clientCard', patientId: 'denied-patient' },
  }));
  f.state.account.role = 'owner';
  f.state.selectedId = 'already-selected';
  const loads = [],
    views = [];
  Object.assign(f.actions, {
    $: f.$,
    ensurePatient: async (id, options) => {
      loads.push({ id, options });
      throw Object.assign(Error('Доступ к карточке закрыт'), { status: 403 });
    },
    setView: async (view) => views.push(view),
  });
  f.w.eval(read('assistant-commands'));
  Object.assign(f.actions, f.w.eval('createAssistantCommands')(f.state, f.actions));
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Открой карточку';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-action]').click();
  await flush();
  assert.equal(loads.length, 1);
  assert.equal(loads[0].id, 'denied-patient');
  assert.equal(loads[0].options.force, true);
  assert.equal(f.state.selectedId, 'already-selected');
  assert.deepEqual(views, []);
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.match(f.$('[data-assistant-status]').textContent, /Доступ к карточке закрыт/);
  assert.deepEqual(f.commands, []);
});

test('administrator delayed actual client-card load cannot replace a newer selected patient or reopen the old assistant result', async (t) => {
  let release;
  const f = fixture(t, () => ({
    text: 'Найдена карточка',
    policyVersion: 1,
    action: { type: 'clientCard', patientId: 'old-patient' },
  }));
  f.state.account.role = 'salon_admin';
  f.state.selectedId = 'initial-patient';
  const views = [];
  Object.assign(f.actions, {
    $: f.$,
    ensurePatient: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    setView: async (view) => views.push(view),
  });
  f.w.eval(read('assistant-commands'));
  Object.assign(f.actions, f.w.eval('createAssistantCommands')(f.state, f.actions));
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Открой карточку';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-action]').click();
  await flush();
  f.state.selectedId = 'newer-selected-patient';
  release({ id: 'old-patient' });
  await flush();
  assert.equal(f.state.selectedId, 'newer-selected-patient');
  assert.deepEqual(views, []);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.deepEqual(f.commands, []);
});

function availabilityDialogue(version, slot) {
  return {
    id: 'synthetic-availability',
    version,
    step: 'availability',
    prompt: 'Выберите свободное время',
    input: null,
    fields: [],
    canEdit: [],
    options: [{ id: slot, label: '2030-01-02 · 09:00–09:30 · Синтетический специалист' }],
  };
}

test('availability replacement uses the new opaque choice and version and a detached stale button cannot prepare a booking', async (t) => {
  const replies = [
    {
      text: 'Выберите время',
      policyVersion: 1,
      action: null,
      dialogue: availabilityDialogue(1, 'old-opaque-slot'),
    },
    {
      text: 'Это окно уже занято. Выберите другое.',
      policyVersion: 1,
      action: null,
      dialogue: availabilityDialogue(2, 'new-opaque-slot'),
    },
    {
      text: 'Кого записать?',
      policyVersion: 1,
      action: null,
      dialogue: { ...availabilityDialogue(3, 'opaque-client'), step: 'client', prompt: 'Клиент' },
    },
  ];
  const f = fixture(t, () => replies.shift());
  f.state.account.role = 'salon_admin';
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Найди свободное время';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  const old = f.$('[data-assistant-choice]');
  old.click();
  await flush();
  assert.match(f.$('[data-assistant-answer]').textContent, /уже занято/);
  assert.equal(f.$('[data-assistant-action]').hidden, true);
  old.click();
  await flush();
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
  f.$('[data-assistant-choice]').click();
  await flush();
  const body = JSON.parse(
    f.requests.filter((row) => row.route.endsWith('/turn')).at(-1).options.body,
  );
  assert.equal(body.choice, 'new-opaque-slot');
  assert.equal(body.dialogueVersion, 2);
  assert.equal(body.patientId, undefined);
  assert.equal(body.time, undefined);
  assert.deepEqual(f.commands, []);
});

test('unknown availability choice can exit through stale cancellation and start a clean command without reusing its old slot', async (t) => {
  let turn = 0;
  const f = fixture(t, () => {
    if (++turn === 1)
      return {
        text: 'Выберите время',
        policyVersion: 1,
        action: null,
        dialogue: availabilityDialogue(1, 'opaque-slot'),
      };
    if (turn === 2) throw Object.assign(Error('Unknown slot outcome'), { outcomeUnknown: true });
    if (turn === 3) throw Object.assign(Error('Stale cancellation'), { status: 409 });
    return { text: 'Новая команда принята', policyVersion: 1, action: null };
  });
  f.state.account.role = 'owner';
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Найди время';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-choice]').click();
  await flush();
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  f.$('[data-assistant-new]').click();
  await flush();
  assert.equal(f.$('[data-assistant-conversation]').hidden, true);
  assert.equal(f.$('[data-assistant-retry]').hidden, true);
  assert.equal(f.$('[data-assistant-text]').disabled, false);
  f.$('[data-assistant-text]').value = 'Покажи завтра';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  const bodies = f.requests
    .filter((row) => row.route.endsWith('/turn'))
    .map((row) => JSON.parse(row.options.body));
  assert.equal(bodies[2].cancel, true);
  assert.equal(bodies[3].text, 'Покажи завтра');
  for (const key of ['choice', 'cancel', 'dialogueId', 'dialogueVersion'])
    assert.equal(bodies[3][key], undefined);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/scope')).length, 2);
  assert.deepEqual(f.commands, []);
});

for (const [kind, reply, expected] of [
  [
    'readonly',
    {
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
      ],
    },
    'Свободно: 2 января 2030 года, с 9 часов до 9 часов 30 минут',
  ],
  [
    'review',
    {
      text: 'Проверьте данные.',
      action: null,
      dialogue: {
        id: 'opaque-review',
        version: 2,
        step: 'review',
        prompt: 'Проверьте данные.',
        input: null,
        fields: [
          { key: 'date', label: 'Дата', value: '2030-01-02' },
          { key: 'time', label: 'Время', value: '14:30' },
        ],
        canEdit: ['date', 'time'],
        options: [{ id: 'opaque-ready', label: 'Подготовить форму записи' }],
      },
    },
    'Дата: 2 января 2030 года',
  ],
  [
    'plain',
    { text: 'Это обычный ответ. Записи не изменялись.', action: null },
    'Это обычный ответ. Записи не изменялись.',
  ],
])
  test(
    'manual Озвучить reads the ' +
      kind +
      ' visible result without starting a microphone, opening a form or submitting another turn',
    async (t) => {
      const spoken = [];
      const f = fixture(
        t,
        (route, options) => {
          if (route.endsWith('/speak')) {
            spoken.push(JSON.parse(options.body).text);
            return { audioBase64: 'synthetic', policyVersion: 1 };
          }
          return { ...reply, policyVersion: 1 };
        },
        {
          startAssistantCapture: async () => {
            throw Error('Manual speech must not use microphone');
          },
          playAssistantAudio: async () => true,
        },
      );
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Синтетический запрос';
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
      assert.equal(f.$('[data-assistant-speak]').hidden, false);
      f.$('[data-assistant-speak]').click();
      await flush();
      assert.ok(spoken.join(' ').includes(expected));
      assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
      assert.equal(f.$('.voice-assistant-dialog').open, true);
      assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 1);
      assert.equal(
        f.requests.some((row) => row.route.endsWith('/transcribe')),
        false,
      );
      assert.deepEqual(f.commands, []);
    },
  );

function pendingAppointmentHandoffFixture(t, { reviewFirst = false } = {}) {
  const loads = [];
  let turns = 0;
  const f = fixture(t, () => {
    turns++;
    if (reviewFirst && turns === 1) return bookingReviewReply();
    return {
      text: 'Готовы данные ' + turns,
      policyVersion: 1,
      action: {
        type: 'prepareAppointment',
        patientId: 'synthetic-patient-' + turns,
        staffId: 'synthetic-staff',
        date: '2030-01-02',
        time: '14:30',
        duration: 30,
      },
    };
  });
  f.state.account.role = 'owner';
  Object.assign(f.state, {
    data: [],
    lazyReads: true,
    workspace: {},
    SERVICE_CATEGORIES: [],
    uploadItems: [],
  });
  f.w.document.body.insertAdjacentHTML(
    'beforeend',
    '<dialog id="editor"><h2 id="dialog-title"></h2><section id="form-content"></section><p id="form-error"></p><button id="save-editor">Сохранить</button></dialog>',
  );
  Object.assign(f.actions, {
    $: f.$,
    accountId: () => f.state.account.id,
    servicesForStaff: () => [],
    isClosedAppointment: () => false,
    ensurePatient: (id) =>
      new Promise((resolve) =>
        loads.push({
          id,
          resolve: () =>
            resolve({ id, name: 'Синтетический клиент', appointments: [], visits: [] }),
        }),
      ),
    clientRecords: () => [],
    appointmentPatientPickerHtml: (patient) =>
      '<select id="appointment-patient"><option value="' +
      patient.id +
      '">Клиент</option></select>',
    patientFieldsHtml: () => '',
    staffField: (id) =>
      '<label><select name="staffId"><option value="' +
      id +
      '">Специалист</option></select></label>',
    serviceDuration: () => 30,
    formatDate: (value) => value,
    isoDate: () => '2030-01-02',
    esc: (value) => String(value),
    timeLabel: (minute) =>
      String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'),
    formatMinutes: (value) => value + ' мин',
    appointmentRoomField: () => '',
    mountAppointmentProcedures() {},
    openDialog() {
      f.$('#editor').open = true;
    },
    refreshAppointmentSchedule: async () => {},
    mountAppointmentPatientPicker() {},
    refreshAppointmentRooms: async () => {},
    mountAppointmentTimePicker() {},
    cancelPhotoProcessing() {},
    photosPending: () => false,
    confirmAction: async () => true,
  });
  f.w.eval(read('appointments'));
  Object.assign(f.actions, f.w.eval('createAppointments')(f.state, f.actions));
  f.w.eval(read('assistant-commands'));
  Object.assign(f.actions, f.w.eval('createAssistantCommands')(f.state, f.actions));
  f.w.eval(fs.readFileSync(path.join(root, 'src/client/core/editor.js'), 'utf8'));
  const editor = f.w.eval('createEditor')(f.state, f.actions);
  Object.assign(f.actions, { discardAssistantDraft: editor.discardAssistantDraft });
  return {
    ...f,
    loads,
    editor,
    async ready() {
      f.open();
      await flush();
      f.$('[data-assistant-text]').value = 'Подготовь синтетическую запись';
      f.$('.voice-assistant-form').dispatchEvent(
        new f.w.Event('submit', { bubbles: true, cancelable: true }),
      );
      await flush();
    },
    async handoff() {
      await this.ready();
      f.$('[data-assistant-action]').click();
      await flush();
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(f.$('#editor').open, false);
      return loads.at(-1);
    },
  };
}

test('delayed actual appointment handoff cannot open an old draft over a newly opened assistant command', async (t) => {
  const f = pendingAppointmentHandoffFixture(t);
  const load = await f.handoff();
  await f.ready();
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-answer]').textContent, 'Готовы данные 2');
  load.resolve();
  await flush();
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.w.document.querySelectorAll('dialog[open]').length, 1);
  assert.equal(f.$('[data-assistant-action]').hidden, false);
  assert.deepEqual(f.commands, []);
});

test('destroying the assistant cancels a pending actual form handoff without opening another form', async (t) => {
  const f = pendingAppointmentHandoffFixture(t);
  const load = await f.handoff();
  f.api.destroyVoiceAssistant();
  load.resolve();
  await flush();
  assert.equal(f.$('.voice-assistant-dialog'), null);
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.deepEqual(f.commands, []);
});

test('an old handoff finally cannot clear a newer handoff cancellation fence', async (t) => {
  const f = pendingAppointmentHandoffFixture(t);
  const first = await f.handoff();
  const second = await f.handoff();
  first.resolve();
  await flush();
  f.open();
  await flush();
  second.resolve();
  await flush();
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.w.document.querySelectorAll('dialog[open]').length, 1);
  assert.deepEqual(f.commands, []);
});

test('the own delayed handoff opens once, keeps manual Save, and ordinary Cancel returns to a clean assistant', async (t) => {
  const f = pendingAppointmentHandoffFixture(t);
  const generation = f.state.assistantGeneration;
  const load = await f.handoff();
  f.$('[data-assistant-action]').click();
  load.resolve();
  await flush();
  assert.equal(f.state.assistantGeneration, generation);
  assert.equal(f.loads.length, 1);
  assert.equal(f.$('#editor').open, true);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.w.document.querySelectorAll('dialog[open]').length, 1);
  assert.equal(f.state.editorMode.kind, 'appointment');
  assert.equal(f.state.editorMode.id, null);
  assert.equal(f.state.assistantEditor, f.state.editorMode);
  assert.equal(
    f.$('.voice-assistant-draft-hint').textContent,
    'Проверьте данные и сохраните запись.',
  );
  assert.equal(
    f.requests.some((row) => !row.route.startsWith('/api/assistant/')),
    false,
  );
  await f.editor.requestEditorClose();
  assert.equal(f.state.editorMode, null);
  assert.equal(f.state.assistantEditor, null);
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.assistantGeneration, generation);
  f.open();
  await flush();
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-action]').hidden, true);
  assert.equal(f.$('[data-assistant-text]').value, '');
  assert.deepEqual(f.commands, []);
});

function bookingReviewReply(version = 1) {
  return {
    text: 'Проверьте данные',
    policyVersion: 1,
    action: null,
    dialogue: {
      id: 'opaque-booking-review',
      version,
      step: 'review',
      prompt: 'Проверьте данные',
      input: null,
      fields: [{ key: 'time', label: 'Время', value: '14:30' }],
      canEdit: ['time'],
      options: [{ id: 'opaque-ready', label: 'Подготовить форму записи' }],
    },
  };
}
function bookingReadyReply() {
  return {
    text: 'Данные для формы готовы',
    policyVersion: 1,
    dialogue: null,
    action: {
      type: 'prepareAppointment',
      patientId: 'synthetic-patient',
      staffId: 'synthetic-staff',
      date: '2030-01-02',
      time: '14:30',
      duration: 30,
    },
  };
}
async function showBookingReview(f) {
  f.open();
  await flush();
  f.$('[data-assistant-text]').value = 'Подготовь синтетическую запись';
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
}
function submitBookingReview(f, text) {
  f.$('[data-assistant-input]').value = text;
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
}
for (const answer of ['открой форму', 'запиши', 'opaque-choice'])
  test(
    'typed review confirmation ' +
      answer +
      ' opens the server-approved form once without another action click or Save',
    async (t) => {
      let count = 0;
      const f = fixture(t, () => (++count === 1 ? bookingReviewReply() : bookingReadyReply()));
      await showBookingReview(f);
      assert.equal(f.commands.length, 0, 'Review still requires confirmation');
      if (answer === 'opaque-choice') f.$('[data-assistant-choice]').click();
      else submitBookingReview(f, answer);
      await flush();
      assert.equal(f.commands.length, 1);
      assert.equal(f.commands[0].type, 'prepareAppointment');
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
      assert.equal(f.requests.filter((row) => row.route.endsWith('/scope')).length, 2);
      assert.ok(f.requests.every((row) => row.route.startsWith('/api/assistant/')));
    },
  );

test('typed review completion reaches the actual unsaved appointment form and actual ordinary Cancel without a second action click', async (t) => {
  const f = pendingAppointmentHandoffFixture(t, { reviewFirst: true });
  await f.ready();
  assert.equal(f.loads.length, 0);
  submitBookingReview(f, 'открой форму');
  await flush();
  assert.equal(f.loads.length, 1);
  f.loads[0].resolve();
  await flush();
  assert.equal(f.$('#editor').open, true);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.$('[name="staffId"]').value, 'synthetic-staff');
  assert.equal(f.state.editorMode.id, null);
  assert.equal(
    f.$('.voice-assistant-draft-hint').textContent,
    'Проверьте данные и сохраните запись.',
  );
  await f.editor.requestEditorClose();
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.ok(f.requests.every((row) => row.route.startsWith('/api/assistant/')));
});

test('an unknown typed ready answer retries the exact frozen request and opens once after the successful replay', async (t) => {
  let count = 0;
  const f = fixture(t, () => {
    if (++count === 1) return bookingReviewReply();
    if (count === 2)
      throw Object.assign(Error('Synthetic unknown outcome'), { outcomeUnknown: true });
    return bookingReadyReply();
  });
  await showBookingReview(f);
  submitBookingReview(f, 'открой форму');
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  f.$('[data-assistant-retry]').click();
  f.$('[data-assistant-retry]').click();
  await flush();
  const turns = f.requests.filter((row) => row.route.endsWith('/turn'));
  assert.equal(turns.length, 3);
  assert.equal(turns[1].options.body, turns[2].options.body);
  assert.equal(f.commands.length, 1);
});

for (const operation of ['cancel', 'edit'])
  test(
    'typed review ' +
      operation +
      ' does not auto-open even if a response incorrectly carries a prepared action',
    async (t) => {
      let count = 0;
      const f = fixture(t, () => (++count === 1 ? bookingReviewReply() : bookingReadyReply()));
      await showBookingReview(f);
      if (operation === 'cancel') f.$('[data-assistant-new]').click();
      else f.$('[data-assistant-edit]').click();
      await flush();
      assert.equal(f.commands.length, 0);
      assert.equal(f.$('.voice-assistant-dialog').open, true);
    },
  );
for (const type of ['calendar', 'clients', 'clientCard'])
  test(
    'typed review reply with ' + type + ' keeps the ordinary explicit action boundary',
    async (t) => {
      let count = 0;
      const f = fixture(t, () =>
        ++count === 1
          ? bookingReviewReply()
          : {
              text: 'Другой результат',
              policyVersion: 1,
              dialogue: null,
              action: { type, date: '2030-01-02', patientId: 'synthetic', query: '' },
            },
      );
      await showBookingReview(f);
      submitBookingReview(f, 'открой форму');
      await flush();
      assert.equal(f.commands.length, 0);
    },
  );

test('typed corrections keep the dialogue while a server completed final field opens the manual form', async (t) => {
  for (const fromReview of [true, false]) {
    let count = 0;
    const question = fromReview
      ? bookingReviewReply()
      : { ...bookingReviewReply(), dialogue: { ...bookingReviewReply().dialogue, step: 'client' } };
    const f = fixture(t, () =>
      ++count === 1 ? question : fromReview ? bookingReviewReply(2) : bookingReadyReply(),
    );
    await showBookingReview(f);
    submitBookingReview(f, fromReview ? 'на полчаса позже' : 'Синтетический клиент');
    await flush();
    assert.equal(f.commands.length, fromReview ? 0 : 1);
  }
});

test('typed automatic handoff still rejects a fresh scope revision change before opening a form', async (t) => {
  let count = 0;
  const f = fixture(t, () => (++count === 1 ? bookingReviewReply() : bookingReadyReply()));
  await showBookingReview(f);
  f.scope({ ...f.state.assistantScope, policyVersion: 2 });
  submitBookingReview(f, 'открой форму');
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/scope')).length, 2);
  assert.match(f.$('[data-assistant-status]').textContent, /изменились/);
});

test('stopping voice while its review confirmation is pending cannot convert that response into typed automatic handoff', async (t) => {
  let complete,
    release,
    turns = 0;
  const f = fixture(
    t,
    (route) => {
      if (route.endsWith('/transcribe')) return { text: 'открой форму', policyVersion: 1 };
      if (++turns === 1) return bookingReviewReply();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    {
      startAssistantCapture: async (onComplete) => {
        complete = onComplete;
        return true;
      },
      playAssistantAudio: async () => true,
    },
  );
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false } },
  });
  await showBookingReview(f);
  f.$('[data-assistant-voice]').click();
  await flush();
  const pending = complete('synthetic-wav', { autoStopped: true });
  await flush();
  assert.equal(typeof release, 'function');
  f.open();
  await flush();
  release(bookingReadyReply());
  await pending;
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
});

async function unknownVoiceReviewFixture(t, laterReply) {
  let complete,
    turns = 0;
  const f = fixture(
    t,
    (route) => {
      if (route.endsWith('/transcribe')) return { text: 'открой форму', policyVersion: 1 };
      turns++;
      if (turns === 1) return bookingReviewReply();
      if (turns === 2)
        throw Object.assign(Error('Synthetic unknown voice outcome'), { outcomeUnknown: true });
      return laterReply(turns);
    },
    {
      startAssistantCapture: async (onComplete) => {
        complete = onComplete;
        return true;
      },
      playAssistantAudio: async () => true,
    },
  );
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false } },
  });
  await showBookingReview(f);
  f.$('[data-assistant-voice]').click();
  await flush();
  await complete('synthetic-wav', { autoStopped: true });
  await flush();
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  assert.equal(f.commands.length, 0);
  // These recovery tests explicitly switch to the manual surface before replaying.
  f.open();
  await flush();
  return f;
}

test('a stopped voice ready origin survives repeated unknown retries and requires an explicit form action', async (t) => {
  const f = await unknownVoiceReviewFixture(t, (turns) => {
    if (turns === 3)
      throw Object.assign(Error('Synthetic retry unknown outcome'), { outcomeUnknown: true });
    return bookingReadyReply();
  });
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  f.$('[data-assistant-retry]').click();
  await flush();
  const turns = f.requests.filter((row) => row.route.endsWith('/turn'));
  assert.equal(turns.length, 4);
  assert.equal(turns[1].options.body, turns[2].options.body);
  assert.equal(turns[1].options.body, turns[3].options.body);
  assert.equal(f.commands.length, 0);
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-action]').hidden, false);
  f.$('[data-assistant-action]').click();
  await flush();
  assert.equal(f.commands.length, 1);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 4);
});

test('closing an unknown voice review clears its origin before a fresh typed review confirmation', async (t) => {
  const f = await unknownVoiceReviewFixture(t, (turns) =>
    turns === 3 ? bookingReviewReply() : bookingReadyReply(),
  );
  f.$('[data-assistant-close]').click();
  await showBookingReview(f);
  assert.equal(f.$('[data-assistant-retry]').hidden, true);
  submitBookingReview(f, 'открой форму');
  await flush();
  assert.equal(f.commands.length, 1);
  const turns = f.requests.filter((row) => row.route.endsWith('/turn'));
  assert.equal(turns.length, 4);
  const fresh = JSON.parse(turns[2].options.body);
  assert.equal(fresh.dialogueId, undefined);
  assert.equal(fresh.text, 'Подготовь синтетическую запись');
});

test('an expired unknown voice review retry remains a stale error and cannot open its old form', async (t) => {
  const f = await unknownVoiceReviewFixture(t, () => {
    throw Object.assign(Error('Synthetic expired review'), { status: 409 });
  });
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-retry]').hidden, true);
  assert.equal(f.$('[data-assistant-action]').hidden, true);
  assert.match(f.$('[data-assistant-status]').textContent, /Диалог изменился или истёк/);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/scope')).length, 1);
});

test('a new identity cannot replay a pending unknown voice confirmation or open its prepared form', async (t) => {
  const f = await unknownVoiceReviewFixture(t, () => bookingReadyReply());
  f.state.account.id = 'synthetic-other-account';
  f.$('[data-assistant-retry]').click();
  await flush();
  assert.equal(f.commands.length, 0);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/scope')).length, 1);
});

test('panel honors personal text and audio limits rather than fixed display caps', async (t) => {
  const f = fixture(t);
  f.scope({
    ...f.state.assistantScope,
    limits: { maxTextChars: 4000, maxAudioSeconds: 60, requestTimeoutMs: 30000 },
  });
  f.open();
  await flush();
  assert.equal(f.$('[data-assistant-text]').maxLength, 4000);
  assert.match(f.$('[data-assistant-hint]').textContent, /60 секунд/);
});

// CANCEL-EXECUTION-36

test('actual voice confirmation dispatches one cancellation and speaks its committed result without a form or action click', async (t) => {
  const captures = [],
    spoken = [],
    executions = [];
  let transcribes = 0,
    turns = 0,
    release;
  const f = fixture(
    t,
    (route, options) => {
      if (route.endsWith('/transcribe'))
        return { text: ++transcribes === 1 ? 'Отмени запись Анны' : 'да', policyVersion: 1 };
      if (route.endsWith('/speak')) {
        spoken.push(JSON.parse(options.body).text);
        return { audioBase64: 'synthetic', policyVersion: 1 };
      }
      if (++turns === 1)
        return {
          text: 'Отменить запись Анны?',
          policyVersion: 1,
          action: null,
          dialogue: {
            id: 'opaque-cancel-confirmation',
            version: 1,
            step: 'appointment',
            phase: 'cancelConfirmation',
            prompt: 'Отменить запись Анны?',
            input: { type: 'text', field: 'appointment' },
            fields: [],
            canEdit: [],
            options: [
              { id: 'opaque-yes', label: 'Да' },
              { id: 'opaque-no', label: 'Нет' },
            ],
          },
        };
      return {
        text: 'Отменяю.',
        policyVersion: 1,
        dialogue: null,
        action: { type: 'cancelAppointment', executionId: '20000000-0000-4000-8000-000000000001' },
      };
    },
    {
      startAssistantCapture: async (complete, error, seconds, options) => {
        captures.push({ complete, error, seconds, options });
        return true;
      },
      playAssistantAudio: async () => true,
      runAssistantAction: async (action) => {
        executions.push(action);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  );
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    appointmentSavingEnabled: true,
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false } },
  });
  f.open();
  await flush();
  f.$('[data-assistant-voice]').click();
  await flush();
  assert.equal(captures.length, 1);
  await captures[0].complete('synthetic-command-wav', { autoStopped: true });
  await flush();
  assert.equal(executions.length, 0);
  assert.equal(captures.length, 2);
  assert.equal(captures[1].options.shortAnswer, true);
  const pending = captures[1].complete('synthetic-yes-wav', { autoStopped: true });
  await flush();
  assert.equal(executions.length, 1);
  assert.equal(executions[0].type, 'cancelAppointment');
  assert.ok(
    spoken.every((text) => !/Запись отменена|Отменяю/u.test(text)),
    'no success or pending text is spoken before commit',
  );
  assert.equal(f.state.editorMode, null);
  release({
    saved: true,
    cancelled: true,
    operation: 'cancel',
    text: 'Запись отменена.',
    policyVersion: 1,
    appointmentId: 'synthetic-appointment',
    action: null,
  });
  await pending;
  await flush();
  assert.equal(executions.length, 1);
  assert.equal(spoken.filter((text) => text === 'Запись отменена.').length, 1);
  assert.equal(captures.length, 2);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
});

// AUTO-MOVE-37

test('a complete spoken move executes immediately and speaks only committed feedback without a form', async (t) => {
  const captures = [],
    spoken = [],
    executions = [];
  let release;
  const f = fixture(
    t,
    (route, options) => {
      if (route.endsWith('/transcribe'))
        return {
          text: 'Перенеси запись Анны на двадцатое октября в пятнадцать часов',
          policyVersion: 1,
        };
      if (route.endsWith('/speak')) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.stream, true);
        assert.equal(payload.format, 'pcm');
        spoken.push(payload.text);
        return { audioBase64: 'synthetic', policyVersion: 1 };
      }
      return {
        text: 'Переношу запись.',
        policyVersion: 1,
        dialogue: null,
        action: { type: 'moveAppointment', executionId: '20000000-0000-4000-8000-000000000001' },
      };
    },
    {
      startAssistantCapture: async (complete, error, seconds, options) => {
        captures.push({ complete, error, seconds, options });
        return true;
      },
      assistantAudioFormat: () => 'pcm',
      playAssistantAudio: async () => true,
      runAssistantAction: async (action) => {
        executions.push(action);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  );
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    appointmentSavingEnabled: true,
    capabilities: {
      stt: { ready: true, demo: false },
      tts: { ready: true, demo: false, streaming: true },
    },
  });
  f.open();
  await flush();
  f.$('[data-assistant-voice]').click();
  await flush();
  const pending = captures[0].complete('synthetic-move-wav', { autoStopped: true });
  await flush();
  assert.equal(executions.length, 1);
  assert.equal(executions[0].type, 'moveAppointment');
  assert.deepEqual(spoken, []);
  assert.equal(f.state.editorMode, null);
  release({
    saved: true,
    moved: true,
    operation: 'move',
    appointmentId: 'existing-id',
    policyVersion: 1,
    text: 'Перенёс запись Анны на 20 октября в 15:00.',
    action: null,
  });
  await pending;
  await flush();
  assert.deepEqual(spoken, ['Перенёс запись Анны на 20 октября в 15:00.']);
  assert.equal(captures.length, 1);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
});

test('a previous voice handoff finally cannot release the newly started voice audio lease', async (t) => {
  const captures = [];
  let completeAction,
    lease = 0,
    next = 0;
  const released = [];
  const f = fixture(
    t,
    (route) => {
      if (route.endsWith('/transcribe')) return { text: 'Перенеси запись', policyVersion: 1 };
      if (route.endsWith('/speak')) return { audioBase64: 'synthetic', policyVersion: 1 };
      return {
        text: 'Переношу',
        policyVersion: 1,
        dialogue: null,
        action: { type: 'moveAppointment', executionId: '20000000-0000-4000-8000-000000000001' },
      };
    },
    {
      unlockAssistantAudio() {
        lease = ++next;
        return Promise.resolve(true);
      },
      releaseAssistantAudio() {
        released.push(lease);
        lease = 0;
      },
      startAssistantCapture: async (complete) => {
        captures.push(complete);
        return true;
      },
      playAssistantAudio: async () => true,
      runAssistantAction: async () =>
        new Promise((resolve) => {
          completeAction = resolve;
        }),
    },
  );
  f.scope({
    ...f.state.assistantScope,
    demo: false,
    appointmentSavingEnabled: true,
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true, demo: false } },
  });
  f.open();
  await flush();
  f.$('[data-assistant-voice]').click();
  await flush();
  const pending = captures[0]('synthetic-wav', { autoStopped: true });
  await flush();
  assert.equal(typeof completeAction, 'function');
  f.open();
  await flush();
  f.$('[data-assistant-voice]').click();
  await flush();
  const newerLease = lease,
    releaseCount = released.length;
  assert.ok(newerLease > 0);
  completeAction({ saved: true, text: 'Запись перенесена.', policyVersion: 1 });
  await pending;
  await flush();
  assert.equal(lease, newerLease);
  assert.equal(released.length, releaseCount);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
});

function retainedVoiceDraft(t, failure) {
  const captures = [];
  let text = 'Запиши Анну Синтетическую',
    turns = 0;
  const question = (version) => ({
    policyVersion: 1,
    demo: false,
    text: 'На какую дату?',
    action: null,
    dialogue: {
      id: 'retained-voice-draft',
      version,
      step: 'date',
      phase: 'date',
      prompt: 'На какую дату?',
      input: { type: 'text', field: 'date' },
      options: [],
      fields: [{ key: 'client', label: 'Клиент', value: 'Анна Синтетическая' }],
      canEdit: [],
    },
  });
  const f = fixture(
    t,
    async (route) => {
      if (route.endsWith('/transcribe')) return { text, policyVersion: 1 };
      if (route.endsWith('/speak')) return { audioBase64: 'synthetic', policyVersion: 1 };
      if (route.endsWith('/turn')) {
        turns++;
        if (turns === 2) {
          if (typeof failure === 'function') return failure();
          throw failure;
        }
        return question(turns === 1 ? 1 : 2);
      }
      throw Error('Unexpected synthetic route');
    },
    {
      async startAssistantCapture(complete, error) {
        captures.push({ complete, error });
        return true;
      },
      async playAssistantAudio() {
        return true;
      },
    },
  );
  Object.assign(f.state.assistantScope, {
    demo: false,
    capabilities: { stt: { ready: true, demo: false }, tts: { ready: true } },
  });
  return {
    f,
    captures,
    answer: (value) => {
      text = value;
      return captures.at(-1).complete('synthetic-wav', { autoStopped: true });
    },
  };
}

test('a 502 pauses voice but retains its visible clarification and answer beyond the empty idle deadline', async (t) => {
  const { f, captures, answer } = retainedVoiceDraft(
    t,
    Object.assign(Error('Ответ помощника не соответствует формату уточнения.'), { status: 502 }),
  );
  f.pointer('pointerdown');
  f.advance(600);
  f.pointer('pointerup');
  await flush();
  await answer('Запиши Анну Синтетическую');
  assert.equal(captures.length, 2);
  await answer('На завтра');
  assert.equal(captures.length, 2);
  f.advance(60000);
  await flush();
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.match(
    f.$('[data-assistant-session-message]').textContent,
    /не соответствует формату уточнения/,
  );
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  assert.match(f.$('[data-assistant-conversation]').textContent, /Анна Синтетическая/);
  assert.equal(f.$('[data-assistant-input]').value, 'На завтра');
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
  f.$('[data-assistant-session-resume]').click();
  await flush();
  assert.equal(captures.length, 3);
  assert.equal(
    f.requests.filter((row) => row.route.endsWith('/turn')).length,
    2,
    'Continue does not retry known invalid output automatically',
  );
  await answer('На послезавтра');
  const bodies = f.requests
    .filter((row) => row.route.endsWith('/turn'))
    .map((row) => JSON.parse(row.options.body));
  assert.equal(bodies[2].dialogueId, 'retained-voice-draft');
  assert.equal(bodies[2].dialogueVersion, 1);
  assert.equal(bodies[2].text, 'На послезавтра');
});

test('an unknown voice turn keeps its exact retry body past idle and replays only on explicit Continue', async (t) => {
  const { f, captures, answer } = retainedVoiceDraft(
    t,
    Object.assign(Error('Synthetic response lost'), { outcomeUnknown: true }),
  );
  f.pointer('pointerdown');
  f.advance(600);
  f.pointer('pointerup');
  await flush();
  await answer('Запиши Анну Синтетическую');
  await answer('На завтра');
  const before = f.requests
    .filter((row) => row.route.endsWith('/turn'))
    .map((row) => row.options.body);
  assert.equal(before.length, 2);
  f.advance(90000);
  await flush();
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.equal(f.$('[data-assistant-session-resume]').textContent, 'Повторить');
  assert.equal(captures.length, 2);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
  f.$('[data-assistant-session-resume]').click();
  await flush();
  const after = f.requests
    .filter((row) => row.route.endsWith('/turn'))
    .map((row) => row.options.body);
  assert.equal(after.length, 3);
  assert.equal(after[2], before[1]);
  assert.equal(captures.length, 3);
});

test('stopping speech during an in-flight turn cannot expose a parallel Continue or discard its draft on idle', async (t) => {
  let resolve;
  const gate = new Promise((done) => {
    resolve = done;
  });
  const { f, captures, answer } = retainedVoiceDraft(t, () => gate);
  f.pointer('pointerdown');
  f.advance(600);
  f.pointer('pointerup');
  await flush();
  await answer('Запиши Анну Синтетическую');
  const pending = answer('На завтра');
  await flush();
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
  f.$('[data-assistant-voice]').click();
  f.advance(60000);
  await flush();
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.equal(f.$('[data-assistant-session-resume]').hidden, true);
  assert.equal(f.$('[data-assistant-send]').disabled, true);
  f.$('[data-assistant-session-resume]').click();
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(captures.length, 2);
  assert.equal(f.requests.filter((row) => row.route.endsWith('/turn')).length, 2);
  resolve({
    policyVersion: 1,
    demo: false,
    text: 'Уточните время.',
    action: null,
    dialogue: {
      id: 'retained-voice-draft',
      version: 2,
      step: 'time',
      phase: 'time',
      prompt: 'Уточните время.',
      input: { type: 'text', field: 'time' },
      options: [],
      fields: [],
      canEdit: [],
    },
  });
  await pending;
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
});
