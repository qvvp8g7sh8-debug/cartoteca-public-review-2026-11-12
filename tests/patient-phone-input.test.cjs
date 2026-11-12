const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { normalizePatientPhoneText } = require('../src/shared/patient-names.cjs');

function fixture(t) {
  const w = new JSDOM(
    '<div id="form-content"><input name="phone" type="tel" data-patient-phone><input name="otherPhone" type="tel"></div>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/patient-phone.js'), 'utf8'));
  w.eval('createPatientPhone')(
    {},
    { $: (selector) => w.document.querySelector(selector), normalizePatientPhoneText },
  ).bindPatientPhoneEvents();
  const input = w.document.querySelector('[data-patient-phone]');
  input.focus();
  const set = (value, position = value.length, type = 'input') => {
    input.value = value;
    input.setSelectionRange(position, position);
    input.dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  return { w, input, set };
}

test('card phone typing and pasted domestic numbers normalize the country code without losing digits', (t) => {
  const f = fixture(t);
  f.set('8');
  assert.equal(f.input.value, '+7');
  f.set('+7999');
  assert.equal(f.input.value, '+7 (999)');
  assert.equal(f.input.selectionStart, f.input.value.length);
  for (const raw of ['89991234567', '9991234567', '+7 999 123 45 67']) {
    f.set(raw);
    assert.equal(f.input.value, '+7 (999) 123-45-67');
  }
  f.set('899912345678');
  assert.equal(f.input.value.replace(/\D/g, ''), '799912345678');
});

test('copied phone formatting keeps the digits and leaves malformed input unchanged', (t) => {
  const { input, set } = fixture(t);
  set('\u202A+7 999 123\u201145\u201167\u202C');
  assert.equal(input.value, '+7 (999) 123-45-67');
  assert.equal(input.selectionStart, input.value.length);
  for (const raw of [
    '\u202A++7 999 123\u201145\u201167\u202C',
    '\u202A+7 999/123\u201145\u201167\u202C',
  ]) {
    set(raw);
    assert.equal(input.value, raw);
  }
});

test('middle edits keep the caret and Backspace crosses mask separators, then clears the prefix', (t) => {
  const { w, input, set } = fixture(t);
  set('+7 (989) 123-45-67', 6);
  assert.equal(input.selectionStart, 6);
  set('+7 (999) 123-45-67', 9);
  input.dispatchEvent(
    new w.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    }),
  );
  assert.equal(input.selectionStart, 6);
  assert.equal(input.selectionEnd, 9);
  input.setRangeText('', input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(input.value, '+7 (991) 234-56-7');
  assert.equal(input.selectionStart, 6);
  set('+7');
  input.dispatchEvent(
    new w.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteContentBackward',
    }),
  );
  assert.equal(input.value, '');
});

test('autofill keeps an explicit foreign country code and the mask stays scoped to card phone fields', (t) => {
  const { w, input, set } = fixture(t);
  set('+374 99 123456', undefined, 'change');
  assert.equal(input.value, '+374 99 123456');
  set('+7');
  input.dispatchEvent(new w.Event('focusout', { bubbles: true }));
  assert.equal(input.value, '');
  const other = w.document.querySelector('[name="otherPhone"]');
  other.value = '89991234567';
  other.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(other.value, '89991234567');
});
