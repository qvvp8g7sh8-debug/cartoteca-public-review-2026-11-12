const task = require('node:test');
const test = (name, run) => task(name, { timeout: 3000 }, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const {
  fixture: voiceFixture,
  deferred,
  flush,
} = require('./helpers/assistant-voice-booking-fixture.cjs');
const read = (name) =>
  fs.readFileSync(path.resolve(__dirname, '../src/client/modules', name + '.js'), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const token = '20000000-0000-4000-8000-000000000001';
const otherToken = '20000000-0000-4000-8000-000000000002';
const organizationId = '10000000-0000-4000-8000-000000000001';
const action = (executionId = token) => ({ type: 'createAppointment', executionId });
function recovered(executionId = token) {
  const text = 'На какое время записать? Укажите время с шагом пять минут.';
  return {
    saved: false,
    definitive: true,
    code: 'ASSISTANT_EXECUTION_REQUIRES_INPUT',
    policyVersion: 1,
    recovery: {
      text,
      policyVersion: 1,
      action: null,
      demo: false,
      dialogue: {
        id: executionId,
        version: 2,
        step: 'time',
        phase: 'period',
        prompt: text,
        input: { type: 'text', field: 'time' },
        options: [],
        controls: [],
        fields: [
          { key: 'client', label: 'Клиент', value: 'Анна Синтетическая' },
          { key: 'service', label: 'Услуга', value: 'Чистка' },
          { key: 'date', label: 'Дата', value: '2030-01-02' },
          { key: 'duration', label: 'Длительность', value: '30 мин' },
        ],
        canEdit: ['client', 'service', 'date', 'duration'],
        expiresAt: Date.now() + 600000,
      },
    },
  };
}
function saveFixture(t, execute = async () => recovered(), previous = null) {
  const w = new JSDOM('', { url: 'https://synthetic.invalid', runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: false });
  const state = {
    account: { id: 'synthetic-owner', organizationId, role: 'owner' },
    assistantScope: {
      enabled: true,
      appointmentSavingEnabled: true,
      organizationId,
      policyVersion: 1,
    },
    assistantGeneration: 1,
    currentView: 'calendar',
    editorMode: null,
    busy: false,
  };
  const calls = [],
    effects = { invalidate: 0, views: [], toasts: [] };
  const key = 'cartoteca-assistant-create:' + JSON.stringify([state.account.id, organizationId]);
  if (previous) w.sessionStorage.setItem(key, JSON.stringify(previous));
  const actions = {
    request: async (route, options) => {
      const body = JSON.parse(options.body);
      calls.push({ route, body, options });
      assert.equal(route, '/api/assistant/execute');
      return execute(body, calls.length);
    },
    invalidateCalendarRead: () => effects.invalidate++,
    setView: async (view) => effects.views.push(view),
    toast: (text) => effects.toasts.push(text),
  };
  w.eval(read('assistant-appointment-save'));
  Object.assign(actions, w.eval('createAssistantAppointmentSave')(state, actions));
  w.eval(read('assistant-commands'));
  const commands = w.eval('createAssistantCommands')(state, actions);
  return {
    w,
    state,
    calls,
    effects,
    actions,
    commands,
    receipt: () => {
      const value = w.sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    },
  };
}

test('a definitive checked time recovery forgets its own pending token and returns the exact clarification envelope', async (t) => {
  const envelope = recovered(),
    f = saveFixture(t, async () => envelope);
  const result = await f.actions.saveAssistantAppointment(action());
  assert.deepEqual(plain(result), envelope);
  assert.equal(result.saved, false);
  assert.equal(f.receipt(), null);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { executionId: token, policyVersion: 1 });
  assert.deepEqual(f.effects, { invalidate: 0, views: [], toasts: [] });
});

test('commands return a checked recovery without calendar invalidation navigation or a saved toast', async (t) => {
  const envelope = recovered(),
    f = saveFixture(t, async () => envelope);
  const result = await f.commands.runAssistantAction(action());
  assert.deepEqual(plain(result), envelope);
  assert.equal(f.receipt(), null);
  assert.deepEqual(f.effects, { invalidate: 0, views: [], toasts: [] });
});

test('a cancellation consent recovery returns its bound question without a success effect or stale receipt', async (t) => {
  const envelope = recovered();
  const dialogue = envelope.recovery.dialogue;
  dialogue.step = 'appointment';
  dialogue.phase = 'cancelConfirmation';
  dialogue.options = [{ id: 'opaque-renewed-consent', label: 'Да, отменить' }];
  dialogue.prompt = envelope.recovery.text = 'Отменить завтра в 10:00?';
  const f = saveFixture(t, async () => envelope);
  const result = await f.commands.runAssistantAction({
    type: 'cancelAppointment',
    executionId: token,
  });
  assert.deepEqual(plain(result), envelope);
  assert.equal(f.receipt(), null);
  assert.deepEqual(f.effects, { invalidate: 0, views: [], toasts: [] });
  assert.equal(f.calls.length, 1);
});

test('an unbound appointment question cannot replace a creation or move receipt', async (t) => {
  for (const type of ['createAppointment', 'moveAppointment']) {
    const envelope = recovered();
    envelope.recovery.dialogue.step = 'appointment';
    envelope.recovery.dialogue.phase = 'cancelConfirmation';
    envelope.recovery.dialogue.options = [{ id: 'opaque', label: 'Да, отменить' }];
    const f = saveFixture(t, async () => envelope);
    await assert.rejects(f.actions.saveAssistantAppointment({ type, executionId: token }));
    assert.ok(f.receipt()?.uncertain);
  }
});

test('malformed or unbound recovery remains uncertain and never erases the pending token', async (t) => {
  const mutations = [
    (r) => {
      r.definitive = false;
    },
    (r) => {
      r.code = 'UNKNOWN_RECOVERY';
    },
    (r) => {
      r.policyVersion = 2;
    },
    (r) => {
      r.recovery.policyVersion = 2;
    },
    (r) => {
      r.recovery.dialogue.id = otherToken;
    },
    (r) => {
      r.recovery.dialogue.version = 0;
    },
    (r) => {
      r.recovery.dialogue.version = Number.MAX_SAFE_INTEGER + 1;
    },
    (r) => {
      r.recovery.dialogue.step = 'review';
    },
    (r) => {
      r.recovery.action = { type: 'calendar', date: '2030-01-02', staffId: 'owner' };
    },
    (r) => {
      delete r.recovery.dialogue;
    },
    (r) => {
      r.recovery.dialogue.fields = 'not-fields';
    },
    (r) => {
      r.recovery.dialogue.options = null;
    },
  ];
  for (const mutate of mutations) {
    const envelope = recovered();
    mutate(envelope);
    const f = saveFixture(t, async () => envelope);
    await assert.rejects(
      () => f.actions.saveAssistantAppointment(action()),
      (error) => error.outcomeUnknown === true,
    );
    assert.deepEqual(f.receipt(), { executionId: token, policyVersion: 1, uncertain: true });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.effects, { invalidate: 0, views: [], toasts: [] });
  }
});

