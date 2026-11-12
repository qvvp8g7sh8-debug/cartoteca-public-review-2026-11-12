const test = require('node:test');
const assert = require('node:assert/strict');
const {
  managementCycleFixture: setup,
} = require('./helpers/assistant-management-cycle-fixture.cjs');
const {
  rejectedSourceOnlyCorrection,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-replacement.cjs');
const {
  managementSource,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-references.cjs');
const m = (f) => f.entry().data.management;
function plain(f) {
  const copy = structuredClone(m(f));
  for (const key of ['cancelConfirmation', 'cancelConfirmed', 'sourceChoices']) delete copy[key];
  return copy;
}
const rejected = [
  'Нет, в 18:00 или 19:00',
  'Нет, отмени другую запись',
  'Нет, если завтра',
  'Нет, если завтра у Марии',
  'Нет, завтра или сегодня у Марии',
  'Нет, завтра у Марии отмени другую запись',
];
for (const raw of rejected)
  test(
    'rejected source roles retain context and require a fresh selection and consent: ' + raw,
    async (t) => {
      const f = setup(t, { intent: 'cancelAppointment' }, {}, { enabled: true });
      f.choose(1);
      const before = plain(f),
        patient = structuredClone(f.entry().data.patient);
      const old = {
        dialogueId: f.result.dialogue.id,
        dialogueVersion: f.result.dialogue.version,
        choice: f.result.dialogue.options[0].id,
      };
      assert.equal(rejectedSourceOnlyCorrection(raw, managementSource(f.c, m(f).source)), true);
      f.turn(raw);
      assert.deepEqual(plain(f), before);
      assert.deepEqual(f.entry().data.patient, patient);
      assert.equal(m(f).cancelConfirmation, undefined);
      assert.equal(m(f).cancelConfirmed, undefined);
      assert.equal(f.result.action, null);
      assert.equal(f.result.dialogue.phase, 'appointmentChoice');
      assert.ok(f.result.dialogue.version > old.dialogueVersion);
      assert.ok([...f.entry().options.values()].every((row) => row.kind === 'appointmentSource'));
      assert.throws(() => f.management.continueDialogue(f.c, old, f.state, f.member, f.clock), {
        status: 409,
      });
      assert.throws(() => f.answer({ choice: old.choice }), { status: 409 });
      f.turn('Да, отменяй');
      assert.equal(f.result.action, null);
      assert.equal(f.calls(), 0);
      const selected = f.entry().options.get(f.result.dialogue.options[1].id).value;
      f.choose(2);
      assert.equal(m(f).source.appointmentId, selected.appointmentId);
      assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
      assert.equal(f.result.action, null);
      assert.equal(m(f).cancelConfirmed, undefined);
      f.turn('Да, отменить');
      assert.equal(f.result.action.type, 'cancelAppointment');
      await f.api.execute(f.c, f.body());
      assert.equal(f.calls(), 1);
      assert.equal(f.rows().find((row) => row.id === selected.appointmentId).status, 'cancelled');
      assert.equal(
        f.rows().find((row) => row.id === before.source.appointmentId).status,
        'scheduled',
      );
    },
  );

test('source rejection preserves explicit filters and one current choice still needs new consent', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' }, {}, { enabled: true });
  f.choose(1);
  const source = managementSource(f.c, m(f).source).appointment;
  Object.assign(m(f), {
    sourceDate: source.date,
    sourceTime: source.time,
    sourceDay: Number(source.date.slice(8)),
    sourceMonth: Number(source.date.slice(5, 7)),
    sourceYear: source.date.slice(0, 4),
    sourceYearRequired: false,
    sourceServiceQuery: source.service,
  });
  const before = plain(f),
    old = f.result.dialogue.options[0].id;
  f.turn('Нет, в 18:00 или 19:00');
  assert.deepEqual(plain(f), before);
  assert.equal(f.result.dialogue.options.length, 1);
  assert.equal(m(f).cancelConfirmation, undefined);
  f.turn('Да');
  assert.equal(f.result.action, null);
  assert.equal(f.calls(), 0);
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.notEqual(f.result.dialogue.options[0].id, old);
  assert.equal(m(f).cancelConfirmed, undefined);
  assert.throws(() => f.answer({ choice: old }), { status: 409 });
});

for (const raw of [
  'Нет, на Ольгу если завтра',
  'Нет, завтра Ольги',
  'Нет, Ольги если завтра',
  'Нет, 9327006 завтра',
  'Нет, на 9327006 если завтра',
  'Нет, 932,70,06 на завтра',
  'Нет, на 932,70,06 если завтра',
  'Нет, на 7006 если завтра',
  'Нет, завтра у Зиновии',
  'Нет, если завтра у Марии Ольги',
  'Нет, в 18:00 или 19:00 Ольги',
  'Нет, завтра отправь сообщение',
  'Нет. Ольги на сегодня в 17:00, ' + 'неизвестная дополнительная часть '.repeat(8),
])
  test('unproven names and phones keep strict87 consent revocation: ' + raw, (t) => {
    const f = setup(t, { intent: 'cancelAppointment' }, {}, { enabled: true });
    f.choose(1);
    const selected = managementSource(f.c, m(f).source),
      old = f.result.dialogue.options[0].id;
    assert.equal(rejectedSourceOnlyCorrection(raw, selected), false);
    f.turn(raw);
    assert.equal(m(f).source, null);
    assert.equal(m(f).cancelConfirmation, undefined);
    assert.equal(m(f).cancelConfirmed, undefined);
    assert.equal(f.result.action, null);
    const current = { dialogueId: f.entry().id, dialogueVersion: f.entry().version };
    assert.throws(
      () =>
        f.management.continueDialogue(f.c, { ...current, choice: old }, f.state, f.member, f.clock),
      { status: 409 },
    );
    if (f.result.dialogue) f.turn('Да, отменяй');
    else
      assert.throws(
        () =>
          f.management.continueDialogue(
            f.c,
            { ...current, text: 'Да, отменяй' },
            f.state,
            f.member,
            f.clock,
          ),
        { status: 409 },
      );
    assert.equal(f.result.action, null);
    assert.equal(f.calls(), 0);
  });

test('staff role coverage uses existing scoped names and consumes the entire remainder', (t) => {
  const f = setup(t, { intent: 'cancelAppointment' });
  f.choose(1);
  const selected = managementSource(f.c, m(f).source);
  assert.equal(rejectedSourceOnlyCorrection('Нет, если завтра у Марии', selected), true);
  assert.equal(rejectedSourceOnlyCorrection('Нет, если завтра у Марии'), false);
  assert.equal(rejectedSourceOnlyCorrection('Нет, если завтра у Марии Ивановой', selected), true);
  assert.equal(rejectedSourceOnlyCorrection('Нет, если завтра у Марии Анны', selected), false);
  assert.equal(
    rejectedSourceOnlyCorrection('Нет, если завтра у Марии отправь сообщение', selected),
    false,
  );
  assert.equal(rejectedSourceOnlyCorrection('Нет, в 18:00 или 19:00', selected), true);
  assert.equal(rejectedSourceOnlyCorrection('в 18:00 или 19:00', selected), false);
});
