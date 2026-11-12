const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t, html, config = {}) {
  const w = new JSDOM(`<main id="global-view">${config.outside || ''}</main>
    <dialog id="editor" open><form id="editor-form"><div id="form-content">${html}</div>
    <button type="submit">Сохранить</button></form></dialog>`, {
    url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  t.after(() => w.close());
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false; this.dispatchEvent(new w.Event('close'));
  };
  const calls = [], changes = [];
  const state = { multiUser: true, editorMode: { kind: config.kind || 'visit' },
    account: { id: 'owner', organizationId: 'synthetic' }, currentView: 'management', busy: false };
  const $ = (selector) => w.document.querySelector(selector);
  const actions = { $ };
  for (const name of ['request', 'loadCalendarRecords', 'loadCalendarSchedule', 'readBackground'])
    actions[name] = () => { calls.push(name); throw new Error('unexpected background action'); };
  for (const [file, factory] of [['time-picker-view', 'createTimePickerView'],
    ['time-picker-source', 'createTimePickerSources'], ['time-picker', 'createTimePicker'],
    ['time-picker-fields', 'createTimePickerFields']]) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules', file + '.js'), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  actions.bindTimePickerEvents();
  if (config.workEvents) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/work-schedule-editor.js'), 'utf8'));
    Object.assign(actions, w.createWorkScheduleEditor(state, actions));
    actions.bindWorkScheduleEditorEvents();
  }
  w.document.addEventListener('change', (event) => changes.push(event.target));
  const field = (source) => source.previousElementSibling;
  const trigger = (source) => field(source).querySelector('[data-time-dropdown]');
  const popup = (source) => w.document.getElementById(trigger(source).getAttribute('aria-controls'));
  function open(source) {
    if (trigger(source).getAttribute('aria-expanded') !== 'true') trigger(source).click();
    return popup(source);
  }
  function choose(source, value) {
    const option = open(source).querySelector(`[data-time-choice="${value}"]`);
    assert.ok(option, 'allowed choice is present: ' + value); option.click();
  }
  const choices = (source) => [...open(source).querySelectorAll('[data-time-choice]')].map((option) => option.textContent);
  const mount = () => actions.mountAppointmentTimePicker();
  const data = () => [...new w.FormData($('#editor-form')).entries()];
  return { w, state, actions, $, calls, changes, field, trigger, popup, open, choose, choices, mount, data };
}

function workPair(endpoint, value = '', id = endpoint) {
  const [hour = '', minute = '00'] = value.split(':');
  const options = (maximum, selected) => Array.from({ length: maximum + 1 }, (_, i) => {
    const item = String(i).padStart(2, '0');
    return `<option value="${item}" ${item === selected ? 'selected' : ''}>${item}</option>`;
  }).join('');
  return `<div data-work-time id="${id}"><select data-work-hour aria-label="Часы ${endpoint}" required>
    <option value="" disabled ${hour ? '' : 'selected'}>—</option>${options(endpoint === 'end' ? 24 : 23, hour)}</select>
    <select data-work-minute aria-label="Минуты ${endpoint}" required ${hour === '24' ? 'disabled' : ''}>
    ${options(59, minute)}</select><input type="hidden" data-work-${endpoint}="0" value="${value}"></div>`;
}

test('personal event preserves source names/options/FormData and has no clear control', (t) => {
  const f = fixture(t, '<select name="time" required><option>09:00</option><option selected>09:35</option></select>', { kind: 'personalEvent' });
  const source = f.$('select'), options = [...source.options], data = f.data(); f.mount();
  assert.equal(source.hidden, true); assert.equal(source.name, 'time'); assert.equal(source.required, true);
  assert.deepEqual([...source.options], options); assert.deepEqual(f.data(), data);
  assert.equal(f.field(source).querySelector('[data-time-picker-clear]'), null);
  assert.deepEqual(f.choices(source), ['09:00', '09:35']); assert.equal(f.changes.length, 0);
});

