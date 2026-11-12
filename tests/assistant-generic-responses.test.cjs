const test = require('node:test'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto'),
  { EventEmitter } = require('node:events');
const {
  servicePickerView,
} = require('../src/server/modules/assistant/dialogue/dialogue-service-picker.cjs');
const { spokenReply } = require('../src/server/modules/assistant/speech/spoken-reply.cjs');
const {
  createSpeechPermits,
} = require('../src/server/modules/assistant/speech/speech-permits.cjs');
const {
  createSpeechCache,
  GENERIC_QUESTIONS,
} = require('../src/server/modules/assistant/speech/speech-cache.cjs');
const { createPaidBookingFixture } = require('./helpers/assistant-paid-booking-fixture.cjs');
function view(title, query = '') {
  const row = { id: 'synthetic-service', name: title, duration: 30, staffId: 'staff' };
  return servicePickerView(
    {},
    { staff: { id: 'staff' } },
    { services: [row] },
    {
      services: [row],
      query,
      pool: [row],
      stamp: 'synthetic',
      grouped: false,
      categoryId: '',
      categories: false,
      rows: [row],
      offset: 0,
    },
  );
}
function reply(v) {
  return {
    text: v.prompt,
    policyVersion: 7,
    dialogue: {
      ...v,
      options: v.choices.map((row) => ({ id: 'synthetic-choice', label: row.label })),
    },
  };
}
function media(c, url) {
  const req = new EventEmitter(),
    res = new EventEmitter();
  req.complete = true;
  Object.assign(res, {
    headersSent: false,
    destroyed: false,
    bytes: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(b) {
      this.bytes += b.length;
      return true;
    },
    end() {
      this.writableEnded = this.writableFinished = true;
    },
  });
  return { ...c, req, res, url: new URL(url, 'https://synthetic.invalid') };
}
test('authoritative generic service branch uses catalog-independent spoken question without changing visible options', () => {
  for (const title of ['Орбиталь Кварц', 'Соколова', 'Массаж', 'Не отменять']) {
    const v = view(title);
    assert.equal(v.prompt, 'Выберите услугу.');
    assert.equal(v.speechQuestion, 'service.ask');
    assert.equal(v.choices[0].label, title + ' · 30 мин');
    assert.equal(spokenReply(reply(v)), 'Какую услугу?');
  }
  const confirmation = view('Орбиталь Кварц', 'Орби');
  assert.equal(confirmation.speechQuestion, undefined);
  assert.equal(spokenReply(reply(confirmation)), 'Орбиталь Кварц, верно?');
});
test('stale or unproven generic keys do not replace information, manual recovery, details or identity confirmation', () => {
  const ordinary = reply(view('Орбиталь Кварц'));
  for (const change of [
    { information: true },
    { manualInputRequired: true },
    { phase: 'cancelConfirmation' },
    { step: 'client' },
    { prompt: 'Орбиталь Кварц, верно?' },
    { input: { type: 'text', field: 'client' } },
    { speechQuestion: '__proto__' },
  ]) {
    const r = { ...ordinary, dialogue: { ...ordinary.dialogue, ...change } };
    assert.notEqual(spokenReply(r), 'Какую услугу?');
  }
  const detail = { ...ordinary, text: 'Важное уточнение. ' + ordinary.text };
  assert.equal(spokenReply(detail), ordinary.dialogue.prompt);
  const legacy = { ...ordinary, dialogue: { ...ordinary.dialogue, speechQuestion: undefined } };
  assert.equal(spokenReply(legacy), 'Выберите услугу.');
});
test('canonical speech is selected before exact permit and only finite generic responses are cacheable', () => {
  assert.equal(GENERIC_QUESTIONS.length, 20);
  const c = { current: { accountId: 'a', organizationId: 'o', sessionId: 's', role: 'owner' } },
    ticket = { id: 'task', grantId: 'grant', attempt: 1 },
    permits = createSpeechPermits();
  const r = reply(view('Орбиталь Кварц')),
    p = permits.issue(c, ticket, r, 600);
  assert.equal(p.answerableText, 'Какую услугу?');
  permits.requirePermit(c, ticket, {
    speechToken: p.token,
    policyVersion: 7,
    text: 'Какую услугу?',
  });
  assert.throws(
    () =>
      permits.requirePermit(c, ticket, {
        speechToken: p.token,
        policyVersion: 7,
        text: 'Выберите услугу.',
      }),
    { status: 403 },
  );
  const state = {
    revision: 7,
    providers: { tts: { provider: 'timeweb', model: 'synthetic', voice: 'alloy' } },
    credentials: { timeweb: 'synthetic' },
    policy: { limits: {} },
    rates: {},
  };
  const cache = createSpeechCache();
  for (const text of [
    'На какой день записать?',
    'Выберите категорию или услугу.',
    'Назовите точное название услуги.',
  ]) {
    const a = cache.claim(state, 'o', text);
    assert.ok(a?.owner);
    a.finish(Buffer.from([1, 2]));
    assert.equal(cache.claim(state, 'o', text).owner, false);
  }
  for (const text of [
    'Орбиталь Кварц, верно?',
    'Клиент не найден. Уточните имя или телефон. Орбиталь',
    'Назовите точное название услуги. Дополнение.',
  ])
    assert.equal(cache.claim(state, 'o', text), null);
});
test('actual paid generic selection reuses TTS across arbitrary catalogs while warm audio still requires fresh scope', async (t) => {
  const f = await createPaidBookingFixture();
  t.after(() => f.close());
  let last;
  for (const title of ['Орбиталь Кварц', 'Соколова']) {
    f.synthetic.services[0].name = title;
    f.synthetic.changed();
    const r = await f.api.turn(f.context, {
      text: 'Запиши Диану Неволину',
      policyVersion: f.scope.policyVersion,
      taskRequestId: randomUUID(),
    });
    assert.equal(r.dialogue.prompt, 'Выберите услугу.');
    assert.equal(r.speechPermit.answerableText, 'Какую услугу?');
    last = {
      text: r.speechPermit.answerableText,
      policyVersion: r.policyVersion,
      taskRequestId: r.taskRequestId,
      speechToken: r.speechPermit.token,
      format: 'pcm',
      stream: true,
    };
    const ticket = await f.api.speak(f.context, last),
      c = media(f.context, ticket.streamUrl);
    await f.api.speakAudio(c);
    assert.equal(c.res.bytes, 4800);
  }
  assert.equal(f.pcmCalls(), 1);
  assert.equal(f.api.runtimeStats().turns.model, 0);
  assert.equal(f.packages.status(f.context.current.organizationId).usedTasks, 2);
  await assert.rejects(f.api.speak(f.context, { ...last, text: 'Посторонний текст.' }), {
    status: 403,
    code: 'ASSISTANT_SPEECH_PROOF_REQUIRED',
  });
  const pending = await f.api.speak(f.context, last),
    settings = f.api.admin.view(f.fixture.actor);
  f.api.admin.settings(f.fixture.actor, {
    expectedRevision: settings.revision,
    requestId: randomUUID(),
    reason: 'Synthetic fresh cache guard',
    policy: { mode: 'off' },
  });
  await assert.rejects(f.api.speakAudio(media(f.context, pending.streamUrl)), { status: 403 });
  assert.equal(f.pcmCalls(), 1);
});
test('category and unknown-service questions are selected by their authoritative branches, never approximate names', () => {
  const group = { id: 'synthetic-group', title: 'Орбита' },
    row = { id: 'synthetic-service', name: 'Кварцевый контур', duration: 30, staffId: 'staff' };
  const base = {
    services: [row],
    query: '',
    pool: [row],
    stamp: 'synthetic',
    grouped: true,
    categoryId: '',
    categories: true,
    rows: [group],
    offset: 0,
  };
  const category = servicePickerView({}, { staff: { id: 'staff' } }, { services: [row] }, base);
  assert.equal(category.speechQuestion, 'service.category');
  assert.equal(spokenReply(reply(category)), 'Выберите категорию или услугу.');
  const missing = servicePickerView(
    {},
    { staff: { id: 'staff' } },
    { services: [row] },
    { ...base, query: 'яяяяяяяя', pool: [], rows: [], categories: false },
  );
  assert.equal(missing.speechQuestion, 'service.exact');
  assert.equal(missing.choices.length, 0);
  assert.equal(spokenReply(reply(missing)), 'Назовите точное название услуги.');
  const stale = {
    ...reply(category),
    dialogue: {
      ...reply(category).dialogue,
      manualInputRequired: true,
      prompt: 'Не удалось уточнить услугу. Проверьте название.',
    },
    text: 'Не удалось уточнить услугу. Проверьте название.',
  };
  assert.equal(spokenReply(stale), stale.text);
});
