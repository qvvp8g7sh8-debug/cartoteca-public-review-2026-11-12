const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { fixture: voiceFixture, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');

function dialogue(version, step, options = []) {
  return {
    policyVersion: 1,
    text: step === 'date' ? 'На какую дату?' : 'Уточните выбор',
    action: null,
    dialogue: {
      id: 'synthetic-choice-dialogue',
      version,
      step,
      prompt: step === 'date' ? 'На какую дату?' : 'Уточните выбор',
      input: { type: 'text', field: step },
      options,
      fields: [],
      canEdit: [],
    },
  };
}
function presentationFixture(t) {
  const w = new JSDOM('<button id="previous">Календарь</button>', {
    url: 'https://synthetic.invalid',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  }).window;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.eval(
    fs.readFileSync(
      path.join(__dirname, '../src/client/modules/assistant-presentation.js'),
      'utf8',
    ),
  );
  const choices = [];
  let closed = 0;
  const presentation = w
    .eval('createAssistantPresentation')()
    .assistantPresentation({
      choose: (selection) => choices.push(selection),
      resume() {},
      close() {
        closed++;
        presentation.close();
      },
    });
  presentation.start();
  t.after(() => {
    presentation.destroy();
    w.close();
  });
  return {
    w,
    presentation,
    choices,
    closed: () => closed,
    $: (selector) => w.document.querySelector(selector),
    update(reply, extra = {}) {
      presentation.update({ reply, busy: false, recording: false, voiceEnabled: true, ...extra });
    },
  };
}

test('client and service clarification use distinct windows and retain opaque versioned selections', (t) => {
  const f = presentationFixture(t);
  f.$('#previous').focus();
  f.update(
    dialogue(1, 'client', [
      { id: 'opaque-client-a', label: 'Анна Синтетическая' },
      { id: 'opaque-client-b', label: 'Анна Примерная' },
    ]),
  );
  const client = f.$('[data-assistant-picker="client"]');
  assert.equal(client.open, true);
  client.querySelector('[data-assistant-choice]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.choices)), [
    {
      choice: 'opaque-client-a',
      dialogueId: 'synthetic-choice-dialogue',
      dialogueVersion: 1,
    },
  ]);
  f.update(dialogue(2, 'service', [{ id: 'opaque-service', label: 'Консультация · 30 мин' }]));
  const service = f.$('[data-assistant-picker="service"]');
  assert.notEqual(service, client);
  assert.equal(client.open, false);
  assert.equal(service.open, true);
  assert.equal(service.getAttribute('aria-label'), 'Выбор услуги');
  assert.equal(service.querySelector('h2').hidden, true);
  assert.equal(service.querySelector('[data-assistant-picker-prompt]').hidden, true);
  assert.doesNotMatch(service.textContent, /Анна Синтетическая/);
  service.querySelector('[data-assistant-choice]').click();
  assert.equal(f.choices[1].dialogueVersion, 2);
  assert.equal(f.choices[1].choice, 'opaque-service');
});

test('the selected service group remains open during processing and marks the suggestion', (t) => {
  const f = presentationFixture(t);
  const reply = dialogue(1, 'service', [{ id: 'first', label: 'Консультация' }]);
  reply.dialogue.serviceGroupTitle = 'Уход';
  f.update(reply);
  const picker = f.$('[data-assistant-picker="service"]');
  f.update(null, { turnPending: true });
  assert.equal(picker.open, true);
  assert.equal(picker.querySelector('[data-assistant-choice]').disabled, true);
  const suggestion = dialogue(2, 'service', [
    { id: 'next', label: 'Консультация', suggested: true },
  ]);
  suggestion.dialogue.serviceGroupTitle = 'Уход';
  suggestion.dialogue.prompt = 'Вы имеете в виду «Консультация»?';
  f.update(suggestion);
  assert.equal(picker.open, true);
  assert.equal(picker.querySelector('[data-assistant-picker-prompt]').textContent, suggestion.dialogue.prompt);
  assert.ok(picker.querySelector('[data-assistant-suggested]'));
  f.update(dialogue(3, 'date'));
  assert.equal(picker.open, false);
});

test('ordinary spoken questions and a missing client do not open a selection window', (t) => {
  const f = presentationFixture(t);
  for (const step of ['date', 'time', 'duration', 'client', 'service']) {
    const reply = dialogue(1, step);
    if (step === 'client') reply.dialogue.phase = 'clientChoice';
    f.update(reply);
    assert.equal(f.w.document.querySelector('dialog[open]'), null, step);
    assert.equal(f.$('.voice-assistant-session').hidden, false, step);
  }
  const closedDay = dialogue(2, 'availability', [{ id: 'yes', label: 'Да' }]);
  closedDay.dialogue.phase = 'closedDay';
  f.update(closedDay);
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
});