test('optional empty visit stays empty through opening/navigation/outside/submit', (t) => {
  const f = fixture(t, '<input name="time" type="time" step="300"><input name="notes">'), source = f.$('input[type="time"]');
  const data = f.data(); f.mount(); f.open(source);
  assert.equal(f.field(source).querySelector('[data-time-value]').textContent, '—');
  assert.equal(f.field(source).querySelector('[data-time-picker-clear]').disabled, true);
  assert.equal(f.popup(source).querySelector('[aria-selected="true"]'), null);
  f.$('input[name="notes"]').focus();
  f.$('#editor-form').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(source.value, ''); assert.deepEqual(f.data(), data); assert.equal(f.changes.length, 0);
  assert.equal(f.popup(source).hidden, true);
});

test('optional visit chooses once and clears once without changing native type or step', (t) => {
  const f = fixture(t, '<input name="time" type="time" step="300">'), source = f.$('input'); f.mount();
  f.choose(source, '09:35'); assert.equal(source.value, '09:35'); assert.equal(f.changes.length, 1);
  const clear = f.field(source).querySelector('[data-time-picker-clear]'); assert.equal(clear.disabled, false);
  clear.click(); assert.equal(source.value, ''); assert.equal(f.changes.length, 2);
  assert.equal(source.type, 'time'); assert.equal(source.step, '300'); assert.equal(clear.disabled, true);
  clear.click(); assert.equal(f.changes.length, 2);
});

test('required empty input has no clear control; invalid focuses trigger without choosing', (t) => {
  const f = fixture(t, '<input name="time" type="time" step="300" required>'), source = f.$('input'); f.mount();
  const field = f.field(source); assert.equal(field.querySelector('[data-time-picker-clear]'), null);
  source.dispatchEvent(new f.w.Event('invalid', { cancelable: true }));
  assert.equal(f.w.document.activeElement, f.trigger(source)); assert.equal(source.value, '');
  assert.equal(f.changes.length, 0); assert.equal(field.getAttribute('aria-invalid'), 'true');
  f.choose(source, '09:35'); assert.equal(field.hasAttribute('aria-invalid'), false);
});

test('native min/max/step expose exactly the allowed range and retain validity', (t) => {
  const f = fixture(t, '<input name="time" type="time" min="09:10" max="10:00" step="600" value="09:20" required>'), source = f.$('input');
  const expected = ['09:10', '09:20', '09:30', '09:40', '09:50', '10:00'];
  assert.deepEqual(Array.from(f.actions.timePickerSource(source).values()), expected);
  const data = f.data(); f.mount(); assert.deepEqual(f.data(), data); assert.deepEqual(f.choices(source), expected);
  f.choose(source, '10:00'); assert.equal(source.value, '10:00');
  assert.equal(source.min, '09:10'); assert.equal(source.max, '10:00'); assert.equal(source.step, '600');
  assert.equal(source.validity.valid, true); assert.equal(f.changes.length, 1);
});

test('native value attribute remains the step base without min', (t) => {
  const f = fixture(t, '<input name="time" type="time" step="300" value="09:03">'), source = f.$('input');
  const values = Array.from(f.actions.timePickerSource(source).values());
  assert.ok(values.includes('09:03')); assert.ok(values.includes('09:08')); assert.equal(values.includes('09:05'), false);
  f.mount(); assert.equal(source.value, '09:03'); assert.equal(f.choices(source).includes('09:05'), false);
  f.choose(source, '09:08'); assert.equal(source.value, '09:08'); assert.equal(f.changes.length, 1);
});

test('overnight range is neither widened nor treated as an empty daytime range', (t) => {
  const f = fixture(t, '<input name="time" type="time" min="22:00" max="02:00" step="3600" value="23:00">'), source = f.$('input');
  const expected = ['00:00', '01:00', '02:00', '22:00', '23:00'];
  assert.deepEqual(Array.from(f.actions.timePickerSource(source).values()), expected);
  f.mount(); assert.deepEqual(f.choices(source), expected); f.choose(source, '00:00');
  assert.equal(source.value, '00:00'); assert.equal(f.changes.length, 1);
});

test('seconds/sub-minute inputs stay native instead of losing precision', (t) => {
  const f = fixture(t, '<input id="seconds" type="time" step="60" value="09:30:15"><input id="subminute" type="time" step="30" value="09:00">');
  const seconds = f.$('#seconds'), subminute = f.$('#subminute');
  assert.equal(f.actions.timePickerSource(seconds), null); assert.equal(f.actions.timePickerSource(subminute), null);
  f.mount(); assert.equal(seconds.hidden, false); assert.equal(subminute.hidden, false);
  assert.equal(f.$('.time-picker-field'), null); assert.equal(seconds.value, '09:30:15'); assert.equal(f.changes.length, 0);
});

