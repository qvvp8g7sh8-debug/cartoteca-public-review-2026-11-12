const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fixture,
  reply,
  deferred,
  flush,
} = require('./helpers/assistant-voice-booking-fixture.cjs');

test('hold600ms starts voice without another click and the full numbered-choice dialogue opens an unsaved ordinary form', async (t) => {
  const f = fixture(t);
  await f.hold();
  assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0].options.silenceStop, true);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.match(f.$('[data-assistant-status]').textContent, /Слушаю/);
  const first = f.transcript('Запиши Анну Синтетическую завтра');
  await flush();
  assert.equal(f.turns().length, 1);
  assert.equal(f.turns()[0].body.text, 'Запиши Анну Синтетическую завтра');
  assert.equal(f.captures.length, 1, 'microphone must wait until the question has finished');
  assert.equal(
    f.$('[data-assistant-input-wrap]').hidden,
    false,
    'opaque choices retain the optional text fallback for answers and corrections',
  );
  assert.equal(f.$('[data-assistant-input]').value, '');
  assert.equal(f.$('[data-assistant-prompt]').textContent, 'Ответ или исправление');
  assert.match(f.calls.find((call) => call.route.endsWith('/speak')).body.text, /Назовите услугу/);
  await f.finishSpeech();
  await first;
  assert.equal(f.captures.length, 2);
  f.control.turn = async () => reply(2, 'review');
  const second = f.transcript('Первый вариант');
  await flush();
  assert.equal(f.turns()[1].body.dialogueId, 'synthetic-dialogue');
  assert.equal(f.turns()[1].body.dialogueVersion, 1);
  assert.equal(f.turns()[1].body.text, 'Первый вариант');
  assert.equal(
    Object.hasOwn(f.turns()[1].body, 'choice'),
    false,
    'the server resolves spoken choices',
  );
  await f.finishSpeech();
  await second;
  assert.equal(f.captures.length, 3);
  f.control.turn = async () => ({
    text: 'Открываю форму для проверки',
    policyVersion: 1,
    demo: false,
    dialogue: null,
    action: {
      type: 'prepareAppointment',
      patientId: 'synthetic-patient',
      staffId: 'staff',
      serviceIds: ['synthetic-service'],
      date: '2030-01-02',
      time: '15:30',
      duration: 30,
      roomId: 'main',
    },
  });
  const final = f.transcript('Открой форму');
  await flush();
  assert.equal(f.opened.length, 1, 'the unsaved form opens before its completion speech');
  await f.finishSpeech();
  await final;
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].origin, 'assistant');
  assert.equal(f.opened[0].draft.patientId, 'synthetic-patient');
  assert.equal(f.opened[0].draft.date, '2030-01-02');
  assert.equal(f.opened[0].draft.time, '15:30');
  assert.equal(f.state.editorMode.id, null);
  assert.equal(f.$('.voice-assistant-draft-hint').textContent, 'Проверьте данные и сохраните запись.');
  assert.equal(f.calls.filter((call) => !call.route.startsWith('/api/assistant/')).length, 0);
});
test('visible voice Stop closes the session, fences late STT and leaves an explicit manual fallback usable', async (t) => {
  const f = fixture(t);
  await f.hold();
  const pending = deferred();
  f.control.stt = () => pending.promise;
  const transcription = f.captures[0].complete('synthetic');
  await flush();
  assert.equal(f.$('.voice-assistant-session').hidden, false);
  f.$('[data-assistant-session-stop]').click();
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
  assert.equal(f.$('.voice-assistant-session').hidden, true);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  pending.resolve({ text: 'Поздняя команда', policyVersion: 1 });
  await transcription;
  await flush();
  assert.equal(f.turns().length, 0);
  assert.equal(f.played.length, 0);
  assert.equal(f.$('[data-assistant-text]').value, '');
  await f.keyboard();
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-send]').disabled, false);
});
test('a lost first voice reply opens the retained command for review on explicit resume', async (t) => {
  const f = fixture(t);
  await f.hold();
  const text = 'Запиши Анну Синтетическую';
  f.control.turn = async () => {
    throw Object.assign(new Error('Synthetic timeout'), {
      outcomeUnknown: true,
      assistantFailure: 'deadline',
    });
  };
  await f.transcript(text);
  assert.equal(f.turns().length, 1);
  assert.match(f.$('[data-assistant-session-message]').textContent, /Истекло время ожидания/);
  f.$('[data-assistant-session-resume]').click();
  await flush();
  assert.equal(f.$('.voice-assistant-dialog').open, true);
  assert.equal(f.$('[data-assistant-text]').value, text);
  assert.equal(f.$('[data-assistant-send]').disabled, false);
  assert.equal(f.turns().length, 1);
});
test('prepared availability uses one browser request and a transcript-only reply still sends a turn', async (t) => {
  for (const combined of [true, false]) {
    const f = fixture(t);
    f.scope.capabilities.stt.availabilityTurn = true;
    await f.hold();
    const prepared = {
      intent: 'availability',
      text: 'Есть свободное время.',
      policyVersion: 1,
      demo: false,
      action: null,
    };
    f.control.stt = async () => ({
      text: 'Найди свободные окна завтра на полчаса',
      policyVersion: 1,
      ...(combined ? { availabilityReply: prepared } : {}),
    });
    f.control.turn = async () => prepared;
    const pending = f.captures[0].complete('synthetic-wav');
    await flush();
    const inputRequests = f.calls.filter(({ route }) =>
      ['/api/assistant/transcribe', '/api/assistant/turn'].includes(route),
    );
    assert.equal(inputRequests[0].body.availabilityTurn, 'plain');
    assert.equal(inputRequests.length, combined ? 1 : 2);
    assert.equal(f.opened.length, 0);
    assert.equal(f.$('[data-assistant-answer]').textContent, prepared.text);
    if (f.played.length) await f.finishSpeech();
    await pending;
  }
});
test('closing the panel aborts pending STT and pending TTS and neither late result rearms recording', async (t) => {
  for (const phase of ['stt', 'tts']) {
    const f = fixture(t);
    await f.hold();
    const gate = deferred();
    if (phase === 'stt') f.control.stt = () => gate.promise;
    else f.control.speak = () => gate.promise;
    const pending = f.captures[0].complete('synthetic');
    await flush();
    const request = f.calls.findLast((call) =>
      call.route.endsWith(phase === 'stt' ? '/transcribe' : '/speak'),
    );
    assert.ok(request);
    f.$('[data-assistant-close]').click();
    assert.equal(request.options.signal.aborted, true);
    gate.resolve(
      phase === 'stt'
        ? { text: 'Поздняя команда', policyVersion: 1 }
        : { audioBase64: 'late-audio', policyVersion: 1 },
    );
    await pending;
    await flush();
    assert.equal(f.captures.length, 1);
    assert.equal(f.played.length, 0);
    assert.equal(f.opened.length, 0);
    assert.equal(f.turns().length, phase === 'stt' ? 0 : 1);
  }
});
test('revoked session and late microphone permission cannot create a new command', async (t) => {
  const f = fixture(t),
    permission = deferred();
  f.control.permission = () => permission.promise;
  await f.hold();
  assert.equal(f.captures.length, 1);
  f.state.assistantGeneration++;
  f.state.account = { id: 'other', organizationId: 'other-org' };
  f.api.destroyVoiceAssistant();
  permission.resolve(true);
  await flush();
  await f.captures[0].complete('late-synthetic');
  await flush();
  assert.equal(f.turns().length, 0);
  assert.equal(f.calls.filter((call) => call.route.endsWith('/transcribe')).length, 0);
  assert.equal(f.$('.voice-assistant-dialog'), null);
  assert.ok(f.stops.includes(true));
});
test('audio failure preserves chosen fields and enables manual continuation without clearing the appointment', async (t) => {
  const f = fixture(t);
  await f.hold();
  const pending = f.transcript('Запиши Анну');
  await flush();
  assert.match(f.$('[data-assistant-conversation]').textContent, /Анна Синтетическая/);
  f.played[0].gate.reject(Error('Синтетический сбой воспроизведения'));
  await pending;
  await flush();
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
  assert.match(f.$('[data-assistant-conversation]').textContent, /Анна Синтетическая/);
  assert.match(f.$('[data-assistant-status]').textContent, /сбой воспроизведения/);
  assert.equal(f.$('[data-assistant-choice]').disabled, false);
  assert.equal(f.captures.length, 1);
  assert.equal(f.opened.length, 0);
});
test('keyboard opening stays text-friendly and one-shot mic still requires review; unavailable voice never loops', async (t) => {
  const f = fixture(t);
  await f.keyboard();
  assert.equal(f.captures.length, 0);
  f.$('[data-assistant-mic]').click();
  await flush();
  assert.equal(f.captures[0].options.silenceStop, false);
  await f.transcript('Покажи расписание');
  await flush();
  assert.equal(f.turns().length, 0);
  assert.equal(f.$('[data-assistant-text]').value, 'Покажи расписание');
  assert.match(f.$('[data-assistant-status]').textContent, /Проверьте/);
  for (const capabilities of [
    { stt: { ready: false, demo: false }, tts: { ready: true } },
    { stt: { ready: true, demo: true }, tts: { ready: true } },
    { stt: { ready: true, demo: false }, tts: { ready: false } },
  ]) {
    const unavailable = fixture(t, { scope: { capabilities } });
    await unavailable.hold();
    assert.equal(unavailable.captures.length, 0);
    assert.equal(unavailable.turns().length, 0);
    assert.equal(unavailable.$('.voice-assistant-dialog').open, false);
    assert.equal(unavailable.$('.voice-assistant-session').hidden, false);
    assert.equal(unavailable.$('.voice-assistant-session').dataset.assistantPhase, 'idle');
    assert.equal(unavailable.$('[data-assistant-session-resume]').hidden, false);
    assert.ok(unavailable.$('[data-assistant-status]').textContent.length > 0);
    unavailable.$('[data-assistant-session-resume]').click();
    await flush();
    assert.equal(unavailable.captures.length, 0, 'Unavailable voice does not start a retry capture loop');
    assert.equal(unavailable.turns().length, 0);
    await unavailable.keyboard();
    assert.equal(unavailable.$('.voice-assistant-dialog').open, true);
    assert.equal(unavailable.$('.voice-assistant-session').hidden, true);
    assert.equal(unavailable.$('[data-assistant-send]').disabled, false);
  }
});

