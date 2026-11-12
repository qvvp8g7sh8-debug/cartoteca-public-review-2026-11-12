const { assetPath } = require('./helpers/interface-assets.cjs');
const { createWorkspaceSettingsHarness } = require('./helpers/workspace-ui.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const root = path.resolve(__dirname, '..');
test('room settings hide a redundant sole-member picker without dropping saved assignments', () => {
  for (const [memberCount, staffIds, staffMode, hidden] of [
    [1, ['owner'], 'single', true],
    [1, ['owner'], 'multiple', true],
    [1, [], 'single', false],
    [2, ['owner'], 'single', false],
    [2, ['owner', 'staff'], 'multiple', false],
  ]) {
    const dom = new JSDOM('<div id="workspace-settings"></div>');
    try {
      const state = {
        roleNames: { owner: 'Владелец', cosmetologist: 'Сотрудник' },
        workspace: {
          canEdit: true,
          enabled: false,
          roomLayout: 'single',
          revision: 0,
          members: [
            { accountId: 'owner', displayName: 'Владелец', role: 'owner', status: 'active' },
            {
              accountId: 'staff',
              displayName: 'Сотрудник',
              role: 'cosmetologist',
              status: 'active',
            },
          ].slice(0, memberCount),
          rooms: [
            {
              id: 'main',
              name: 'Основной кабинет',
              active: true,
              preventOverlap: true,
              staffMode,
              staffIds,
            },
          ],
        },
      };
      const actions = {
        $: (selector) => dom.window.document.querySelector(selector),
        canManageTeam: () => true,
        esc: (value) => String(value),
        settingsHelpHtml: () => '',
      };
      createWorkspaceSettingsHarness(state, actions, {
        document: dom.window.document,
        window: dom.window,
      }).renderWorkspaceSettings();
      const row = dom.window.document.querySelector('[data-room-id]');
      assert.equal(row.querySelector('.workspace-room-assignments').hidden, hidden);
      assert.equal(row.querySelector('[data-room-staff-mode]').value, staffMode);
      assert.deepEqual(
        [...row.querySelectorAll('[data-room-staff]:checked')].map((input) => input.value),
        staffIds,
      );
      assert.equal(row.querySelector('[data-room-name]').value, 'Основной кабинет');
      assert.equal(row.querySelector('[data-room-number]').textContent, '1');
      assert.equal(dom.window.document.querySelectorAll('[data-workspace-staff-rule]').length, 0);
    } finally {
      dom.window.close();
    }
  }
});
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Workspace UI timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

for (const canEdit of [true, false])
  test(
    'desktop room overview preserves drafts and existing role controls: ' +
      (canEdit ? 'owner' : 'administrator'),
    () => {
      const dom = new JSDOM('<div id="workspace-settings"></div>'),
        w = dom.window;
      try {
        let writes = 0;
        const state = {
          busy: false,
          roleNames: { owner: 'Владелец', cosmetologist: 'Сотрудник' },
          workspace: {
            canEdit,
            canEditRoomAssignments: true,
            canEditRoomOverlap: true,
            enabled: false,
            roomLayout: 'multiple',
            revision: 0,
            members: [
              {
                accountId: 'owner',
                displayName: 'Анна Примерова',
                role: 'owner',
                status: 'active',
              },
              {
                accountId: 'staff',
                displayName: 'Елена Примерова',
                role: 'cosmetologist',
                status: 'active',
              },
            ],
            rooms: [
              {
                id: 'main',
                name: 'Основной кабинет',
                active: true,
                preventOverlap: true,
                staffMode: 'multiple',
                staffIds: ['owner'],
              },
            ],
          },
        };
        const actions = {
          $: (selector) => w.document.querySelector(selector),
          canManageTeam: () => true,
          accountId: () => 'owner',
          esc: String,
          settingsHelpHtml: () => '',
          request: () => {
            writes++;
            throw Error('No saving during disclosure');
          },
        };
        const api = createWorkspaceSettingsHarness(state, actions, {
          document: w.document,
          window: w,
        });
        api.renderWorkspaceSettings();
        api.bindWorkspaceSettingsEvents();
        const row = w.document.querySelector('[data-room-id]'),
          button = row.querySelector('[data-room-edit]'),
          name = row.querySelector('[data-room-name]');
        assert.equal(row.dataset.roomExpanded, 'false');
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(row.querySelector('[data-room-prevent-overlap]').disabled, false);
        assert.equal(name.disabled, !canEdit);
        assert.equal(row.querySelector('[data-room-staff]').disabled, false);
        button.click();
        assert.equal(row.dataset.roomExpanded, 'true');
        const staff = row.querySelector('[data-room-staff][value="staff"]');
        staff.click();
        assert.match(
          row.querySelector('[data-room-summary-staff]').textContent,
          /Анна Примерова, Елена Примерова/,
        );
        if (canEdit) {
          name.value = 'Тихий кабинет';
          name.dispatchEvent(new w.Event('input', { bubbles: true }));
        }
        button.click();
        assert.equal(row.dataset.roomExpanded, 'false');
        button.click();
        assert.equal(
          row.querySelector('[data-room-name]'),
          name,
          'Inputs are retained, not rerendered',
        );
        assert.equal(staff.checked, true);
        assert.equal(name.value, canEdit ? 'Тихий кабинет' : 'Основной кабинет');
        assert.equal(writes, 0);
        if (canEdit) {
          name.value = '';
          button.click();
          assert.equal(row.dataset.roomExpanded, 'true', 'Invalid required input stays reachable');
          name.value = 'Тихий кабинет';
          button.click();
          assert.equal(row.dataset.roomExpanded, 'false');
          name.value = '';
          name.dispatchEvent(new w.Event('invalid', { cancelable: true }));
          assert.equal(
            row.dataset.roomExpanded,
            'true',
            'Native invalid capture reveals a collapsed field',
          );
          name.value = 'Тихий кабинет';
          w.document.querySelector('#workspace-add-room').click();
          const added = w.document.querySelector('[data-room-id]:last-child');
          assert.equal(added.dataset.roomExpanded, 'true');
          assert.equal(added.querySelector('[data-room-name]').value, 'Кабинет 2');
        }
        assert.equal(writes, 0);
      } finally {
        w.close();
      }
    },
  );
test('administrator confirms room rule changes and submits only permitted room fields', async () => {
  const dom = new JSDOM('<div id="workspace-settings"></div>'),
    w = dom.window,
    writes = [],
    confirmations = [],
    state = {
      busy: false,
      roleNames: { owner: 'Владелец' },
      workspace: {
        canEdit: false,
        canEditRoomAssignments: true,
        canEditRoomOverlap: true,
        revision: 4,
        enabled: false,
        roomLayout: 'single',
        members: [
          { accountId: 'owner', displayName: 'Специалист', role: 'owner', status: 'active' },
        ],
        rooms: [
          {
            id: 'main',
            name: 'Основной кабинет',
            active: true,
            preventOverlap: true,
            staffMode: 'single',
            staffIds: ['owner'],
          },
        ],
      },
    };
  let confirmResult = false;
  w.confirm = (message) => {
    confirmations.push(message);
    return confirmResult;
  };
  try {
    const api = createWorkspaceSettingsHarness(
      state,
      {
        $: (selector) => w.document.querySelector(selector),
        canManageTeam: () => true,
        accountId: () => 'admin',
        esc: String,
        settingsHelpHtml: () => '',
        renderStaffBookingRules() {},
        toast() {},
        request: async (route, options) => {
          assert.equal(route, '/api/workspace');
          const body = JSON.parse(options.body);
          writes.push(body);
          return {
            ...state.workspace,
            revision: state.workspace.revision + 1,
            rooms: state.workspace.rooms.map((room) => ({ ...room, ...body.roomAssignments[0] })),
          };
        },
      },
      { document: w.document, window: w },
    );
    api.renderWorkspaceSettings();
    api.bindWorkspaceSettingsEvents();
    let form = w.document.querySelector('#workspace-settings-form');
    assert.equal(form.querySelector('[type="submit"]').textContent.trim(), 'Сохранить настройки');
    assert.equal(form.querySelector('[data-room-name]').disabled, true);
    assert.equal(form.querySelector('[data-room-active]').disabled, true);
    assert.equal(form.querySelector('[data-room-prevent-overlap]').disabled, false);
    form.querySelector('[data-room-prevent-overlap]').click();
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(writes.length, 0);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], /Изменить правила пересечений/);
    assert.equal(state.workspace.rooms[0].preventOverlap, true);
    confirmResult = true;
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !state.busy);
    assert.deepEqual(writes[0], {
      revision: 4,
      roomAssignments: [
        { id: 'main', staffMode: 'single', staffIds: ['owner'], preventOverlap: false },
      ],
    });
    assert.equal(state.workspace.rooms[0].preventOverlap, false);
    assert.equal(state.workspace.enabled, false);
    form = w.document.querySelector('#workspace-settings-form');
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => !state.busy);
    assert.equal(confirmations.length, 2, 'Saving unchanged rules needs no extra confirmation');
    assert.equal(writes.length, 2);
    state.workspace.canEditRoomOverlap = false;
    api.renderWorkspaceSettings();
    form = w.document.querySelector('#workspace-settings-form');
    assert.equal(form.querySelector('[data-room-prevent-overlap]').disabled, true);
    assert.equal(form.querySelector('[type="submit"]').textContent.trim(), 'Сохранить назначения');
    assert.equal(
      Object.hasOwn(api.workspaceFormValues(form).roomAssignments[0], 'preventOverlap'),
      false,
    );
  } finally {
    w.close();
  }
});
test('appointment room picker follows active room count and employees retain room selection', () => {
  const createRooms = require('node:vm').runInNewContext(
    fs.readFileSync(path.join(root, 'src/client/modules/rooms.js'), 'utf8') + ';createRooms',
  );
  const dom = new JSDOM('<form></form>');
  try {
    for (const role of ['owner', 'salon_admin', 'cosmetologist']) {
      const state = {
        multiUser: true,
        workspace: {
          enabled: false,
          roomLayout: 'multiple',
          rooms: [
            { id: 'r1', name: 'Основной кабинет', active: true, staffIds: ['staff'] },
            { id: 'r2', name: 'Второй кабинет', active: false, staffIds: ['staff'] },
          ],
        },
      };
      const actions = { accountId: () => 'staff', accountRole: () => role, esc: String };
      const rooms = createRooms(state, actions),
        form = dom.window.document.querySelector('form');
      form.innerHTML = rooms.appointmentRoomField({ id: 'record', roomId: 'r1', staffId: 'staff' });
      assert.equal(form.elements.roomId.type, 'hidden');
      assert.equal(new dom.window.FormData(form).get('roomId'), 'r1');
      state.workspace.rooms[1].active = true;
      state.workspace.roomLayout = 'single'; // Stored layout must not conceal a real choice.
      form.innerHTML = rooms.appointmentRoomField({ id: 'record', roomId: 'r1', staffId: 'staff' });
      assert.equal(form.elements.roomId.tagName, 'SELECT');
      assert.equal(form.elements.roomId.disabled, false);
      form.elements.roomId.value = 'r2';
      assert.equal(new dom.window.FormData(form).get('roomId'), 'r2');
    }
  } finally {
    dom.window.close();
  }
});
async function fixture(t, width, configured = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-rooms-ui-')),
    platform = createPlatformStore(path.join(dir, 'platform')),
    windows = [];
  const owner = await platform.registerOwner({
    email: 'owner-ui@example.test',
    password: 'Rooms-ui-owner-password',
    displayName: 'PRIVATE-OWNER',
    organizationName: 'Пример',
  });
  platform.verifyEmail(owner.verificationToken);
  const invitation = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role: 'cosmetologist',
    }),
    staff = await platform.acceptInvitation({
      token: invitation.token,
      email: 'staff-ui@example.test',
      password: 'Rooms-ui-staff-password',
      displayName: 'Тестовый сотрудник',
    });
  // Fixtures must use the organization's day, not the Linux/Windows host day.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const component = (type) => Number(parts.find((part) => part.type === type).value);
  const tomorrow = new Date(component('year'), component('month') - 1, component('day') + 1);
  const date =
    tomorrow.getFullYear() +
    '-' +
    String(tomorrow.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(tomorrow.getDate()).padStart(2, '0');
  const clinic = createStorage(path.join(dir, 'tenants', owner.organizationId));
  const state = {
    revision: 0,
    services: [
      {
        id: 's',
        staffId: staff.accountId,
        name: 'Уход',
        category: 'care',
        product: '',
        duration: '30 минут',
        price: 1000,
      },
    ],
    patients: [
      {
        id: 'p',
        name: 'Общий клиент',
        createdBy: owner.accountId,
        visits: [
          {
            id: 'owner-v',
            date: '2020-01-01',
            procedure: 'PRIVATE-OTHER-HISTORY',
            staffId: owner.accountId,
            photos: [],
          },
          {
            id: 'staff-v',
            date: '2020-01-02',
            procedure: 'Своя история',
            staffId: staff.accountId,
            photos: [],
          },
        ],
        appointments: [
          {
            id: 'foreign-a',
            date,
            time: '10:00',
            duration: 60,
            roomId: 'r1',
            staffId: owner.accountId,
            service: 'PRIVATE-OTHER-SERVICE',
            notes: 'PRIVATE-OTHER-NOTES',
          },
          {
            id: 'own-a',
            date,
            time: '13:00',
            duration: 30,
            roomId: 'r2',
            staffId: staff.accountId,
            service: 'Уход',
          },
          {
            id: 'future-own-a',
            date: '2030-01-01',
            time: '13:00',
            duration: 30,
            roomId: 'r2',
            staffId: staff.accountId,
            service: 'Уход',
          },
        ],
      },
    ],
  };
  clinic.write(state);
  if (configured)
    platform.saveWorkspace(
      owner.organizationId,
      owner.accountId,
      {
        revision: 0,
        enabled: true,
        mode: 'shared',
        rooms: [
          {
            id: 'r1',
            name: 'Первый кабинет',
            active: true,
            staffIds: [owner.accountId, staff.accountId],
          },
          {
            id: 'r2',
            name: 'Второй кабинет',
            active: true,
            staffIds: [owner.accountId, staff.accountId],
          },
        ],
      },
      () => clinic.read(),
    );
  else {
    state.revision = 1;
    state.patients[0].appointments = [];
    clinic.write(state);
  }
  clinic.close();
  platform.close();
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    windows.forEach((w) => {
      w.dispatchEvent(new w.Event('pagehide'));
      w.close();
    });
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const contexts = new Map();
  async function login(role) {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1' },
      body: JSON.stringify({
        email: role + '-ui@example.test',
        password: 'Rooms-ui-' + role + '-password',
      }),
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    contexts.set(cookie, authContextHeaders(await r.json()));
    return cookie;
  }
  async function ui(role) {
    if (role === 'staff' && configured) {
      const ownerCookie = await login('owner'),
        headers = {
          Origin: base,
          Cookie: ownerCookie,
          ...contexts.get(ownerCookie),
          'Content-Type': 'application/json',
          'X-Cartoteca-Request': '1',
        };
      const schedule = await (
        await fetch(
          base + '/api/work-schedules?staffId=' + staff.accountId + '&from=' + date + '&to=' + date,
          { headers },
        )
      ).json();
      const reply = await fetch(base + '/api/work-schedules', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          staffId: staff.accountId,
          dates: [date],
          status: 'working',
          intervals: [['00:00', '24:00']],
          revision: schedule.revision,
          expectedTimeZone: schedule.timeZone,
        }),
      });
      assert.equal(reply.status, 200, 'Ordinary employee booking fixture must have a working day');
    }
    const cookie = await login(role),
      errors = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
      url: base,
      runScripts: 'outside-only',
      virtualConsole: vc,
      pretendToBeVisual: true,
    }).window;
    windows.push(w);
    w.fetch = (route, options = {}) =>
      fetch(base + route, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookie },
      });
    w.AbortController = AbortController;
    w.structuredClone = structuredClone;
    w.matchMedia = () => ({ matches: width <= 700, addEventListener() {} });
    w.confirm = () => true;
    require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    return {
      w,
      errors,
      $: (s) => w.document.querySelector(s),
      change(node, value) {
        node.value = value;
        node.dispatchEvent(new w.Event('change', { bubbles: true }));
      },
      submit() {
        w.document
          .querySelector('#editor-form')
          .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      },
      read: async () =>
        await (
          await fetch(base + '/api/cabinet', {
            headers: { Cookie: cookie, ...contexts.get(cookie) },
          })
        ).json(),
    };
  }
  return { ui, date, owner, staff };
}
for (const width of [390, 1440])
  test(
    'employee calendar exposes only anonymous room occupancy and supports choosing another room at ' +
      width,
    async (t) => {
      const f = await fixture(t, width),
        h = await f.ui('staff'),
        { $, w } = h;
      $('[data-calendar-mode="day"]').click();
      $('[data-calendar-next]').click();
      await until(() => $('.calendar-busy'));
      assert.doesNotMatch($('#global-view').textContent, /PRIVATE-OTHER|PRIVATE-OWNER/);
      assert.equal($('[data-appointment-id="foreign-a"]'), null);
      assert.equal($('.calendar-busy [data-appointment-id]'), null);
      $('.calendar-busy').click();
      assert.equal($('#editor').open, false);
      h.change($('#calendar-room-filter'), 'r2');
      assert.equal($('.calendar-busy'), null);
      h.change($('#calendar-room-filter'), '');
      assert.ok($('.calendar-busy'));
      $('[data-calendar-mode="month"]').click();
      await until(() =>
        $('[data-overview-date="' + f.date + '"]')?.textContent.includes('Есть занятое время'),
      );
      const monthDay = $('[data-overview-date="' + f.date + '"]');
      assert.match(monthDay.textContent, /1 запись/);
      assert.doesNotMatch($('#global-view').textContent, /PRIVATE-OTHER/);
      h.change($('#calendar-room-filter'), 'r2');
      assert.doesNotMatch(
        $('[data-overview-date="' + f.date + '"]').textContent,
        /Есть занятое время/,
      );
      h.change($('#calendar-room-filter'), '');
      $('[data-calendar-mode="day"]').click();
      await until(() => $('.calendar-busy'));
      $('#calendar-new').click();
      await until(() => $('#appointment-patient'));
      h.change($('[name="patientId"]'), 'p');
      // The form must check own appointments outside the currently loaded calendar month.
      h.change($('[name="date"]'), '2030-01-01');
      h.change($('#appointment-room'), 'r2');
      h.change($('[name="time"]'), '13:00');
      $('#appointment-service').open = true;
      const service = $('[data-appointment-service="s"]');
      assert.ok(service);
      service.closest('details').querySelector('summary').click();
      service.click();
      assert.equal(service.disabled, true);
      await until(() => $('#appointment-room-status').textContent.includes('Время занято'));
      assert.equal($('[name="time"] option[value="13:00"]').disabled, false);
      assert.equal($('#appointment-room-status').classList.contains('is-warning'), true);
      h.change($('[name="date"]'), f.date);
      h.change($('#appointment-room'), 'r1');
      h.change($('[name="time"]'), '10:15');
      await until(() => $('#appointment-room-status').textContent.includes('Время занято'));
      assert.equal($('[name="time"] option[value="10:15"]').disabled, false);
      assert.equal($('#appointment-room-status').classList.contains('is-warning'), true);
      h.change($('#appointment-room'), 'r2');
      await until(() => $('#appointment-room-status').textContent.includes('Время свободно'));
      assert.equal($('[name="time"] option[value="10:15"]').disabled, false);
      h.submit();
      await until(() => !$('#editor').open);
      const saved = await h.read();
      assert.equal(saved.patients.length, 1);
      assert.equal(saved.patients[0].appointments.find((a) => a.time === '10:15').roomId, 'r2');
      assert.deepEqual(
        saved.patients[0].visits.map((v) => v.procedure),
        ['Своя история'],
      );
      assert.deepEqual(h.errors, []);
    },
  );
