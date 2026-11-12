const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/client/public/phone.js'), 'utf8');
function fixture(t) {
  const w = new JSDOM(
    '<main><form id="booking-contact-form"><input name="phone" type="tel"></form></main>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  w.eval(source);
  w.eval('bindPublicBookingPhone')(w.document.querySelector('main'));
  return {
    w,
    input: w.document.querySelector('input'),
    format: w.eval('formatPublicBookingPhone'),
  };
}
test('phone accepts 8, +7, national digits and pasted separators without losing digits', (t) => {
  const f = fixture(t);
  for (const value of ['89991234567', '+79991234567', '9991234567', '8 (999) 123 45 67'])
    assert.equal(f.format(value).value, '+7 999 123-45-67');
  for (const [value, expected] of [
    ['9', '+7 9'],
    ['8', '+7'],
    ['8999', '+7 999'],
    ['', ''],
    ['+37499123456', '+37499123456'],
    ['7123456789', '+7 712 345-67-89'],
  ])
    assert.equal(f.format(value).value, expected);
  assert.equal(f.format('+799912345678').value.replace(/\D/g, ''), '799912345678');
});
test('phone typing, middle editing, replacement, autofill and full deletion preserve caret and validity', (t) => {
  const { w, input } = fixture(t);
  input.focus();
  const set = (value, position = value.length, type = 'input') => {
    input.value = value;
    input.setSelectionRange(position, position);
    input.dispatchEvent(new w.Event(type, { bubbles: true }));
  };
  set('9');
  assert.equal(input.value, '+7 9');
  assert.equal(input.selectionStart, 4);
  set('89991234567');
  assert.equal(input.value, '+7 999 123-45-67');
  assert.equal(input.validity.valid, true);
  set('+7 998 123-45-67', 6);
  assert.equal(input.selectionStart, 6);
  set('9991234567');
  assert.equal(input.value, '+7 999 123-45-67');
  set('+37499123456', undefined, 'change');
  assert.equal(input.value, '+37499123456');
  assert.equal(input.validity.valid, true);
  set('+7 999');
  assert.equal(input.validity.valid, false);
  set('');
  assert.equal(input.value, '');
  assert.equal(input.validationMessage, '');
  set('899912345678');
  assert.equal(input.validity.valid, false);
});
test('backspace on separators consumes the preceding digit instead of trapping the cursor', (t) => {
  const { w, input } = fixture(t);
  input.value = '+7 999 123-45-67';
  input.focus();
  input.setSelectionRange(11, 11);
  input.dispatchEvent(
    new w.InputEvent('beforeinput', { bubbles: true, inputType: 'deleteContentBackward' }),
  );
  assert.equal(input.selectionStart, 9);
  assert.equal(input.selectionEnd, 11);
  input.setRangeText('', input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(
    new w.InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
  );
  assert.equal(input.value, '+7 999 124-56-7');
  assert.equal(input.selectionStart, 9);
});
