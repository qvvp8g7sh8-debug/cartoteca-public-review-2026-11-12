const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { installActionConfirmation } = require('./helpers/action-confirmation.cjs');
test('profile timezone select retains WebKit paint containment after leaving Telegram settings', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '../src/client/styles/action-confirmation.css'),
    'utf8',
  );
  const rule = css.match(/\.organization-time-zone-form select\s*\{([^}]+)\}/)[1];
  assert.match(rule, /contain:\s*paint/);
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /max-width:\s*480px/);
});
function fixture(t) {
  const w = new JSDOM(
    '<button id="opener">Открыть</button><div id="global-view"><div class="settings-panel"><form><input name="city" value="Москва"></form></div></div>',
    { runScripts: 'outside-only' },
  ).window;
  t.after(() => w.close());
  installActionConfirmation(w, { automatic: false });
  for (const name of ['action-confirmation', 'settings-guard'])
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/', name + '.js'), 'utf8'));
  const state = { busy: false },
    $ = (selector) => w.document.querySelector(selector),
    confirmation = w.createActionConfirmation(state, { $ }),
    guard = w.createSettingsGuard(state, { $, ...confirmation });
  return { w, $, state, ...confirmation, ...guard };
}
test('explicit accept/cancel resolves once, safe focus is restored, concurrent requests are refused', async (t) => {
  const f = fixture(t);
  f.$('#opener').focus();
  const decision = f.confirmAction('Удалить?', '<b>Только текст</b>', 'Удалить', 'Оставить');
  assert.equal(f.$('#action-confirmation-message').innerHTML, '&lt;b&gt;Только текст&lt;/b&gt;');
  assert.equal(await f.confirmAction('Другой вопрос', ''), false);
  f.$('[data-confirm-cancel]').click();
  assert.equal(await decision, false);
  assert.equal(f.w.document.activeElement.id, 'opener');
  const accepted = f.confirmAction('Изменить?', 'Вымышленный клиент');
  f.$('[data-confirm-accept]').click();
  assert.equal(await accepted, true);
  const escape = f.confirmAction('Ещё?', '');
  f.$('#action-confirmation').close();
  assert.equal(await escape, false);
});
test('settings leave is guarded only while the form differs from its saved baseline', async (t) => {
  const f = fixture(t);
  f.bindSettingsGuardEvents();
  assert.equal(await f.confirmSettingsLeave(), true);
  f.$('[name=city]').value = 'Черновик';
  const cancelled = f.confirmSettingsLeave();
  f.$('[data-confirm-cancel]').click();
  assert.equal(await cancelled, false);
  assert.equal(f.$('[name=city]').value, 'Черновик');
  f.markSettingsSaved(f.$('form'));
  assert.equal(await f.confirmSettingsLeave(), true);
});

test('backdrop click neither cancels nor accepts a pending confirmation', async (t) => {
  const f = fixture(t);
  const decision = f.confirmAction('Закрыть форму?', 'Черновик сохранён до решения');
  const dialog = f.$('#action-confirmation');
  dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 400, bottom: 300 });
  dialog.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
  assert.equal(dialog.open, true);
  assert.equal(await f.confirmAction('Второй вопрос', ''), false);
  f.$('[data-confirm-cancel]').click();
  assert.equal(await decision, false);
});

test('draft warning prioritizes continuing without changing accept/cancel semantics', async (t) => {
  const f = fixture(t);
  const decision = f.confirmAction(
    'Закрыть форму?',
    'Изменения будут потеряны.',
    'Закрыть без сохранения',
    'Продолжить',
    { preferCancel: true },
  );
  assert.equal(f.$('[data-confirm-cancel]').className, 'primary');
  assert.equal(f.$('[data-confirm-accept]').className, 'secondary');
  f.$('[data-confirm-cancel]').click();
  assert.equal(await decision, false);
  const next = f.confirmAction('Сохранить?', '');
  assert.equal(f.$('#action-confirmation').classList.contains('confirmation-prefer-cancel'), false);
  assert.equal(f.$('[data-confirm-cancel]').className, 'secondary');
  assert.equal(f.$('[data-confirm-accept]').className, 'primary');
  f.$('[data-confirm-accept]').click();
  assert.equal(await next, true);
});