test('a completed or pending choice hides the old window, restores focus and close clears candidates', (t) => {
  const f = presentationFixture(t);
  f.$('#previous').focus();
  const reply = dialogue(1, 'client', [
    { id: 'opaque-client', label: '<img src=x> Синтетический' },
  ]);
  f.update(reply);
  assert.equal(f.$('[data-assistant-picker="client"] img'), null);
  f.update(reply, { turnPending: true });
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
  assert.equal(f.w.document.activeElement.id, 'previous');
  f.update(dialogue(2, 'date'));
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
  f.update(dialogue(3, 'service', [{ id: 'opaque-service', label: 'Консультация' }]));
  const event = new f.w.Event('cancel', { cancelable: true });
  f.$('[data-assistant-picker="service"]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.closed(), 1);
  assert.equal(f.w.document.querySelector('[data-assistant-picker]'), null);
  assert.equal(f.$('.voice-assistant-session').hidden, true);
});

test('voice choices and plain date questions keep one session without opening the general panel or saving', async (t) => {
  const f = voiceFixture(t);
  const replies = [
    dialogue(1, 'client', [{ id: 'opaque-client', label: 'Анна Синтетическая' }]),
    dialogue(2, 'service', [{ id: 'opaque-service', label: 'Консультация' }]),
    dialogue(3, 'date'),
    dialogue(4, 'time'),
  ];
  let next = 0;
  f.control.turn = async () => replies[next++];
  await f.hold();
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.captures.length, 1);
  const initial = f.transcript('Запиши Анну на консультацию');
  await flush();
  assert.equal(f.$('[data-assistant-picker="client"]').open, true);
  await f.finishSpeech();
  await initial;
  assert.equal(f.captures.length, 2);
  f.$('[data-assistant-picker="client"] [data-assistant-choice]').click();
  await flush();
  assert.equal(f.$('[data-assistant-picker="client"]').open, false);
  assert.equal(f.$('[data-assistant-picker="service"]').open, true);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  await f.finishSpeech();
  const service = f.transcript('Консультация');
  await flush();
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
  await f.finishSpeech();
  await service;
  const date = f.transcript('На завтра');
  await flush();
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
  await f.finishSpeech();
  await date;
  const turns = f.turns().map((item) => item.body);
  assert.equal(turns.length, 4);
  assert.equal(turns[1].choice, 'opaque-client');
  assert.deepEqual(
    turns.slice(1).map((body) => body.dialogueVersion),
    [1, 2, 3],
  );
  assert.ok(turns.slice(1).every((body) => body.dialogueId === 'synthetic-choice-dialogue'));
  assert.equal(f.calls.filter((item) => item.route === '/api/assistant/scope').length, 1);
  assert.deepEqual(f.opened, []);
  const beforeClose = f.turns().length;
  f.$('[data-assistant-session-stop]').click();
  await f.captures.at(-1).complete('late-synthetic-wav');
  await flush();
  assert.equal(f.turns().length, beforeClose);
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
  assert.equal(f.$('.voice-assistant-session').hidden, true);
});

test('client choices are compact strips with an accessible label and a reachable stop below them', (t) => {
  const f = presentationFixture(t);
  f.update(
    dialogue(1, 'client', [
      { id: 'client-one', label: 'Гульнара Мухамедьянова' },
      { id: 'client-two', label: 'Гульнара Хабибуллина' },
      { id: 'client-three', label: 'Гульнара Синтетическая' },
      { id: 'client-four', label: 'Не показываемый четвёртый кандидат' },
    ]),
    { phase: 'listening', recording: true },
  );
  const picker = f.$('[data-assistant-picker="client"]');
  const strips = [...picker.querySelectorAll('[data-assistant-picker-choices] > button')];
  assert.equal(picker.getAttribute('aria-label'), 'Выбор клиента');
  assert.equal(strips.length, 3);
  assert.equal(picker.querySelector('h2, [data-assistant-picker-prompt]'), null);
  assert.doesNotMatch(picker.textContent, /Уточните выбор|Выберите клиента|×|четвёртый кандидат/);
  const indicator = f.$('.voice-assistant-session');
  assert.equal(indicator.parentNode, picker);
  assert.equal(picker.lastElementChild, indicator);
  assert.equal(indicator.hidden, false);
  indicator.querySelector('[data-assistant-session-stop]').click();
  assert.equal(f.closed(), 1);
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
});

