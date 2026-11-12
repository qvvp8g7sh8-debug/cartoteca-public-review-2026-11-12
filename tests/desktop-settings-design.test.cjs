const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sheets = [
  'desktop-settings.css',
  'desktop-workspace.css',
  'desktop-booking.css',
  'desktop-editors.css',
].map((file) => ({
  file,
  sheet: postcss.parse(read('src/client/styles/' + file)),
}));

test('desktop settings and editors cannot leak into 980px, print, v1 or public booking', () => {
  const order = JSON.parse(read('src/client/manifest.json')).styles.map((file) =>
    path.basename(file),
  );
  for (const { file, sheet } of sheets) {
    assert.ok(order.indexOf(file) > order.indexOf('buttons-calm.css'), file);
    assert.ok(order.indexOf('buttons-calm.css') >= 0);
    sheet.walkRules((rule) => {
      let outer = rule;
      while (outer.parent?.type !== 'root') outer = outer.parent;
      assert.equal(outer.type, 'atrule');
      assert.equal(outer.name, 'media');
      assert.equal(outer.params, 'screen and (min-width: 981px)');
      for (const selector of rule.selectors) {
        assert.ok(
          selector.startsWith(
            file !== 'desktop-editors.css'
              ? '.settings-panel.settings-pages'
              : '#editor.editor-designed',
          ),
          selector,
        );
        assert.doesNotMatch(selector, /booking-shell|public-booking|calendar-panel|\bbody\b/);
      }
      rule.walkDecls((decl) => {
        if (decl.prop === 'display' && decl.value === 'none') {
          const allowedHidden = {
            'desktop-settings.css':
              '.settings-panel.settings-pages #improvement-settings :is([data-improvement-new], [data-improvement-cancel])',
            'desktop-workspace.css':
              '.settings-panel.settings-pages #workspace-settings [data-room-expanded="false"] > :is(.workspace-room-heading, .workspace-room-assignments)',
          };
          assert.equal(
            rule.selector.replace(/\s+/g, ' ').replaceAll('"', "'"),
            allowedHidden[file]?.replaceAll('"', "'"),
            'Only redundant composer toggles or explicitly collapsed room editors may be hidden',
          );
        }
        assert.ok(!(decl.prop === 'pointer-events' && decl.value === 'none'), 'Keep interactions');
      });
    });
  }
});

test('compact desktop booking labels retain a 36px help hit area without enlarging the glyph', () => {
  const sheet = sheets.find(({ file }) => file === 'desktop-booking.css').sheet;
  const dimensions = {};
  sheet.walkRules((rule) => {
    if (
      !rule.selector.replace(/\s+/g, ' ').endsWith('.online-booking-fields .settings-help-trigger')
    )
      return;
    rule.walkDecls((decl) => {
      dimensions[decl.prop] = decl.value;
    });
  });
  for (const property of ['flex-basis', 'width', 'min-width', 'height', 'min-height'])
    assert.equal(dimensions[property], '36px', property);
  assert.equal(dimensions['font-size'], undefined, 'The existing glyph remains unchanged');
});

function fixture(t, initialWidth = 1280) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const w = new JSDOM(
    '<header class="topbar"><nav class="app-nav"></nav></header><main id="global-view"></main>',
    {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole,
    },
  ).window;
  const settle = () => new Promise((resolve) => w.setTimeout(() => w.setTimeout(resolve, 0), 0));
  t.after(async () => {
    await settle();
    try {
      assert.deepEqual(errors, []);
    } finally {
      w.close();
    }
  });
  let width = initialWidth;
  w.matchMedia = (query) => ({ matches: width >= Number(query.match(/min-width:\s*(\d+)/)[1]) });
  for (const name of ['team', 'settings-pages']) w.eval(read('src/client/modules/' + name + '.js'));
  const state = {
    multiUser: true,
    currentView: 'settings',
    busy: false,
    roleNames: { owner: 'Владелец' },
  };
  const actions = {
    syncVisibleTelegram: async () => {},
    $: (selector) => w.document.querySelector(selector),
    esc: (value) => String(value ?? '').replaceAll('<', '&lt;'),
    accountRole: () => 'owner',
    canManageTeam: () => true,
    settingsHelpHtml: () => '',
  };
  Object.assign(
    actions,
    w.eval('createTeam')(state, actions),
    w.eval('createSettingsPages')(state, actions),
  );
  const sections = [
    ['profile', 'profile', 'Мой профиль'],
    ['integrations', 'integrations', 'Интеграции'],
    ['paidServices', 'paid-services', 'Пакеты и оплата'],
    ['workspace', 'workspace', 'Кабинеты и занятость'],
    ['onlineBooking', 'online-booking', 'Онлайн-запись'],
    ['telegram', 'telegram', 'Напоминания клиентам'],
    ['support', 'support', 'Техподдержка'],
    ['improvement', 'improvement', 'Развитие Картотеки'],
  ];
  for (const [name, id, title] of sections) {
    actions[name + 'SettingsHtml'] = () =>
      actions.settingsSectionHtml(
        title,
        id + '-settings',
        `<form><input name="draft" value="Черновик"><button type="submit">Сохранить</button></form>`,
      );
  }
  actions.$('#global-view').innerHTML = actions.settingsHtml();
  const panel = actions.$('.settings-panel'),
    tiles = actions.$('.settings-tiles');
  const dimensions = { top: 64, height: 488, panelHeight: 584 };
  Object.defineProperty(w, 'innerHeight', { value: 720, configurable: true });
  Object.defineProperty(panel, 'clientHeight', { get: () => dimensions.panelHeight });
  Object.defineProperty(tiles, 'offsetTop', { get: () => dimensions.top });
  Object.defineProperty(tiles, 'offsetHeight', { get: () => dimensions.height });
  panel.getBoundingClientRect = () => ({ top: 120 });
  actions.bindSettingsPageEvents();
  actions.mountSettingsPages();
  return {
    w,
    actions,
    panel,
    tiles,
    dimensions,
    settle,
    resize(value) {
      width = value;
      w.dispatchEvent(new w.Event('resize'));
    },
  };
}

