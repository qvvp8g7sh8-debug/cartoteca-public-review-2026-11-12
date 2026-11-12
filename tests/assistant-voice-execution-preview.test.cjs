const testTask = require('node:test');
const test = (title, run) => testTask(title, { timeout: 2000 }, run);
const assert = require('node:assert/strict');
const {
  fixture,
  reply,
  deferred,
  flush,
} = require('./helpers/assistant-voice-booking-fixture.cjs');
const ready = () => ({
  intent: 'prepareAppointment',
  policyVersion: 1,
  demo: false,
  dialogue: null,
  text: 'Подготовил запись Анны Синтетической на 2 января в 15:30. Запись не сохранена.',
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
const speaks = (f) => f.calls.filter((call) => call.route === '/api/assistant/speak');
const assertNoSave = (f) =>
  assert.ok(f.calls.every((call) => call.route.startsWith('/api/assistant/')));
async function begin(f, response = ready()) {
  f.control.turn = async () => response;
  await f.hold();
  const pending = f.transcript('Запиши Анну Синтетическую на 2 января в 15:30 на чистку');
  await flush();
  return { pending };
}

test('voice opens the validated unsaved form before its one short confirmation, without another command', async (t) => {
  const f = fixture(t),
    { pending } = await begin(f);
  assert.equal(f.opened.length, 1, 'the action executes before completion speech');
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.state.editorMode.id, null);
  assert.equal(speaks(f).length, 1);
  assert.equal(speaks(f)[0].body.text, ready().text);
  assert.equal(f.played.length, 1);
  await f.finishSpeech();
  await pending;
  assert.equal(f.captures.length, 1, 'the destination form must not rearm the microphone');
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
  assert.equal(
    f.$('.voice-assistant-draft-hint').textContent,
    'Проверьте данные и сохраните запись.',
  );
  assertNoSave(f);
});

for (const [type, target, text] of [
  ['calendar', 'calendar', 'Открыл расписание.'],
  ['clientCard', 'card', 'Открыл карточку клиента.'],
  ['clients', 'clients', 'Открыл список клиентов.'],
])
  test(
    'voice executes ' + type + ' before a short acknowledgement without a result click',
    async (t) => {
      const f = fixture(t);
      f.w.document.body.insertAdjacentHTML('beforeend', '<input id="search">');
      Object.assign(f.actions, {
        parseDate: (value) => new Date(value + 'T12:00:00'),
        weekStart: (value) => value,
        setCalendarMode: (value) => {
          f.state.calendarMode = value;
        },
        setView: async (value) => {
          f.state.currentView = value;
        },
        ensurePatient: async (id) => ({ id }),
        ensurePatientView: async (id) => ({ id }),
        renderList() {},
      });
      const response = {
        policyVersion: 1,
        demo: false,
        dialogue: null,
        text: 'Длинное предварительное описание не должно зачитываться.',
        action: { type, patientId: 'synthetic-patient', date: '2030-01-02', mode: 'day' },
      };
      const { pending } = await begin(f, response);
      assert.equal(f.state.currentView, target);
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(speaks(f).length, 1);
      assert.equal(speaks(f)[0].body.text, text);
      await f.finishSpeech();
      await pending;
      assert.equal(f.captures.length, 1);
      assertNoSave(f);
    },
  );

test('voice waits for actual form opening and fresh scope, never announces a pending action', async (t) => {
  const f = fixture(t),
    gate = deferred(),
    original = f.actions.openAppointmentForm;
  f.actions.openAppointmentForm = async (...args) => {
    await gate.promise;
    return original(...args);
  };
  const { pending } = await begin(f);
  assert.equal(f.opened.length, 0);
  assert.equal(speaks(f).length, 0);
  gate.resolve();
  await flush();
  assert.equal(f.opened.length, 1);
  assert.equal(speaks(f).length, 1);
  await f.finishSpeech();
  await pending;
  assert.equal(f.calls.filter((call) => call.route.endsWith('/scope')).length, 2);
  assertNoSave(f);
});

for (const result of ['false', 'throw'])
  test(
    'failed ' + result + ' handoff has no success speech and retains explicit retry',
    async (t) => {
      const f = fixture(t);
      let attempts = 0;
      f.actions.runAssistantAction = async () => {
        attempts++;
        if (result === 'throw') throw Error('Synthetic destination unavailable');
        return false;
      };
      const { pending } = await begin(f);
      await pending;
      assert.equal(attempts, 1);
      assert.equal(speaks(f).length, 0);
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(f.$('.voice-assistant-session').hidden, false);
      assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
      assert.equal(f.$('[data-assistant-action]').hidden, false);
      assert.equal(f.$('[data-assistant-action]').disabled, false);
      assert.equal(f.captures.length, 1);
      assertNoSave(f);
    },
  );

for (const change of [
  'policy',
  'identity',
  'generation',
  'destination',
  'new-panel',
  'destroy',
  'pagehide',
  'hidden',
])
  test('late completion audio is suppressed after ' + change + ' changes ownership', async (t) => {
    const f = fixture(t),
      gate = deferred();
    f.control.speak = () => gate.promise;
    const { pending } = await begin(f);
    assert.equal(f.opened.length, 1);
    assert.equal(speaks(f).length, 1);
    const request = speaks(f)[0];
    if (change === 'policy') f.state.assistantScope = { ...f.scope, policyVersion: 2 };
    if (change === 'identity') f.state.account.role = 'another-role';
    if (change === 'generation') f.state.assistantGeneration++;
    if (change === 'destination')
      f.state.editorMode = { kind: 'appointment', id: null, source: 'calendar' };
    if (change === 'new-panel') {
      f.state.editorMode = null;
      await f.keyboard();
    }
    if (change === 'destroy') f.api.destroyVoiceAssistant();
    if (change === 'pagehide') f.w.dispatchEvent(new f.w.Event('pagehide'));
    if (change === 'hidden') {
      Object.defineProperty(f.w.document, 'hidden', { value: true, configurable: true });
      f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
    }
    gate.resolve({ audioBase64: 'synthetic', mimeType: 'audio/wav', policyVersion: 1 });
    await pending;
    await flush();
    assert.equal(f.played.length, 0);
    assert.equal(f.opened.length, 1);
    assert.equal(f.captures.length, 1);
    if (['destroy', 'pagehide', 'hidden', 'new-panel'].includes(change))
      assert.equal(request.options.signal.aborted, true);
    assertNoSave(f);
  });

test('completion audio failure keeps the successfully opened form and never retries the action', async (t) => {
  const f = fixture(t);
  f.control.speak = async () => {
    throw Error('Synthetic TTS unavailable');
  };
  const { pending } = await begin(f);
  await pending;
  assert.equal(f.opened.length, 1);
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.state.editorMode.source, 'assistant');
  assert.equal(f.captures.length, 1);
  assert.equal(speaks(f).length, 1);
  assert.match(f.toasts.at(-1), /Действие выполнено.*озвучить/u);
  assertNoSave(f);
});

