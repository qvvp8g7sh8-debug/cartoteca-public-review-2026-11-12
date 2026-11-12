// Prepared for the next user-requested verification stage; no real data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
function fixture() {
  const dom = new JSDOM(
    '<dialog id="editor"><form id="editor-form"><div class="dialog-heading">' +
      '<h2 id="dialog-title">Новая запись</h2><button id="close-editor">×</button></div>' +
      '<div id="form-content"><input name="patientId" value="synthetic-client">' +
      '<input name="service" value="Synthetic service"><input name="date" value="2030-01-05">' +
      '<input name="time" value="23:00"><input name="duration" value="20">' +
      '<input name="staffId" value="synthetic-staff"></div><p id="form-error"></p>' +
      '<button id="save-editor">Сохранить</button></form></dialog>',
  );
  const document = dom.window.document;
  const state = {
    multiUser: true,
    busy: false,
    editorMode: {
      kind: 'appointment',
      id: null,
      serviceItems: [{ id: 'synthetic-service' }],
    },
  };
  const actions = {
    $: (selector) => document.querySelector(selector),
    durationOptions: (value) => '<option value="' + value + '">' + value + '</option>',
    personalEventFields: (seed) =>
      ['date', 'time', 'duration', 'staffId']
        .map((name) => `<input name="${name}" value="${seed[name]}">`)
        .join('') + '<textarea name="notes"></textarea>',
  };
  const factory = vm.runInNewContext(
    fs.readFileSync('src/client/modules/calendar-creation-tabs.js', 'utf8') +
      '\ncreateCalendarCreationTabs',
    { document, FormData: dom.window.FormData },
  );
  const tabs = factory(state, actions);
  tabs.mountCalendarCreationTabs();
  tabs.bindCalendarCreationTabEvents();
  return { document, state, actions, tabs, dom };
}
test('new appointment starts selected; text tabs replace only the close icon', () => {
  const f = fixture();
  assert.equal(f.actions.$('#appointment-creation-tab').getAttribute('aria-selected'), 'true');
  assert.equal(f.actions.$('#personal-creation-panel').disabled, true);
  assert.equal(f.actions.$('#close-editor').hidden, true);
  assert.equal(f.state.editorMode.kind, 'appointment');
  assert.equal(f.actions.$('#editor-form').elements.time.tagName, 'INPUT');
  f.dom.window.close();
});
test('personal needs no client/service and keeps both drafts across keyboard tab switches', () => {
  const f = fixture();
  f.actions.$('#appointment-creation-panel [name="time"]').value = '22:35';
  f.actions.$('#personal-creation-tab').click();
  assert.equal(f.state.editorMode.kind, 'personalEvent');
  const form = () =>
    Object.fromEntries(new f.dom.window.FormData(f.actions.$('#editor-form')).entries());
  assert.equal(form().patientId, undefined);
  assert.equal(form().service, undefined);
  assert.equal(form().time, '22:35');
  f.actions.$('#personal-creation-panel [name="notes"]').value = 'Synthetic reminder';
  f.actions.$('#personal-creation-tab').dispatchEvent(
    new f.dom.window.KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
    }),
  );
  assert.equal(form().patientId, 'synthetic-client');
  assert.equal(form().service, 'Synthetic service');
  assert.equal(f.state.editorMode.serviceItems[0].id, 'synthetic-service');
  f.actions.$('#personal-creation-tab').click();
  assert.equal(form().notes, 'Synthetic reminder');
  f.dom.window.close();
});
