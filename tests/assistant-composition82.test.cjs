const test = require('node:test');
const assert = require('node:assert/strict');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  prepareManagementIntent,
  localManagementIntent,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-intent.cjs');
const {
  continuationExample,
} = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
function setup(t, values = {}, options = {}) {
  const f = moveExecutionFixture(t, {
    enabled: false,
    targetDate: null,
    targetTime: null,
    ...options,
    beforeStart(f) {
      f.addBooking({
        date: '2099-01-06',
        time: '12:00',
        service: 'Пилинг PRX-T133',
        serviceItems: [],
      });
      f.addBooking({ date: '2099-01-06', time: '15:00', service: 'Чистка', serviceItems: [] });
    },
  });
  f.start(values);
  const id = f.result.dialogue?.id;
  return {
    ...f,
    get result() {
      return f.result;
    },
    entry: () => f.flow.get(f.c, f.member, f.state, id),
  };
}
const m = (f) => f.entry().data.management;
const source = (f) => f.rows().find((row) => row.id === m(f).source?.appointmentId);
for (const raw of [
  'Перенеси запись Анны Семёновой завтра в 16:00 на пилинг PRX',
  'Перенеси запись Анны Семёновой на пилинг PRX на завтра в 16:00',
])
  test('a repeated source service replaces the original appointment: ' + raw, (t) => {
    const f = setup(t);
    f.answer({ choice: f.result.dialogue.options[0].id });
    const before = m(f).source.appointmentId;
    f.answer({ text: raw });
    assert.equal(source(f).service, 'Пилинг PRX-T133');
    assert.notEqual(m(f).source.appointmentId, before);
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).targetTime, '16:00');
    assert.equal(f.result.action.type, 'appointmentPreview');
    assert.equal(f.calls(), 0);
  });
test('a repeated service-only request cannot invent an unknown target day', (t) => {
  const f = setup(t);
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'Перенеси запись Анны Семёновой на пилинг PRX' });
  assert.equal(source(f).service, 'Пилинг PRX-T133');
  assert.equal(m(f).targetDate, null);
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(f.result.action, null);
});
test('a repeated service-only request preserves the known target but renews the source', (t) => {
  const f = setup(t, { date: '2099-01-06' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'Перенеси запись Анны Семёновой на пилинг PRX' });
  assert.equal(source(f).service, 'Пилинг PRX-T133');
  assert.equal(m(f).targetDate, '2099-01-06');
  assert.equal(f.result.dialogue.step, 'time');
  assert.equal(f.result.action, null);
});
for (const raw of [
  'вторую на завтра в 16:00',
  'Перенеси вторую на завтра в 16:00',
  'вторую запись, на завтра в 16:00',
])
  test('a source choice and complete target are applied together: ' + raw, (t) => {
    const f = setup(t);
    f.answer({ text: raw });
    assert.equal(source(f).service, 'Пилинг PRX-T133');
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).targetTime, '16:00');
    assert.equal(f.result.action.type, 'appointmentPreview');
    assert.equal(f.calls(), 0);
  });
for (const raw of ['вторую на час позже', 'вторую на час раньше'])
  test('a bound source selection supplies a relative anchor: ' + raw, (t) => {
    const f = setup(t);
    f.answer({ text: raw });
    assert.equal(source(f).service, 'Пилинг PRX-T133');
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).targetTime, raw.includes('позже') ? '13:00' : '11:00');
  });
for (const raw of [
  'вторую если завтра в 16:00',
  'вторую или третью на завтра',
  'вторую на завтра в 16:00 отправь сообщение',
  'вторую на завтра в 16:00 Мария',
])
  test('source/target composition cannot discard conditions or trailing words: ' + raw, (t) => {
    const f = setup(t);
    f.answer({ text: raw });
    assert.equal(m(f).source, null);
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });
for (const [raw, fields] of [
  ['Перенеси запись Анны Семёновой на пилинг PRX на час позже', { serviceQuery: 'пилинг PRX' }],
  ['Перенеси запись Анны Семёновой у Марии на час позже', { staffQuery: 'Марии' }],
  ['Перенеси запись Анны Семёновой на пилинг PRX на час раньше', { serviceQuery: 'пилинг PRX' }],
])
  test('proven source entities do not consume a relative clause: ' + raw, () => {
    const clock = { date: '2099-01-05', hour: 8, minute: 0 };
    const prepared = prepareManagementIntent(
      { intent: 'moveAppointment', query: 'Анны Семёновой', ...fields },
      raw,
      clock,
    );
    assert.equal(prepared.constraints.relativeTarget.kind, 'shiftTime');
    assert.equal(prepared.constraints.relativeTarget.minutes, raw.includes('раньше') ? -60 : 60);
    if (fields.serviceQuery)
      assert.equal(localManagementIntent(raw, clock).serviceQuery, 'пилинг PRX');
  });