test('completion playback failure does not resurrect the old question or perform the action twice', async (t) => {
  const f = fixture(t),
    { pending } = await begin(f);
  assert.equal(f.opened.length, 1);
  f.played[0].gate.reject(Error('Synthetic playback failure'));
  await pending;
  assert.equal(f.$('.voice-assistant-dialog').open, false);
  assert.equal(f.opened.length, 1);
  assert.equal(f.captures.length, 1);
  assert.match(f.toasts.at(-1), /Действие выполнено.*озвучить/u);
  assertNoSave(f);
});

for (const change of ['policy', 'stop'])
  test('fresh-scope ' + change + ' prevents voice handoff and success speech', async (t) => {
    const f = fixture(t),
      gate = deferred(),
      request = f.actions.request;
    let scopes = 0;
    f.actions.request = async (route, options) =>
      route.endsWith('/scope') && ++scopes === 2 ? gate.promise : request(route, options);
    const { pending } = await begin(f);
    assert.equal(f.opened.length, 0);
    assert.equal(speaks(f).length, 0);
    if (change === 'stop') f.$('[data-assistant-voice]').click();
    gate.resolve(change === 'policy' ? { ...f.scope, policyVersion: 2 } : f.scope);
    await pending;
    assert.equal(f.opened.length, 0);
    assert.equal(speaks(f).length, 0);
    assertNoSave(f);
  });

test('unknown terminal voice turn does not execute or speak until the user explicitly retries', async (t) => {
  const f = fixture(t);
  let turns = 0;
  f.control.turn = async () => {
    if (++turns === 1) return reply(1, 'service');
    throw Object.assign(Error('Synthetic unknown result'), { outcomeUnknown: true });
  };
  await f.hold();
  const initial = f.transcript('Запиши Анну');
  await flush();
  await f.finishSpeech();
  await initial;
  const next = f.transcript('Чистка');
  await flush();
  await next;
  assert.equal(f.opened.length, 0);
  assert.equal(speaks(f).length, 1, 'only the original question was spoken');
  assert.equal(f.$('[data-assistant-retry]').hidden, false);
  assertNoSave(f);
});

