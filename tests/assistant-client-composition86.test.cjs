const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managementCycleFixture: setup,
} = require('./helpers/assistant-management-cycle-fixture.cjs');
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createClientCardFlow,
} = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
const {
  createDialogueStore,
} = require('../src/server/modules/assistant/dialogue/dialogue-store.cjs');
const m = (f) => f.entry().data.management;
const patient = (f) => f.entry().data.patient;
for (const raw of [
  'Клиента поменяй на Ольгу Семёнову на завтра в 18:00',
  'На завтра в 18:00 клиента поменяй на Ольгу Семёнову',
  'Клиента поменяй на Ольгу Семёнову в 18:00 на завтра',
  'На завтра клиента поменяй на Ольгу Семёнову в 18:00',
])
  test('whole client and target composition uses the new patient: ' + raw, (t) => {
    const f = setup(t, { date: '2099-01-07', time: '16:00' });
    f.choose(1);
    const before = patient(f).id;
    f.turn(raw);
    assert.notEqual(patient(f).id, before);
    assert.match(patient(f).label, /Ольга/u);
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).targetTime, '18:00');
    if (f.result.dialogue?.phase === 'closedDay') f.turn('да');
    assert.equal(f.result.action.type, 'appointmentPreview');
    assert.match(f.result.text, /Ольга/u);
    assert.equal(f.calls(), 0);
  });
for (const raw of [
  'Клиента поменяй на Ольгу Семёнову на сегодня в 17:00',
  'На сегодня клиента поменяй на Ольгу Семёнову в 17:00',
])
  test('cancel client and source temporal tuple require new bound consent: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    const oldConsent = f.result.dialogue.options[0].id,
      oldClient = patient(f).id;
    f.turn(raw);
    assert.notEqual(patient(f).id, oldClient);
    assert.match(patient(f).label, /Ольга/u);
    assert.equal(m(f).sourceDate, '2099-01-05');
    assert.equal(m(f).sourceTime, '17:00');
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
    f.turn('да, отменить');
    assert.match(f.result.text, /Ольга/u);
    assert.equal(f.calls(), 0);
  });
for (const operation of ['moveAppointment', 'cancelAppointment', 'editAppointment'])
  for (const raw of ['Не Анну, а Ольгу Семёнову', 'Нет, не Анну, а Ольгу Семёнову'])
    test('anchored client replacement retains the operation: ' + operation + ' ' + raw, (t) => {
      const f = setup(t, { intent: operation });
      if (operation !== 'editAppointment') f.choose(1);
      f.turn(raw);
      assert.match(patient(f).label, /Ольга/u);
      assert.equal(m(f).cancelConfirmed, undefined);
      if (operation === 'cancelAppointment')
        assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      if (operation === 'moveAppointment') assert.equal(f.result.dialogue.step, 'date');
      if (operation === 'editAppointment') {
        assert.equal(f.result.action.type, 'appointmentPreview');
        assert.equal(f.result.action.operation, 'edit');
      }
      assert.equal(f.calls(), 0);
    });
for (const raw of [
  'Клиента поменяй на Ольгу Семёнову на завтра в 25:00',
  'Клиента поменяй на Ольгу Семёнову на 31 февраля в 18:00',
])
  test(
    'a partial client correction cannot apply the remaining target to the old patient: ' + raw,
    (t) => {
      const f = setup(t, { date: '2099-01-07', time: '16:00' });
      f.choose(1);
      f.turn(raw);
      assert.match(patient(f).label, /Ольга/u);
      assert.equal(f.result.action, null);
      if (raw.includes('25:00')) {
        assert.equal(m(f).targetDate, '2099-01-06');
        assert.equal(m(f).targetTime, null);
      } else {
        assert.equal(m(f).targetDate, null);
        assert.equal(m(f).targetTime, '18:00');
      }
      assert.equal(f.calls(), 0);
    },
  );
for (const raw of [
  'Клиента поменяй на Ольгу или Анну на завтра в 18:00',
  'Клиента поменяй на Зиновию Абрикосову на завтра в 18:00',
  'Клиента поменяй на Ольгу Семёнову если завтра в 18:00',
  'Клиента поменяй на Ольгу Семёнову на завтра в 18:00 отправь сообщение',
])
  test('unresolved client composition cannot execute the former source: ' + raw, (t) => {
    const f = setup(t, { date: '2099-01-07', time: '16:00' });
    f.choose(1);
    const oldConsent = f.result.dialogue.options[0].id;
    f.turn(raw);
    assert.equal(patient(f), null);
    assert.equal(m(f).source, null);
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue.step, 'client');
    assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
    assert.equal(f.calls(), 0);
  });
for (const tail of ['на пилинг PRX', 'у Марии'])
  test('unresolved relative intention survives full source reselection ' + tail, (t) => {
    const f = setup(t, {}, { relativeTarget: { kind: 'shiftTime', minutes: 60 } });
    f.turn('Перенеси запись Анны Семёновой ' + tail);
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).targetTime || m(f).requestedTime, tail.includes('PRX') ? '13:00' : '15:00');
    assert.equal(f.calls(), 0);
  });
