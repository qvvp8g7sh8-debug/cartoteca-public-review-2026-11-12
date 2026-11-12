const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(
  path.join(__dirname, '../src/client/modules/staff-booking-rules.js'),
  'utf8',
);

function fixture(
  t,
  {
    canEdit = true,
    canEditStaffRules = canEdit,
    manager = true,
    reject = false,
    confirmed = true,
    initialBlocked = false,
  } = {},
) {
  const dom = new JSDOM(
    '<section id="team-settings"><div id="staff-booking-rules"></div></section><div id="workspace-settings"><form id="workspace-settings-form" data-workspace-revision="4"><input data-room-name value="Несохранённый кабинет"></form></div>',
  );
  t.after(() => dom.window.close());
  const members = [
    { accountId: 'owner', displayName: 'Пример владельца', role: 'owner', status: 'active' },
    {
      accountId: 'staff',
      displayName: 'Пример специалиста',
      role: 'cosmetologist',
      status: 'active',
    },
  ];
  const state = {
    account: { id: 'owner' },
    busy: false,
    roleNames: { owner: 'Владелец', cosmetologist: 'Сотрудник' },
    workspace: {
      revision: 4,
      enabled: false,
      mode: 'separate',
      roomLayout: 'single',
      canEdit,
      canEditStaffRules,
      staffRules: [{ staffId: 'owner', preventOverlap: initialBlocked }],
      members: manager ? members : [],
      rooms: [
        {
          id: 'main',
          name: 'Сохранённый кабинет',
          active: true,
          staffMode: 'single',
          staffIds: ['owner'],
          preventOverlap: true,
        },
      ],
    },
  };
  const requests = [],
    savedForms = [];
  dom.window.confirm = () => confirmed;
  const actions = {
    $: (selector) => dom.window.document.querySelector(selector),
    accountId: () => 'owner',
    canManageTeam: () => manager,
    confirmAction: async () => confirmed,
    esc: (value) => String(value),
    settingsHelpHtml: () => '<button type="button">?</button>',
    markSettingsSaved: (form) => savedForms.push(form),
    toast: () => {},
    request: async (url, options) => {
      if (!options) {
        requests.push({ url, method: 'GET' });
        return structuredClone(state.workspace);
      }
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (reject)
        throw typeof reject === 'object'
          ? reject
          : Error('Настройки изменились. Обновите их перед сохранением.');
      return { ...state.workspace, ...body, revision: body.revision + 1 };
    },
  };
  const create = vm.runInNewContext(source + ';createStaffBookingRules', {
    document: dom.window.document,
    window: dom.window,
    structuredClone,
  });
  const module = create(state, actions);
  module.renderStaffBookingRules();
  module.bindStaffBookingRulesEvents();
  const input = () => actions.$('[data-workspace-staff-rule="owner"]');
  const toggle = (value = true) => {
    input().checked = value;
    input().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  const submit = () =>
    actions
      .$('#staff-booking-rules-form')
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const done = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { dom, state, actions, requests, savedForms, module, input, toggle, submit, done };
}

test('staff rule form is compactly separated from room settings and preserves the unsaved room draft', async (t) => {
  const f = fixture(t),
    prior = f.actions.$('#staff-booking-rules-form');
  assert.equal(prior.closest('#team-settings').id, 'team-settings');
  assert.equal(f.actions.$('#workspace-settings [data-workspace-staff-rule]'), null);
  f.toggle();
  assert.equal(
    f.actions.$('[data-staff-rule-state="allowed"] [data-staff-rule-label]').textContent,
    'Разрешены',
  );
  assert.equal(f.input().checked, false);
  assert.equal(prior.querySelector('[type="submit"]'), null);
  await f.done();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.revision, 4);
  assert.deepEqual(Object.keys(f.requests[0].body).sort(), ['revision', 'staffRules']);
  assert.deepEqual(f.requests[0].body.staffRules, [
    { staffId: 'owner', preventOverlap: true },
    { staffId: 'staff', preventOverlap: false },
  ]);
  assert.equal(f.actions.$('[data-room-name]').value, 'Несохранённый кабинет');
  assert.equal(f.actions.$('#workspace-settings-form').dataset.workspaceRevision, '5');
  assert.equal(f.input().checked, true);
  assert.notEqual(f.actions.$('#staff-booking-rules-form'), prior);
  assert.equal(f.state.busy, false);
});

