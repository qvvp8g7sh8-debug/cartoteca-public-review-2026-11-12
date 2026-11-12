const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managementCycleFixture: setup,
} = require('./helpers/assistant-management-cycle-fixture.cjs');
const {
  bareManagementClientCorrection,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-client.cjs');

const management = (f) => f.entry().data.management;
const olga = (f) => f.storage.read().patients.find((p) => p.firstName === 'Ольга');
for (const raw of [
  'Нет, Ольги на 2099-01-05 в 17:00',
  'Нет, Ольги на сегодня в 17:00',
  'Нет, на сегодня Ольги в 17:00',
  'Нет, в 17:00 Ольги на сегодня',
  'Нет, Ольги Семёновой на сегодня в 17:00',
  'Нет, Ольги',
  'Нет. Ольги на сегодня в 17:00',
  'Нет; Ольги на сегодня в 17:00',
  'Нет: Ольги на сегодня в 17:00',
  'Нет! Ольги на сегодня в 17:00',
  'Нет? Ольги на сегодня в 17:00',
  'Нет… Ольги на сегодня в 17:00',
  'Нет\nОльги на сегодня в 17:00',
])
  test(
    'bare cancellation client correction binds consent and execution to the new source: ' + raw,
    async (t) => {
      const f = setup(t, { intent: 'cancelAppointment' }, {}, { enabled: true });
      f.choose(1);
      const previousSource = structuredClone(management(f).source);
      const previousConsent = f.result.dialogue.options[0].id;
      const newPatient = olga(f);
      const target = newPatient.appointments[0];
      f.turn(raw);
      assert.equal(f.entry().data.patient.id, newPatient.id);
      assert.equal(management(f).source.appointmentId, target.id);
      assert.equal(management(f).cancelConfirmation.appointment.id, target.id);
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.notEqual(f.result.dialogue.options[0].id, previousConsent);
      assert.throws(() => f.answer({ choice: previousConsent }), { status: 409 });
      assert.equal(f.calls(), 0);
      f.turn('Да, отменяй');
      assert.equal(f.result.action.type, 'cancelAppointment');
      const saved = await f.api.execute(f.c, f.body());
      assert.equal(saved.appointmentId, target.id);
      assert.equal(saved.cancelled, true);
      assert.equal(f.calls(), 1);
      const after = f.storage.read();
      assert.equal(
        after.patients.find((p) => p.id === newPatient.id).appointments[0].status,
        'cancelled',
      );
      assert.equal(
        after.patients
          .find((p) => p.id === previousSource.patientId)
          .appointments.find((a) => a.id === previousSource.appointmentId).status,
        'scheduled',
      );
    },
  );

for (const raw of [
  'Нет, Богдана на сегодня в 10:00',
  'Нет, Зиновии Абрикосовой на сегодня в 10:00',
])
  test(
    'an unknown bare client correction revokes consent instead of filtering the former patient: ' +
      raw,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.choose(1);
      const previousConsent = f.result.dialogue.options[0].id;
      f.turn(raw);
      assert.equal(f.entry().data.patient, null);
      assert.equal(management(f).source, null);
      assert.equal(management(f).cancelConfirmation, undefined);
      assert.equal(f.result.dialogue.step, 'client');
      assert.throws(() => f.answer({ choice: previousConsent }), { status: 409 });
      f.turn('Да, отменяй');
      assert.equal(f.result.action, null);
      assert.equal(f.calls(), 0);
    },
  );

test('a proven service correction remains a service correction', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const patientId = f.entry().data.patient.id;
  f.turn('Нет, пилинг PRX');
  assert.equal(f.entry().data.patient.id, patientId);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.match(f.result.dialogue.fields.find((field) => field.key === 'service').value, /Пилинг/u);
  assert.equal(f.calls(), 0);
});

test('a negative ordinal keeps its existing source-selection meaning', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const patientId = f.entry().data.patient.id;
  const wanted = management(f).sourceChoices[1];
  f.turn('Нет, вторую');
  assert.equal(f.entry().data.patient.id, patientId);
  assert.equal(management(f).source.appointmentId, wanted.appointmentId);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.equal(f.calls(), 0);
});

test('an identity shared by an available client and source service asks which role to change', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.mutate((next) => {
    next.patients[0].appointments[1].service = 'Ольга';
    next.patients[0].appointments[1].serviceItems = [];
  });
  f.choose(1);
  const oldConsent = f.result.dialogue.options[0].id;
  f.turn('Нет, Ольга');
  assert.equal(f.result.text, 'Клиента или услугу изменить?');
  assert.equal(management(f).source, null);
  assert.equal(management(f).cancelConfirmation, undefined);
  assert.equal(f.result.dialogue.options.length, 0);
  assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
  assert.equal(f.calls(), 0);
});