test('unresolved relative client correction uses the fresh new source anchor', (t) => {
  const f = setup(t, {}, { relativeTarget: { kind: 'shiftTime', minutes: 60 } });
  f.turn('Клиента поменяй на Ольгу Семёнову');
  assert.match(patient(f).label, /Ольга/u);
  assert.equal(m(f).targetTime, '18:00');
  assert.equal(m(f).targetDate, '2099-01-05');
  assert.equal(f.calls(), 0);
});
test('source reselection does not apply an already resolved relative shift twice', (t) => {
  const f = setup(
    t,
    { date: '2099-01-07' },
    { relativeTarget: { kind: 'shiftTime', minutes: 60 } },
  );
  f.choose(1);
  assert.equal(m(f).targetTime, '11:00');
  f.turn('Перенеси запись Анны Семёновой на пилинг PRX');
  assert.equal(m(f).targetTime, '11:00');
  assert.equal(m(f).relativeTarget, undefined);
});
test('a still pending month preserves the relative hour through source selection', (t) => {
  const f = setup(
    t,
    {},
    {
      date: null,
      dateProposal: { day: 20, date: '2099-01-20' },
      relativeTarget: { kind: 'shiftTime', minutes: 60 },
    },
  );
  f.turn('Перенеси запись Анны Семёновой на пилинг PRX');
  assert.equal(m(f).dateProposal.day, 20);
  assert.equal(m(f).targetTime, '13:00');
  assert.equal(m(f).targetDate, null);
  assert.equal(f.result.dialogue.phase, 'date');
});
test('keep-time intention retains its new day until a source is selected', (t) => {
  const f = setup(t, { date: '2099-01-07' }, { keepTime: true });
  f.turn('Перенеси запись Анны Семёновой на пилинг PRX');
  assert.equal(m(f).targetDate, '2099-01-07');
  assert.equal(m(f).targetTime, '12:00');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
for (const raw of [
  'Не Анну, а Ольгу Семёнову на завтра в 18:00',
  'Нет, не Анну, а Ольгу Семёнову на завтра в 18:00',
  'Клиента поменяй не Анну, а Ольгу Семёнову на завтра в 18:00',
])
  test('negative client and temporal correction remain one complete composition: ' + raw, (t) => {
    const f = setup(t, { date: '2099-01-07', time: '16:00' });
    f.choose(1);
    f.turn(raw);
    assert.match(patient(f)?.label || '', /Ольга/u);
    assert.equal(m(f).targetDate, '2099-01-06');
    assert.equal(m(f).targetTime, '18:00');
    assert.equal(f.calls(), 0);
  });
test('client/target composition checks current permission before applying either part', (t) => {
  const f = setup(t, { date: '2099-01-07', time: '16:00' });
  f.choose(1);
  f.revoke();
  assert.throws(() => f.turn('Клиента поменяй на Ольгу Семёнову на завтра в 18:00'), {
    status: 403,
  });
  assert.equal(f.calls(), 0);
});
for (const text of [
  'Не записывай эту запись',
  'Не нужно записывать эту запись',
  'Эту запись оставь',
])
  test('whole refusal stops creation without a model or mutation: ' + text, () => {
    const f = dialogueFixture({ ambiguous: true });
    f.start({ query: 'Семёнова', serviceQuery: 'Чистка' });
    const original = JSON.stringify(f.patients);
    const body = {
      dialogueId: f.result.dialogue.id,
      dialogueVersion: f.result.dialogue.version,
      text,
    };
    assert.equal(f.flow.prepareModelTurn(f.c, body, f.state, f.member, f.clock), null);
    const result = f.flow.continueDialogue(f.c, body, f.state, f.member, f.clock);
    assert.equal(result.action, null);
    assert.equal(result.dialogue, null);
    assert.equal(JSON.stringify(f.patients), original);
  });
for (const text of ['Не переноси эту запись', 'Нет, эту запись не переноси', 'Эту запись оставь'])
  test('whole refusal stops the pending move instead of accepting its goal: ' + text, (t) => {
    const f = setup(t, { date: '2099-01-07', time: '16:00' });
    f.choose(1);
    const original = JSON.stringify(f.storage.read());
    f.turn(text);
    assert.equal(f.result.action, null);
    assert.equal(f.result.dialogue, null);
    assert.equal(f.entry().cancelled, true);
    assert.equal(f.calls(), 0);
    assert.equal(JSON.stringify(f.storage.read()), original);
  });
for (const text of ['Не открывай карточку', 'Нет, эту карточку не открывай', 'Эту карточку оставь'])
  test('whole refusal stops an ambiguous card opening: ' + text, () => {
    const f = dialogueFixture({ ambiguous: true }),
      memory = createDialogueStore();
    f.state.policy.commands.clients = true;
    const cards = createClientCardFlow({ memory });
    const first = cards.start(
      f.c,
      { intent: 'clientCard', query: 'Семёнова' },
      f.state,
      f.member,
      f.clock,
      memory.beginCommand(f.c, f.member, f.state),
    );
    const result = cards.continueDialogue(
      f.c,
      { dialogueId: first.dialogue.id, dialogueVersion: first.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    );
    assert.equal(result.action, null);
    assert.equal(result.dialogue, null);
  });
for (const text of [
  'Стоп, не отменяй эту запись',
  'Нет, эту запись не отменяй, я передумал',
  'Не отменяй эту запись, а перенеси на завтра',
])
  test('explicit refusal cannot retain the former cancellation gate: ' + text, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    const original = JSON.stringify(f.storage.read()),
      old = f.result.dialogue;
    f.turn(text);
    assert.equal(f.result.dialogue, null);
    assert.equal(f.result.action, null);
    assert.equal(f.entry().cancelled, true);
    assert.throws(
      () =>
        f.management.continueDialogue(
          f.c,
          { dialogueId: old.id, dialogueVersion: old.version, text: 'да, отменить' },
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    );
    assert.equal(JSON.stringify(f.storage.read()), original);
    assert.equal(f.calls(), 0);
  });
