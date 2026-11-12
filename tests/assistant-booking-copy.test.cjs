const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function bookingView({ slots = [], availability = {} } = {}) {
  const filename = path.join(
    root,
    'src/server/modules/assistant/dialogue/dialogue-booking-time.cjs',
  );
  const realRequire = createRequire(filename),
    module = { exports: {} },
    reads = [];
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      structuredClone,
      require(name) {
        if (name !== '../actions/availability.cjs') return realRequire(name);
        return {
          findAvailability(c, value) {
            reads.push(structuredClone(value));
            return {
              slots: structuredClone(slots),
              availability: { truncated: false, ...availability },
            };
          },
        };
      },
    },
    { filename },
  );
  return { ...module.exports, reads };
}
const clock = { date: '2099-01-05', hour: 8, minute: 0 };
const draft = () => ({
  patient: { id: 'synthetic-client' },
  staff: { id: 'synthetic-staff' },
  service: { id: 'synthetic-service' },
  serviceChosen: true,
  duration: 30,
  date: clock.date,
});
const context = { current: { role: 'owner' } };
const info = (empty = false) => ({
  status: 'working',
  empty,
  remainingOnly: false,
  workingIntervals: [['09:00', '18:00']],
  freeRanges: empty
    ? [['09:00', '18:00']]
    : [
        ['09:00', '10:00'],
        ['11:00', '18:00'],
      ],
});
const slots = [9, 12, 17].map((hour) => ({
  date: clock.date,
  time: String(hour).padStart(2, '0') + ':00',
  endTime: String(hour).padStart(2, '0') + ':30',
  staffId: 'synthetic-staff',
  staffName: 'Тестовый специалист',
}));

test('booking date copy asks one short question while retaining actual date choices and bounded reads', () => {
  const f = bookingView({ slots }),
    data = draft();
  data.date = null;
  const reply = f.bookingTimeView(context, data, clock, { step: 'date', input: { field: 'date' } });
  assert.equal(reply.prompt, 'На какой день записать?');
  assert.equal(reply.phase, 'date');
  assert.deepEqual(
    Array.from(reply.choices, (row) => row.value),
    slots.map((row) => row.date),
  );
  assert.equal(data.timeSelectionStage, 'date');
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].strategy, 'dates');
  assert.equal(f.reads[0].from, clock.date);
  assert.equal(f.reads[0].limit, 3);
  assert.equal(f.reads[0].duration, 30);
  assert.deepEqual(f.reads[0].staffIds, ['synthetic-staff']);
});

test('free ranges and an empty working day keep precise availability with only one follow-up question', () => {
  for (const empty of [false, true]) {
    const f = bookingView(),
      data = draft(),
      day = info(empty);
    const reply = f.bookingTimeView(context, data, clock, { step: 'time' }, day);
    const expected = empty
      ? 'Весь рабочий день свободен: с 09:00 до 18:00. На какое время?'
      : 'Свободно с 09:00 до 10:00, с 11:00 до 18:00. На какое время?';
    assert.equal(reply.prompt, expected);
    assert.equal(reply.phase, 'period');
    assert.equal(reply.choices.length, day.freeRanges.length);
    assert.ok(reply.choices.every((row) => row.kind === 'freeRange'));
    assert.equal(f.reads.length, 0, 'Copy must use the same verified day summary');
  }
});

test('a confirmed closed day asks only for the missing time without another confirmation or availability claim', () => {
  const f = bookingView(),
    data = draft();
  data.closedDayConfirmation = data.date + '|' + data.staff.id;
  const reply = f.bookingTimeView(context, data, clock, { step: 'time' }, { status: 'closed' });
  assert.equal(reply.prompt, 'Во сколько записать?');
  assert.equal(reply.choices.length, 0);
  assert.equal(data.closedDayConfirmation, data.date + '|' + data.staff.id);
  assert.equal(f.reads.length, 0);
  assert.equal(reply.action, undefined);
});

test('more-time copy distinguishes exhausted recommendations from an actually unavailable period', () => {
  const f = bookingView({ slots, availability: { truncated: true } }),
    data = draft();
  data.timeWindow = { kind: 'any' };
  const current = f.bookingSlotView(context, data, info());
  assert.equal(current.controls.find((row) => row.kind === 'moreSlots').label, 'Ещё время');
  const empty = bookingView(),
    later = draft();
  later.timeWindow = { kind: 'any' };
  later.slotCriteria = JSON.stringify([
    later.date,
    later.staff.id,
    later.service.id,
    later.duration,
    later.timeWindow,
  ]);
  later.shownSlots = slots;
  const exhausted = empty.bookingSlotView(context, later, info());
  assert.equal(exhausted.prompt, 'Назовите другое время или выберите период.');
  assert.equal(exhausted.choices.length, 0);
  assert.ok(exhausted.controls.some((row) => row.kind === 'otherPeriod'));
  assert.ok(exhausted.controls.some((row) => row.kind === 'otherDate'));
  const unavailable = draft();
  unavailable.timeWindow = { kind: 'any' };
  assert.match(empty.bookingSlotView(context, unavailable, info()).prompt, /подходящих окон нет/iu);
});

