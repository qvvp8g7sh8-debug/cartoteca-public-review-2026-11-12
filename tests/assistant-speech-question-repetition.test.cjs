const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t) {
  const requests = [],
    played = [],
    state = {
      assistantGeneration: 1,
      assistantScope: { limits: { maxReplyChars: 1000 }, capabilities: { tts: { ready: true } } },
    };
  const load = (file, factory) =>
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../src/client/modules', file), 'utf8') + '\n' + factory,
      {},
    );
  const actions = {
    ...load('assistant-speech-text.js', 'createAssistantSpeechText')(),
    playAssistantAudio: async (reply) => {
      played.push(reply.text);
      return true;
    },
    stopAssistantAudio() {},
    stopAssistantCapture() {},
  };
  const ui = {
    valid: () => true,
    session: 1,
    busy: false,
    recording: false,
    activity(busy, recording) {
      this.busy = busy;
      this.recording = recording;
    },
    status() {},
    request: async (route, body) => {
      requests.push({ route, body });
      return { audioBase64: 'synthetic' };
    },
  };
  const controller = load('assistant-speech.js', 'createAssistantSpeech')(
    state,
    actions,
  ).assistantSpeechController(ui);
  t.after(() => controller.stopVoice());
  return {
    async speak(reply, answerable) {
      const original = JSON.stringify(reply),
        before = requests.length;
      assert.equal(await controller.speakReply(reply, answerable), true);
      assert.equal(
        JSON.stringify(reply),
        original,
        'all visible choices and identities stay intact',
      );
      const calls = requests.slice(before);
      assert.ok(calls.every(({ route }) => route === '/api/assistant/speak'));
      assert.deepEqual(
        played.slice(before),
        calls.map(({ body }) => body.text),
      );
      return calls.map(({ body }) => body.text).join(' ');
    },
  };
}

function question(step, phase, prompt, labels, text = prompt) {
  return {
    text,
    action: null,
    dialogue: {
      id: 'synthetic-dialogue',
      version: 3,
      step,
      phase,
      prompt,
      options: labels.map((label, i) => ({ id: 'opaque-choice-' + i, label })),
      fields: [],
    },
  };
}