test('semantic400 speaks a clarification and accepts a corrected answer in the same dialogue version without restart', async (t) => {
  const f = fixture(t);
  const initial = reply(7, 'time', { type: 'time', field: 'time' });
  initial.dialogue.prompt = 'Назовите точное время';
  initial.dialogue.options = [];
  const clarification = 'Укажите время в формате ЧЧ:ММ, например 14:30.';
  f.control.turn = async (body) => {
    if (!body.dialogueId) return initial;
    if (body.text === 'в три') throw Object.assign(Error(clarification), { status: 400 });
    assert.equal(body.text, '15:30');
    return reply(8, 'review');
  };
  await f.hold();
  const start = f.transcript('Запиши Анну завтра');
  await flush();
  await f.finishSpeech();
  await start;
  assert.equal(f.captures.length, 2);
  const ambiguous = f.transcript('в три');
  await flush();
  assert.equal(f.turns().length, 2);
  assert.equal(f.turns()[1].body.dialogueId, 'synthetic-dialogue');
  assert.equal(f.turns()[1].body.dialogueVersion, 7);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.match(f.$('[data-assistant-conversation]').textContent, /Анна Синтетическая/);
  assert.match(f.$('[data-assistant-conversation]').textContent, /2030-01-02/);
  assert.equal(f.played.length, 2);
  assert.equal(f.played[1].result.text, clarification);
  assert.equal(f.captures.length, 2, 'clarification must finish before listening resumes');
  await f.finishSpeech();
  await ambiguous;
  assert.equal(f.captures.length, 3);
  const corrected = f.transcript('15:30');
  await flush();
  const body = f.turns()[2].body;
  assert.equal(body.text, '15:30');
  assert.equal(body.dialogueId, 'synthetic-dialogue');
  assert.equal(body.dialogueVersion, 7, 'HTTP400 does not invent a new server dialogue version');
  assert.equal(Object.hasOwn(body, 'choice'), false);
  assert.equal(
    f.calls.filter((call) => call.route === '/api/assistant/scope').length,
    1,
    'semantic clarification must not restart the panel or reload its scope',
  );
  assert.equal(f.opened.length, 0);
  await f.finishSpeech();
  await corrected;
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.captures.length, 4);
});