for (const width of [390, 1440])
  test(
    'owner configures per-room staffing without resetting profile drafts at ' + width,
    async (t) => {
      const f = await fixture(t, width),
        h = await f.ui('owner'),
        { $, w } = h;
      $('[data-view="settings"]').click();
      await until(() => $('#workspace-settings-form') && $('#account-profile-form'));
      const section = $('#workspace-settings').closest('details');
      assert.equal(section.open, false);
      section.querySelector('summary').click();
      const profile = $('#account-profile-form');
      profile.querySelector('[name="displayName"]').value = 'Несохранённый черновик';
      const form = $('#workspace-settings-form');
      assert.equal(form.querySelectorAll('[data-room-id]').length, 2);
      assert.equal(form.querySelectorAll('[data-room-prevent-overlap]').length, 2);
      assert.ok(
        [...form.querySelectorAll('[data-room-prevent-overlap]')].every((field) => field.checked),
      );
      assert.match(section.querySelector('summary').textContent, /Кабинеты и занятость/);
      assert.doesNotMatch(form.textContent, /Общие физические|Раздельные физические/);
      h.change(form.elements.roomLayout, 'single');
      assert.equal(form.elements.roomLayout.value, 'multiple');
      assert.equal(form.querySelectorAll('[data-room-id]').length, 2);
      for (const row of form.querySelectorAll('[data-room-id]')) {
        const picker = row.querySelector('[data-room-staff-mode]');
        h.change(picker, 'single');
        assert.equal(picker.value, 'multiple');
        for (const input of row.querySelectorAll('[data-room-staff]'))
          input.checked =
            input.value === (row.dataset.roomId === 'r1' ? f.owner.accountId : f.staff.accountId);
        h.change(picker, 'single');
        assert.ok([...row.querySelectorAll('[data-room-staff]')].every((i) => i.type === 'radio'));
      }
      form.querySelector('[data-room-id="r2"] [data-room-prevent-overlap]').click();
      assert.equal(
        form.querySelector('[data-room-id="r1"] [data-room-prevent-overlap]').checked,
        true,
      );
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => $('#workspace-settings-form') !== form);
      assert.ok(
        [...$('#workspace-settings-form').querySelectorAll('[data-room-staff-mode]')].every(
          (i) => i.value === 'single',
        ),
      );
      assert.equal($('#account-profile-form'), profile);
      assert.equal(profile.querySelector('[name="displayName"]').value, 'Несохранённый черновик');
      assert.equal(section.open, true);
      assert.equal(
        $('#workspace-settings-form').querySelector(
          '[data-room-id="r2"] [data-room-prevent-overlap]',
        ).checked,
        false,
      );
      $('#workspace-add-room').click();
      const fresh = $('#workspace-settings-form');
      assert.equal(fresh.querySelectorAll('[data-room-id]').length, 3);
      assert.deepEqual(h.errors, []);
    },
  );