for (const event of ['input', 'change'])
  test(
    'editing the unsaved form during pending completion ' +
      event +
      ' suppresses stale spoken values',
    async (t) => {
      const f = fixture(t),
        gate = deferred();
      f.control.speak = () => gate.promise;
      const { pending } = await begin(f);
      assert.equal(f.opened.length, 1);
      const input = f.$('#form-content [name="time"]');
      input.value = '16:00';
      input.dispatchEvent(new f.w.Event(event, { bubbles: true }));
      assert.equal(speaks(f)[0].options.signal.aborted, true);
      gate.resolve({ policyVersion: 1, audioBase64: 'synthetic', mimeType: 'audio/wav' });
      await pending;
      assert.equal(f.played.length, 0);
      assert.equal(input.value, '16:00');
      assert.equal(f.opened.length, 1);
      assertNoSave(f);
    },
  );

test('duplicate completion of one capture executes and confirms the prepared form only once', async (t) => {
  const f = fixture(t);
  f.control.turn = async () => ready();
  await f.hold();
  const capture = f.captures[0];
  const first = capture.complete('first-synthetic');
  const duplicate = capture.complete('duplicate-synthetic');
  await flush();
  assert.equal(f.opened.length, 1);
  assert.equal(f.turns().length, 1);
  assert.equal(speaks(f).length, 1);
  await f.finishSpeech();
  await Promise.all([first, duplicate]);
  await capture.complete('late-synthetic');
  assert.equal(f.opened.length, 1);
  assert.equal(speaks(f).length, 1);
  assertNoSave(f);
});

for (const type of ['calendar', 'clientCard', 'clients'])
  test(
    'actual navigation mount lifecycle keeps ownership for its own voice ' + type + ' action',
    async (t) => {
      const f = fixture(t);
      f.w.document.body.insertAdjacentHTML(
        'beforeend',
        '<input id="search"><div id="workspace"><div id="global-view"></div><div id="detail"></div></div>',
      );
      Object.assign(f.actions, {
        parseDate: (value) => new Date(value + 'T12:00:00'),
        weekStart: (value) => value,
        setCalendarMode: (value) => {
          f.state.calendarMode = value;
        },
        ensurePatient: async (id) => ({ id }),
        ensurePatientView: async (id) => ({ id }),
        renderList() {},
        renderDetail() {},
        configureServiceView() {},
        renderBookingInbox() {},
        refreshBookingInbox: async () => {},
        renderBookingHealth() {},
        refreshBookingHealth: async () => {},
        invalidatePrint() {},
        mountAssistant: () => f.api.mountVoiceAssistant(),
        calendarHtml: () => '',
        positionCalendarEvents() {},
        updateCurrentTime() {},
        loadRoomAvailability: async () => {},
        loadCalendarRecords: async () => {},
        loadCalendarSchedule: async () => {},
      });
      f.w.eval(
        require('node:fs').readFileSync(
          require('node:path').resolve(__dirname, '../src/client/core/navigation.js'),
          'utf8',
        ),
      );
      Object.assign(f.actions, f.w.eval('createNavigation')(f.state, f.actions));
      const response = {
        policyVersion: 1,
        demo: false,
        dialogue: null,
        text: 'Ready',
        action: { type, patientId: 'synthetic-patient', date: '2030-01-02' },
      };
      const { pending } = await begin(f, response);
      assert.equal(f.state.assistantGeneration, 0, 'own transition does not reset ownership');
      assert.equal(speaks(f).length, 1);
      assert.equal(f.played.length, 1);
      assert.equal(f.state.currentView, type === 'clientCard' ? 'card' : type);
      await f.finishSpeech();
      await pending;
      assert.equal(f.captures.length, 1);
      assertNoSave(f);
    },
  );

for (const type of ['calendar', 'clientCard', 'clients'])
  test(
    'cancelled destination navigation for ' + type + ' cannot receive success acknowledgement',
    async (t) => {
      const f = fixture(t);
      f.w.document.body.insertAdjacentHTML('beforeend', '<input id="search">');
      Object.assign(f.actions, {
        parseDate: (value) => new Date(value + 'T12:00:00'),
        weekStart: (value) => value,
        setCalendarMode() {},
        ensurePatient: async (id) => ({ id }),
        renderList() {},
        setView: async () => {
          f.state.currentView = 'settings';
        },
      });
      const { pending } = await begin(f, {
        policyVersion: 1,
        demo: false,
        dialogue: null,
        text: 'Should not be spoken',
        action: { type, patientId: 'synthetic-patient', date: '2030-01-02' },
      });
      await pending;
      assert.equal(speaks(f).length, 0);
      assert.equal(f.played.length, 0);
      assertNoSave(f);
    },
  );