for (const raw of [',', '.', ';', ':'].flatMap((separator) => [
  'Нет' + separator + ' Ольги если на сегодня в 10:00',
  'Нет' + separator + ' Ольги на сегодня в 10:00 отправь сообщение',
  'Нет' + separator + ' Ольги или Анны на сегодня в 10:00',
]))
  test(
    'unproven negative replacement cannot retain executable old cancellation consent: ' + raw,
    (t) => {
      const f = setup(t, { intent: 'cancelAppointment' });
      f.choose(1);
      const oldConsent = f.result.dialogue.options[0].id;
      f.turn(raw);
      assert.equal(management(f).source, null);
      assert.equal(management(f).cancelConfirmation, undefined);
      assert.equal(f.result.dialogue.phase, 'appointmentChoice');
      assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
      f.turn('Да, отменяй');
      assert.equal(f.result.action, null);
      assert.equal(f.calls(), 0);
    },
  );

test('a new bare patient with an invalid clock is retained and the source clock is asked', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  f.turn('Нет, Ольги на сегодня в 25:00');
  assert.equal(f.entry().data.patient.id, olga(f).id);
  assert.equal(f.result.text, 'Во сколько запись?');
  assert.equal(management(f).sourceTimeRequired, true);
  assert.equal(management(f).source, null);
  assert.equal(f.calls(), 0);
});

for (const operation of ['moveAppointment', 'editAppointment'])
  test(
    'the same bare client composition keeps the existing management operation: ' + operation,
    (t) => {
      const f = setup(t, { intent: operation });
      if (operation === 'moveAppointment') f.choose(1);
      f.turn('Нет, Ольги на завтра в 18:00');
      assert.equal(f.entry().data.patient.id, olga(f).id);
      assert.equal(management(f).operation, operation === 'moveAppointment' ? 'move' : 'edit');
      if (operation === 'moveAppointment') {
        assert.equal(management(f).targetDate, '2099-01-06');
        assert.equal(management(f).targetTime, '18:00');
      }
      assert.equal(f.calls(), 0);
    },
  );

test('bare parser proves the complete replacement and leaves unsafe tails unparsed', () => {
  const clock = { date: '2099-01-05' };
  assert.equal(
    bareManagementClientCorrection('Нет, Ольги на сегодня в 17:00', clock).query,
    'Ольги',
  );
  assert.equal(bareManagementClientCorrection('Нет, Ольги если сегодня в 17:00', clock), null);
  assert.equal(bareManagementClientCorrection('Нет, у Марии', clock), null);
  assert.equal(bareManagementClientCorrection('Нет, январь', clock), null);
  assert.equal(bareManagementClientCorrection('Нет, двенадцать', clock), null);
  assert.equal(bareManagementClientCorrection('Нет, вторую на завтра', clock), null);
  assert.equal(bareManagementClientCorrection('Нет, на пилинг PRX', clock), null);
});

for (const [raw, expected] of [
  ['Нет. пилинг PRX', 'Пилинг'],
  ['Нет, на пилинг PRX', 'Пилинг'],
  ['Нет; на пилинг PRX', 'Пилинг'],
  ['Нет; вторую', 'Пилинг'],
])
  test('leading ASR punctuation retains an established source correction: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' });
    f.choose(1);
    const patientId = f.entry().data.patient.id;
    f.turn(raw);
    assert.equal(f.entry().data.patient.id, patientId);
    assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
    assert.match(
      f.result.dialogue.fields.find((field) => field.key === 'service').value,
      new RegExp(expected, 'u'),
    );
    assert.equal(f.calls(), 0);
  });

test('the leading correction boundary is strict and does not discard an inner condition', () => {
  const {
    managementCorrectionRemainder,
  } = require('../src/server/modules/assistant/actions/appointments/appointment-management-replacement.cjs');
  assert.equal(managementCorrectionRemainder('Нет; Ольги если завтра'), 'Ольги если завтра');
  assert.equal(managementCorrectionRemainder('НетОльги на завтра'), null);
  assert.equal(managementCorrectionRemainder('Ольги нет на завтра'), null);
  assert.equal(managementCorrectionRemainder('Нет. '), null);
});

test('a correction exceeding the entity parser limit still revokes cancellation consent', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' }, {}, { enabled: true });
  f.choose(1);
  const oldConsent = f.result.dialogue.options[0].id;
  const raw = 'Нет. Ольги на сегодня в 17:00, ' + 'неизвестная дополнительная часть '.repeat(8);
  assert.ok(raw.length > 160 && raw.length < 2000);
  const {
    managementCorrectionRemainder,
    hasManagementCorrectionPrefix,
  } = require('../src/server/modules/assistant/actions/appointments/appointment-management-replacement.cjs');
  assert.equal(managementCorrectionRemainder(raw), null);
  assert.equal(hasManagementCorrectionPrefix(raw), true);
  f.turn(raw);
  assert.equal(management(f).source, null);
  assert.equal(management(f).cancelConfirmation, undefined);
  assert.equal(f.result.dialogue.phase, 'appointmentChoice');
  assert.throws(() => f.answer({ choice: oldConsent }), { status: 409 });
  f.turn('Да, отменяй');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
});
