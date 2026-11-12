// Prepared for the next authorized check stage; synthetic DOM and source only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const styles = [
  ['client-directory-contrast.css', '.workspace-designed.clients-mode', 'client-workspace.css'],
  [
    'management-details-design.css',
    '.workspace-designed .management-panel',
    'management-design.css',
  ],
  ['settings-details-design.css', '.settings-panel.settings-pages', 'mobile-navigation-design.css'],
];

test('detail styles remain late, screen-only and scoped away from the main calendar and v1', () => {
  const order = JSON.parse(read('src/client/manifest.json')).styles.map((file) =>
    path.basename(file),
  );
  for (const [file, scope, predecessor] of styles) {
    assert.ok(order.indexOf(file) > order.indexOf(predecessor));
    assert.ok(order.indexOf(predecessor) >= 0);
    const sheet = postcss.parse(read('src/client/styles/' + file));
    sheet.walkRules((rule) => {
      for (const selector of rule.selectors)
        assert.ok(selector.replace(/\s+/g, ' ').startsWith(scope), selector);
      assert.doesNotMatch(rule.selector, /calendar-panel|time-grid|print-services/);
      let parent = rule.parent;
      while (parent && parent.type !== 'atrule') parent = parent.parent;
      assert.equal(parent?.name, 'media');
      assert.match(parent.params, /^screen(?:\s|$)/);
    });
  }
});

test('client emphasis, sticky work actions and reminder typography are explicit', () => {
  const directory = read('src/client/styles/client-directory-contrast.css').replace(/\s+/g, ' ');
  assert.match(directory, /\.person-cell strong\s*\{[^}]*font-weight:\s*700/s);
  assert.match(directory, /\.client-filter\.active\s*\{[^}]*color:\s*#fff/s);
  assert.match(directory, /forced-colors: active/);
  const management = read('src/client/styles/management-details-design.css').replace(/\s+/g, ' ');
  assert.match(management, /\.work-selection\s*\{[^}]*position:\s*sticky/s);
  assert.match(
    management,
    /\.booking-request-actions \.booking-danger\s*\{[^}]*grid-column:\s*auto/s,
  );
  const settings = read('src/client/styles/settings-details-design.css').replace(/\s+/g, ' ');
  assert.match(settings, /\.telegram-message-preview pre\s*\{[^}]*font:\s*inherit/s);
  assert.match(settings, /#staff-notifications \[data-staff-state='ready'\]/);
  assert.match(settings, /data-connection-state='checking'/);
});

test('work selection precedes the month and preserves disabled permission controls', (t) => {
  const w = new JSDOM('<main></main>', { runScripts: 'outside-only' }).window;
  t.after(() => w.close());
  w.eval(read('src/client/modules/work-schedule-view.js'));
  const actions = {
    esc: (value) => String(value).replaceAll('<', '&lt;'),
    accountRole: () => 'owner',
    formatDate: (date) => date,
    monthTitle: () => 'октябрь 2030',
    cabinetTimeZoneLabel: () => 'Москва',
  };
  const view = {
    members: [{ accountId: 'staff', displayName: '<Synthetic>', role: 'cosmetologist' }],
    staffId: 'staff',
    days: {},
    closures: {},
    canEdit: false,
    canManagePermission: false,
    canManageCalendar: false,
    calendarHiddenUntil: '09:00',
  };
  const renderer = w.eval('createWorkScheduleView')({}, actions);
  const baseline = JSON.stringify(view);
  const main = w.document.querySelector('main');
  main.innerHTML = renderer.workScheduleMonthHtml(view, '2030-10', ['2030-10-12']);
  assert.equal(main.querySelectorAll('[data-work-edit]').length, 1);
  assert.equal(main.querySelectorAll('[data-work-clear]').length, 1);
  assert.equal(main.querySelector('[data-work-edit]').disabled, true);
  assert.equal(main.querySelector('[data-work-clear]').disabled, false);
  assert.ok(
    main
      .querySelector('.work-selection')
      .compareDocumentPosition(main.querySelector('.work-schedule-calendar')) &
      w.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.equal(
    main.querySelector('[data-work-date="2030-10-12"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(main.querySelectorAll('synthetic').length, 0);
  assert.equal(JSON.stringify(view), baseline);
});
