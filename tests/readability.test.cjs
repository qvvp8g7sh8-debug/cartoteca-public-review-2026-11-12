const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = require('../src/client/manifest.json');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('feature sources remain readable and editor lifecycle does not own clinical mutations', () => {
  for (const file of [manifest.state, manifest.events, ...manifest.factories.map(item => item.path), ...manifest.adminSources]) {
    assert.ok(Math.max(...read(file).split(/\r?\n/).map(line => line.length)) <= 500, file + ': split the long expression or markup without changing output');
  }
  assert.doesNotMatch(read('src/client/core/editor.js'), /state\.(data|services)\b/);
  const validation = read('src/client/modules/form-validation.js');
  assert.doesNotMatch(validation, /\b(?:document|window|state)\.[A-Za-z_$]|\bawait\b/);
  assert.deepEqual([...new Set([...validation.matchAll(/actions\.([A-Za-z]\w*)/g)].map(match => match[1]))], ['hasPatientIdentity']);
  for (const kind of ['service', 'patient', 'appointment', 'visit']) {
    assert.doesNotMatch(read(`src/client/modules/${kind}-save.js`), /innerHTML|showModal/);
  }
});

test('synchronous invalid form releases busy and buttons without a microtask delay', async () => {
  const state = {busy: false, editorMode: {kind: 'visit'}};
  const elements = new Map();
  const actions = {
    $: selector => {if (!elements.has(selector)) elements.set(selector, {});return elements.get(selector);},
    photosPending: () => false,
    cabinetSaveStatus: () => null,
    saveVisitForm: () => undefined,
    updatePhotoSaveButton: () => {},
  };
  const context = vm.createContext({FormData: class {entries() {return [];}}, state, actions});
  vm.runInContext(read('src/client/core/editor.js') + '\nthis.editor = createEditor(state, actions);', context);
  const task = context.editor.submit({preventDefault() {}, target: {}});
  assert.equal(state.busy, false);
  await task;
});
