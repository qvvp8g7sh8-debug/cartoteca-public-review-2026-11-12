const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');
const {
  managementClientContext,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-scope.cjs');
const { resolveClient } = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const { createClientCardFlow } = require('../src/server/modules/assistant/actions/client-card-flow.cjs');
function fixture(t, { role = 'owner' } = {}) {
  const f = dialogueFixture({ role });
  const appointment = {
    id: randomUUID(),
    date: day,
    time: '10:00',
    duration: 30,
    staffId: 'owner',
    status: 'scheduled',
    service: 'Чистка',
  };
  Object.assign(f.patients[0], {
    firstName: 'Дарья',
    lastName: 'Козлова',
    name: 'Дарья Козлова',
    appointments: [appointment],
  });
  f.patients.push({
    ...f.patients[0],
    id: randomUUID(),
    firstName: 'Дарина',
    name: 'Дарина Козлова',
    appointments: [],
  });
  const storage = f.c.tenantStore('org');
  storage.readSelected = (ids) => ({
    patients: f.patients.filter((row) => ids.includes(row.id)),
    services: [],
    revision: 1,
  });
  storage.indexes.summaryRows = (current, ids) =>
    f.patients
      .filter((row) => !ids || ids.includes(row.id))
      .map((row) => ({ patient_id: row.id, value: storage.encode(row) }));
  storage.read = () => {
    throw Error('Full cabinet read is forbidden');
  };
  let writes = 0;
  for (const key of ['write', 'save', 'saveAppointment'])
    storage[key] = () => {
      writes++;
      throw Error('Turn must not write');
    };
  f.state.providers = { llm: { provider: 'codex', model: 'synthetic-no-provider' } };
  const flow = createAppointmentManagementFlow({ memory: f.flow, appointmentSavingEnabled: true });
  let result;
  const start = (intent = 'cancelAppointment', query = 'Козлова') =>
    (result = flow.start(
      f.c,
      { intent, query },
      f.state,
      f.member,
      f.clock,
      f.flow.beginCommand(f.c, f.member, f.state),
    ));
  const answer = (text) =>
    (result = flow.continueDialogue(
      f.c,
      { dialogueId: result.dialogue.id, dialogueVersion: result.dialogue.version, text },
      f.state,
      f.member,
      f.clock,
    ));
  t.after(() => assert.equal(writes, 0));
  return {
    ...f,
    memory: f.flow,
    flow,
    start,
    answer,
    appointment,
    get result() {
      return result;
    },
  };
}

test('management exact matching sees only the client with an accessible active future appointment before choosing names', (t) => {
  const f = fixture(t);
  const scoped = managementClientContext(f.c);
  const eligible = resolveClient(scoped, 'Козлова'),
    ordinary = resolveClient(f.c, 'Козлова');
  assert.deepEqual(
    eligible.matches.map((row) => row.firstName),
    ['Дарья'],
  );
  assert.deepEqual(
    ordinary.matches.map((row) => row.firstName).sort(),
    ['Дарина', 'Дарья'].sort(),
    'normal client search cache is not contaminated',
  );
  f.start();
  assert.equal(f.result.dialogue.phase, 'cancelConfirmation');
  assert.match(f.result.dialogue.fields.find((field) => field.key === 'client').value, /Дарья/u);
  assert.doesNotMatch(f.result.text, /Дарина/u);
  f.answer('да');
  assert.equal(f.result.action.type, 'cancelAppointment');
});

test('approximate Darya/Darina candidates are filtered before name suggestion ranking', (t) => {
  const f = fixture(t);
  f.start('cancelAppointment', 'Даря');
  assert.equal(f.result.action, null);
  assert.doesNotMatch(f.result.text, /Дарина/u);
  assert.ok((f.result.dialogue.options || []).every((row) => !/Дарина/u.test(row.label)));
});

test('movement uses the same future eligible pool while its result remains preview', (t) => {
  const f = fixture(t);
  f.start('moveAppointment');
  assert.equal(f.result.dialogue.step, 'date');
  assert.equal(
    f.result.dialogue.fields.find((row) => row.key === 'client').value.includes('Дарья'),
    true,
  );
  assert.equal(f.result.action, null);
});

for (const mode of ['past', 'cancelled', 'completed', 'no_show', 'invalidtime'])
  test(
    'a client with only ' +
      mode +
      ' appointments is excluded without falsely saying the client does not exist',
    (t) => {
      const f = fixture(t);
      if (mode === 'past') f.appointment.date = '2001-01-01';
      else if (mode === 'invalidtime') f.appointment.time = '14:99';
      else f.appointment.status = mode;
      f.start();
      assert.equal(f.result.action, null);
      assert.equal(f.result.dialogue.step, 'client');
      assert.equal(f.result.dialogue.options.length, 0);
      assert.match(f.result.text, /Подходящих будущих записей не нашёл/u);
      assert.doesNotMatch(f.result.text, /Клиент не найден/u);
    },
  );

test('an employee cannot receive a colleague-only appointment even on a visible client card', (t) => {
  const f = fixture(t, { role: 'cosmetologist' });
  f.appointment.staffId = 'colleague';
  f.start();
  assert.equal(f.result.action, null);
  assert.equal(f.result.dialogue.options.length, 0);
});

test('future eligibility is reread at each new candidate context instead of a stale ordinary directory cache', (t) => {
  const f = fixture(t);
  assert.equal(resolveClient(managementClientContext(f.c), 'Козлова').matches.length, 1);
  f.appointment.status = 'cancelled';
  assert.equal(resolveClient(managementClientContext(f.c), 'Козлова').matches.length, 0);
  assert.equal(resolveClient(f.c, 'Козлова').matches.length, 2);
});

test('ordinary card opening keeps clients who have no appointments', (t) => {
  const f = fixture(t);
  f.state.policy.commands.clients = true;
  const cards = createClientCardFlow({ memory: f.memory });
  const result = cards.start(
    f.c,
    { intent: 'clientCard', query: 'Дарина Козлова' },
    f.state,
    f.member,
    f.clock,
    f.memory.beginCommand(f.c, f.member, f.state),
  );
  assert.equal(result.action.type, 'clientCard');
  assert.equal(result.action.patientId, f.patients[1].id);
});
