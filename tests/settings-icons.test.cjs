const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');
const source = fs.readFileSync(path.join(__dirname, '../src/client/modules/team.js'), 'utf8');
const cssPath = 'src/client/styles/settings-icons.css';
const css = fs.readFileSync(path.join(__dirname, '..', cssPath), 'utf8');

test('settings icons are decorative vectors with section identities and a common reminder bell', (t) => {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  w.eval(source);
  const actions = { esc: (value) => String(value) };
  const settings = w.eval('createTeam')({ multiUser: true }, actions);
  for (const id of [
    'profile-settings',
    'team-settings',
    'personal-access',
    'workspace-settings',
    'online-booking-settings',
    'telegram-settings',
    'support-settings',
  ]) {
    w.document.querySelector('main').innerHTML = settings.settingsSectionHtml('Раздел', id, '');
    const icon = w.document.querySelector('.settings-tile-icon');
    assert.equal(icon.dataset.settingsIcon, id);
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.equal(icon.hasAttribute('tabindex'), false);
    // Read the case-sensitive SVG attribute directly (JSDOM's HTML selector folds its name).
    assert.equal(icon.querySelector('svg')?.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(icon.querySelector('img'), null);
    assert.equal(icon.querySelector('button'), null);
    assert.ok(w.document.querySelector('#' + id));
    if (id === 'telegram-settings') assert.ok(icon.querySelector('.settings-icon-volume'));
  }
  const legacy = w.eval('createTeam')({ multiUser: false }, actions);
  assert.doesNotMatch(
    legacy.settingsSectionHtml('Telegram', 'telegram-settings', ''),
    /settings-icon-volume/,
  );
});

test('icon color and volume are a screen-only v2 layer without enlarged rows or network assets', () => {
  const sheet = postcss.parse(css);
  sheet.walkRules((rule) => {
    assert.ok(
      rule.selector
        .split(',')
        .every((selector) => selector.trim().startsWith('.settings-panel.settings-pages')),
    );
    assert.equal(rule.parent.type, 'atrule');
    assert.equal(rule.parent.name, 'media');
    assert.match(rule.parent.params, /^screen/);
  });
  const declarations = [];
  sheet.walkDecls((declaration) => declarations.push(declaration.prop));
  for (const property of ['width', 'height', 'min-height', 'font-family', 'animation'])
    assert.equal(declarations.includes(property), false);
  assert.match(css, /forced-colors: active/);
  assert.doesNotMatch(css, /url\(|@import/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../src/client/manifest.json'), 'utf8'),
  );
  assert.ok(
    manifest.styles.indexOf(cssPath) >
      manifest.styles.indexOf('src/client/styles/settings-pages.css'),
  );
});