test('sidebar select exposes only sparse enabled original choices', (t) => {
  const f = fixture(t, '', { outside: '<section id="side"><select id="calendar-hidden-until"><option>00:00</option><option>10:00</option><option disabled>11:00</option><option>14:00</option></select></section>' });
  const source = f.$('#calendar-hidden-until'); f.actions.mountTimePickerFields(f.$('#side'), { editor: false });
  assert.deepEqual(f.choices(source), ['00:00', '10:00', '14:00']);
  f.choose(source, '10:00'); assert.equal(source.value, '10:00'); assert.equal(f.changes.length, 1);
});

test('work interval keeps arbitrary minute and emits one original minute change', (t) => {
  const f = fixture(t, workPair('start', '09:37'), { kind: 'workSchedule', workEvents: true }), source = f.$('[data-work-time]');
  const original = [...source.querySelectorAll('select,input')]; f.mount();
  assert.deepEqual([...source.querySelectorAll('select,input')], original);
  assert.equal(source.querySelector('input').value, '09:37'); assert.equal(f.changes.length, 0);
  f.choose(source, '09:38'); assert.equal(source.querySelector('input').value, '09:38');
  assert.equal(f.changes.length, 1); assert.equal(f.changes[0], source.querySelector('[data-work-minute]'));
});

test('only endpoint containing hour24 allows24:00 and returning to another hour enables minutes', (t) => {
  const f = fixture(t, workPair('start', '09:37') + workPair('end', '10:37'), { kind: 'workSchedule', workEvents: true });
  const start = f.$('#start'), end = f.$('#end');
  assert.equal(f.actions.timePickerSource(start).values().includes('24:00'), false);
  assert.equal(f.actions.timePickerSource(end).values().includes('24:00'), true);
  assert.equal(f.actions.timePickerSource(end).values().includes('24:05'), false);
  f.mount(); assert.equal(f.choices(start).includes('24:00'), false); f.choose(end, '24:00');
  assert.equal(end.querySelector('input').value, '24:00'); assert.equal(end.querySelector('[data-work-minute]').disabled, true);
  assert.equal(start.querySelector('input').value, '09:37'); assert.equal(f.changes.length, 1);
  f.choose(end, '10:37'); assert.equal(end.querySelector('input').value, '10:37');
  assert.equal(end.querySelector('[data-work-minute]').disabled, false); assert.equal(f.changes.length, 2);
});

test('blank required work endpoints never choose or fill themselves on submit', (t) => {
  const f = fixture(t, workPair('start') + workPair('end'), { kind: 'workSchedule', workEvents: true }); f.mount();
  for (const source of f.w.document.querySelectorAll('[data-work-time]')) {
    assert.equal(source.querySelector('input').value, '');
    assert.equal(f.field(source).querySelector('[data-time-picker-clear]'), null);
    assert.equal(f.field(source).querySelector('[data-time-value]').textContent, '—');
  }
  f.$('#editor-form').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok([...f.w.document.querySelectorAll('[data-work-time] input')].every((source) => source.value === ''));
  assert.equal(f.changes.length, 0);
});

test('remounting one scope preserves another and editor close leaves sidebar active', (t) => {
  const f = fixture(t, '<section id="inside"><input name="time" type="time" step="300" value="09:00"></section>',
    { outside: '<section id="side"><select id="calendar-hidden-until"><option>00:00</option><option>10:00</option></select></section>' });
  const inside = f.$('#inside'), side = f.$('#side'), source = f.$('#calendar-hidden-until');
  f.actions.mountTimePickerFields(inside); f.actions.mountTimePickerFields(side, { editor: false });
  const field = f.field(source), popup = f.open(source), nodes = [...popup.querySelector('[data-time-options]').children];
  f.actions.mountTimePickerFields(inside);
  assert.equal(f.field(source), field); assert.equal(f.popup(source), popup);
  assert.deepEqual([...popup.querySelector('[data-time-options]').children], nodes);
  f.$('#editor').close(); f.state.editorMode = null; f.choose(source, '10:00');
  assert.equal(source.value, '10:00'); assert.equal(f.changes.length, 1);
});

