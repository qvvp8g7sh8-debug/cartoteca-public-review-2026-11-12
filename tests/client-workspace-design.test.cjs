// Prepared for the next user-authorized check stage; no runtime or real clients.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const root = path.resolve(__dirname, '..');
const css = (file) =>
  postcss.parse(fs.readFileSync(path.join(root, 'src/client/styles', file), 'utf8'));

test('new client and management presentation is screen-only and scoped to the multiuser workspace', () => {
  for (const name of ['client-workspace.css', 'client-card-design.css', 'management-design.css']) {
    const sheet = css(name);
    assert.equal(sheet.nodes.find((node) => node.type === 'atrule').params, 'screen');
    sheet.walkRules((rule) => {
      assert.ok(rule.selector.includes('.workspace-designed'));
      assert.doesNotMatch(rule.selector, /calendar-panel|time-grid|print-services/);
    });
  }
  const navigation = fs.readFileSync(path.join(root, 'src/client/core/navigation.js'), 'utf8');
  assert.match(navigation, /classList\.toggle\('workspace-designed', state\.multiUser\)/);
});

test('mobile client directory preserves phone, appointment and distinct contact controls', () => {
  const source = fs.readFileSync(path.join(root, 'src/client/modules/clients.js'), 'utf8');
  for (const name of ['client-list-phone', 'client-list-last', 'client-list-next'])
    assert.ok(source.includes(name));
  const sheet = css('client-workspace.css'),
    display = new Map();
  sheet.walkRules((rule) => {
    rule.walkDecls('display', (decl) => display.set(rule.selector, decl.value));
  });
  assert.equal(display.get('.workspace-designed.clients-mode .client-list-phone'), 'none');
  assert.equal(
    display.get(
      '.workspace-designed.clients-mode .person-cell > span:last-child > small.client-inline-phone',
    ),
    'block',
  );
  assert.equal(display.get('.workspace-designed.clients-mode .client-list-next'), 'flex');
  assert.ok(source.includes('actions.clientContactActionsHtml(p)'));
});

test('client initials have six stable identity colors, independent of service status', () => {
  const palette = new Map();
  css('client-directory-contrast.css').walkRules((rule) => {
    const match = rule.selector.match(
      /^\.workspace-designed\.clients-mode \.avatar\[data-client-color=(["'])([0-5])\1\]$/,
    );
    if (match) palette.set(match[2], rule.nodes.find((node) => node.prop === 'background')?.value);
  });
  assert.equal(palette.size, 6);
  assert.equal(new Set(palette.values()).size, 6);
  const source = fs.readFileSync(path.join(root, 'src/client/modules/clients.js'), 'utf8');
  assert.match(source, /data-client-color="\$\{avatarColor\(p\.id\)\}"/);
  assert.doesNotMatch(source, /Math\.random/);
});

test('active service categories remain readable after the later design layer', () => {
  let active;
  css('management-design.css').walkRules((rule) => {
    if (rule.selector.endsWith('.service-category-tab.active'))
      active = Object.fromEntries(rule.nodes.map((node) => [node.prop, node.value]));
  });
  assert.equal(active.background, 'var(--blue)');
  assert.equal(active.color, '#fff');
});

test('calm client card is screen-only, scoped and preserves semantic icons and statuses', () => {
  const sheet = css('client-card-calm.css');
  sheet.walkRules((rule) => {
    for (const selector of rule.selectors) {
      assert.ok(selector.startsWith('.workspace.workspace-designed.card-mode'));
      assert.doesNotMatch(
        selector,
        /patient-mark-button|connection-service|photo-item|is-confirmed|calendar-panel|#editor/,
      );
    }
    let parent = rule.parent;
    while (parent.parent?.type !== 'root') parent = parent.parent;
    assert.match(parent.params, /^screen(?: and \(.+\))?$/);
  });
  const values = (selector) => {
    let declarations;
    sheet.walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, ' ') !== selector) return;
      declarations = Object.fromEntries(
        rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
      );
    });
    return declarations;
  };
  assert.equal(
    values('.workspace.workspace-designed.card-mode #new-patient-appointment')['--card-action-ink'],
    '#fff',
  );
  assert.equal(
    values(
      ".workspace.workspace-designed.card-mode .telegram-strip-tools > button[data-confirm-value='true']",
    )['--card-action-bottom'],
    '#deeee5',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/client/manifest.json'), 'utf8'));
  assert.equal(
    values('.workspace.workspace-designed.card-mode .visit-history-heading #new-visit')['justify-self'],
    'center',
  );
  assert.equal(
    values('.workspace.workspace-designed.card-mode .visit-history-heading #new-visit')['grid-column'],
    '1 / -1',
  );
  const card = fs.readFileSync(path.join(root, 'src/client/modules/card.js'), 'utf8');
  assert.ok(card.includes('<span>Добавить посещение без записи</span>'));
  assert.ok(
    manifest.styles.indexOf('src/client/styles/client-card-calm.css') >
      manifest.styles.indexOf('src/client/styles/client-card-header.css'),
  );
});
