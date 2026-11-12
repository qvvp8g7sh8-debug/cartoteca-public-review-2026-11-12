const test = require('node:test');
const assert = require('node:assert/strict');
const { cancellationFixture } = require('./helpers/assistant-cancellation-fixture.cjs');
const { moveExecutionFixture } = require('./helpers/assistant-move-execution-fixture.cjs');
for (const operation of ['cancel', 'move'])
  for (const imperfective of [false, true])
    for (const lowercase of [false, true]) {
      test(
        'modal withdrawal closes active ' +
          operation +
          ' proof (' +
          (imperfective ? 'imperfective' : 'perfective') +
          ', lowercase=' +
          lowercase +
          ') and rejects a later yes',
        (t) => {
          const f =
            operation === 'cancel'
              ? cancellationFixture(t, { enabled: false })
              : moveExecutionFixture(t, { enabled: false, targetDate: null, targetTime: null });
          const id = f.result.dialogue.id;
          const entry = f.flow.get(f.c, f.member, f.state, id);
          const before = operation === 'cancel' ? f.row() : f.rows();
          const previousVersion = entry.version;
          const previousChoice = [...entry.options.keys()][0];
          f.c.tenantStore = () =>
            assert.fail('withdrawal must not wait for a clinical source read');
          let text =
            operation === 'cancel'
              ? imperfective
                ? 'Я не хочу отменять запись Анны Семёновой.'
                : 'Я не хочу отменить запись Анны Семёновой.'
              : imperfective
                ? 'Я не хочу переносить запись Анны Семёновой.'
                : 'Я не хочу перенести запись Анны Семёновой.';
          if (lowercase) text = text.toLowerCase().replace('запись ', 'запись, ');
          f.answer({ text });
          assert.equal(f.result.action, null);
          assert.equal(f.result.dialogue, null);
          assert.equal(entry.cancelled, true);
          // Stored proof may remain for receipts, but the cancelled fence makes it inactive.
          if (previousChoice)
            assert.throws(
              () =>
                f.management.continueDialogue(
                  f.c,
                  { dialogueId: id, dialogueVersion: entry.version, choice: previousChoice },
                  f.state,
                  f.member,
                  f.clock,
                ),
              { status: 409 },
            );
          assert.throws(
            () =>
              f.management.continueDialogue(
                f.c,
                { dialogueId: id, dialogueVersion: entry.version, text: 'да' },
                f.state,
                f.member,
                f.clock,
              ),
            { status: 409 },
          );
          assert.throws(
            () =>
              f.management.continueDialogue(
                f.c,
                { dialogueId: id, dialogueVersion: previousVersion, text: 'да' },
                f.state,
                f.member,
                f.clock,
              ),
            { status: 409 },
          );
          assert.deepEqual(operation === 'cancel' ? f.row() : f.rows(), before);
        },
      );
    }
test('withdrawal does not turn conditions, replacement clauses or another operation into cancellation', (t) => {
  for (const text of [
    'Я не хочу перенести запись Анны Семёновой.',
    'Я не хочу отменить запись Анны Семёновой, а перенести её.',
    'Я не хочу отменить запись Анны Семёновой если завтра выходной.',
    'Не меняй услугу.',
  ]) {
    const f = cancellationFixture(t, { enabled: false });
    const entry = f.flow.get(f.c, f.member, f.state, f.result.dialogue.id);
    f.answer({ text });
    assert.equal(Boolean(entry.cancelled), false);
    assert.equal(f.result.action, null);
  }
});
const { dialogueFixture } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
for (const intent of ['cancelAppointment', 'moveAppointment'])
  test('client-choice withdrawal preserves fences for ' + intent, () => {
    const f = dialogueFixture({ ambiguous: true });
    Object.assign(f.patients[1], { firstName: 'Анна', lastName: 'Иванова', name: 'Анна Иванова' });
    for (const patient of f.patients)
      patient.appointments = [
        {
          id: require('node:crypto').randomUUID(),
          date: '2099-01-05',
          time: '10:00',
          duration: 30,
          staffId: 'owner',
          roomId: 'main',
          status: 'scheduled',
          service: 'Чистка',
          serviceItems: [],
        },
      ];
    const management = createAppointmentManagementFlow({ memory: f.flow });
    const initial = management.start(
      f.c,
      { intent, query: 'Анна' },
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
    );
    assert.equal(initial.dialogue.step, 'client');
    const entry = f.flow.get(f.c, f.member, f.state, initial.dialogue.id);
    const body = {
      dialogueId: entry.id,
      dialogueVersion: entry.version,
      text:
        intent === 'cancelAppointment'
          ? 'я не хочу отменить запись, анны семёновой.'
          : 'я не хочу переносить запись, анны семёновой.',
    };
    const choice = initial.dialogue.options[0].id;
    const before = structuredClone(f.patients);
    f.c.tenantStore = () =>
      assert.fail('withdraw at client choice must not query candidates again');
    assert.throws(
      () =>
        management.continueDialogue(
          f.c,
          { ...body, dialogueVersion: entry.version + 1 },
          f.state,
          f.member,
          f.clock,
        ),
      { status: 409 },
    );
    assert.equal(Boolean(entry.cancelled), false);
    const result = management.continueDialogue(f.c, body, f.state, f.member, f.clock);
    assert.equal(entry.cancelled, true);
    assert.equal(result.action, null);
    assert.equal(result.dialogue, null);
    assert.deepEqual(management.continueDialogue(f.c, body, f.state, f.member, f.clock), result);
    for (const answer of [{ text: 'да' }, { choice }])
      assert.throws(
        () =>
          management.continueDialogue(
            f.c,
            { dialogueId: entry.id, dialogueVersion: entry.version, ...answer },
            f.state,
            f.member,
            f.clock,
          ),
        { status: 409 },
      );
    assert.deepEqual(f.patients, before);
  });
