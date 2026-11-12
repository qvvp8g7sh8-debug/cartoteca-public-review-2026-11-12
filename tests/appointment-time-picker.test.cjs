const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t, config = {}) {
  const hours = config.hours || Array.from({ length: 24 }, (_, i) => i);
  const values = hours.flatMap((hour) => Array.from({ length: 12 }, (_, i) =>
    `${String(hour).padStart(2, '0')}:${String(i * 5).padStart(2, '0')}`));
  const w = new JSDOM(`<dialog id="editor" open><form id="appointment-form">
    <h2 id="dialog-title">Запись</h2><div id="form-content">
    <input name="date" value="2030-02-05"><select name="time" required ${config.calendarSlot ? 'data-calendar-slot-time' : ''}>
    ${values.map((value) => `<option>${value}</option>`).join('')}</select>
    <input name="duration" value="5"></div><p id="form-error"></p>
    <button id="save-editor">Сохранить</button></form></dialog>`, {
    url: 'http://127.0.0.1/', runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  t.after(() => w.close());
  let modals = 0;
  w.HTMLDialogElement.prototype.showModal = config.noModal ? undefined : function () {
    modals++; this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false; this.dispatchEvent(new w.Event('close'));
  };
  const frames = new Map(), timers = new Map();
  let sequence = 0;
  w.requestAnimationFrame = (callback) => { frames.set(++sequence, callback); return sequence; };
  w.cancelAnimationFrame = (id) => frames.delete(id);
  w.setTimeout = (callback) => { timers.set(++sequence, callback); return sequence; };
  w.clearTimeout = (id) => timers.delete(id);
  const audio = { contexts: 0, tones: 0, disconnected: 0, storageReads: 0 };
  const parameter = () => Object.fromEntries(['setValueAtTime', 'linearRampToValueAtTime',
    'exponentialRampToValueAtTime'].map((method) => [method, () => {}]));
  w.AudioContext = config.noAudio ? undefined : class {
    constructor() {
      audio.contexts++;
      if (config.audioDenied) throw new Error('audio denied');
      this.state = 'running'; this.currentTime = 1; this.destination = {};
    }
    createOscillator() {
      audio.tones++;
      return { frequency: parameter(), connect() {}, disconnect() { audio.disconnected++; },
        start() {}, stop() { this.onended?.(); } };
    }
    createGain() { return { gain: parameter(), connect() {}, disconnect() { audio.disconnected++; } }; }
  };
  w.webkitAudioContext = undefined;
  if (config.legacyPreferenceOff) w.localStorage.setItem('cartoteca-time-picker-sound-v1', 'off');
  if (config.storageDenied) Object.defineProperty(w, 'localStorage', {
    get() { audio.storageReads++; throw new Error('storage denied'); },
  });
  const state = { multiUser: true, editorMode: { kind: config.kind || 'appointment', id: config.id || null },
    account: { id: 'owner', organizationId: 'synthetic' }, uploadItems: [], busy: false };
  const calls = [], $ = (selector) => w.document.querySelector(selector);
  const actions = { $, photosPending: () => false, confirmAction: () => { calls.push('confirm'); return false; } };
  for (const name of ['request', 'loadCalendarRecords', 'loadCalendarSchedule', 'loadRoomAvailability',
    'cancelPhotoProcessing', 'mountServiceGroupControl', 'renderSaveRecovery', 'updatePhotoSaveButton'])
    actions[name] = () => calls.push(name);
  for (const [name, factory] of [['time-picker-view', 'createTimePickerView'],
    ['time-picker-source', 'createTimePickerSources'], ['time-picker-sound', 'createTimePickerSound'],
    ['time-picker-wheel', 'createTimePickerWheel'], ['time-picker', 'createTimePicker'],
    ['time-picker-fields', 'createTimePickerFields']]) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules', name + '.js'), 'utf8'));
    Object.assign(actions, w[factory](state, actions));
  }
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/core/editor.js'), 'utf8'));
  Object.assign(actions, w.createEditor(state, actions));
  const source = $('select[name="time"]'); source.value = config.value || values[0];
  let changes = 0;
  $('#appointment-form').addEventListener('change', (event) => { if (event.target === source) changes++; });
  actions.bindTimePickerEvents();
  const formData = () => [...new w.FormData($('#appointment-form')).entries()];
  const fingerprint = () => JSON.stringify([...$('#form-content').querySelectorAll('input,select,textarea')]
    .map((field) => [field.name || field.id, field.value, field.checked]));
  const key = (root, value) => root.dispatchEvent(new w.KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true,
  }));
  const trigger = () => $('[data-time-dropdown]');
  const popup = () => w.document.getElementById(trigger().getAttribute('aria-controls'));
  function open() { if (trigger().getAttribute('aria-expanded') !== 'true') trigger().click(); return popup(); }
  function choose(value) {
    const option = open().querySelector(`[data-time-choice="${value}"]`);
    assert.ok(option, 'allowed choice is present: ' + value); option.click();
  }
  function preview(value) {
    const list = open().querySelector('[data-time-options]');
    const digits = value.replace(':', '').padStart(value.length <= 2 ? 2 : 4, '0');
    const time = value.includes(':') ? value : value.length <= 2 ? digits + ':00' : digits.slice(0, 2) + ':' + digits.slice(2);
    const choices = [...list.querySelectorAll('[data-time-choice]')];
    const target = choices.findIndex(option => option.dataset.timeChoice === time);
    assert.ok(target >= 0, 'Allowed navigation target: ' + value);
    key(list, 'Home');
    for (let index = 0; index < Math.floor(target / 7); index++) key(list, 'PageDown');
    for (let index = 0; index < target % 7; index++) key(list, 'ArrowDown');
    return list;
  }
  const choices = () => [...open().querySelectorAll('[data-time-choice]')].map((option) => option.textContent);
  function framesOnly() {
    const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback();
  }
  function settle() {
    const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback();
  }
  const mount = () => { actions.mountAppointmentTimePicker(); return $('.time-picker-field'); };
  return { w, state, actions, source, $, audio, calls, frames, timers, key, choose, trigger, popup,
    open, preview, choices, framesOnly, settle, mount, formData, fingerprint,
    changes: () => changes, modals: () => modals };
}