test('reconciliation of an older token returns its clarification and never rewrites it as a previous saved appointment', async (t) => {
  const envelope = recovered(),
    f = saveFixture(t, async () => envelope, {
      executionId: token,
      policyVersion: 1,
      uncertain: true,
    });
  const result = await f.actions.saveAssistantAppointment(action(otherToken));
  assert.deepEqual(plain(result), envelope);
  assert.equal(f.receipt(), null);
  assert.deepEqual(
    f.calls.map((row) => row.body.executionId),
    [token],
  );
  assert.doesNotMatch(JSON.stringify(result), /Предыдущая запись сохранена/u);
});

test('concurrent different-token callers share the earlier recovery without creating a second operation or success text', async (t) => {
  const gate = deferred(),
    envelope = recovered(),
    f = saveFixture(t, () => gate.promise);
  const first = f.actions.saveAssistantAppointment(action()),
    second = f.actions.saveAssistantAppointment(action(otherToken));
  await flush();
  assert.equal(f.calls.length, 1);
  gate.resolve(envelope);
  const values = await Promise.all([first, second]);
  for (const value of values) {
    assert.deepEqual(plain(value), envelope);
    assert.doesNotMatch(JSON.stringify(value), /Предыдущая запись сохранена/u);
  }
  assert.equal(f.receipt(), null);
  assert.equal(f.calls.length, 1);
});

function uiFixture(t, execute = async () => recovered()) {
  const f = voiceFixture(t, { scope: { appointmentSavingEnabled: true } });
  f.state.account.role = 'owner';
  let releases = 0,
    invalidations = 0;
  const views = [];
  f.actions.releaseAssistantAudio = () => releases++;
  f.actions.invalidateCalendarRead = () => invalidations++;
  f.actions.setView = async (view) => {
    views.push(view);
    f.state.currentView = view;
  };
  const request = f.actions.request;
  f.actions.request = async (route, options) => {
    if (route === '/api/assistant/execute') {
      const body = JSON.parse(options.body);
      f.calls.push({ route, body, options });
      return execute(body);
    }
    return request(route, options);
  };
  f.w.eval(read('assistant-appointment-save'));
  Object.assign(f.actions, f.w.eval('createAssistantAppointmentSave')(f.state, f.actions));
  f.control.turn = async () => ({
    text: 'Записываю.',
    policyVersion: 1,
    demo: false,
    dialogue: null,
    action: action(),
  });
  return Object.assign(f, { releases: () => releases, invalidations: () => invalidations, views });
}
const speaks = (f) => f.calls.filter((row) => row.route === '/api/assistant/speak');
async function begin(f) {
  await f.hold();
  const pending = f.transcript(
    'Запиши Анну Синтетическую на чистку на сегодня в двадцать ноль одну.',
  );
  await flush();
  return { pending };
}

