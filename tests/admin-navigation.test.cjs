const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
function fixture(t) {
  const window = new JSDOM(fs.readFileSync(assetPath('admin.html'), 'utf8'), {
    runScripts: 'outside-only', url: 'https://synthetic.invalid/admin.html',
  }).window;
  t.after(() => window.close());
  const $ = (selector) => window.document.querySelector(selector);
  $('#admin-dashboard').hidden = false;
  $('[data-admin-section="overview"]').hidden = true;
  $('#admin-voice-assistant').hidden = false;
  window.eval(fs.readFileSync(path.join(root, 'src/client/modules/admin/navigation.js'), 'utf8'));
  const navigation = window.createAdminNavigation({ $ });
  navigation.bind(); navigation.bind();
  return { window, $ };
}
test('voice tabs preserve drafts and keep one selected panel without recreating forms', (t) => {
  const f = fixture(t);
  const field = f.$('#admin-voice-org-search'); field.value = 'Synthetic draft';
  const member = f.$('[data-admin-voice-tab="members"]'); member.click();
  assert.equal(f.$('#admin-voice-panel-members').hidden, false);
  assert.equal(f.$('#admin-voice-panel-settings').hidden, true);
  f.$('[data-admin-voice-tab="behavior"]').click(); member.click();
  assert.equal(f.$('#admin-voice-org-search'), field);
  assert.equal(field.value, 'Synthetic draft');
  assert.equal(f.window.document.querySelectorAll('[role="tab"][aria-selected="true"]').length, 1);
  assert.equal(f.window.document.querySelectorAll('[role="tabpanel"]:not([hidden])').length, 1);
});
test('keyboard navigation selects a tab, moves focus and supports Home and End', (t) => {
  const f = fixture(t), first = f.$('[data-admin-voice-tab="settings"]');
  first.focus();
  const press = (element, key) => element.dispatchEvent(new f.window.KeyboardEvent('keydown', { key, bubbles: true }));
  press(first, 'ArrowRight');
  assert.equal(f.window.document.activeElement, f.$('[data-admin-voice-tab="members"]'));
  press(f.window.document.activeElement, 'End');
  assert.equal(f.window.document.activeElement, f.$('[data-admin-voice-tab="history"]'));
  press(f.window.document.activeElement, 'Home'); assert.equal(f.window.document.activeElement, first);
});
test('native validation exposes the relevant panel and collapsed advanced fields', (t) => {
  const f = fixture(t), group = f.window.document.createElement('details');
  group.innerHTML = '<summary>Advanced</summary><input required>';
  f.$('#admin-voice-panel-settings').append(group);
  f.$('[data-admin-voice-tab="members"]').click();
  group.querySelector('input').dispatchEvent(new f.window.Event('invalid'));
  assert.equal(f.$('#admin-voice-panel-settings').hidden, false);
  assert.equal(group.open, true);
});