test('mount keeps original options/validity/FormData/editor fingerprint and is idempotent', (t) => {
  const f = fixture(t, { value: '09:00' });
  const fields = [...f.$('#form-content').querySelectorAll('input,select,textarea')];
  const options = [...f.source.options], data = f.formData(), snapshot = f.fingerprint();
  f.mount(); f.mount(); f.preview('935');
  assert.equal(f.source.hidden, true); assert.equal(f.source.required, true); assert.equal(f.source.checkValidity(), true);
  assert.deepEqual([...f.source.options], options);
  assert.deepEqual([...f.$('#form-content').querySelectorAll('input,select,textarea')], fields);
  assert.deepEqual(f.formData(), data); assert.equal(f.fingerprint(), snapshot);
  assert.equal(f.w.document.querySelectorAll('.time-picker-field').length, 1);
  assert.equal(f.w.document.querySelectorAll('[data-time-popup]').length, 1);
  assert.equal(f.audio.contexts, 0); assert.equal(f.changes(), 0);
});

test('one accessible dropdown/list lives outside snapshot without another modal', (t) => {
  const f = fixture(t, { noModal: true, value: '09:00' }), field = f.mount(), popup = f.open();
  assert.equal(f.$('#form-content').contains(field), true); assert.equal(f.$('#form-content').contains(popup), false);
  assert.equal(f.$('#appointment-form').contains(popup), false); assert.equal(f.$('#editor').contains(popup), true);
  assert.equal(field.getAttribute('role'), 'group'); assert.equal(field.getAttribute('aria-label'), 'Время');
  assert.equal(f.trigger().type, 'button'); assert.equal(f.trigger().getAttribute('aria-expanded'), 'true');
  const listControl = popup.querySelector('[data-time-options]'), list = popup.querySelector('[role="listbox"]');
  assert.equal(listControl.getAttribute('role'), 'listbox');
  assert.equal(popup.querySelector('input, textarea, [contenteditable]'), null);
  assert.equal(f.w.document.activeElement, listControl);
  assert.equal(list.children.length, 288); assert.equal(popup.querySelectorAll('[role="listbox"]').length, 1);
  assert.equal(popup.querySelector('[aria-selected="true"]').textContent, '09:00');
  assert.equal(listControl.getAttribute('aria-activedescendant'), popup.querySelector('[aria-selected="true"]').id);
  assert.equal(f.w.document.querySelectorAll('dialog').length, 1); assert.equal(f.modals(), 0);
  assert.equal(field.querySelector('[data-time-wheel]'), null); assert.equal(f.changes(), 0);
});