test('the actual assistant panel passes its current dialogue metadata to local STT on the next voice answer', async (t) => {
  const f = fixture(t, {
    scope: {
      capabilities: {
        stt: { ready: true, demo: false, local: true },
        tts: { ready: true, demo: false },
      },
    },
  });
  await f.hold();
  const first = f.transcript('Запиши Анну Синтетическую');
  await flush();
  await f.finishSpeech();
  await first;
  assert.equal(f.captures.at(-1).options.shortAnswer, true);
  f.control.turn = async () => reply(2, 'review');
  const second = f.transcript('Чистка');
  await flush();
  const transcriptions = f.calls.filter((call) => call.route.endsWith('/transcribe'));
  assert.equal(transcriptions[0].body.dialogueId, undefined);
  assert.equal(transcriptions[1].body.dialogueId, 'synthetic-dialogue');
  assert.equal(transcriptions[1].body.dialogueVersion, 1);
  assert.equal(transcriptions[1].body.step, undefined);
  assert.equal(transcriptions[1].body.optionCount, undefined);
  await f.finishSpeech();
  await second;
  assert.equal(f.opened.length, 0);
});

function trustedReadyReply() {
  return {
    intent: 'prepareAppointment',
    text: 'Данные для формы готовы',
    policyVersion: 1,
    demo: false,
    dialogue: null,
    action: {
      type: 'prepareAppointment',
      patientId: 'synthetic-patient',
      staffId: 'staff',
      serviceIds: ['synthetic-service'],
      date: '2030-01-02',
      time: '15:30',
      duration: 45,
      roomId: 'main',
    },
  };
}
async function submitTypedBooking(f, text) {
  f.$(
    f.$('[data-assistant-input-wrap]').hidden ? '[data-assistant-text]' : '[data-assistant-input]',
  ).value = text;
  f.$('.voice-assistant-form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
}
function assertManualBooking(f) {
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].origin, 'assistant');
  assert.equal(f.opened[0].draft.patientId, 'synthetic-patient');
  assert.equal(f.opened[0].draft.date, '2030-01-02');
  assert.equal(f.opened[0].draft.time, '15:30');
  assert.equal(f.opened[0].draft.duration, 45);
  assert.equal(f.state.editorMode.id, null);
  assert.equal(f.state.editorMode.source, 'assistant');
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.$('.voice-assistant-draft-hint').textContent, 'Проверьте данные и сохраните запись.');
  assert.ok(f.calls.every((call) => call.route.startsWith('/api/assistant/')));
}

