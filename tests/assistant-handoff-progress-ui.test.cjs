const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, deferred, flush } = require('./helpers/assistant-voice-booking-fixture.cjs');

const labels = {
  createAppointment: ['Сохраняю запись…', 'Запись сохранена.'],
  moveAppointment: ['Переношу запись…', 'Запись перенесена.'],
  cancelAppointment: ['Отменяю запись…', 'Запись отменена.'],
};
function committed(kind) {
  return {
    saved: true,
    appointmentId: 'synthetic-appointment',
    text: labels[kind][1],
    policyVersion: 1,
    action: null,
    ...(kind === 'moveAppointment' ? { moved: true, operation: 'move' } : {}),
    ...(kind === 'cancelAppointment' ? { cancelled: true, operation: 'cancel' } : {}),
  };
}
function executionFixture(t, kind = 'createAppointment') {
  const f = fixture(t, { scope: { appointmentSavingEnabled: true } });
  const execution = deferred();
  const executions = [];
  const request = f.actions.request;
  f.actions.request = (route, options) => {
    if (route !== '/api/assistant/execute') return request(route, options);
    const entry = { route, body: JSON.parse(options.body), options };
    f.calls.push(entry);
    executions.push(entry);
    return execution.promise;
  };
  f.actions.invalidateCalendarRead = () => {};
  f.actions.setView = async (view) => {
    f.state.currentView = view;
  };
  f.w.eval(
    fs.readFileSync(
      path.join(__dirname, '../src/client/modules/assistant-appointment-save.js'),
      'utf8',
    ),
  );
  Object.assign(f.actions, f.w.eval('createAssistantAppointmentSave')(f.state, f.actions));
  f.control.turn = async () => ({
    text: 'Данные готовы.',
    policyVersion: 1,
    demo: false,
    dialogue: null,
    action: {
      type: kind,
      executionId: '10000000-0000-4000-8000-000000000001',
    },
  });
  return { ...f, execution, executions };
}
function indicator(f) {
  return f.$('.voice-assistant-session');
}
function message(f) {
  return f.$('[data-assistant-session-message]');
}

for (const kind of Object.keys(labels))
  test(
    'pending ' + kind + ' stays visible until commit without speaking a premature result',
    async (t) => {
      const f = executionFixture(t, kind);
      await f.hold();
      const pending = f.transcript('Синтетическая полная команда');
      await flush();
      assert.equal(f.executions.length, 1);
      assert.equal(indicator(f).hidden, false);
      assert.equal(indicator(f).dataset.assistantPhase, 'pending');
      assert.equal(message(f).textContent, labels[kind][0]);
      assert.equal(message(f).hidden, false);
      assert.equal(f.$('[data-assistant-session-resume]').hidden, true);
      assert.match(
        f.$('[data-assistant-session-stop]').getAttribute('aria-label'),
        /продолжит выполняться/,
      );
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
      await flush();
      assert.equal(f.executions.length, 1, 'progress creates no polling or business retry');
      f.execution.resolve(committed(kind));
      await flush();
      assert.equal(indicator(f).hidden, true);
      assert.equal(message(f).textContent, '');
      assert.deepEqual(
        f.calls.filter((row) => row.route.endsWith('/speak')).map((row) => row.body.text),
        [labels[kind][1]],
      );
      await f.finishSpeech();
      await pending;
      assert.equal(f.executions.length, 1);
      assert.equal(indicator(f).hidden, true);
    },
  );

test('unknown execution clears progress and exposes the existing reconciliation state without announcing success', async (t) => {
  const f = executionFixture(t);
  await f.hold();
  const pending = f.transcript('Синтетическая полная команда');
  await flush();
  f.execution.reject(Object.assign(Error('Synthetic connection loss'), { outcomeUnknown: true }));
  await pending;
  await flush();
  assert.equal(f.executions.length, 2, 'only the existing executor retry is used');
  assert.deepEqual(f.executions[0].body, f.executions[1].body);
  assert.equal(indicator(f).hidden, false);
  assert.equal(indicator(f).dataset.assistantPhase, 'idle');
  assert.match(message(f).textContent, /Результат сохранения пока неизвестен/);
  assert.doesNotMatch(message(f).textContent, /Сохраняю запись|Запись сохранена/);
  assert.equal(f.$('[data-assistant-session-resume]').hidden, false);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
  const stored = JSON.parse(
    f.w.sessionStorage.getItem('cartoteca-assistant-create:' + JSON.stringify(['staff', 'org'])),
  );
  assert.equal(stored.uncertain, true, 'the durable reconciliation token is retained');
});

test('closing pending execution hides feedback without aborting its write or speaking a late result', async (t) => {
  const f = executionFixture(t);
  await f.hold();
  const pending = f.transcript('Синтетическая полная команда');
  await flush();
  f.$('[data-assistant-session-stop]').click();
  assert.equal(indicator(f).hidden, true);
  assert.equal(f.executions[0].options.signal, undefined, 'a UI close cannot abort execution');
  f.execution.resolve(committed('createAppointment'));
  await pending;
  await flush();
  assert.equal(f.executions.length, 1);
  assert.equal(indicator(f).hidden, true);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
});