for (const input of ['click', 'Enter']) {
  test(input + ' commits exactly one bubbling source change; selecting same value emits none', (t) => {
    const f = fixture(t, { value: '09:00' }); f.mount();
    if (input === 'click') f.choose('09:05');
    else { const listControl = f.open().querySelector('[data-time-options]'); f.key(listControl, 'ArrowDown'); f.key(listControl, 'Enter'); }
    assert.equal(f.source.value, '09:05'); assert.equal(f.changes(), 1); assert.equal(f.popup().hidden, true);
    f.choose('09:05'); assert.equal(f.changes(), 1); assert.equal(f.w.document.activeElement, f.trigger());
  });
}

test('scroll/hover/arrows/page navigation only preview and never alter selected source', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount(); const popup = f.open(), list = popup.querySelector('[data-time-options]');
  const listControl = popup.querySelector('[data-time-options]');
  list.scrollTop = 1100; list.dispatchEvent(new f.w.Event('scroll', { bubbles: true }));
  list.dispatchEvent(new f.w.Event('wheel', { bubbles: true }));
  list.querySelector('[data-time-choice="10:35"]').dispatchEvent(new f.w.Event('mouseover', { bubbles: true }));
  for (const key of ['ArrowDown', 'PageDown', 'ArrowUp', 'PageUp']) f.key(listControl, key);
  f.framesOnly(); f.settle();
  assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
  assert.equal(list.querySelector('[aria-selected="true"]').textContent, '09:00');
  assert.deepEqual(f.calls, []); assert.equal(f.audio.contexts, 0);
});

for (const [key, expected] of [['ArrowDown', '10:05'], ['ArrowUp', '09:55'], ['PageDown', '10:35'],
  ['PageUp', '09:25'], ['Home', '00:00'], ['End', '23:55']]) {
  test('list navigation ' + key + ' previews without changing value/FormData', (t) => {
    const f = fixture(t, { value: '10:00' }), data = f.formData(); f.mount();
    const list = f.open().querySelector('[data-time-options]'); f.key(list, key);
    assert.equal(list.querySelector('[data-active="true"]').textContent, expected);
    assert.equal(list.children.length, 288); assert.equal(f.source.value, '10:00');
    assert.equal(f.changes(), 0); assert.deepEqual(f.formData(), data);
    assert.equal(f.popup().querySelector('input, textarea, [contenteditable]'), null);
  });
}

test('an empty source disables opening and cannot commit on Enter', (t) => {
  const f = fixture(t, { hours: [] }); f.mount();
  assert.equal(f.trigger().disabled, true); assert.equal(f.popup().hidden, true);
  f.key(f.trigger(), 'Enter'); assert.equal(f.source.value, ''); assert.equal(f.changes(), 0);
});

test('submit consumes the committed source instead of unchosen list navigation', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount(); const listControl = f.preview('935'); f.key(listControl, 'ArrowDown');
  let submitted;
  f.$('#appointment-form').addEventListener('submit', (event) => { event.preventDefault(); submitted = f.formData(); });
  f.$('#appointment-form').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(new Map(submitted).get('time'), '09:00'); assert.equal(f.changes(), 0); assert.equal(f.popup().hidden, true);
});

for (const reason of ['pointerdown', 'focusin']) {
  test('outside ' + reason + ' closes without committing or restoring focus', (t) => {
    const f = fixture(t, { value: '09:00' }); f.mount(); f.preview('935');
    const other = f.$('input[name="date"]');
    if (reason === 'focusin') other.focus(); else other.dispatchEvent(new f.w.Event('pointerdown', { bubbles: true }));
    assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0); assert.equal(f.popup().hidden, true);
    if (reason === 'focusin') assert.equal(f.w.document.activeElement, other);
  });
}

test('pointer/focus inside popup does not dismiss or choose it', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount(); const popup = f.open(), listControl = popup.querySelector('[data-time-options]');
  listControl.dispatchEvent(new f.w.Event('pointerdown', { bubbles: true })); listControl.focus();
  assert.equal(popup.hidden, false); assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
});

test('option mousedown retains list focus until explicit click; blank list area allows default behavior', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount();
  const popup = f.open(), listControl = popup.querySelector('[data-time-options]');
  const list = popup.querySelector('[data-time-options]'), option = list.querySelector('[data-time-choice="09:35"]');
  const blankDown = new f.w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  assert.equal(list.dispatchEvent(blankDown), true); assert.equal(blankDown.defaultPrevented, false);
  const optionDown = new f.w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  assert.equal(option.dispatchEvent(optionDown), false); assert.equal(optionDown.defaultPrevented, true);
  assert.equal(f.w.document.activeElement, listControl); assert.equal(popup.hidden, false);
  assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
  option.click(); assert.equal(f.source.value, '09:35'); assert.equal(f.changes(), 1);
  assert.equal(popup.hidden, true); f.mount();
  const staleDown = new f.w.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  assert.equal(option.dispatchEvent(staleDown), true); assert.equal(staleDown.defaultPrevented, false);
  assert.equal(f.source.value, '09:35'); assert.equal(f.changes(), 1);
});