function speech(t) {
  const state = {
    assistantGeneration: 0,
    assistantScope: {
      limits: { maxAudioSeconds: 30 },
      capabilities: { stt: { ready: true, demo: false }, tts: { ready: true } },
    },
  };
  const seen = { requests: [], captures: 0, opened: 0, sent: [], busy: false, recording: false };
  const ui = {
    valid: () => true,
    session: 1,
    input: () => ({ value: '' }),
    get busy() {
      return seen.busy;
    },
    get recording() {
      return seen.recording;
    },
    activity(busy, recording) {
      seen.busy = busy;
      seen.recording = recording;
    },
    status() {},
    voiceState() {},
    request: async (route, body) => {
      seen.requests.push({ route, body });
      return route.endsWith('/transcribe')
        ? { text: 'Синтетический ответ' }
        : { audioBase64: 'synthetic' };
    },
    sendText: async (text) => seen.sent.push(text),
    openResult: async () => {
      seen.opened++;
    },
  };
  const actions = {
    startAssistantCapture: async (complete) => {
      seen.complete = complete;
      seen.captures++;
      return true;
    },
    stopAssistantCapture() {},
    stopAssistantAudio() {},
    playAssistantAudio: async () => true,
    assistantLocalVoiceReady: async () => true,
    ...vm.runInNewContext(
      source('src/client/modules/assistant-speech-text.js') + '\ncreateAssistantSpeechText',
      {},
    )(),
  };
  const controller = vm
    .runInNewContext(
      source('src/client/modules/assistant-speech.js') + '\ncreateAssistantSpeech',
      {},
    )(state, actions)
    .assistantSpeechController(ui);
  t.after(() => controller.stopVoice());
  return { seen, controller, text: () => seen.requests.map((row) => row.body.text).join(' ') };
}
const dialogueReply = (phase, prompt, options, step = 'time') => ({
  text: prompt,
  dialogue: {
    step,
    phase,
    prompt,
    options,
    controls: [{ id: 'opaque-other-date', label: 'Другая дата' }],
  },
});

test('date speech asks one question and actual-slot speech keeps its options', async (t) => {
  for (const [phase, step, prompt, options] of [
    [
      'date',
      'date',
      'На какой день записать?',
      [
        { id: 'opaque-date-1', label: 'Сегодня · 5 января' },
        { id: 'opaque-date-2', label: 'Завтра · 6 января' },
      ],
    ],
    [
      'slots',
      'time',
      '5 января, утром. Какое время подойдёт?',
      slots.map((row, i) => ({
        id: 'opaque-slot-' + i,
        label: row.date + ' · ' + row.time + '–' + row.endTime + ' · ' + row.staffName,
      })),
    ],
  ]) {
    const f = speech(t),
      reply = dialogueReply(phase, prompt, options, step),
      before = JSON.stringify(reply);
    assert.equal(await f.controller.speakReply(reply, true), true);
    if (step === 'date') assert.equal(f.text(), prompt);
    assert.equal((f.text().match(/\?/gu) || []).length, 1, f.text());
    assert.doesNotMatch(f.text(), /Какой подходит|вариант|Другая дата/iu);
    for (const option of options) assert.equal(JSON.stringify(reply).includes(option.id), true);
    assert.equal(
      JSON.stringify(reply),
      before,
      'Speech cannot alter current choices or dialogue version',
    );
    assert.equal(f.seen.opened, 0);
    assert.equal(f.seen.captures, 0);
    assert.deepEqual(f.seen.sent, []);
  }
});

test('closed-day speech asks the server question once instead of reading its confirmation button', async (t) => {
  const f = speech(t),
    prompt = 'День не открыт. Записать?';
  const reply = dialogueReply('closedDay', prompt, [
    { id: 'opaque-confirm', label: 'Да, продолжить' },
  ]);
  assert.equal(await f.controller.speakReply(reply, true), true);
  assert.equal(f.text(), prompt);
  assert.equal(f.seen.opened, 0);
  assert.equal(f.seen.captures, 0);
});

test('short speech retains the busy warning and the one actual nearest interval', async (t) => {
  const f = speech(t),
    prompt = 'Ближайшее свободное время — 12:00–12:30. Подойдёт?';
  const reply = dialogueReply('slots', prompt, [
    { id: 'opaque-nearest', label: '2099-01-05 · 12:00–12:30 · Тестовый специалист' },
  ]);
  reply.text = 'Это время уже занято. ' + prompt;
  assert.equal(await f.controller.speakReply(reply, true), true);
  assert.equal(f.text(), reply.text);
  assert.equal((f.text().match(/12:00/gu) || []).length, 1);
  assert.equal(f.seen.opened, 0);
});

