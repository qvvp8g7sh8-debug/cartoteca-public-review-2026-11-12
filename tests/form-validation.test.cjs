const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const identity = require('../src/shared/patient-names.cjs');
const context = vm.createContext({identity});
vm.runInContext(fs.readFileSync(require.resolve('../src/client/modules/form-validation.js'), 'utf8') + '\nthis.validation = createFormValidation({}, identity);', context);
const validation = context.validation;

test('pure form validation accepts arbitrary prices and rejects invalid durations without mutating values', () => {
  const values = {name: 'Услуга', price: '1234.56', duration: '45'};
  assert.equal(validation.validateServiceValues(values), '');
  assert.deepEqual(values, {name: 'Услуга', price: '1234.56', duration: '45'});
  for (const duration of ['5', '10', '20', '80', '1440']) assert.equal(validation.validateServiceValues({...values, duration}), '');
  for (const duration of ['0', '1445', '7.5']) assert.ok(validation.validateServiceValues({...values, duration}));
  for (const duration of ['NaN', '-15', '14', '16']) assert.ok(validation.validateServiceValues({...values, duration}));
  for (const price of ['NaN', '-1']) assert.ok(validation.validateServiceValues({...values, price}));
  assert.equal(validation.validateServiceValues({...values, name: ' '}), 'Укажите название услуги.');
});

test('appointment, patient and factual visit validation retain distinct rules', () => {
  const appointment = {date: '2026-10-05', time: '10:00', service: 'Услуга', duration: '60'};
  assert.equal(validation.validateAppointmentValues(appointment), '');
  assert.ok(validation.validateAppointmentValues({...appointment, duration: '1441'}));
  assert.ok(validation.validateAppointmentValues({...appointment, time: ''}));
  assert.equal(validation.validatePatientValues({name: '', designation: 'От тренера'}), '');
  assert.ok(validation.validatePatientValues({name: '', designation: ''}));
  assert.equal(validation.validateVisitDuration({duration: ''}), '');
  assert.equal(validation.validateVisitDuration({duration: '1440'}), '');
  assert.ok(validation.validateVisitDuration({duration: '16'}));
});
