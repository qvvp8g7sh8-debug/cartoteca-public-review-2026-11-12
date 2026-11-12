const test = require('node:test');
const assert = require('node:assert/strict');
const {
  previewFixture,
  flush,
  deferred,
} = require('./helpers/assistant-appointment-preview-fixture.cjs');
for (const operation of ['move', 'edit', 'cancel'])
  test(
    operation + ' preview uses the actual existing appointment and leaves all records unchanged',
    async (t) => {
      const f = previewFixture(t),
        before = f.snapshot(),
        action = f.action(operation);
      assert.equal(await f.actions.runAssistantAction(action), true);
      assert.equal(f.$('#editor').open, true);
      assert.equal(f.state.editorMode.id, action.appointmentId);
      assert.equal(f.state.editorMode.patientId, action.patientId);
      if (operation === 'cancel') {
        assert.equal(f.state.editorMode.kind, 'appointmentOutcome');
        assert.equal(f.$('#save-editor').hidden, true);
        f.$('#editor-form').dispatchEvent(
          new f.w.Event('submit', { bubbles: true, cancelable: true }),
        );
        await flush();
        assert.equal(f.$('#form-content').querySelectorAll('button').length, 0);
        assert.match(f.$('#form-content').textContent, /Отмена не выполнена/u);
      } else {
        assert.equal(f.state.editorMode.kind, 'appointment');
        assert.equal(f.$('#form-content [name="date"]').value, action.date || '2030-01-02');
        assert.equal(f.$('#form-content [name="time"]').value, action.time || '10:00');
        assert.equal(f.$('#form-content [name="duration"]').value, '45');
        assert.equal(f.$('#form-content [name="staffId"]').value, 'synthetic-owner');
        assert.equal(f.$('#appointment-service-value').value, 'Тестовая консультация');
        assert.deepEqual(
          Array.from(f.state.editorMode.serviceItems, (item) => item.id),
          ['synthetic-service'],
        );
        assert.equal(f.$('#form-content [name="notes"]').value, 'Synthetic original note');
        assert.equal(f.ports.ensure.length, 2);
        assert.ok(f.ports.ensure.every((call) => call.options.force === true));
      }
      assert.equal(f.snapshot(), before);
      assert.equal(f.ports.saves, 0);
    },
  );
for (const field of [
  'date',
  'time',
  'duration',
  'staffId',
  'roomId',
  'service',
  'status',
  'serviceItems',
])
  test(
    'changed source ' + field + ' is rejected before opening a management preview',
    async (t) => {
      const f = previewFixture(t),
        action = f.action();
      const record = f.data[0].appointments[0];
      if (field === 'serviceItems') record.serviceItems[0].price++;
      else record[field] = field === 'duration' ? 50 : 'changed';
      await assert.rejects(f.actions.runAssistantAction(action), /изменилась|недоступна/u);
      assert.equal(f.$('#editor').open, false);
      assert.equal(f.ports.saves, 0);
    },
  );
for (const change of ['account', 'role', 'organization', 'generation', 'view'])
  test('late source load after ' + change + ' change cannot open the old preview', async (t) => {
    const f = previewFixture(t),
      gate = deferred(),
      action = f.action();
    f.previewControl.ensure = () => gate.promise;
    const pending = f.actions.runAssistantAction(action);
    if (change === 'account') f.state.account.id = 'another-owner';
    if (change === 'role') f.state.account.role = 'cosmetologist';
    if (change === 'organization') f.state.account.organizationId = 'another-org';
    if (change === 'generation') f.state.assistantGeneration++;
    if (change === 'view') f.state.currentView = 'clients';
    gate.resolve(f.data[0]);
    assert.equal(await pending, false);
    assert.equal(f.$('#editor').open, false);
    assert.equal(f.ports.saves, 0);
  });
for (const status of ['cancelled', 'no_show', 'completed'])
  test('closed ' + status + ' appointment cannot receive a preview', async (t) => {
    const f = previewFixture(t);
    f.data[0].appointments[0].status = status;
    await assert.rejects(f.actions.runAssistantAction(f.action()), /изменилась|недоступна/u);
    assert.equal(f.$('#editor').open, false);
    assert.equal(f.ports.saves, 0);
  });