test('a short voice question still waits for the answer and never opens or saves a form', async (t) => {
  const f = speech(t);
  assert.equal(await f.controller.startVoice(), true);
  const captures = f.seen.captures;
  await f.seen.complete('synthetic-wav', { autoStopped: true, seconds: 2, stopReason: 'silence' });
  const sentBeforeReply = [...f.seen.sent];
  await f.controller.afterReply(
    dialogueReply('closedDay', 'День не открыт. Продолжить?', [
      { id: 'opaque-confirm', label: 'Да, продолжить' },
    ]),
  );
  assert.equal(f.seen.captures, captures + 1);
  assert.equal(f.seen.opened, 0);
  assert.deepEqual(f.seen.sent, sentBeforeReply);
  assert.deepEqual(sentBeforeReply, ['Синтетический ответ']);
  assert.ok(
    f.seen.requests.every((row) =>
      ['/api/assistant/speak', '/api/assistant/transcribe'].includes(row.route),
    ),
  );
});

test('a client prompt suggests a name rather than a numbered time choice and retains opaque options', () => {
  const dom = new JSDOM('<div id="panel"></div>'),
    document = dom.window.document;
  const factory = vm.runInNewContext(
    source('src/client/modules/assistant-conversation.js') + '\ncreateAssistantConversation',
    { document },
  );
  const actions = factory(),
    panel = document.querySelector('#panel');
  panel.innerHTML = actions.assistantPanelHtml();
  actions.renderAssistantConversation(
    panel,
    {
      dialogue: {
        step: 'client',
        prompt: 'Кого записать?',
        input: { field: 'client' },
        options: [{ id: 'opaque-client', label: 'Синтетический клиент' }],
      },
    },
    { voice: true },
  );
  const input = panel.querySelector('[data-assistant-input]');
  assert.equal(input.placeholder, 'Имя или фамилия клиента');
  assert.equal(
    panel.querySelector('[data-assistant-choice]').dataset.assistantChoice,
    'opaque-client',
  );
  dom.window.close();
});

test('a service confirmation is spoken once as its short catalog question', async (t) => {
  const f = speech(t),
    prompt = '«Миндальный пилинг» или «Молочный пилинг»?';
  const reply = dialogueReply(
    'serviceChoice',
    prompt,
    [
      { id: 'opaque-almond', label: 'Миндальный пилинг · 30 мин' },
      { id: 'opaque-milk', label: 'Молочный пилинг · 45 мин' },
    ],
    'service',
  );
  assert.equal(await f.controller.speakReply(reply, true), true);
  assert.equal(f.text(), prompt);
  assert.equal(f.seen.captures, 0);
});

test('short closed-day prompts preserve role permissions and date-staff confirmation binding', () => {
  const f = bookingView(),
    closed = { status: 'closed' };
  for (const role of ['owner', 'salon_admin']) {
    const c = { current: { role } },
      data = draft();
    const reply = f.closedDayView(c, data, closed);
    assert.equal(reply.prompt, 'День не открыт. Записать?');
    assert.equal(reply.phase, 'closedDay');
    assert.equal(reply.choices.length, 1);
    assert.equal(reply.choices[0].kind, 'closedDayContinue');
    assert.equal(reply.choices[0].value, data.date + '|' + data.staff.id);
    assert.equal(data.closedDayConfirmation, undefined, 'asking must not imply consent');
    data.closedDayConfirmation = reply.choices[0].value;
    assert.equal(f.allowsClosedDay(c, data), true);
    assert.equal(f.closedDayView(c, data, closed), null, 'one confirmation is sufficient');
    const anotherDate = { ...data, date: '2099-01-06' };
    const anotherStaff = { ...data, staff: { id: 'different-synthetic-staff' } };
    for (const changed of [anotherDate, anotherStaff]) {
      assert.equal(f.allowsClosedDay(c, changed), false);
      assert.equal(f.closedDayView(c, changed, closed).prompt, 'День не открыт. Записать?');
    }
  }
  const c = { current: { role: 'cosmetologist' } },
    data = draft();
  data.closedDayConfirmation = data.date + '|' + data.staff.id;
  const reply = f.closedDayView(c, data, closed);
  assert.equal(reply.prompt, 'День не открыт. Выберите другую дату.');
  assert.equal(reply.choices.length, 0);
  assert.equal(f.allowsClosedDay(c, data), false);
  assert.equal(reply.controls[0].kind, 'otherDate');
});