test('Escape/Tab/toggle dismiss without commit; Enter never submits form', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount(); let submits = 0;
  f.$('#appointment-form').addEventListener('submit', () => submits++);
  let listControl = f.preview('935'); assert.equal(f.key(listControl, 'Escape'), false);
  assert.equal(f.popup().hidden, true); assert.equal(f.w.document.activeElement, f.trigger());
  assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
  listControl = f.preview('940'); f.key(listControl, 'Tab'); assert.equal(f.popup().hidden, true); assert.equal(f.changes(), 0);
  f.preview('945'); f.trigger().click(); assert.equal(f.popup().hidden, true); assert.equal(f.changes(), 0);
  listControl = f.preview('935'); assert.equal(f.key(listControl, 'Enter'), false);
  assert.equal(f.source.value, '09:35'); assert.equal(f.changes(), 1); assert.equal(submits, 0);
});

test('navigation-only editor remains clean; committed time invokes unsaved-change confirmation', async (t) => {
  const f = fixture(t, { value: '09:00' }); f.actions.openDialog();
  const snapshot = f.fingerprint(); f.preview('935'); assert.equal(f.fingerprint(), snapshot);
  await f.actions.requestEditorClose(); assert.equal(f.$('#editor').open, false); assert.equal(f.calls.includes('confirm'), false);
  f.state.editorMode = { kind: 'appointment' }; f.actions.openDialog(); f.choose('09:35');
  await f.actions.requestEditorClose(); assert.equal(f.$('#editor').open, true); assert.equal(f.calls.includes('confirm'), true);
});

test('calendar-hour source retains exactly twelve original five-minute full-time options', (t) => {
  const f = fixture(t, { hours: [12], value: '12:10', calendarSlot: true }); f.mount();
  assert.deepEqual(f.choices(), Array.from({ length: 12 }, (_, i) => '12:' + String(i * 5).padStart(2, '0')));
  assert.equal(f.choices().some(value => value.startsWith('13:')), false); assert.equal(f.source.value, '12:10');
  f.preview('1235'); f.key(f.popup().querySelector('[data-time-options]'), 'Enter');
  assert.equal(f.source.value, '12:35'); assert.equal(f.changes(), 1);
});

for (const [name, invalidate] of [
  ['busy', (f) => { f.state.busy = true; }],
  ['mode replaced', (f) => { f.state.editorMode = { kind: 'appointment' }; }],
  ['account replaced', (f) => { f.state.account = { ...f.state.account }; }],
  ['source disabled', (f) => { f.source.disabled = true; }],
  ['editor inert', (f) => { f.$('#form-content').setAttribute('inert', ''); }],
  ['field hidden', (f) => { f.$('.time-picker-field').hidden = true; }],
  ['editor closed', (f) => { f.$('#editor').open = false; }],
  ['source disconnected', (f) => { f.source.remove(); }],
]) {
  test('opened dropdown rejects click when ' + name, (t) => {
    const f = fixture(t, { value: '09:00' }); f.mount(); const option = f.open().querySelector('[data-time-choice="09:35"]');
    invalidate(f); option.click(); assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
    assert.equal(f.popup().hidden, true);
  });
}

test('option availability is revalidated at click before MutationObserver can run', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount(); const option = f.open().querySelector('[data-time-choice="09:35"]');
  [...f.source.options].find((item) => item.value === '09:35').disabled = true; option.click();
  assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
  assert.equal(f.popup().querySelector('[data-time-choice="09:35"]'), null);
});

test('off-step current option is displayed truthfully but never offered or silently repaired', (t) => {
  const f = fixture(t, { hours: [9], value: '09:00' }), option = f.w.document.createElement('option');
  option.value = option.textContent = '09:36'; f.source.append(option); f.source.value = '09:36'; f.mount();
  assert.equal(f.choices().includes('09:36'), false); assert.equal(f.source.value, '09:36');
  assert.equal(f.$('[data-time-value]').textContent, '09:36'); assert.equal(f.changes(), 0);
  f.choose('09:35'); assert.equal(f.source.value, '09:35'); assert.equal(f.changes(), 1);
});