test('initial source-service relative move reaches its anchored target', (t) => {
  const f = setup(t),
    raw = 'Перенеси запись Анны Семёновой на пилинг PRX на час позже';
  const prepared = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Анны Семёновой', serviceQuery: 'пилинг PRX' },
    raw,
    f.clock,
  );
  const r = f.management.start(
    f.c,
    prepared.intent,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    prepared.constraints,
  );
  assert.equal(r.action.date, '2099-01-06');
  assert.equal(r.action.time, '13:00');
  assert.equal(r.action.type, 'appointmentPreview');
  assert.equal(f.calls(), 0);
});
for (const raw of [
  'Утром в ноябре',
  'В шестнадцать тридцать в ноябре',
  'В ноябре после обеда',
  'После обеда в ноябре',
])
  test('a pending month works in either order and with shared period synonyms: ' + raw, () => {
    const f = dialogueFixture();
    f.start({ query: 'Анна Семёнова', serviceQuery: 'Чистка' }, { date: null });
    f.answer({ text: 'на двадцать девятое' });
    const body = {
      dialogueId: f.result.dialogue.id,
      dialogueVersion: f.result.dialogue.version,
      text: raw,
    };
    const snapshot = f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock);
    const proposal = /шестнадцать/u.test(raw)
      ? continuationExample({ operation: 'patch', fields: { time: '16:30' } })
      : continuationExample({ operation: 'slots' });
    const r = snapshot
      ? f.flow.applyModelTurn(f.c, body, f.state, f.member, f.clock, proposal, snapshot)
      : f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    const data = f.flow.get(f.c, f.member, f.state, body.dialogueId).data;
    assert.equal(data.date, '2099-11-29');
    assert.equal(data.dateProposal, undefined);
    assert.equal(r.action, null);
    assert.equal(f.patients[0].appointments.length, 0);
    if (/шестнадцать/u.test(raw)) assert.equal(data.time, '16:30');
    else assert.equal(data.timeWindow.kind, /обеда/u.test(raw) ? 'day' : 'morning');
  });
for (const raw of [
  'Нет, на пилинг PRX завтра',
  'Нет, завтра на пилинг PRX',
  'Нет, завтра в 12:00 на пилинг PRX',
])
  test(
    'a composite cancellation correction renews consent for the matching source: ' + raw,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.answer({ choice: f.result.dialogue.options[0].id });
      const oldSource = m(f).source.appointmentId;
      f.answer({ text: raw });
      assert.notEqual(m(f).source.appointmentId, oldSource);
      assert.equal(source(f).service, 'Пилинг PRX-T133');
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.equal(f.result.action, null);
      assert.equal(m(f).cancelConfirmed, undefined);
      assert.match(f.result.text, /завтра в 12:00/u);
      assert.equal(f.calls(), 0);
    },
  );
