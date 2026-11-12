const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, flush, deferred } = require('./assistant-voice-booking-fixture.cjs');
const root = path.resolve(__dirname, '../..');
const clone = (value) => JSON.parse(JSON.stringify(value));
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/gu,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
function previewFixture(t, options = {}) {
  const account = options.account || {
    id: 'synthetic-owner',
    organizationId: 'synthetic-org',
    role: 'owner',
  };
  const f = fixture(t, {
    scope: {
      organizationId: account.organizationId,
      policyVersion: options.policyVersion || 1,
      ...(options.scope || {}),
    },
  });
  f.w.structuredClone = structuredClone;
  const data = clone(
    options.patients || [
      {
        id: 'synthetic-patient',
        firstName: 'Анна',
        lastName: 'Синтетическая',
        appointments: [
          {
            id: 'synthetic-appointment',
            date: '2030-01-02',
            time: '10:00',
            duration: 45,
            staffId: 'synthetic-owner',
            roomId: 'synthetic-room',
            status: 'scheduled',
            service: 'Тестовая консультация',
            serviceItems: [
              {
                id: 'synthetic-service',
                name: 'Тестовая консультация',
                duration: 60,
                price: 100,
                staffId: 'synthetic-owner',
              },
            ],
            notes: 'Synthetic original note',
          },
        ],
        visits: [],
      },
    ],
  ).map((patient) => ({
    ...patient,
    name:
      patient.name ||
      [patient.firstName, patient.middleName, patient.lastName].filter(Boolean).join(' '),
    appointments: patient.appointments || [],
    visits: patient.visits || [],
  }));
  const services = clone(
    options.services || [
      {
        id: 'synthetic-service',
        name: 'Тестовая консультация',
        duration: 60,
        price: 100,
        staffId: 'synthetic-owner',
      },
    ],
  );
  const ports = { ensure: [], schedules: 0, rooms: 0, opens: 0, saves: 0, actionRuns: 0 };
  const control = {
    ensure: async (id) => data.find((patient) => patient.id === id),
    schedule: async () => {},
    rooms: async () => {},
  };
  const noWrite = () => {
    ports.saves++;
    assert.fail('NO_SAVE preview forbids all save commands');
  };
  f.w.fetch = noWrite;
  f.w.document.body.insertAdjacentHTML(
    'beforeend',
    '<dialog id="editor"><h2 id="dialog-title"></h2><button id="close-editor" type="button">Закрыть</button>' +
      '<form id="editor-form"><p id="form-error"></p><button id="save-editor" type="submit">Сохранить</button></form></dialog>',
  );
  f.$('#editor-form').prepend(f.$('#form-content'));
  Object.assign(f.state, {
    account: clone(account),
    data,
    lazyReads: true,
    workspace: {},
    uploadItems: [],
    SERVICE_CATEGORIES: [{ id: 'synthetic', title: 'Синтетические услуги' }],
  });
  Object.assign(f.actions, {
    clientRecords: () => data,
    async ensurePatient(id, ensureOptions) {
      ports.ensure.push({ id, options: ensureOptions });
      return control.ensure(id, ensureOptions, ports.ensure.length);
    },
    servicesForStaff(staffId) {
      const current = staffId || f.$('#form-content [name="staffId"]')?.value || f.state.account.id;
      return services.filter((service) => !service.staffId || service.staffId === current);
    },
    serviceCategory: () => 'synthetic',
    durationMinutes: (value) => Number(value),
    serviceDuration: () => 60,
    formatPrice: (value) => String(value || 0),
    formatMinutes: (value) => value + ' мин',
    formatPhone: (value) => String(value || ''),
    formatDate: (value) => value,
    esc: escape,
    patientFieldsHtml: () => '',
    staffField: (id) =>
      '<label><select name="staffId"><option value="' +
      escape(id) +
      '">' +
      escape(id) +
      '</option></select></label>',
    appointmentRoomField: (draft) =>
      '<label><select name="roomId">' +
      [...new Set([draft.roomId, ...(options.roomIds || [])].filter(Boolean))]
        .map((id) => '<option value="' + escape(id) + '">' + escape(id) + '</option>')
        .join('') +
      '</select></label>',
    isoDate: () => '2030-01-01',
    timeLabel: (minutes) =>
      String(Math.floor(minutes / 60)).padStart(2, '0') +
      ':' +
      String(minutes % 60).padStart(2, '0'),
    async refreshAppointmentSchedule() {
      ports.schedules++;
      await control.schedule(ports.schedules);
    },
    async refreshAppointmentRooms() {
      ports.rooms++;
      await control.rooms(ports.rooms);
    },
    mountAppointmentTimePicker() {},
    mountServiceGroupControl() {},
    cancelPhotoProcessing() {},
    renderSaveRecovery() {},
    updatePhotoSaveButton() {},
    photosPending: () => false,
    cabinetSaveStatus: () => false,
    confirmAction: async () => true,
    save: noWrite,
    saveCabinet: noWrite,
    saveAppointmentForm: noWrite,
    savePersonalEventForm: noWrite,
    savePatientForm: noWrite,
    saveServiceForm: noWrite,
    saveWorkScheduleForm: noWrite,
    saveVisitForm: noWrite,
  });
  function load(file, factory) {
    f.w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    Object.assign(f.actions, f.w.eval(factory)(f.state, f.actions));
  }
  for (const [file, factory] of [
    ['src/client/shared/access.js', 'createAccess'],
    ['src/shared/appointment-status.cjs', 'createAppointmentStatuses'],
    ['src/shared/assistant-appointment-identity.cjs', 'createAssistantAppointmentIdentity'],
    ['src/client/modules/appointment-patient-picker.js', 'createAppointmentPatientPicker'],
    ['src/client/modules/appointment-procedures.js', 'createAppointmentProcedures'],
    ['src/client/modules/appointments.js', 'createAppointments'],
    ['src/client/core/editor.js', 'createEditor'],
    ['src/client/modules/assistant-appointment-preview.js', 'createAssistantAppointmentPreview'],
  ])
    load(file, factory);
  const openDialog = f.actions.openDialog;
  f.actions.openDialog = (...args) => {
    ports.opens++;
    return openDialog(...args);
  };
  const actualRun = f.actions.runAssistantAction;
  f.actions.runAssistantAction = async (action) => {
    ports.actionRuns++;
    return actualRun(action);
  };
  f.$('#editor-form').addEventListener('submit', (event) => {
    void f.actions.submit(event);
  });
  f.api.mountVoiceAssistant();
  f.control.speak = async () => ({
    policyVersion: f.scope.policyVersion,
    audioBase64: 'synthetic',
    mimeType: 'audio/wav',
  });
  return {
    ...f,
    data,
    services,
    ports,
    previewControl: control,
    noWrite,
    action(operation = 'move', patch = {}) {
      const patient = data[0],
        appointment = patient.appointments[0];
      return {
        type: 'appointmentPreview',
        operation,
        patientId: patient.id,
        appointmentId: appointment.id,
        sourceStamp: f.actions.assistantAppointmentStamp(appointment),
        ...(operation === 'move' ? { date: '2030-01-03', time: '12:30' } : {}),
        ...patch,
      };
    },
    snapshot: () => JSON.stringify(data),
  };
}
module.exports = { previewFixture, flush, deferred };
