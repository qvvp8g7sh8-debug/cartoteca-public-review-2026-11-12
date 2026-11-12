const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(process.env.ASSISTANT_PICKER_SOURCE || path.join(__dirname, '../src/client/modules/assistant-presentation.js'), 'utf8');
function fixture(t) {
  const w = new JSDOM('<button id="calendar-new">Новая запись</button>', { url: 'https://synthetic.invalid', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.eval(source);
  let closed = 0;
  const presentation = w.eval('createAssistantPresentation')().assistantPresentation({ choose() {}, resume() {}, close() { closed++; presentation.close(); } });
  presentation.start();
  const show = (version = 1) => {
    presentation.update({ reply: { dialogue: { id: 'synthetic-picker', version, step: 'service', prompt: 'Выберите услугу', options: [{ id: 'synthetic-service', label: 'Консультация' }] } }, busy: false, recording: false, voiceEnabled: true });
    const picker = w.document.querySelector('[data-assistant-picker="service"]');
    picker.getBoundingClientRect = () => ({ left: 100, right: 500, top: 100, bottom: 400 });
    return picker;
  };
  function event(target, type, values = {}) {
    const Constructor = (type.startsWith('pointer') || type === 'click') ? w.PointerEvent : w.MouseEvent;
    return target.dispatchEvent(new Constructor(type, { bubbles: true, cancelable: true, pointerId: 11, isPrimary: true, button: 0, detail: 1, clientX: 50, clientY: 50, ...values }));
  }
  t.after(() => { presentation.destroy(); w.close(); });
  return { w, show, event, closed: () => closed, presentation };
}

test('a held calendar gesture release retargeted onto a new picker cannot dismiss it', (t) => {
  const f = fixture(t);
  f.event(f.w.document.querySelector('#calendar-new'), 'pointerdown');
  const picker = f.show();
  f.event(picker, 'pointerup');
  f.event(picker, 'click');
  assert.equal(f.closed(), 0);
  assert.equal(picker.open, true);
});

test('a genuine fresh primary backdrop down and matching click dismisses exactly once', (t) => {
  const f = fixture(t), picker = f.show();
  f.event(picker, 'pointerdown');
  f.event(picker, 'pointerup');
  f.event(picker, 'click');
  assert.equal(f.closed(), 1);
  assert.equal(picker.open, false);
});

for (const variant of ['inside-to-outside', 'cancelled', 'secondary', 'nonprimary', 'mismatched-pointer']) {
  test(`${variant} cannot dismiss the picker through a backdrop click`, (t) => {
    const f = fixture(t), picker = f.show();
    f.event(picker, 'pointerdown', {
      ...(variant === 'inside-to-outside' ? { clientX: 200, clientY: 200 } : {}),
      ...(variant === 'secondary' ? { button: 2 } : {}),
      ...(variant === 'nonprimary' ? { isPrimary: false } : {}),
    });
    if (variant === 'cancelled') f.event(picker, 'pointercancel');
    const pointerId = variant === 'mismatched-pointer' ? 12 : 11;
    f.event(picker, 'pointerup', { pointerId });
    f.event(picker, 'click', { pointerId });
    assert.equal(f.closed(), 0);
    assert.equal(picker.open, true);
  });
}

test('Escape and explicit close controls still dismiss the picker', (t) => {
  const f = fixture(t), picker = f.show();
  const cancel = new f.w.Event('cancel', { cancelable: true });
  picker.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(f.closed(), 1);
  f.presentation.start();
  f.presentation.update({ reply: { dialogue: { id: 'synthetic-picker', version: 2, step: 'staff', options: [{ id: 'synthetic-staff', label: 'Сотрудник' }] } }, busy: false, voiceEnabled: true });
  const staff = f.w.document.querySelector('[data-assistant-picker="staff"]');
  staff.querySelector('button[aria-label="Закрыть выбор и остановить помощника"]').click();
  assert.equal(f.closed(), 2);
  assert.equal(staff.open, false);
});

test('a backdrop pointer from a hidden picker cannot dismiss a reopened version', (t) => {
  const f = fixture(t), picker = f.show();
  f.event(picker, 'pointerdown');
  f.presentation.update({ reply: null, turnPending: true, voiceEnabled: true });
  assert.equal(picker.open, false);
  const reopened = f.show(2);
  assert.equal(reopened, picker, 'the cached dialog element is reused');
  f.event(reopened, 'pointerup');
  f.event(reopened, 'click');
  assert.equal(f.closed(), 0);
  assert.equal(reopened.open, true);
});