test('an unknown composite cancellation filter cannot retain old consent or silently cancel', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'Нет, завтра на массаж' });
  assert.equal(m(f).source, null);
  assert.equal(m(f).cancelConfirmed, undefined);
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
test('keepTime without a target day asks for the date and preserves the source clock', (t) => {
  const f = setup(t);
  f.answer({ choice: f.result.dialogue.options[0].id });
  f.answer({ text: 'в то же время' });
  assert.equal(m(f).targetDate, null);
  assert.equal(m(f).targetTime, '10:00');
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(f.result.action, null);
  f.answer({ text: 'на завтра' });
  assert.equal(m(f).targetDate, '2099-01-06');
  assert.equal(m(f).targetTime, '10:00');
  assert.equal(f.result.action.type, 'appointmentPreview');
});
test('initial keepTime without date does not silently reuse the source date', (t) => {
  const f = setup(t),
    raw = 'Перенеси запись Анны Семёновой в то же время';
  const p = prepareManagementIntent(
    { intent: 'moveAppointment', query: 'Анны Семёновой' },
    raw,
    f.clock,
  );
  const r = f.management.start(
    f.c,
    p.intent,
    f.state,
    f.member,
    f.clock,
    f.flow.beginCommand(f.c, f.member, f.state),
    p.constraints,
  );
  const choice = r.dialogue.options[0].id;
  const next = f.management.continueDialogue(
    f.c,
    { dialogueId: r.dialogue.id, dialogueVersion: r.dialogue.version, choice },
    f.state,
    f.member,
    f.clock,
  );
  assert.equal(next.dialogue.step, 'date');
  assert.equal(next.action, null);
});
test('an explicitly unchanged tuple cannot produce a completed move', (t) => {
  const f = setup(t, { date: '2099-01-05', time: '10:00' });
  f.answer({ choice: f.result.dialogue.options[0].id });
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.step, 'date');
  assert.match(f.result.text, /не изменились/u);
});
test('opening an existing appointment at the same coordinates remains allowed', (t) => {
  const f = setup(t, { intent: 'editAppointment', date: '2099-01-05', time: '10:00' });
  assert.equal(f.result.dialogue, null);
  assert.equal(f.result.action.type, 'appointmentPreview');
  assert.equal(f.result.action.operation, 'edit');
});
test('new pending-month examples agree with the real continuation guard and require pending context', () => {
  const {
    continuationExamples,
  } = require('../src/server/modules/assistant/dialogue/continuation/continuation-examples.cjs');
  const {
    continuationOperation,
  } = require('../src/server/modules/assistant/dialogue/continuation/continuation-operation.cjs');
  const {
    safeContinuationContext,
  } = require('../src/server/modules/assistant/dialogue/continuation/continuation-contract.cjs');
  const clock = { date: '2099-01-05', hour: 8, minute: 0 };
  const entry = {
    step: 'date',
    options: new Map(),
    data: { dateProposal: { day: 29, date: '2099-01-29' } },
  };
  const context = safeContinuationContext(entry, 'owner', clock);
  for (const text of [
    'Утром в ноябре',
    'В ноябре после обеда',
    'В шестнадцать тридцать в ноябре',
  ]) {
    const selected = continuationExamples(text, context);
    const example = selected.examples.find((row) => row.text === text);
    assert.ok(example);
    const actual = continuationOperation(example.expected, { text }, entry, clock);
    assert.equal(actual.constraints.date, '2099-11-29');
    assert.ok(
      !continuationExamples(text, { ...context, dateClarification: undefined }).examples.some(
        (row) => row.text === text,
      ),
    );
  }
});
test('a literal source staff remains separate from client and relative target', () => {
  const clock = { date: '2099-01-05', hour: 8, minute: 0 };
  const value = localManagementIntent('Перенеси запись Анны Семёновой у Марии на час позже', clock);
  assert.equal(value.query, 'Анны Семёновой');
  assert.equal(value.staffQuery, 'Марии');
});
test('a selected source cannot be executed after its stamp changes', (t) => {
  const f = setup(t);
  const oldChoice = f.result.dialogue.options[1].id;
  f.mutate((next) => {
    next.patients[0].appointments[1].time = '12:30';
  });
  assert.throws(() => f.answer({ text: 'вторую на завтра в 16:00' }), { status: 409 });
  assert.equal(m(f).source, null);
  assert.equal(f.calls(), 0);
  assert.ok(oldChoice);
});
test('a revoked scope cannot accept a combined source/target reply', (t) => {
  const f = setup(t);
  f.revoke();
  assert.throws(() => f.answer({ text: 'вторую на завтра в 16:00' }), { status: 403 });
  assert.equal(f.calls(), 0);
});
test('combined source selection still checks occupied target time', (t) => {
  const f = setup(t);
  f.answer({ text: 'вторую на завтра в 15:00' });
  assert.equal(f.result.action, null);
  assert.equal(source(f).service, 'Пилинг PRX-T133');
  assert.equal(f.calls(), 0);
});
test('a corrected cancellation rejects the former consent and commits only the newly confirmed TEMP appointment', async (t) => {
  const f = setup(t, { intent: 'cancelAppointment' }, { enabled: true });
  f.answer({ choice: f.result.dialogue.options[0].id });
  const oldConsent = f.result.dialogue.options[0].id,
    oldSource = m(f).source.appointmentId;
  f.answer({ text: 'Нет, завтра на пилинг PRX' });
  const selected = m(f).source.appointmentId;
  assert.notEqual(selected, oldSource);
  assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
  assert.equal(m(f).cancelConfirmed, undefined);
  f.answer({ text: 'да, отменить' });
  assert.equal(f.result.action.type, 'cancelAppointment');
  const body = f.body();
  const r = await f.api.execute(f.c, body);
  assert.equal(r.cancelled, true);
  assert.equal(f.rows().find((row) => row.id === oldSource).status, 'scheduled');
  assert.equal(f.rows().find((row) => row.id === selected).status, 'cancelled');
  await f.api.execute(f.c, body);
  assert.equal(f.calls(), 1);
});
test('a repeated command moves only the new service source through the common TEMP executor', async (t) => {
  const f = setup(t, {}, { enabled: true });
  f.answer({ choice: f.result.dialogue.options[0].id });
  const old = m(f).source.appointmentId;
  f.answer({ text: 'Перенеси запись Анны Семёновой на пилинг PRX на завтра в 16:00' });
  assert.equal(f.result.action.type, 'moveAppointment');
  const selected = m(f).source.appointmentId;
  const r = await f.api.execute(f.c, f.body());
  assert.equal(r.moved, true);
  assert.equal(f.rows().find((row) => row.id === old).time, '10:00');
  assert.equal(f.rows().find((row) => row.id === selected).time, '16:00');
  assert.equal(f.calls(), 1);
});