test('pending checkbox confirmation is not discarded or silently rebased by a render', async (t) => {
  const f = fixture(t),
    form = f.actions.$('#staff-booking-rules-form');
  let answer;
  f.actions.confirmAction = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  f.toggle();
  f.state.workspace.revision = 5;
  f.module.renderStaffBookingRules();
  assert.equal(f.actions.$('#staff-booking-rules-form'), form);
  assert.equal(form.dataset.revision, '4');
  f.module.renderStaffBookingRules({ rebase: true });
  assert.equal(f.actions.$('#staff-booking-rules-form'), form);
  assert.equal(form.dataset.revision, '4');
  assert.equal(f.input().checked, false);
  answer(false);
  await f.done();
  assert.equal(f.requests.length, 0);
});

test('failed autosave restores the checkbox and does not touch the room draft', async (t) => {
  const f = fixture(t, { reject: true }),
    form = f.actions.$('#staff-booking-rules-form');
  f.toggle();
  await f.done();
  assert.equal(f.actions.$('#staff-booking-rules-form'), form);
  assert.equal(f.input().checked, false);
  assert.match(f.actions.$('#staff-booking-rules-message').textContent, /Настройки изменились/);
  assert.equal(f.actions.$('#workspace-settings-form').dataset.workspaceRevision, '4');
  assert.equal(f.state.busy, false);
});

test('removing the checkbox also confirms and saves immediately', async (t) => {
  const f = fixture(t, { initialBlocked: true });
  let questions = 0;
  f.actions.confirmAction = async () => {
    questions++;
    return true;
  };
  f.toggle(false);
  assert.equal(f.input().checked, true);
  await f.done();
  assert.equal(questions, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.staffRules[0].preventOverlap, false);
  assert.equal(f.input().checked, false);
});

test('unknown write result blocks new changes until an explicit read, without replaying a write', async (t) => {
  const error = Error('Lost response');
  error.outcomeUnknown = true;
  const f = fixture(t, { reject: error });
  f.toggle();
  await f.done();
  assert.equal(f.input().disabled, true);
  assert.equal(
    f.actions.$('[data-staff-rule-state="unknown"] [data-staff-rule-label]').textContent,
    'Неизвестно',
  );
  const form = f.actions.$('#staff-booking-rules-form');
  f.module.renderStaffBookingRules();
  assert.equal(f.actions.$('#staff-booking-rules-form'), form);
  f.state.workspace.staffRules[0].preventOverlap = true;
  f.actions.$('[data-staff-rules-refresh]').click();
  await f.done();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].method, 'GET');
  assert.equal(f.input().checked, true);
  assert.equal(f.input().disabled, false);
  assert.equal(f.actions.$('#workspace-settings-form').dataset.workspaceRevision, '4');
});

test('cancelled confirmation and unchanged rules do not send a request', async (t) => {
  const f = fixture(t, { confirmed: false });
  f.submit();
  await f.done();
  f.toggle();
  f.submit();
  await f.done();
  assert.equal(f.requests.length, 0);
});

test('administrator can edit staff rules without permission to edit rooms', async (t) => {
  const admin = fixture(t, { canEdit: false, canEditStaffRules: true });
  assert.equal(admin.input().disabled, false);
  assert.equal(admin.actions.$('#staff-booking-rules-form [type="submit"]'), null);
  admin.toggle();
  await admin.done();
  assert.equal(admin.requests.length, 1);
  assert.deepEqual(Object.keys(admin.requests[0].body).sort(), ['revision', 'staffRules']);
  assert.equal(admin.input().checked, true);
  assert.equal(admin.state.workspace.canEdit, false);
});

test('employee sees only their own status without editable controls', (t) => {
  const employee = fixture(t, { canEdit: false, manager: false });
  assert.equal(employee.actions.$('#staff-booking-rules-form'), null);
  assert.equal(employee.actions.$('[data-staff-rule-label]').textContent, 'Разрешены');
  assert.equal(employee.actions.$('[type="checkbox"]'), null);
  const blockedEmployee = fixture(t, { canEdit: false, manager: false, initialBlocked: true });
  assert.equal(blockedEmployee.actions.$('[data-staff-rule-label]').textContent, 'Запрещены');
  assert.ok(blockedEmployee.actions.$('[data-staff-rule-state="blocked"]'));
  assert.doesNotMatch(employee.actions.$('#staff-booking-rules').textContent, /Пример специалиста/);
});
