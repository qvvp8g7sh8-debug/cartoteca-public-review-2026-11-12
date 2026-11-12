const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { fixture: voiceFixture, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');

function reply(count, version = 1) {
  return {
    text: 'Какое имя?',
    policyVersion: 1,
    demo: false,
    action: null,
    dialogue: {
      id: 'synthetic-expanded-clients',
      version,
      step: 'client',
      phase: 'clientChoice',
      prompt: 'Какое имя?',
      input: { type: 'text', field: 'client' },
      fields: [],
      canEdit: [],
      options: Array.from({ length: count }, (_, index) => ({
        id: 'opaque-client-' + (index + 1),
        label: 'Синтетический клиент ' + (index + 1) + ' · …' + String(index + 1).padStart(4, '0'),
      })),
    },
  };
}
function fixture(t) {
  const w = new JSDOM('<button id="calendar">Календарь</button>', {
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
  const presentation = w
    .eval('createAssistantPresentation')()
    .assistantPresentation({
      choose: (selection) => choices.push(selection),
      close: () => presentation.close(),
      resume: () => assert.fail('Local expansion cannot resume voice'),
    });
  presentation.start();
  t.after(() => {
    presentation.destroy();
    w.close();
  });
  return {
    w,
    choices,
    presentation,
    $: (selector) => w.document.querySelector(selector),
    update(value, extra = {}) {
      presentation.update({
        reply: value,
        busy: false,
        recording: true,
        voiceEnabled: true,
        phase: 'listening',
        ...extra,
      });
    },
  };
}

for (const count of [4, 5, 12])
  test(
    'all ' +
      count +
      ' received clients become reachable without replacing the first three or dispatching a choice',
    (t) => {
      const f = fixture(t);
      const value = reply(count);
      f.update(value);
      const picker = f.$('[data-assistant-picker="client"]');
      const selector = '[data-assistant-picker-choices] > [data-assistant-choice]';
      const first = [...picker.querySelectorAll(selector)];
      const microphone = f.$('[data-assistant-session-stop]');
      const more = f.$('[data-assistant-clients-more]');
      assert.equal(first.length, 3);
      assert.equal(more.textContent, 'Ещё ' + (count - 3));
      assert.equal(more.getAttribute('aria-label'), 'Показать остальных клиентов');
      f.w.setTimeout = f.w.setInterval = () => assert.fail('No local expansion timers');
      more.click();
      assert.equal(picker.querySelectorAll(selector).length, count);
      assert.deepEqual([...picker.querySelectorAll(selector)].slice(0, 3), first);
      assert.equal(f.$('[data-assistant-session-stop]'), microphone);
      assert.equal(f.$('[data-assistant-clients-more]'), null);
      assert.equal(f.$('[data-assistant-picker-controls]').hidden, true);
      assert.equal(f.w.document.activeElement.dataset.assistantChoice, 'opaque-client-4');
      assert.deepEqual(f.choices, []);
      more.click();
      assert.equal(
        picker.querySelectorAll(selector).length,
        count,
        'a detached repeated click adds no duplicates',
      );
      f.update(value, { phase: 'speaking' });
      assert.equal(
        picker.querySelectorAll(selector).length,
        count,
        'same-version speech updates retain expansion',
      );
      f.$('[data-assistant-choice="opaque-client-' + count + '"]').click();
      assert.deepEqual(JSON.parse(JSON.stringify(f.choices)), [
        {
          dialogueId: value.dialogue.id,
          dialogueVersion: 1,
          choice: 'opaque-client-' + count,
        },
      ]);
    },
  );

test('three or fewer clients retain the original strips without a redundant expansion control', (t) => {
  const f = fixture(t);
  for (const count of [1, 2, 3]) {
    f.update(reply(count, count));
    assert.equal(f.$('[data-assistant-clients-more]'), null);
    assert.equal(f.$('[data-assistant-picker-controls]').hidden, true);
  }
});

test('busy and pending states block local expansion and a hidden page cannot expand it', (t) => {
  const f = fixture(t);
  const value = reply(5);
  f.update(value, { voiceEnabled: false, busy: true, recording: false });
  const more = f.$('[data-assistant-clients-more]');
  assert.equal(more.disabled, true);
  more.click();
  assert.equal(f.$('[data-assistant-picker-choices]').children.length, 3);
  f.update(value);
  assert.equal(more.disabled, false);
  Object.defineProperty(f.w.document, 'hidden', { value: true, configurable: true });
  more.click();
  assert.equal(f.$('[data-assistant-picker-choices]').children.length, 3);
  Object.defineProperty(f.w.document, 'hidden', { value: false, configurable: true });
  f.update(value, { turnPending: true });
  assert.equal(f.$('[data-assistant-picker="client"]').open, false);
  more.click();
  assert.equal(f.$('[data-assistant-picker-choices]').children.length, 3);
  assert.deepEqual(f.choices, []);
});

test('an old expansion cannot append candidates into a newer version or a closed assistant', (t) => {
  const f = fixture(t);
  f.update(reply(12));
  const stale = f.$('[data-assistant-clients-more]');
  const next = reply(4, 2);
  next.dialogue.options.forEach((option) => (option.id = 'new-' + option.id));
  f.update(next);
  const current = f.$('[data-assistant-clients-more]');
  stale.click();
  assert.equal(f.$('[data-assistant-picker-choices]').children.length, 3);
  assert.equal(f.$('[data-assistant-clients-more]'), current);
  current.click();
  assert.equal(f.$('[data-assistant-choice="new-opaque-client-4"]') !== null, true);
  assert.equal(f.$('[data-assistant-choice="opaque-client-12"]'), null);
  f.presentation.close();
  current.click();
  assert.equal(f.$('[data-assistant-picker]'), null);
  assert.equal(f.$('.voice-assistant-session').hidden, true);
  assert.deepEqual(f.choices, []);
});

test('expansion preserves server controls, treats labels as text and uses only received opaque candidates', (t) => {
  const f = fixture(t);
  const value = reply(5);
  value.dialogue.options[4].label = '<img src=x onerror=alert(1)> · …0005';
  value.dialogue.controls = [{ id: 'opaque-back', label: 'Назад' }];
  f.update(value);
  f.$('[data-assistant-clients-more]').click();
  const controls = f.$('[data-assistant-picker-controls]');
  assert.equal(controls.hidden, false);
  assert.equal(controls.children.length, 1);
  assert.equal(f.$('img'), null);
  assert.match(f.$('[data-assistant-choice="opaque-client-5"]').textContent, /<img src=x/);
  controls.querySelector('[data-assistant-choice="opaque-back"]').click();
  assert.equal(f.choices[0].choice, 'opaque-back');
  assert.equal(f.choices[0].dialogueVersion, 1);
});

test(
  'expanding clients leaves current speech running, and selecting the twelfth continues the same voice dialogue',
  { timeout: 4000 },
  async (t) => {
    const f = voiceFixture(t);
    let turns = 0;
    f.control.turn = async () => {
      if (++turns === 1) return reply(12);
      const next = reply(0, 2);
      next.text = next.dialogue.prompt = 'На какую дату?';
      next.dialogue.step = next.dialogue.phase = 'date';
      next.dialogue.input.field = 'date';
      return next;
    };
    await f.hold();
    const initial = f.transcript('Найди синтетического клиента');
    await flush();
    const currentSpeech = f.played.at(-1);
    let speechStopped = false;
    void currentSpeech.gate.promise.then(() => (speechStopped = true));
    const requests = f.calls.length;
    f.$('[data-assistant-clients-more]').click();
    await flush();
    assert.equal(speechStopped, false);
    assert.equal(f.played.at(-1), currentSpeech);
    assert.equal(f.calls.length, requests, 'local expansion starts no HTTP, STT or TTS');
    assert.equal(f.captures.length, 1);
    const candidate = f.$(
      '[data-assistant-picker="client"] [data-assistant-choice="opaque-client-12"]',
    );
    assert.equal(candidate.disabled, false);
    candidate.click();
    await flush();
    assert.equal(
      speechStopped,
      true,
      'selecting the expanded candidate stops the current question',
    );
    assert.equal(f.turns().length, 2);
    assert.deepEqual(f.turns()[1].body, {
      dialogueId: 'synthetic-expanded-clients',
      dialogueVersion: 1,
      choice: 'opaque-client-12',
      policyVersion: 1,
    });
    await f.finishSpeech();
    await initial;
    assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.$('.voice-assistant-session').hidden, false);
    assert.equal(f.captures.length, 2);
    assert.equal(f.calls.filter((entry) => entry.route.endsWith('/execute')).length, 0);
  },
);
