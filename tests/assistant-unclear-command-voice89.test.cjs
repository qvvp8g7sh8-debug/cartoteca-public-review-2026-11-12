const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, reply, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');

const unclear = (extra = {}) => ({
  policyVersion: 1,
  intent: 'help',
  text: 'Что нужно сделать?',
  action: null,
  dialogue: null,
  ...extra,
});
const speaks = (f) => f.calls.filter((row) => row.route.endsWith('/speak'));
async function hear(f, text) {
  const pending = f.transcript(text);
  await flush();
  await f.finishSpeech();
  await pending;
  await flush();
}

test('an unclear initial command asks once and listens for a full new command with no previous draft identity', async (t) => {
  const f = fixture(t);
  f.control.turn = async (body) => (f.turns().length === 1 ? unclear() : reply(1));
  await f.hold();
  await hear(f, 'Проект Арту Дарьи Мороз');
  assert.equal(f.captures.length, 2);
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  assert.equal(f.$('.voice-assistant-session').dataset.assistantPhase, 'listening');
  const options = f.captures.at(-1).options;
  assert.equal(options.shortAnswer, false);
  assert.equal(options.shortSilence, false);
  assert.equal(options.initialCommand, true);
  assert.equal(options.startCue, false);
  assert.equal(f.turns().length, 1, 'listening starts no automatic model request');
  await hear(f, 'Открой карту Дед Мороз');
  assert.equal(f.turns().length, 2);
  assert.equal(f.turns()[1].body.text, 'Открой карту Дед Мороз');
  assert.equal(f.turns()[1].body.dialogueId, undefined);
  assert.equal(f.turns()[1].body.dialogueVersion, undefined);
  assert.equal(f.opened.length, 0);
});

test('two unclear questions remain answerable, the third pauses without repeating the question or polling', async (t) => {
  const f = fixture(t);
  f.control.turn = async () => unclear();
  await f.hold();
  await hear(f, 'Первая неясная реплика');
  await hear(f, 'Вторая неясная реплика');
  assert.equal(f.captures.length, 3);
  assert.deepEqual(
    speaks(f).map((row) => row.body.text),
    ['Что нужно сделать?', 'Что нужно сделать?'],
  );
  await f.transcript('Третья неясная реплика');
  await flush();
  assert.equal(f.captures.length, 3);
  assert.equal(
    speaks(f).length,
    2,
    'a final unanswered question must not precede a stopped microphone',
  );
  assert.equal(f.$('.voice-assistant-session').dataset.assistantPhase, 'idle');
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  assert.equal(
    f.$('[data-assistant-session-message]').textContent,
    'Не получилось разобрать команду. Начните заново.',
  );
  const requests = f.calls.length;
  await flush();
  await flush();
  assert.equal(f.calls.length, requests);
  f.$('[data-assistant-session-resume]').click();
  await flush();
  assert.equal(f.captures.length, 4, 'an explicit resume starts a new command attempt');
  assert.equal(f.turns().length, 3);
});

for (const result of [
  unclear({ text: 'Эта команда не поддерживается.' }),
  unclear({ intent: undefined }),
  unclear({ intent: 'calendar' }),
  unclear({
    readOnlySlots: [
      {
        date: '2099-01-05',
        time: '10:00',
        endTime: '11:00',
        duration: 60,
        staffName: 'Синтетический',
      },
    ],
  }),
])
  test(
    'ordinary terminal/read-only responses keep their stop boundary: ' +
      String(result.intent) +
      ' ' +
      result.text,
    async (t) => {
      const f = fixture(t);
      f.control.turn = async () => result;
      await f.hold();
      await hear(f, 'Синтетическая команда');
      assert.equal(f.captures.length, 1);
      assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
      assert.equal(f.opened.length, 0);
    },
  );

test('the same generic help after a real field dialogue still terminates instead of starting another draft', async (t) => {
  const f = fixture(t);
  f.control.turn = async () => (f.turns().length === 1 ? reply(1) : unclear());
  await f.hold();
  await hear(f, 'Запиши синтетического клиента');
  assert.equal(f.captures.length, 2);
  await hear(f, 'Неподходящий ответ внутри услуги');
  assert.equal(f.captures.length, 2);
  assert.equal(f.turns()[1].body.dialogueId, 'synthetic-dialogue');
  assert.equal(f.opened.length, 0);
});

for (const boundary of ['close', 'generation', 'hidden'])
  test('an unclear question cannot restart capture after ' + boundary, async (t) => {
    const f = fixture(t);
    f.control.turn = async () => unclear();
    await f.hold();
    const pending = f.transcript('Синтетическая неясная реплика');
    await flush();
    if (boundary === 'close') f.$('[data-assistant-session-stop]').click();
    if (boundary === 'generation') f.state.assistantGeneration++;
    if (boundary === 'hidden') {
      Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true });
      f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
    }
    if (boundary !== 'close') await f.finishSpeech();
    await pending;
    await flush();
    assert.equal(f.captures.length, 1);
    assert.equal(f.turns().length, 1);
  });

test('an unclear-command audio failure stops without automatic capture or a business action', async (t) => {
  const f = fixture(t);
  f.control.turn = async () => unclear();
  f.control.speak = async () => {
    throw Error('Synthetic TTS failure');
  };
  await f.hold();
  await f.transcript('Синтетическая неясная реплика');
  await flush();
  assert.equal(f.captures.length, 1);
  assert.equal(f.opened.length, 0);
  assert.match(f.$('[data-assistant-session-message]').textContent, /Synthetic TTS failure/u);
});