test('service picker shows the whole server page and distinct versioned navigation controls', (t) => {
  const f = presentationFixture(t);
  const reply = dialogue(
    7,
    'service',
    Array.from({ length: 7 }, (_, index) => ({
      id: 'service-' + index,
      label: 'Синтетическая услуга ' + index,
    })),
  );
  reply.dialogue.controls = [
    { id: 'server-next-page', label: 'Ещё' },
    { id: 'server-clear-filter', label: 'Все услуги' },
  ];
  f.update(reply, { phase: 'listening', recording: true });
  const picker = f.$('[data-assistant-picker="service"]');
  assert.equal(picker.querySelectorAll('[data-assistant-picker-choices] > button').length, 7);
  const controls = picker.querySelector('[data-assistant-picker-controls]');
  assert.equal(controls.hidden, false);
  assert.equal(controls.children.length, 2);
  controls.querySelector('[data-assistant-choice="server-next-page"]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.choices)), [
    {
      choice: 'server-next-page',
      dialogueId: 'synthetic-choice-dialogue',
      dialogueVersion: 7,
    },
  ]);
  f.update(dialogue(8, 'service', [{ id: 'service-next', label: 'Другая услуга' }]), {
    busy: true,
    voiceEnabled: false,
  });
  assert.equal(picker.querySelector('[data-assistant-picker-controls]').hidden, true);
  const next = picker.querySelector('[data-assistant-choice="service-next"]');
  assert.equal(next.disabled, true);
  next.click();
  assert.equal(f.choices.length, 1);
});

test('microphone phases use the same visual control without exposing long status text', (t) => {
  const f = presentationFixture(t);
  let microphone;
  for (const phase of ['starting', 'listening', 'pending', 'speaking', 'idle']) {
    f.update(dialogue(1, 'date'), {
      phase,
      message: 'Очень длинное пояснение, которое не должно быть видно рядом с микрофоном.',
    });
    const indicator = f.$('.voice-assistant-session');
    const current = indicator.querySelector('[data-assistant-session-stop]');
    if (microphone) assert.equal(current, microphone);
    microphone = current;
    assert.equal(indicator.dataset.assistantPhase, phase);
    assert.equal(current.textContent, '');
    assert.match(current.getAttribute('aria-label'), /Остановить голосового помощника/);
    assert.doesNotMatch(indicator.textContent, /Очень длинное|×/);
    assert.equal(indicator.parentNode, f.w.document.body);
  }
  f.update(dialogue(1, 'date'), { recording: true });
  assert.equal(f.$('.voice-assistant-session').dataset.assistantPhase, 'listening');
  f.update(dialogue(1, 'date'), { busy: true });
  assert.equal(f.$('.voice-assistant-session').dataset.assistantPhase, 'pending');
});

test('capture level is bounded and updates without replacing choices or scheduling work', (t) => {
  const f = presentationFixture(t);
  f.update(dialogue(1, 'client', [{ id: 'client-one', label: 'Анна Синтетическая' }]), {
    phase: 'listening',
    recording: true,
  });
  const indicator = f.$('.voice-assistant-session');
  const choice = f.$('[data-assistant-choice]');
  const microphone = f.$('[data-assistant-session-stop]');
  const unexpectedSchedule = () => assert.fail('level updates must not schedule background work');
  f.w.requestAnimationFrame = unexpectedSchedule;
  f.w.setTimeout = unexpectedSchedule;
  f.w.setInterval = unexpectedSchedule;
  for (const [input, expected] of [
    [0.6, '0.6'],
    [4, '1'],
    [-2, '0'],
    [NaN, '0'],
  ]) {
    f.presentation.setLevel(input);
    assert.equal(indicator.style.getPropertyValue('--assistant-level'), expected);
    assert.equal(f.$('[data-assistant-choice]'), choice);
    assert.equal(f.$('[data-assistant-session-stop]'), microphone);
  }
  Object.defineProperty(f.w.document, 'hidden', { value: true, configurable: true });
  f.presentation.setLevel(1);
  assert.equal(indicator.style.getPropertyValue('--assistant-level'), '0');
  Object.defineProperty(f.w.document, 'hidden', { value: false, configurable: true });
  f.presentation.close();
  f.presentation.setLevel(1);
  assert.equal(indicator.style.getPropertyValue('--assistant-level'), '0');
});