test('a server-approved complete initial typed booking opens its ordinary unsaved form immediately', async (t) => {
  const f = fixture(t);
  f.control.turn = async () => trustedReadyReply();
  await f.keyboard();
  await submitTypedBooking(
    f,
    'Запиши Анну Синтетическую на Чистку второго января в 15:30 на 45 минут',
  );
  assert.equal(f.turns().length, 1);
  assert.equal(f.turns()[0].body.dialogueId, undefined);
  assert.equal(f.captures.length, 0);
  assert.equal(f.played.length, 0);
  assertManualBooking(f);
});

test('the final typed field or opaque slot choice opens a server-approved booking without a separate review click', async (t) => {
  for (const step of ['service', 'availability']) {
    const f = fixture(t);
    let turns = 0;
    f.control.turn = async () => (++turns === 1 ? reply(5, step) : trustedReadyReply());
    await f.keyboard();
    await submitTypedBooking(f, 'Подготовь запись Анны');
    assert.equal(f.opened.length, 0);
    if (step === 'service') await submitTypedBooking(f, 'Чистка');
    else {
      f.$('[data-assistant-choice]').click();
      await flush();
    }
    const finalBody = f.turns()[1].body;
    assert.equal(finalBody.dialogueId, 'synthetic-dialogue');
    assert.equal(finalBody.dialogueVersion, 5);
    if (step === 'service') assert.equal(finalBody.text, 'Чистка');
    else assert.equal(finalBody.choice, 'opaque-option-5');
    assert.equal(f.turns().length, 2);
    assertManualBooking(f);
  }
});