test('remount destroys stale popup/listeners and legacy/non-time modes restore native source', (t) => {
  const f = fixture(t, { value: '09:00' }), data = f.formData(); f.mount();
  const popup = f.open(), oldOption = popup.querySelector('[data-time-choice="09:35"]'); f.mount(); oldOption.click();
  assert.equal(popup.isConnected, false); assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
  assert.equal(f.w.document.querySelectorAll('[data-time-popup]').length, 1);
  f.state.multiUser = false; f.mount(); assert.equal(f.source.hidden, false); assert.equal(f.$('.time-picker-field'), null);
  assert.equal(f.$('[data-time-popup]'), null);
  f.state.multiUser = true; f.state.editorMode = { kind: 'service' }; f.mount();
  assert.equal(f.$('.time-picker-field'), null); assert.deepEqual(f.formData(), data);
});

test('closing editor destroys its popup and rejects detached choice', (t) => {
  const f = fixture(t, { value: '09:00' }); f.mount(); const popup = f.open(), option = popup.querySelector('[data-time-choice="09:35"]');
  f.$('#editor').close(); option.click(); assert.equal(popup.isConnected, false);
  assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
});

test('external source change synchronizes trigger and selected choice without a duplicate change', (t) => {
  const f = fixture(t, { value: '09:30' }); f.mount(); f.open();
  f.source.value = '09:45'; f.source.dispatchEvent(new f.w.Event('change', { bubbles: true }));
  assert.equal(f.source.value, '09:45'); assert.equal(f.changes(), 1); assert.equal(f.$('[data-time-value]').textContent, '09:45');
  assert.equal(f.popup().querySelector('[aria-selected="true"]').textContent, '09:45');
  assert.equal(f.audio.contexts, 0); assert.equal(f.audio.tones, 0);
});

test('navigation stops at day edges instead of cycling or altering selected time', (t) => {
  const f = fixture(t, { value: '23:55' }); f.mount(); const listControl = f.open().querySelector('[data-time-options]');
  f.key(listControl, 'ArrowDown'); f.key(listControl, 'PageDown');
  assert.equal(f.popup().querySelector('[data-active="true"]').textContent, '23:55'); assert.equal(f.changes(), 0);
  f.preview('00'); f.key(listControl, 'ArrowUp'); f.key(listControl, 'PageUp');
  assert.equal(f.popup().querySelector('[data-active="true"]').textContent, '00:00');
  assert.equal(f.source.value, '23:55'); assert.equal(f.changes(), 0);
});

for (const [name, config, emphasis] of [['ordinary new appointment', {}, true], ['existing appointment', { id: 'synthetic-appointment' }, false],
  ['personal event', { kind: 'personalEvent' }, false], ['calendar-cell appointment', { hours: [9], calendarSlot: true }, false]]) {
  test('hour/half-hour emphasis scope: ' + name, (t) => {
    const f = fixture(t, { value: '09:00', ...config }); f.mount(); const popup = f.open();
    assert.equal(popup.dataset.timeEmphasis, String(emphasis));
    for (const option of popup.querySelectorAll('[data-time-choice]'))
      assert.equal(option.dataset.timeMajor, String(['00', '30'].includes(option.textContent.slice(3))));
    assert.equal(f.source.value, '09:00'); assert.equal(f.changes(), 0);
  });
}

// The retained wheel/sound modules still have independent callers/contracts.
// Keep their own tests separate from the dropdown's explicit click/Enter behavior.
test('standalone sound ignores legacy mute preference and releases audio nodes', (t) => {
  const f = fixture(t, { legacyPreferenceOff: true });
  assert.equal(f.audio.contexts, 0); f.actions.unlockTimePickerSound(); f.actions.playTimePickerTick();
  assert.equal(f.audio.contexts, 1); assert.equal(f.audio.tones, 1); assert.equal(f.audio.disconnected, 2);
  f.actions.playTimePickerTick(); assert.equal(f.audio.tones, 1);
});

for (const config of [{ noAudio: true, storageDenied: true }, { audioDenied: true, storageDenied: true }]) {
  test('unsupported audio/storage does not prevent dropdown selection: ' + JSON.stringify(config), (t) => {
    const f = fixture(t, { ...config, value: '09:00' });
    f.actions.unlockTimePickerSound(); f.actions.playTimePickerTick(); f.mount(); f.choose('09:35');
    assert.equal(f.source.value, '09:35'); assert.equal(f.changes(), 1);
    assert.equal(f.audio.tones, 0); assert.equal(f.audio.storageReads, 0);
  });
}

