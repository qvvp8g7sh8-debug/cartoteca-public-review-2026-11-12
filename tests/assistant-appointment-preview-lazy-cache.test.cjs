const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { previewFixture } = require('./helpers/assistant-appointment-preview-fixture.cjs');
const { dialogueFixture, day } = require('./helpers/assistant-dialogue-fixture.cjs');
const {
  createAppointmentManagementFlow,
} = require('../src/server/modules/assistant/actions/appointments/appointment-management-flow.cjs');

function selectedPreview(t, { emptyDirectory = false, changeRead = () => {} } = {}) {
  const server = dialogueFixture();
  server.patients[0].appointments = ['10:00', '15:00'].map((time, index) => ({
    id: 'synthetic-appointment-' + index,
    date: day,
    time,
    duration: 45,
    staffId: 'owner',
    roomId: 'synthetic-room',
    status: 'scheduled',
    service: 'Синтетическая консультация',
    serviceItems: [],
  }));
  const storage = server.c.tenantStore('org');
  storage.readSelected = (ids) => ({
    patients: server.patients.filter((patient) => ids.includes(patient.id)),
    services: [],
    revision: 1,
  });
  const flow = createAppointmentManagementFlow({ memory: server.flow });
  const first = flow.start(
    server.c,
    { intent: 'editAppointment', query: 'Анна Семёнова' },
    server.state,
    server.member,
    server.clock,
    server.flow.beginCommand(server.c, server.member, server.state),
    {},
  );
  assert.equal(first.dialogue.options.length, 2);
  const selected = flow.continueDialogue(
    server.c,
    {
      dialogueId: first.dialogue.id,
      dialogueVersion: first.dialogue.version,
      choice: first.dialogue.options[1].id,
    },
    server.state,
    server.member,
    server.clock,
  );
  assert.equal(selected.action.type, 'appointmentPreview');
  assert.equal(selected.action.appointmentId, 'synthetic-appointment-1');
  const f = previewFixture(t, {
    account: { id: 'owner', organizationId: 'org', role: 'owner' },
    patients: server.patients,
  });
  const remote = structuredClone(f.data);
  const original = JSON.stringify(remote);
  f.state.data = [];
  f.state.directory = emptyDirectory
    ? []
    : remote.map(({ appointments, visits, ...summary }) => summary);
  const queryCode = fs.readFileSync(
    path.join(__dirname, '../src/client/core/cabinet-queries.js'),
    'utf8',
  );
  f.w.eval(queryCode);
  const queries = f.w.createCabinetQueries(f.state, f.actions);
  f.actions.ensurePatient = queries.ensurePatient;
  f.actions.clientRecords = queries.clientRecords;
  f.actions.rememberLoadedPatient = () => {};
  const reads = [];
  f.actions.request = async (url) => {
    assert.equal(url, '/api/cabinet/patient?id=' + encodeURIComponent(remote[0].id));
    reads.push(url);
    changeRead(remote, reads.length);
    return { patients: structuredClone(remote), revision: 1 };
  };
  return { ...f, action: selected.action, remote, original, reads };
}

for (const emptyDirectory of [false, true])
  test(
    'a selected current server source opens from the fresh detail cache; empty directory=' +
      emptyDirectory,
    async (t) => {
      const f = selectedPreview(t, { emptyDirectory });
      assert.equal(await f.actions.runAssistantAction(f.action), true);
      assert.equal(f.$('#editor').open, true);
      assert.equal(f.state.editorMode.id, f.action.appointmentId);
      assert.equal(f.$('#form-content [name="time"]').value, '15:00');
      assert.equal(f.reads.length, 2, 'reuse the two existing forced source/form reads');
      assert.equal(JSON.stringify(f.remote), f.original);
      assert.equal(f.ports.saves, 0);
      assert.ok(f.state.directory.every((row) => row.appointments === undefined));
    },
  );

test('a real source change in the second forced detail read still discards the preview', async (t) => {
  const f = selectedPreview(t, {
    changeRead(remote, count) {
      if (count === 2) remote[0].appointments[1].duration = 50;
    },
  });
  await assert.rejects(f.actions.runAssistantAction(f.action), /Запись изменилась/u);
  assert.equal(f.reads.length, 2);
  assert.equal(f.state.data[0].appointments[1].duration, 50);
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.ports.saves, 0);
});

test('a replaced detail cache during schedule refresh remains protected by the final stamp check', async (t) => {
  const f = selectedPreview(t);
  f.previewControl.schedule = async (count) => {
    if (count === 2) {
      const replacement = structuredClone(f.state.data);
      replacement[0].appointments[1].time = '16:00';
      f.state.data = replacement;
    }
  };
  await assert.rejects(f.actions.runAssistantAction(f.action), /Запись изменилась/u);
  assert.equal(f.reads.length, 2);
  assert.ok(f.ports.schedules >= 2);
  assert.equal(f.state.data[0].appointments[1].time, '16:00');
  assert.equal(f.$('#editor').open, false);
  assert.equal(f.state.editorMode, null);
  assert.equal(f.ports.saves, 0);
});
