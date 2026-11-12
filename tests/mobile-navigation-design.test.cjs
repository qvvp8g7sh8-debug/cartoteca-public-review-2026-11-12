const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');
const cssPath = 'src/client/styles/mobile-navigation-design.css';
const css = fs.readFileSync(path.join(__dirname, '..', cssPath), 'utf8');

test('colored navigation is a late v2 layer with mobile glyphs and non-color selection cues', () => {
  const sheet = postcss.parse(css);
  sheet.walkRules((rule) => {
    assert.equal(rule.parent.type, 'atrule');
    if (rule.selector === '.app-nav .nav-management-glyph') {
      assert.equal(rule.parent.params, 'screen');
      rule.walkDecls((declaration) => assert.equal(declaration.prop, 'display'));
      return;
    }
    assert.match(
      rule.parent.params,
      /^screen(?: and \((?:max-width: (?:700|360)px|forced-colors: active|prefers-reduced-motion: reduce)\))?(?: and \(forced-colors: active\))?$/,
    );
    // PostCSS preserves commas inside :is(...); they are not selector-list separators.
    for (const selector of rule.selectors)
      assert.match(selector, /app-nav-designed|workspace-designed/);
  });
  for (const view of ['calendar', 'clients', 'services', 'settings'])
    assert.ok(css.includes("[data-view='" + view + "']"));
  assert.match(css, /\.app-nav-item\.active/);
  assert.match(css, /aria-selected='true'/);
  assert.match(css, /forced-colors: active/);
  assert.doesNotMatch(css, /url\(|@import|calendar-grid|time-grid/);
  assert.doesNotMatch(css, /opacity:\s*0\.5|saturate\(0\.55\)/);
  const markers = [];
  sheet.walkRules('.topbar .app-nav-designed .app-nav-item.active::after', (rule) => {
    const declarations = Object.fromEntries(
      rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
    );
    markers.push({ media: rule.parent.params, declarations });
  });
  assert.ok(
    markers.some(
      ({ media, declarations }) =>
        media === 'screen' &&
        declarations.bottom === '2px' &&
        declarations['pointer-events'] === 'none',
    ),
  );
  assert.ok(
    markers.some(
      ({ media, declarations }) =>
        media === 'screen and (max-width: 700px)' &&
        declarations.top === '3px' &&
        declarations.bottom === 'auto',
    ),
  );
  assert.ok(
    markers.some(
      ({ media, declarations }) =>
        media === 'screen and (forced-colors: active)' && declarations.background === 'Highlight',
    ),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../src/client/manifest.json'), 'utf8'),
  );
  assert.ok(
    manifest.styles.indexOf(cssPath) >
      manifest.styles.indexOf('src/client/styles/management-design.css'),
  );
});

test('rooms, service catalog and management have distinct decorative silhouettes', (t) => {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  for (const file of ['team', 'management'])
    w.eval(fs.readFileSync(path.join(__dirname, '../src/client/modules/' + file + '.js'), 'utf8'));
  const state = { multiUser: true };
  const settings = w.eval('createTeam')(state, { esc: String });
  w.document.querySelector('main').innerHTML = settings.settingsSectionHtml(
    'Кабинеты и занятость',
    'workspace-settings',
    '',
  );
  const room = w.document.querySelector('[data-settings-icon="workspace-settings"] svg');
  const roomGlyph = room.innerHTML;
  assert.ok(room.querySelector('rect[width="11"]'));
  assert.ok(room.querySelector('circle[cx="18"][cy="17"]'));
  const management = w.eval('createManagement')(state, { servicesHtml: () => '' });
  w.document.querySelector('main').innerHTML = management.managementHtml();
  const service = w.document.querySelector('[data-management-tab="services"] svg');
  const serviceGlyph = service.innerHTML;
  assert.equal(service.querySelector('rect'), null);
  assert.ok(service.querySelector('circle[cx="7"][cy="7"]'));
  const shell = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'));
  t.after(() => shell.window.close());
  const nav = shell.window.document.querySelector('[data-view="services"] svg');
  const managementGlyph = nav.querySelector('.nav-management-glyph');
  assert.equal(nav.getAttribute('aria-hidden'), 'true');
  assert.equal(managementGlyph.querySelectorAll('circle').length, 3);
  assert.equal(new Set([roomGlyph, serviceGlyph, managementGlyph.innerHTML]).size, 3);
  assert.equal(nav.querySelectorAll('.nav-services-glyph rect').length, 4);
  const legacy = w.eval('createManagement')({ multiUser: false }, { servicesHtml: () => '' });
  w.document.querySelector('main').innerHTML = legacy.managementHtml();
  assert.equal(w.document.querySelectorAll('[data-management-tab="services"] svg rect').length, 4);
  assert.match(css, /\.app-nav-designed \.nav-services-glyph\s*\{\s*display: none/);
  assert.match(css, /\.app-nav-designed \.nav-management-glyph\s*\{\s*display: block/);
});

test('schedule and request icon colors override the general services palette', () => {
  const sheet = postcss.parse(css);
  const base = (id) => {
    let value;
    sheet.walkRules(
      ".workspace-designed .management-tabs [data-management-tab='" + id + "']",
      (rule) =>
        rule.walkDecls('--nav-icon-base', (declaration) => {
          value = declaration.value;
        }),
    );
    return value;
  };
  assert.equal(base('schedule'), '#20977b');
  assert.equal(base('requests'), '#d97956');
});