test('blank picker space preserves the session while an outside backdrop click stops it', (t) => {
  const f = presentationFixture(t);
  f.update(dialogue(1, 'client', [{ id: 'client-one', label: 'Анна Синтетическая' }]));
  const picker = f.$('[data-assistant-picker="client"]');
  picker.getBoundingClientRect = () => ({ left: 100, right: 500, top: 100, bottom: 400 });
  picker.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, clientX: 200, clientY: 200 }));
  assert.equal(f.closed(), 0);
  assert.equal(picker.open, true);
  picker.dispatchEvent(new f.w.PointerEvent('pointerdown', { bubbles: true, pointerId: 11, isPrimary: true, button: 0, clientX: 50, clientY: 50 }));
  picker.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, clientX: 50, clientY: 50 }));
  assert.equal(f.closed(), 1);
  assert.equal(f.w.document.querySelector('dialog[open]'), null);
});

test('paused voice status is visible as plain text and cleared when the session resumes or closes', (t) => {
  const f = presentationFixture(t);
  const message = 'Не удалось воспроизвести ответ. <img src=x onerror=alert(1)>';
  f.update(dialogue(1, 'date'), { phase: 'idle', voiceEnabled: false, message });
  const detail = f.$('[data-assistant-session-message]');
  assert.equal(detail.hidden, false);
  assert.equal(detail.textContent, message);
  assert.equal(detail.classList.contains('voice-assistant-sr-only'), false);
  assert.equal(detail.getAttribute('role'), 'status');
  assert.equal(detail.querySelector('img'), null);
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  for (const extra of [
    { busy: true },
    { recording: true },
    { turnPending: true },
    { voiceEnabled: true },
  ]) {
    f.update(dialogue(1, 'date'), { phase: 'idle', voiceEnabled: false, message, ...extra });
    assert.equal(detail.hidden, true);
    assert.equal(detail.textContent, '');
  }
  f.update(dialogue(1, 'date'), { phase: 'idle', voiceEnabled: false, message });
  f.presentation.close();
  assert.equal(detail.hidden, true);
  assert.equal(detail.textContent, '');
});

test('voice failures expose their reason beside the microphone without opening the general panel or saving', async (t) => {
  for (const stage of ['permission', 'stt', 'turn', 'speak']) {
    await t.test(stage, async (t) => {
      const f = voiceFixture(t);
      const message =
        stage === 'permission'
          ? 'Доступ к микрофону закрыт. Разрешите его в браузере или введите запрос.'
          : 'Синтетический отказ ' + stage;
      f.control[stage] = async () => {
        throw Object.assign(
          Error(message),
          stage === 'permission' ? { name: 'NotAllowedError' } : { status: 502 },
        );
      };
      await f.hold();
      if (stage !== 'permission')
        await f.captures
          .at(-1)
          .complete('synthetic-wav', { autoStopped: true, seconds: 2, stopReason: 'silence' });
      await flush();
      const detail = f.$('[data-assistant-session-message]');
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(f.$('.voice-assistant-session').hidden, false);
      assert.equal(f.$('.voice-assistant-session').dataset.assistantPhase, 'idle');
      assert.equal(detail.hidden, false);
      assert.equal(detail.textContent, message);
      assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
      assert.equal(f.captures.length, 1);
      assert.deepEqual(f.opened, []);
      assert.equal(
        f.calls.some((call) => call.route === '/api/assistant/execute'),
        false,
      );
      if (stage === 'permission') {
        f.control.permission = async () => true;
        f.$('[data-assistant-session-resume]').click();
        await flush();
        assert.equal(detail.hidden, true);
        assert.equal(detail.textContent, '');
        assert.equal(f.captures.length, 2);
      }
    });
  }
});

test('recoverable sound failure exposes Continue while the microphone session remains enabled', (t) => {
  const f = presentationFixture(t);
  f.update(dialogue(1, 'date'), {
    phase: 'idle',
    voiceEnabled: true,
    voicePaused: true,
    message: 'Браузер заблокировал звук. Нажмите «Продолжить».',
  });
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  assert.equal(f.$('[data-assistant-session-message]').hidden, false);
  f.update(dialogue(1, 'date'), {
    phase: 'listening',
    voiceEnabled: true,
    voicePaused: false,
    recording: true,
    message: '',
  });
  assert.equal(f.$('[data-assistant-session-resume]').hidden, true);
  assert.equal(f.$('[data-assistant-session-message]').hidden, true);
});