test('actual voice handoff restores the recovered fields asks only the new time and resumes listening without success audio', async (t) => {
  const envelope = recovered(),
    f = uiFixture(t, async () => envelope),
    { pending } = await begin(f);
  assert.equal(f.calls.filter((row) => row.route === '/api/assistant/execute').length, 1);
  assert.equal(speaks(f).length, 1);
  assert.equal(speaks(f)[0].body.text, envelope.recovery.text);
  assert.doesNotMatch(
    speaks(f)
      .map((row) => row.body.text)
      .join(' '),
    /Записываю|сохранена/u,
  );
  assert.equal(f.$('[data-assistant-answer]').textContent, envelope.recovery.text);
  const summary = f.$('[data-assistant-conversation]').textContent;
  for (const value of ['Анна Синтетическая', 'Чистка', '2030-01-02', '30 мин'])
    assert.ok(summary.includes(value), value);
  assert.equal(f.releases(), 0, 'Recovery keeps the same unlocked output across the handoff');
  assert.equal(f.invalidations(), 0);
  assert.deepEqual(f.views, []);
  assert.deepEqual(f.toasts, []);
  await f.finishSpeech();
  await pending;
  await flush();
  assert.equal(f.captures.length, 2);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.equal(f.$('.voice-assistant-session').dataset.assistantPhase, 'listening');
  assert.equal(f.turns().length, 1);
  assert.equal(f.releases(), 0);
  f.$('[data-assistant-session-stop]').click();
  await flush();
  assert.ok(f.releases() >= 1, 'Ordinary close releases the output afterwards');
});

test('actual cancellation recovery speaks the renewed consent once and resumes voice without cancelling again', async (t) => {
  const envelope = recovered();
  envelope.recovery.text = envelope.recovery.dialogue.prompt = 'Отменить завтра в 10:00?';
  envelope.recovery.dialogue.step = 'appointment';
  envelope.recovery.dialogue.phase = 'cancelConfirmation';
  envelope.recovery.dialogue.input.field = 'appointment';
  envelope.recovery.dialogue.options = [{ id: 'opaque-new-consent', label: 'Да, отменить' }];
  const f = uiFixture(t, async () => envelope);
  f.control.turn = async () => ({
    text: 'Отменяю запись.',
    policyVersion: 1,
    dialogue: null,
    action: { type: 'cancelAppointment', executionId: token },
  });
  const { pending } = await begin(f);
  assert.equal(speaks(f).length, 1);
  assert.equal(speaks(f)[0].body.text, 'Отменить завтра в 10:00?');
  assert.equal(f.calls.filter((row) => row.route === '/api/assistant/execute').length, 1);
  assert.equal(f.invalidations(), 0);
  await f.finishSpeech();
  await pending;
  assert.equal(f.captures.length, 2);
  assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.toasts, []);
});

for (const change of ['account', 'policy', 'view', 'generation', 'hidden'])
  test(
    'a late execution recovery cannot resume a voice session after ' + change + ' changed',
    async (t) => {
      const gate = deferred(),
        f = uiFixture(t, () => gate.promise),
        { pending } = await begin(f);
      assert.equal(f.calls.filter((row) => row.route === '/api/assistant/execute').length, 1);
      if (change === 'account') f.state.account = { ...f.state.account, id: 'another-account' };
      if (change === 'policy')
        f.state.assistantScope = { ...f.state.assistantScope, policyVersion: 2 };
      if (change === 'view') f.state.currentView = 'clients';
      if (change === 'generation') f.state.assistantGeneration++;
      if (change === 'hidden')
        Object.defineProperty(f.w.document, 'hidden', { configurable: true, value: true });
      gate.resolve(recovered());
      await flush();
      await pending;
      assert.equal(speaks(f).length, 0);
      assert.equal(f.captures.length, 1);
      assert.equal(f.$('[data-assistant-voice]').getAttribute('aria-pressed'), 'false');
      assert.equal(f.invalidations(), 0);
      assert.deepEqual(f.views, []);
      assert.deepEqual(f.toasts, []);
      assert.notEqual(f.$('[data-assistant-answer]').textContent, recovered().recovery.text);
    },
  );
