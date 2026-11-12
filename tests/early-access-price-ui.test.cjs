const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('settings temporarily omit the free access banner and annual price', (t) => {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/team.js'), 'utf8'));
  const state = {
    multiUser: true,
    account: { displayName: 'Синтетический владелец', email: 'owner@example.test' },
    roleNames: { owner: 'Владелец' },
  };
  const actions = { accountRole: () => 'owner', canManageTeam: () => true, esc: String };
  for (const name of [
    'profile',
    'integrations',
    'paidServices',
    'workspace',
    'onlineBooking',
    'telegram',
    'support',
    'improvement',
  ])
    actions[name + 'SettingsHtml'] = () => '';
  Object.assign(actions, w.eval('createTeam')(state, actions));
  const root = w.document.querySelector('main');
  root.innerHTML = actions.settingsHtml();
  const offer = root.querySelector('.settings-panel > .early-access-offer');
  assert.equal(offer, null);
  assert.equal(root.querySelector('#early-access-days'), null);
  assert.doesNotMatch(root.textContent, /Первые (12|двенадцать) месяцев бесплатно/);
  assert.doesNotMatch(root.textContent, /990|₽|Бесплатный доступ|срок бесплатного доступа/);
  state.multiUser = false;
  root.innerHTML = actions.settingsHtml();
  assert.equal(root.querySelector('.early-access-offer'), null);
});

test('annual offer is not added to login or registration', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../src/client/modules/auth/login.html'),
    'utf8',
  );
  assert.doesNotMatch(html, /early-access-offer|990|Первые 12 месяцев/);
});