for (const invalidation of ['guard', 'account']) {
  test('outside-editor ' + invalidation + ' rejects a click from already opened choices', (t) => {
    const f = fixture(t, '', { outside: '<section id="side"><select id="calendar-hidden-until"><option>00:00</option><option>10:00</option></select></section>' });
    const source = f.$('#calendar-hidden-until'); let live = true;
    f.actions.mountTimePickerFields(f.$('#side'), { editor: false, guard: () => live });
    const option = f.open(source).querySelector('[data-time-choice="10:00"]');
    if (invalidation === 'guard') live = false; else f.state.account = { ...f.state.account };
    option.click(); assert.equal(source.value, '00:00'); assert.equal(f.changes.length, 0);
    assert.equal(f.popup(source).hidden, true);
  });
}

test('rerendered scope destroys old popup and cannot commit disconnected source', (t) => {
  const f = fixture(t, '<section id="inside"><input name="time" type="time" step="300" value="09:00"></section>');
  const root = f.$('#inside'), previous = root.querySelector('input'); f.actions.mountTimePickerFields(root);
  const popup = f.open(previous), option = popup.querySelector('[data-time-choice="09:35"]');
  root.innerHTML = '<input name="time" type="time" step="300" value="08:05">'; f.actions.mountTimePickerFields(root);
  option.click(); assert.equal(previous.isConnected, false); assert.equal(previous.value, '09:00');
  assert.equal(popup.isConnected, false); assert.equal(root.querySelector('input').value, '08:05');
  assert.equal(f.changes.length, 0); assert.equal(f.w.document.querySelectorAll('[data-time-popup]').length, 1);
});

test('hidden/disabled form sections retain untouched native controls', (t) => {
  const f = fixture(t, '<fieldset disabled><input id="disabled" type="time" value="09:00"></fieldset><section hidden><input id="hidden" type="time" value="10:00"></section>'); f.mount();
  assert.equal(f.$('.time-picker-field'), null); assert.equal(f.$('#disabled').hidden, false); assert.equal(f.$('#hidden').hidden, false);
  assert.equal(f.$('#disabled').value, '09:00'); assert.equal(f.$('#hidden').value, '10:00'); assert.equal(f.changes.length, 0);
});

test('changed native constraints reject stale option immediately and refresh opened choices', async (t) => {
  const f = fixture(t, '<input name="time" type="time" min="09:00" max="10:00" step="300" value="09:30">'), source = f.$('input');
  f.mount(); const option = f.open(source).querySelector('[data-time-choice="09:35"]'); source.max = '09:30';
  option.click(); await Promise.resolve(); await Promise.resolve();
  assert.equal(source.value, '09:30'); assert.equal(f.changes.length, 0);
  assert.equal(f.popup(source).querySelector('[data-time-choice="09:35"]'), null);
});

test('disabled current option stays truthful in trigger without becoming selectable', (t) => {
  const f = fixture(t, '<select name="time" required><option selected disabled>09:35</option><option>09:40</option></select>', { kind: 'personalEvent' });
  const source = f.$('select'); f.mount(); assert.equal(source.value, '09:35'); assert.equal(f.changes.length, 0);
  assert.equal(f.field(source).querySelector('[data-time-value]').textContent, '09:35');
  assert.deepEqual(f.choices(source), ['09:40']); assert.equal(f.popup(source).querySelector('[aria-selected="true"]'), null);
  f.choose(source, '09:40'); assert.equal(source.value, '09:40'); assert.equal(f.changes.length, 1);
});

test('no enabled choices disables trigger without silently replacing existing source', async (t) => {
  const f = fixture(t, '<select name="time"><option selected>09:00</option></select>', { kind: 'personalEvent' });
  const source = f.$('select'); f.mount(); f.open(source); source.options[0].disabled = true;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.trigger(source).disabled, true); assert.equal(f.popup(source).hidden, true);
  assert.equal(source.value, '09:00'); assert.equal(f.changes.length, 0); assert.deepEqual(f.calls, []);
});