test('missing appointment cannot receive a preview', async (t) => {
  const f = previewFixture(t),
    action = f.action();
  f.data[0].appointments = [];
  await assert.rejects(f.actions.runAssistantAction(action), /изменилась|недоступна/u);
  assert.equal(f.$('#editor').open, false);
});
test('employee cannot preview another performer record even when its source stamp is current', async (t) => {
  const f = previewFixture(t, {
    account: { id: 'synthetic-other', organizationId: 'synthetic-org', role: 'cosmetologist' },
  });
  await assert.rejects(f.actions.runAssistantAction(f.action()), /изменилась|недоступна/u);
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.ports.saves, 0);
});
test('source mutation during actual form loading discards the newly opened stale preview', async (t) => {
  const f = previewFixture(t),
    action = f.action();
  f.previewControl.ensure = async (id, options, count) => {
    if (count === 2) f.data[0].appointments[0].duration = 50;
    return f.data[0];
  };
  await assert.rejects(f.actions.runAssistantAction(action), /изменилась/u);
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.ports.saves, 0);
});
test('source mutation while the refreshed schedule is pending cannot report a valid preview', async (t) => {
  const f = previewFixture(t),
    action = f.action();
  f.previewControl.schedule = async (count) => {
    if (count === 2) f.data[0].appointments[0].time = '16:00';
  };
  const result = await f.actions.runAssistantAction(action).catch(() => false);
  assert.equal(
    result,
    false,
    'a changed source must invalidate the preview even after its initial form check',
  );
  assert.equal(f.ports.saves, 0);
});
for (const operation of ['move', 'edit', 'cancel'])
  test(
    'voice ' +
      operation +
      ' action opens once and confirms only after the actual preview is visible',
    async (t) => {
      const f = previewFixture(t),
        action = f.action(operation),
        before = f.snapshot();
      const reply = {
        policyVersion: 1,
        dialogue: null,
        action,
        text:
          operation === 'cancel'
            ? 'Подготовил отмену. Изменения не сохранены.'
            : 'Подготовил изменение записи. Изменения не сохранены.',
      };
      f.control.turn = async () => reply;
      await f.hold();
      const pending = f.transcript('Синтетическая команда');
      await flush();
      assert.equal(f.$('#editor').open, true);
      assert.equal(f.ports.actionRuns, 1);
      assert.equal(f.played.length, 1);
      assert.equal(f.played[0].result.text, reply.text);
      assert.equal(f.$('.voice-assistant-dialog').open, false);
      await f.finishSpeech();
      await pending;
      assert.equal(f.captures.length, 1);
      assert.equal(f.snapshot(), before);
      assert.equal(f.ports.saves, 0);
    },
  );
for (const event of ['input', 'change'])
  test(
    'user ' + event + ' during awaited schedule refresh suppresses original action confirmation',
    async (t) => {
      const f = previewFixture(t),
        action = f.action(),
        before = f.snapshot();
      f.previewControl.schedule = async (count) => {
        if (count === 2) {
          const field = f.$('#form-content [name="time"]');
          field.value = '16:00';
          field.dispatchEvent(new f.w.Event(event, { bubbles: true }));
        }
      };
      const reply = {
        policyVersion: 1,
        dialogue: null,
        action,
        text: 'Подготовил перенос на 12:30. Изменения не сохранены.',
      };
      f.control.turn = async () => reply;
      await f.hold();
      const pending = f.transcript('Перенеси запись');
      await flush();
      assert.equal(
        f.played.length,
        0,
        'do not announce the original 12:30 after the user entered 16:00',
      );
      await pending;
      assert.equal(f.ports.saves, 0);
      assert.equal(f.snapshot(), before);
    },
  );
test('replacement of the account object during source loading cannot reuse the old session preview', async (t) => {
  const f = previewFixture(t),
    action = f.action(),
    gate = deferred();
  f.previewControl.ensure = () => gate.promise;
  const pending = f.actions.runAssistantAction(action);
  f.state.account = { ...f.state.account };
  gate.resolve(f.data[0]);
  assert.equal(await pending, false);
  assert.equal(f.$('#editor').open, false);
});
test('appointment clarification renders and speaks its short options without instructing a manual Save', async (t) => {
  const f = previewFixture(t);
  f.control.turn = async () => ({
    policyVersion: 1,
    action: null,
    text: 'Какую запись?',
    dialogue: {
      id: 'synthetic-appointment-dialogue',
      version: 0,
      step: 'appointment',
      phase: 'appointmentChoice',
      prompt: 'Какую запись?',
      options: [
        { id: 'synthetic-option1', label: '2030-01-02 · 10:00 · Консультация' },
        { id: 'synthetic-option2', label: '2030-01-03 · 12:00 · Пилинг' },
      ],
      fields: [],
      canEdit: [],
      input: { field: 'appointment', type: 'text' },
    },
  });
  await f.hold();
  const pending = f.transcript('Измени запись');
  await flush();
  assert.equal(f.$('[data-assistant-input-wrap]').hidden, false);
  assert.equal(
    f.$('[data-assistant-conversation]').querySelectorAll('[data-assistant-choice]').length,
    2,
  );
  assert.doesNotMatch(f.played[0].result.text, /Сохранить|сохраните|открой форму/iu);
  await f.finishSpeech();
  await pending;
  assert.equal(f.captures.length, 2);
  assert.equal(f.ports.saves, 0);
});