test('all owner settings pages retain forms and drafts while the desktop menu scrolls', async (t) => {
  const f = fixture(t),
    $ = f.actions.$;
  await f.settle();
  const pages = [...f.tiles.querySelectorAll(':scope > details')];
  assert.deepEqual(
    pages.map((page) => [
      page.querySelector('.settings-accordion-content').id,
      page.querySelector('.settings-page-title').textContent,
    ]),
    [
      ['profile-settings', 'Мой профиль'],
      ['integrations-settings', 'Интеграции'],
      ['paid-services-settings', 'Пакеты и оплата'],
      ['team-settings', 'Сотрудники и доступ'],
      ['workspace-settings', 'Кабинеты и занятость'],
      ['online-booking-settings', 'Онлайн-запись'],
      ['telegram-settings', 'Напоминания клиентам'],
      ['support-settings', 'Техподдержка'],
      ['improvement-settings', 'Развитие Картотеки'],
    ],
  );
  const input = $('#profile-settings input');
  input.value = 'Несохранённый профиль';
  f.tiles.scrollTop = 180;
  pages.at(-1).open = true;
  await f.settle();
  assert.equal(f.panel.dataset.settingsOpen, 'improvement-settings');
  assert.equal(f.tiles.querySelectorAll(':scope > details[open]').length, 1);
  assert.equal(f.tiles.scrollTop, 180);
  assert.equal($('#profile-settings input'), input, 'No reparenting or rebuilding forms');
  assert.equal(input.value, 'Несохранённый профиль');
  const team = $('#team-settings').closest('details');
  assert.equal($('#staff-notifications').closest('details'), team);
  assert.equal($('#staff-booking-rules').closest('details'), team);
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-top'), '64px');
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-bottom'), '32px');
  f.dimensions.top = 108;
  f.dimensions.height = 428;
  f.resize(1366);
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-top'), '108px');
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-bottom'), '48px');
  assert.equal(f.tiles.scrollTop, 180);
  f.resize(980);
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-top'), '');
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-bottom'), '');
  assert.equal(input.value, 'Несохранённый профиль');
  assert.equal(pages.at(-1).open, true);
  f.resize(1280);
  pages[0].open = true;
  await f.settle();
  assert.equal($('#profile-settings input'), input);
  assert.equal(input.value, 'Несохранённый профиль');
});

test('mobile settings retain the existing index and explicit Back behavior', async (t) => {
  const f = fixture(t, 390);
  assert.equal(f.tiles.querySelector('details[open]'), null);
  assert.equal(f.panel.style.getPropertyValue('--settings-desktop-top'), '');
  const last = f.tiles.querySelector('details:last-child');
  last.open = true;
  await f.settle();
  last.querySelector('[data-settings-back]').click();
  await f.settle();
  assert.equal(last.open, false);
  assert.equal(f.panel.hasAttribute('data-settings-open'), false);
  assert.equal(f.w.document.activeElement, last.querySelector('summary'));
});

test('shared editor layout selects new and existing appointments and visits only', (t) => {
  const w = new JSDOM('<main></main>').window;
  t.after(() => w.close());
  const sheet = sheets.find(({ file }) => file === 'desktop-editors.css').sheet;
  let gridRule, timingRule;
  sheet.walkRules((rule) => {
    if (rule.nodes.some((node) => node.prop === 'grid-template-columns')) gridRule = rule;
    if (rule.nodes.some((node) => node.prop === 'grid-column' && node.value === 'auto'))
      timingRule = rule;
  });
  for (const [kind, edit] of [
    ['appointment', false],
    ['appointment', true],
    ['visit', false],
    ['patient', false],
    ['service', false],
    ['appointmentActions', false],
  ]) {
    w.document.querySelector('main').innerHTML =
      `<dialog id="editor" class="editor-designed" data-editor-kind="${kind}"><form id="editor-form"><div class="form-grid${edit ? ' appointment-edit-form' : ''}">${['date', 'time', 'duration', 'notes'].map((name) => `<label class="field"><input name="${name}"></label>`).join('')}</div></form></dialog>`;
    const selected = ['appointment', 'visit'].includes(kind);
    assert.equal(w.document.querySelectorAll(gridRule.selector).length, selected ? 1 : 0, kind);
    assert.equal(w.document.querySelectorAll(timingRule.selector).length, selected ? 3 : 0, kind);
  }
  sheet.walkDecls((decl) => {
    assert.ok(
      !['position', 'inset', 'left', 'top', 'transform', 'touch-action'].includes(decl.prop),
      'Keep dialog dragging and position intact',
    );
    assert.notEqual(decl.prop, 'border-color', 'Keep existing field validation colors');
  });
});
