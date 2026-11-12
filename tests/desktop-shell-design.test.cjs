const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const root = path.resolve(__dirname, '..');
const sheet = (name) =>
  postcss.parse(fs.readFileSync(path.join(root, 'src/client/styles', name), 'utf8'));

test('desktop shell, directory and calendar layers cannot affect mobile or print', () => {
  for (const name of ['desktop-shell.css', 'desktop-directory.css', 'desktop-calendar.css']) {
    sheet(name).walkRules((rule) => {
      assert.equal(rule.parent.type, 'atrule');
      assert.equal(rule.parent.params, 'screen and (min-width: 981px)');
      assert.match(rule.selector, /workspace-designed|app-nav-designed/);
    });
  }
});

test('navigation and working sections retain separate white surfaces', () => {
  const rules = new Map();
  sheet('desktop-shell.css').walkRules((rule) => {
    rules.set(
      rule.selector,
      Object.fromEntries(rule.nodes.filter((n) => n.type === 'decl').map((n) => [n.prop, n.value])),
    );
  });
  assert.equal(rules.get('.topbar:has(.app-nav-designed)').background, '#fff');
  assert.equal(rules.get('.topbar .app-nav-designed')['justify-self'], 'center');
  assert.equal(rules.get('.topbar:has(.app-nav-designed) .brand')['grid-row'], '1');
  const surface = [...rules].find(([selector]) =>
    selector.includes('.workspace-designed > .detail'),
  );
  assert.equal(surface[1].background, '#fff');
});

test('calendar polishing does not override appointment geometry or status colors', () => {
  sheet('desktop-calendar.css').walkRules((rule) => {
    assert.doesNotMatch(
      rule.selector,
      /calendar-event|time-row|time-slot|time-labels|appointment-color/,
    );
  });
});

test('desktop layers are built after the old cross-device design without replacing it', () => {
  const { styles } = JSON.parse(
    fs.readFileSync(path.join(root, 'src/client/manifest.json'), 'utf8'),
  );
  const boundary = styles.indexOf('src/client/styles/buttons-calm.css');
  for (const name of [
    'shell',
    'directory',
    'calendar',
    'card',
    'management',
    'settings',
    'editors',
  ])
    assert.ok(styles.indexOf(`src/client/styles/desktop-${name}.css`) > boundary);
  assert.ok(styles.includes('src/client/styles/calendar-mobile-composition.css'));
});