for (const width of [390, 1440])
  test(
    'default single room, mixed staffing and archived rooms survive save/reload at ' + width,
    async (t) => {
      const f = await fixture(t, width, false),
        h = await f.ui('owner'),
        { $, w } = h;
      $('[data-view="settings"]').click();
      await until(() => $('#workspace-settings-form'));
      let form = $('#workspace-settings-form');
      assert.equal(form.elements.roomLayout.value, 'single');
      assert.equal($('#workspace-add-room').hidden, true);
      const initial = form.querySelector('[data-room-id]');
      assert.equal(initial.querySelector('[data-room-name]').value, 'Основной кабинет');
      assert.equal(form.elements.enabled.checked, false);
      assert.equal(
        initial
          .querySelector('[data-room-number]')
          .closest('.workspace-room-name-control')
          .querySelector('[data-room-name]').value,
        'Основной кабинет',
      );
      assert.equal(initial.querySelector('[data-room-number]').textContent, '1');
      assert.equal(initial.querySelector('[data-room-prevent-overlap]').checked, true);
      await until(() => $('#staff-booking-rules-form'));
      const rulesForm = $('#staff-booking-rules-form');
      assert.ok(rulesForm.closest('#team-settings'));
      assert.equal(form.querySelector('[data-workspace-staff-rule]'), null);
      const rules = [...rulesForm.elements].filter((input) =>
        input.matches('[data-workspace-staff-rule]'),
      );
      assert.equal(rules.length, 2);
      assert.ok(rules.every((rule) => !rule.checked));
      rules.find((rule) => rule.dataset.workspaceStaffRule === f.staff.accountId).click();
      assert.equal(
        rules.find((rule) => rule.dataset.workspaceStaffRule === f.owner.accountId).checked,
        false,
      );
      await until(() => $('#staff-booking-rules-form') !== rulesForm);
      assert.equal($('#workspace-settings-form'), form);
      assert.equal(initial.querySelector('[data-remove-room]'), null);
      assert.equal(form.querySelectorAll('[data-room-id]').length, 1);
      h.change(form.elements.roomLayout, 'multiple');
      assert.equal($('#workspace-add-room').hidden, false);
      $('#workspace-add-room').click();
      const rows = [...form.querySelectorAll('[data-room-id]')];
      h.change(rows[0].querySelector('[data-room-staff-mode]'), 'multiple');
      rows[0].querySelector('[data-room-staff][value="' + f.staff.accountId + '"]').click();
      assert.equal(rows[0].querySelectorAll('[data-room-staff]:checked').length, 2);
      assert.equal(rows[1].querySelector('[data-room-staff-mode]').value, 'single');
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => $('#workspace-settings-form') !== form);
      form = $('#workspace-settings-form');
      assert.equal(form.elements.roomLayout.value, 'multiple');
      assert.equal(form.querySelector('[data-room-staff-mode]').value, 'multiple');
      assert.equal(
        form.querySelector('[data-room-id]').querySelectorAll('[data-room-staff]:checked').length,
        2,
      );
      assert.equal($('[data-workspace-staff-rule="' + f.staff.accountId + '"]').checked, true);
      assert.equal($('[data-workspace-staff-rule="' + f.owner.accountId + '"]').checked, false);
      const inactive = form
        .querySelectorAll('[data-room-id]')[1]
        .querySelector('[data-room-active]');
      inactive.checked = false;
      inactive.dispatchEvent(new w.Event('change', { bubbles: true }));
      h.change(form.elements.roomLayout, 'single');
      assert.equal(form.elements.roomLayout.value, 'single');
      assert.equal($('#workspace-add-room').hidden, true);
      assert.equal(form.querySelectorAll('[data-room-id]').length, 2);
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => $('#workspace-settings-form') !== form);
      form = $('#workspace-settings-form');
      assert.equal(form.elements.roomLayout.value, 'single');
      assert.equal(form.querySelectorAll('[data-room-active]:checked').length, 1);
      assert.equal(form.querySelectorAll('[data-room-id]').length, 2);
      assert.equal(form.elements.enabled.checked, false);
      $('[data-view="calendar"]').click();
      await until(() => $('#calendar-new'));
      assert.equal($('#calendar-room-filter'), null);
      $('#calendar-new').click();
      await until(() => $('#appointment-room'));
      assert.equal($('#appointment-room').value, 'main');
      assert.deepEqual(h.errors, []);
    },
  );