test('initial typed readonly outcomes and an untrusted prepared action retain their explicit action boundary', async (t) => {
  for (const mode of ['missing-intent', 'readonly-intent', 'readonly-action']) {
    const f = fixture(t);
    const ready = trustedReadyReply();
    if (mode === 'missing-intent') delete ready.intent;
    else if (mode === 'readonly-intent') ready.intent = 'showCalendar';
    else ready.action = { type: 'calendar', date: '2030-01-02' };
    f.control.turn = async () => ready;
    await f.keyboard();
    await submitTypedBooking(f, 'Покажи расписание');
    assert.equal(f.opened.length, 0);
    assert.equal(f.$('.voice-assistant-dialog').open, true);
    assert.equal(f.$('[data-assistant-action]').hidden, false);
    assert.equal(f.turns().length, 1);
  }
});

test('an unknown final typed field retries the identical body and opens the unsaved form only once', async (t) => {
  const f = fixture(t);
  let turns = 0;
  f.control.turn = async () => {
    if (++turns === 1) return reply(5, 'service');
    if (turns === 2)
      throw Object.assign(Error('Synthetic lost typed response'), { outcomeUnknown: true });
    return trustedReadyReply();
  };
  await f.keyboard();
  await submitTypedBooking(f, 'Подготовь запись Анны');
  await submitTypedBooking(f, 'Чистка');
  assert.equal(f.opened.length, 0);
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  f.$('[data-assistant-retry]').click();
  f.$('[data-assistant-retry]').click();
  await flush();
  const sent = f.turns();
  assert.equal(sent.length, 3);
  assert.equal(sent[1].options.body, sent[2].options.body);
  assertManualBooking(f);
});

test('switching a pending or unknown final voice field to manual keeps its origin and requires an explicit handoff', async (t) => {
  for (const outcome of ['pending', 'unknown']) {
    const f = fixture(t);
    const gate = deferred();
    let turns = 0;
    f.control.turn = async () => {
      if (++turns === 1) return reply(5, 'service');
      if (turns === 2) {
        if (outcome === 'pending') return gate.promise;
        throw Object.assign(Error('Synthetic lost voice response'), { outcomeUnknown: true });
      }
      return trustedReadyReply();
    };
    await f.hold();
    const initial = f.transcript('Запиши Анну Синтетическую');
    await flush();
    await f.finishSpeech();
    await initial;
    const final = f.transcript('Чистка');
    await flush();
    if (outcome === 'pending') {
      await f.keyboard();
      gate.resolve(trustedReadyReply());
    }
    await final;
    await flush();
    if (outcome === 'unknown') {
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(f.$('.voice-assistant-session').hidden, false);
      assert.equal(f.$('[data-assistant-session-resume]').textContent, 'Повторить');
      await f.keyboard();
      assert.equal(f.$('[data-assistant-retry]').hidden, false);
      f.$('[data-assistant-retry]').click();
      await flush();
      const sent = f.turns();
      assert.equal(sent.length, 3);
      assert.equal(sent[1].options.body, sent[2].options.body);
    }
    assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
    assert.equal(f.opened.length, 0);
    assert.equal(f.$('.voice-assistant-dialog').open, true);
    assert.equal(f.$('[data-assistant-action]').hidden, false);
    f.$('[data-assistant-action]').click();
    await flush();
    assertManualBooking(f);
  }
});