for (const answerable of [false, true]) {
  test(
    'a month confirmation is spoken once without its duplicate UI option; voice=' + answerable,
    async (t) => {
      const f = fixture(t);
      for (const [prompt, option] of [
        ['Девятнадцатого октября?', 'Девятнадцатого октября'],
        ['Двадцатого ноября?', 'двадцатого ноября.'],
        ['Пятого мая 2030 года?', 'Пятого мая 2030 года'],
      ]) {
        const spoken = await f.speak(question('date', 'date', prompt, [option]), answerable);
        assert.equal(spoken, prompt);
        assert.doesNotMatch(spoken, /\?\./u);
      }
    },
  );

  test(
    'a date warning is spoken with the question and without the UI dates; voice=' + answerable,
    async (t) => {
      const f = fixture(t);
      const warning = 'Эта дата уже прошла.';
      const prompt = 'На какой день записать?';
      const reply = question(
        'date',
        'date',
        prompt,
        ['Сегодня · 16 октября', 'Завтра · 17 октября', '18 октября'],
        warning,
      );
      assert.equal(await f.speak(reply, answerable), warning + ' ' + prompt);
    },
  );

  test('an explicit choice between two dates remains audible; voice=' + answerable, async (t) => {
    const f = fixture(t);
    const prompt = 'На сегодня или на следующую среду?';
    const reply = question('date', undefined, prompt, ['На сегодня', 'На следующую среду']);
    assert.equal(await f.speak(reply, answerable), prompt);
  });

  test(
    'concrete client and service questions keep a single required confirmation; voice=' +
      answerable,
    async (t) => {
      const f = fixture(t);
      for (const reply of [
        question('client', 'clientChoice', 'Иванцов, верно?', ['Иванцов · …1001']),
        question('client', undefined, 'Иванцов или Иванченко?', ['Иванцов', 'Иванченко']),
        question('service', 'serviceChoice', 'Пилинг PRX-T33, верно?', ['Пилинг PRX-T33 · 60 мин']),
      ]) {
        assert.equal(await f.speak(reply, answerable), reply.dialogue.prompt);
      }
      assert.equal(
        await f.speak(
          question('client', undefined, 'Нашёл похожего клиента. Это нужный человек?', [
            'Анна Неволина · …1001',
          ]),
          answerable,
        ),
        'Анна Неволина, верно?',
      );
    },
  );

  test(
    'staff and appointment labels already present in a question are not read again; voice=' +
      answerable,
    async (t) => {
      const f = fixture(t);
      for (const reply of [
        question('staff', 'staff', 'Марина Иванова или Алёна Петрова?', [
          'марина иванова',
          'Алена Петрова',
        ]),
        question(
          'appointment',
          'appointmentChoice',
          'Девятнадцатого октября в 10:00 · Консультация?',
          ['Девятнадцатого октября в 10:00 · Консультация'],
        ),
      ]) {
        assert.equal(await f.speak(reply, answerable), reply.dialogue.prompt);
      }
    },
  );

  test(
    'the whole repeated prompt is compared across punctuation while its warning remains; voice=' +
      answerable,
    async (t) => {
      const f = fixture(t);
      const reply = question(
        'date',
        'date',
        'Девятнадцатого октября.',
        ['девятнадцатого октября'],
        'Уточните месяц: девятнадцатого октября?',
      );
      assert.equal(await f.speak(reply, answerable), reply.text);
    },
  );

  test(
    'free periods and one nearest-time offer remain complete and are not enumerated twice; voice=' +
      answerable,
    async (t) => {
      const f = fixture(t);
      for (const reply of [
        question(
          'time',
          'period',
          'В 09:00 занято. Свободно с 07:00 до 09:00, с 11:00 до 18:00. Во сколько?',
          ['с 07:00 до 09:00', 'с 11:00 до 18:00'],
        ),
        question('time', 'closedDay', 'День не открыт. Записать?', ['Да, продолжить']),
        question('time', 'slots', 'Ближайшее свободное время — в 12:30. Подойдёт?', [
          '2030-10-19 · 12:30–13:00 · Марина Иванова',
        ]),
      ]) {
        assert.equal(await f.speak(reply, answerable), reply.text);
      }
    },
  );
}

test('similar names and repeated clock components cannot erase distinct choice context', async (t) => {
  const f = fixture(t);
  const name = await f.speak(
    question('staff', 'staff', 'Иванцов или другой специалист?', ['Иванцович Пётр']),
    true,
  );
  assert.match(name, /Иванцович Пётр/u);
  const reply = question('appointment', 'appointmentChoice', 'Какую запись?', [
    '19 октября в 10:00 · Консультация',
    '20 октября в 10:00 · Консультация',
    '20 октября в 11:00 · Консультация',
  ]);
  const spoken = await f.speak(reply, true);
  for (const option of reply.dialogue.options) assert.ok(spoken.includes(option.label));
  assert.equal(spoken.split('Консультация').length - 1, 3);
  assert.equal(spoken.split('10:00').length - 1, 2);
  assert.equal(spoken.split('Какой подходит?').length - 1, 1);
  assert.doesNotMatch(spoken, /\?\./u);
});

test('a separate useful prompt and the unmentioned choice still follow the warning', async (t) => {
  const f = fixture(t);
  const spoken = await f.speak(
    question(
      'appointment',
      'appointmentChoice',
      'Какую запись?',
      ['19 октября в 10:00 · Консультация'],
      'На эту дату у клиента две записи.',
    ),
    true,
  );
  assert.match(spoken, /^На эту дату у клиента две записи\. Какую запись\? 19 октября/u);
  assert.equal(spoken.split('Какую запись?').length - 1, 1);
});
