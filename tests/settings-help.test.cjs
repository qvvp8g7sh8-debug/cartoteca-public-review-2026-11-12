const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function fixture(t) {
  const w = new JSDOM('<main class="settings-panel"></main>', {
    runScripts: 'outside-only',
    url: 'https://synthetic.test/',
  }).window;
  t.after(() => w.close());
  for (const file of ['settings-help', 'profile', 'profile-overview']) {
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules', file + '.js'), 'utf8'));
  }
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new w.Event('close'));
  };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  const state = { account: { id: 'a' }, busy: false, roleNames: { cosmetologist: 'Сотрудник' } };
  const actions = {
    canManageTeam: () => false,
    accountRole: () => 'cosmetologist',
    initials: () => 'СП',
    markSettingsSaved() {},
    mountOrganizationTimeZone() {},
    $: (selector) => w.document.querySelector(selector),
    esc: (value) =>
      String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
      ),
    settingsSectionHtml: (title, id, body) =>
      `<details open><summary>${title}</summary><div id="${id}">${body}</div></details>`,
  };
  Object.assign(actions, w.eval('createSettingsHelp')(state, actions));
  Object.assign(actions, w.eval('createProfileOverview')(state, actions));
  actions.bindSettingsHelpEvents();
  return { w, actions, state, root: actions.$('main') };
}

test('help row keeps its label compact and the question next to text, with a touch target', (t) => {
  const { w, actions, root } = fixture(t);
  const style = w.document.createElement('style');
  style.textContent = ['settings-compact.css', 'settings-help.css']
    .map((file) => fs.readFileSync(path.join(__dirname, '../src/client/styles', file), 'utf8'))
    .join('\n');
  w.document.head.append(style);
  root.innerHTML =
    '<div class="settings-label-row"><label>Запретить пересекающиеся записи</label>' +
    actions.settingsHelpHtml('Защита', 'Пояснение') +
    '</div>';
  const row = w.getComputedStyle(actions.$('.settings-label-row'));
  const label = w.getComputedStyle(actions.$('label'));
  const button = w.getComputedStyle(actions.$('[data-settings-help]'));
  assert.equal(row.justifyContent, 'flex-start');
  assert.equal(label.flexGrow, '0');
  assert.equal(label.width, 'auto');
  assert.equal(button.minWidth, '36px');
});

test('help opens on click only, does not toggle checkboxes or submit, and restores focus', (t) => {
  const { w, actions, root } = fixture(t);
  const heading = 'Пояснение <имя> "параметра"';
  const text = 'Первая строка.\n\n<img src=x onerror="alert(1)"> & ещё текст';
  root.innerHTML = [
    '<details open><summary>Кабинеты</summary><form>',
    '<div class="settings-label-row"><label><input type="checkbox" name="enabled" checked>Защита</label>',
    actions.settingsHelpHtml(heading, text),
    '</div><input name="draft" value="Несохранённое имя"></form></details>',
    actions.settingsHelpDialogHtml(),
  ].join('');
  let submits = 0;
  actions.$('form').addEventListener('submit', (event) => {
    event.preventDefault();
    submits++;
  });
  const button = actions.$('[data-settings-help]');
  const dialog = actions.$('#settings-help-dialog');
  button.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(dialog.open, false);
  button.click();
  assert.equal(dialog.open, true);
  assert.equal(actions.$('#settings-help-title').textContent, heading);
  assert.equal(actions.$('#settings-help-text').textContent, text);
  assert.equal(root.querySelectorAll('img,script').length, 0);
  assert.equal(actions.$('[name=enabled]').checked, true);
  assert.equal(actions.$('[name=draft]').value, 'Несохранённое имя');
  assert.equal(submits, 0);
  assert.equal(actions.$('details').open, true);
  assert.equal(button.closest('label,summary'), null);
  assert.equal(button.getAttribute('aria-haspopup'), 'dialog');
  actions.$('[data-settings-help-close]').click();
  assert.equal(dialog.open, false);
  assert.equal(w.document.activeElement, button);
});

test('inside and backdrop clicks keep help open; explicit and native close return focus', (t) => {
  const { w, actions, root } = fixture(t);
  root.innerHTML =
    actions.settingsHelpHtml('Настройка', 'Текст') + actions.settingsHelpDialogHtml();
  const button = actions.$('[data-settings-help]');
  const dialog = actions.$('#settings-help-dialog');
  dialog.getBoundingClientRect = () => ({ left: 20, top: 20, right: 200, bottom: 200 });
  button.click();
  dialog.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }));
  assert.equal(dialog.open, true);
  dialog.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
  assert.equal(dialog.open, true);
  actions.$('[data-settings-help-close]').click();
  assert.equal(dialog.open, false);
  assert.equal(w.document.activeElement, button);
  button.click();
  // The browser closes a native dialog on Escape; the common close listener restores focus.
  dialog.close();
  assert.equal(w.document.activeElement, button);
});

for (const canEditOrganization of [true, false]) {
  test(
    'compact profile keeps editable fields and readonly login email: ' + canEditOrganization,
    async (t) => {
      const { actions, state, root } = fixture(t);
      const calls = [];
      const result = {
        account: { displayName: 'Сотрудник', email: 'synthetic@example.test' },
        organization: {
          name: 'Организация',
          city: 'Город',
          phone: '+7 900 0000000',
          businessType: 'organization',
        },
        specialty: 'Тренер',
        canEditOrganization,
      };
      actions.request = async (...args) => {
        calls.push(args);
        return structuredClone(result);
      };
      actions.readBackground = (...args) => actions.request(...args);
      const profile = actions.$;
      const w = root.ownerDocument.defaultView;
      const module = w.eval('createProfile')(state, actions);
      root.innerHTML = module.profileSettingsHtml() + actions.settingsHelpDialogHtml();
      await module.loadAccountProfile();
      const form = profile('#account-profile-form');
      assert.ok(form.querySelector('.profile-grid'));
      assert.equal(form.elements.displayName.value, 'Сотрудник');
      assert.equal(form.elements.specialty.value, 'Тренер');
      assert.equal(form.elements.specialty.required, false);
      assert.equal(form.elements.expectedSpecialty.value, 'Тренер');
      assert.equal(form.querySelector('input[type=email]').readOnly, true);
      assert.equal(Boolean(form.elements.organizationName), canEditOrganization);
      if (canEditOrganization) {
        assert.equal(form.elements.organizationName.value, 'Организация');
        assert.equal(form.elements.city.value, 'Город');
        assert.equal(form.elements.phone.value, '+7 900 0000000');
      }
      assert.equal(form.querySelectorAll('label button,summary button').length, 0);
      form.elements.displayName.value = 'Черновик';
      form.querySelector('[data-settings-help]').click();
      assert.equal(profile('#settings-help-dialog').open, true);
      assert.equal(form.elements.displayName.value, 'Черновик');
      assert.equal(calls.length, 1);
      assert.equal(state.busy, false);
    },
  );
}