function standaloneWheel(f, values = ['00', '05', '10', '15'], value = '05') {
  const root = f.w.document.createElement('div'), selected = [], commits = [];
  root.setAttribute('role', 'listbox'); root.tabIndex = 0; root.style.setProperty('--time-wheel-row', '44px');
  Object.defineProperty(root, 'clientHeight', { value: 44 }); f.w.document.body.append(root);
  const wheel = f.actions.mountTimePickerWheel(root, values, value,
    (item) => selected.push(item), (item) => commits.push(item));
  return { root, selected, commits, wheel };
}

test('circular rows expose one accessible copy and keyboard updates selected option', (t) => {
  const f = fixture(t), { root, wheel } = standaloneWheel(f);
  assert.equal(root.children.length, 12); assert.ok([...root.children].every((node) => node.textContent));
  assert.equal(root.querySelectorAll('[role="option"]').length, 4);
  assert.equal(root.querySelectorAll('[role="presentation"][aria-hidden="true"]').length, 8);
  f.key(root, 'End'); assert.equal(wheel.current(), '15');
  f.key(root, 'Home'); f.key(root, 'ArrowDown'); assert.equal(wheel.current(), '05');
  assert.equal(root.querySelector('[aria-selected="true"]').textContent, '05');
  assert.equal(root.getAttribute('aria-activedescendant'), root.querySelector('[aria-selected="true"]').id);
});

test('preview/recentering stays uncommitted until wheel settles; equivalent copy emits no value change', (t) => {
  const f = fixture(t), { root, selected, commits, wheel } = standaloneWheel(f, undefined, '00');
  root.dispatchEvent(new f.w.Event('wheel')); root.scrollTop = 3 * 44;
  root.dispatchEvent(new f.w.Event('scroll')); f.framesOnly();
  assert.equal(wheel.current(), '15'); assert.equal(root.scrollTop, 7 * 44);
  assert.equal(wheel.settled(), false); assert.deepEqual(commits, []);
  f.settle(); assert.deepEqual(commits, ['15']); assert.equal(wheel.settled(), true);
  const tones = f.audio.tones;
  root.scrollTop = 11 * 44; root.dispatchEvent(new f.w.Event('scroll')); f.framesOnly(); f.settle();
  assert.equal(root.scrollTop, 7 * 44); assert.deepEqual(selected, ['15']); assert.equal(f.audio.tones, tones);
});

test('wheel set is silent and destroy cancels pending preview/commit without background actions', (t) => {
  const f = fixture(t), { root, selected, commits, wheel } = standaloneWheel(f);
  root.dispatchEvent(new f.w.Event('scroll')); f.framesOnly(); f.settle();
  assert.equal(f.audio.contexts, 0); assert.equal(f.audio.tones, 0); assert.deepEqual(commits, []);
  wheel.set(['00', '05', '10'], '00'); assert.equal(f.audio.tones, 0);
  root.dispatchEvent(new f.w.Event('wheel')); root.scrollTop = 5 * 44;
  root.dispatchEvent(new f.w.Event('scroll')); wheel.destroy(); f.framesOnly(); f.settle(); f.key(root, 'End');
  assert.equal(root.hasAttribute('aria-activedescendant'), false); assert.deepEqual(selected, []); assert.deepEqual(commits, []);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.ok(!f.calls.some((name) => ['request', 'loadCalendarRecords', 'loadCalendarSchedule', 'loadRoomAvailability'].includes(name)));
});

test('wheel set is idempotent for same items/value and reuses nodes for value-only update', (t) => {
  const f = fixture(t), { root, selected, commits, wheel } = standaloneWheel(f);
  const nodes = [...root.children], position = root.scrollTop, active = root.getAttribute('aria-activedescendant');
  wheel.set(['00', '05', '10', '15'], '05');
  assert.deepEqual([...root.children], nodes); assert.equal(root.scrollTop, position);
  assert.equal(root.getAttribute('aria-activedescendant'), active);
  wheel.set(['00', '05', '10', '15'], '10');
  assert.deepEqual([...root.children], nodes); assert.equal(wheel.current(), '10');
  assert.equal(root.scrollTop, 6 * 44); assert.deepEqual(selected, []); assert.deepEqual(commits, []);
  assert.equal(f.audio.contexts, 0); assert.equal(f.audio.tones, 0);
});
