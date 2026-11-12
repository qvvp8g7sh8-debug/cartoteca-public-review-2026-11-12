// Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const names = require('../src/shared/patient-names.cjs');
const { validateState } = require('../src/server/modules/cabinet/validation.cjs');
const { createStorage } = require('../storage.cjs');
const load = (module) =>
  fs.readFileSync(path.join(__dirname, '../src/client/modules', module + '.js'), 'utf8');
const patient = (phone) => ({
  id: 'phone-only',
  name: '',
  firstName: '',
  lastName: '',
  middleName: '',
  designation: '',
  phone,
  visits: [],
  appointments: [],
});
const payload = (p) => ({ revision: 0, patients: [p], services: [] });
const validation = () => {
  const context = vm.createContext({ actions: names.createPatientNames() });
  vm.runInContext(
    load('form-validation') + '\nthis.feature=createFormValidation({},actions);',
    context,
  );
  return context.feature;
};

test('complete phone permits an empty name without rewriting identity on either side', () => {
  const v = validation();
  for (const phone of [
    '+7 (900) 123-45-67',
    '89001234567',
    '9001234567',
    '+374 99 123456',
    '\u202A+7 999 123\u201145\u201167\u202C',
  ]) {
    const p = patient(phone),
      before = structuredClone(p);
    assert.equal(v.validatePatientValues(p), '');
    assert.doesNotThrow(() => validateState(payload(p)));
    assert.deepEqual(p, before);
    assert.equal(names.patientFullName(p), '');
  }
});

test('blank or incomplete phone cannot replace missing identity, but named/designated contacts remain compatible', () => {
  const v = validation();
  for (const phone of [
    '',
    '+7',
    '+7 900123',
    '900123456',
    '+7 900123456789',
    'phone',
    '++79991234567',
  ]) {
    assert.ok(v.validatePatientValues(patient(phone)));
    assert.throws(
      () => validateState(payload(patient(phone))),
      (e) => e.status === 400,
    );
  }
  for (const identity of [{ name: 'Тестовый клиент' }, { designation: 'Тестовое обозначение' }]) {
    const p = {
      id: 'legacy',
      phone: 'free-form contact',
      name: '',
      visits: [],
      appointments: [],
      ...identity,
    };
    assert.equal(v.validatePatientValues(p), '');
    assert.doesNotThrow(() => validateState(payload(p)));
  }
});

test('native forms do not require a first name in either card or appointment mode', (t) => {
  const context = vm.createContext({ actions: { ...names.createPatientNames(), esc: String } });
  vm.runInContext(
    load('patient-fields') + '\nthis.feature=createPatientFields({},actions);',
    context,
  );
  const w = new JSDOM(
    context.feature.patientFieldsHtml() +
      context.feature.patientFieldsHtml(null, { appointment: true }),
  ).window;
  t.after(() => w.close());
  assert.equal(w.document.querySelector('[name="firstName"]').required, false);
  assert.equal(w.document.querySelector('[name="newFirstName"]').required, false);
  assert.equal(context.feature.patientFormValues({ phone: '89001234567' }).name, '');
});

test('new appointment accepts a phone-only client and rejects an incomplete phone before mutation', async () => {
  for (const phone of ['89001234567', '+7 900']) {
    const state = {
      data: [],
      account: {},
      editorMode: { kind: 'appointment', serviceItems: [] },
      workspace: { enabled: false, rooms: [], staffRules: [] },
    };
    const error = { textContent: '' };
    let saves = 0;
    const actions = {
      $: () => error,
      patientFormValues: () => ({
        name: '',
        firstName: '',
        lastName: '',
        middleName: '',
        designation: '',
        nameNeedsReview: false,
      }),
      validatePatientValues: validation().validatePatientValues,
      validateAppointmentValues: () => '',
      accountId: () => 'owner',
      assertAppointmentAvailability: async () => {},
      confirmAppointmentWorkSchedule: async () => '',
      save: async () => {
        saves++;
      },
      closeEditor() {},
      parseDate: () => new Date(2030, 0, 1),
      setView() {},
      toast() {},
      prepareTelegramInvitation: async () => {},
    };
    const context = vm.createContext({ state, actions, structuredClone });
    vm.runInContext(
      load('appointment-save') + '\nthis.feature=createAppointmentSave(state,actions);',
      context,
    );
    await context.feature.saveAppointmentForm({
      patientId: '__new__',
      newPhone: phone,
      date: '2030-01-01',
      time: '10:00',
      service: 'Тест',
      duration: '15',
      notes: '',
      staffId: 'owner',
    });
    assert.equal(saves, phone === '89001234567' ? 1 : 0);
    if (saves) {
      assert.equal(state.data[0].name, '');
      assert.equal(state.data[0].phone, phone);
      assert.equal(state.data[0].appointments[0].duration, 15);
    } else {
      assert.equal(state.data.length, 0);
      assert.match(error.textContent, /полный номер телефона/);
    }
  }
});

test('calendar projection uses current empty identity rather than stale indexed name; adding a name preserves records', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patient-phone-only-'));
  const storage = createStorage(dir);
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const p = patient('89001234567');
  p.appointments.push({
    id: 'a',
    date: '2030-01-01',
    time: '10:00',
    duration: 15,
    staffId: 'owner',
  });
  storage.write({ ...payload(p), revision: storage.read().revision });
  let rows = storage.indexes.appointments('2030-01-01', '2030-01-01');
  assert.equal(rows[0].patientName, '');
  assert.equal(rows[0].patientPhone, p.phone);
  const appointments = structuredClone(p.appointments);
  p.firstName = 'Анна';
  p.lastName = 'Тестовая';
  p.name = names.patientFullName(p);
  storage.write({ ...payload(p), revision: storage.read().revision });
  rows = storage.indexes.appointments('2030-01-01', '2030-01-01');
  assert.equal(rows[0].patientName, 'Тестовая Анна');
  assert.deepEqual(storage.read().patients[0].appointments, appointments);
  p.firstName = '';
  p.lastName = '';
  p.name = '';
  storage.write({ ...payload(p), revision: storage.read().revision });
  assert.equal(storage.indexes.appointments('2030-01-01', '2030-01-01')[0].patientName, '');
  assert.equal(
    storage.indexes.appointments('2030-01-01', '2030-01-01', { includeNames: false })[0]
      .patientPhone,
    undefined,
  );
});