test('a manual assistant action click uses the same bounded progress without enabling voice', async (t) => {
  const f = executionFixture(t);
  await f.keyboard();
  f.$('[data-assistant-text]').value = 'Синтетическая полная команда';
  f.$('.voice-assistant-dialog form').dispatchEvent(
    new f.w.Event('submit', { bubbles: true, cancelable: true }),
  );
  await flush();
  f.$('[data-assistant-action]').click();
  await flush();
  assert.equal(f.executions.length, 1);
  assert.equal(indicator(f).hidden, false);
  assert.equal(message(f).textContent, 'Сохраняю запись…');
  assert.equal(f.captures.length, 0);
  assert.deepEqual(f.toasts, []);
  f.execution.resolve(committed('createAppointment'));
  await flush();
  assert.equal(indicator(f).hidden, true);
  assert.deepEqual(f.toasts, ['Запись сохранена.']);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
});

test('hidden pending execution stays hidden on return and its late response cannot restore audio', async (t) => {
  const f = executionFixture(t);
  let hidden = false;
  Object.defineProperty(f.w.document, 'hidden', { configurable: true, get: () => hidden });
  await f.hold();
  const pending = f.transcript('Синтетическая полная команда');
  await flush();
  hidden = true;
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
  assert.equal(indicator(f).hidden, true);
  hidden = false;
  f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
  assert.equal(indicator(f).hidden, true);
  f.execution.resolve(committed('createAppointment'));
  await pending;
  await flush();
  assert.equal(f.executions.length, 1);
  assert.equal(f.executions[0].options.signal, undefined);
  assert.equal(indicator(f).hidden, true);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
});

for (const change of ['account', 'organization', 'generation', 'policy', 'navigation', 'editor'])
  test(
    'pending progress is invalidated by ' + change + ' and cannot reappear after completion',
    async (t) => {
      const f = executionFixture(t);
      await f.hold();
      const pending = f.transcript('Синтетическая полная команда');
      await flush();
      if (change === 'account') f.state.account = { ...f.state.account, id: 'another-account' };
      if (change === 'organization') f.state.account.organizationId = 'another-organization';
      if (change === 'generation') f.state.assistantGeneration++;
      if (change === 'policy') f.state.assistantScope.policyVersion++;
      if (change === 'navigation') f.state.currentView = 'clients';
      if (change === 'editor') f.state.editorMode = { kind: 'appointment', source: 'manual' };
      f.api.mountVoiceAssistant();
      assert.equal(indicator(f).hidden, true);
      f.execution.resolve(committed('createAppointment'));
      await pending;
      await flush();
      assert.equal(indicator(f).hidden, true);
      assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
      assert.equal(f.executions.length, 1);
    },
  );

test('an older execution cannot close a newly opened assistant session or speak into it', async (t) => {
  const f = executionFixture(t);
  await f.hold();
  const pending = f.transcript('Синтетическая полная команда');
  await flush();
  await f.keyboard();
  const panel = f.$('.voice-assistant-dialog');
  assert.equal(panel.open, true);
  f.$('[data-assistant-text]').value = 'Новая команда';
  f.execution.resolve(committed('createAppointment'));
  await pending;
  await flush();
  assert.equal(panel.open, true);
  assert.equal(f.$('[data-assistant-text]').value, 'Новая команда');
  assert.equal(indicator(f).hidden, true);
  assert.equal(f.calls.filter((row) => row.route.endsWith('/speak')).length, 0);
});

function slowScope(f) {
  const gate = deferred();
  const request = f.actions.request;
  f.actions.request = (route, options) => {
    if (route !== '/api/assistant/scope') return request(route, options);
    f.calls.push({ route, body: null, options });
    return gate.promise;
  };
  return gate;
}
test('initial scope wait is visibly pending access rather than paused and starts no premature recording', async (t) => {
  const f = fixture(t);
  const scope = slowScope(f);
  await f.hold();
  assert.equal(indicator(f).hidden, false);
  assert.equal(indicator(f).dataset.assistantPhase, 'pending');
  assert.equal(message(f).textContent, 'Проверяю доступ…');
  assert.equal(f.$('[data-assistant-session-status]').textContent, 'Проверяю доступ');
  assert.equal(f.$('[data-assistant-session-resume]').hidden, true);
  assert.equal(f.captures.length, 0);
  scope.resolve(f.scope);
  await flush();
  assert.equal(f.captures.length, 1);
  assert.equal(indicator(f).dataset.assistantPhase, 'listening');
  assert.equal(message(f).hidden, true);
});

test('closing a pending access check cannot revive the indicator or microphone after its late response', async (t) => {
  const f = fixture(t);
  const scope = slowScope(f);
  await f.hold();
  f.$('[data-assistant-session-stop]').click();
  assert.equal(indicator(f).hidden, true);
  scope.resolve(f.scope);
  await flush();
  assert.equal(indicator(f).hidden, true);
  assert.equal(f.captures.length, 0);
  assert.equal(f.calls.length, 1);
});
