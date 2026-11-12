const { assetPath } = require('./helpers/interface-assets.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { DatabaseSync } = require('node:sqlite'),
  { JSDOM, VirtualConsole } = require('jsdom');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const password = 'Synthetic-manual-confirmation-2026',
  root = path.resolve(__dirname, '..');
async function until(fn, describe = () => '') {
  const end = Date.now() + 7000;
  while (!fn()) {
    if (Date.now() > end) throw Error('Manual confirmation UI timeout ' + describe());
    await new Promise((r) => setTimeout(r, 15));
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-manual-confirmation-')),
    platform = createPlatformStore(path.join(dir, 'platform')),
    windows = [];
  const owner = await platform.registerOwner({
    email: 'owner@example.test',
    password,
    displayName: 'Тестовый владелец',
    organizationName: 'Тестовая организация',
  });
  platform.verifyEmail(owner.verificationToken);
  const users = { owner };
  for (const [name, role] of [
    ['staff', 'cosmetologist'],
    ['admin', 'salon_admin'],
  ]) {
    const invite = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role,
    });
    users[name] = await platform.acceptInvitation({
      token: invite.token,
      email: name + '@example.test',
      password,
      displayName: name,
    });
  }
  users.other = await platform.registerOwner({
    email: 'other@example.test',
    password,
    displayName: 'Other',
    organizationName: 'Other',
  });
  platform.verifyEmail(users.other.verificationToken);
  users.global = await platform.bootstrapGlobalAdmin({
    email: 'global@example.test',
    password,
    displayName: 'Global',
  });
  const clinic = createStorage(path.join(dir, 'tenants', owner.organizationId)),
    a = {
      id: 'a',
      date: '2030-01-01',
      time: '12:00',
      duration: 30,
      service: 'Тестовая услуга',
      staffId: owner.accountId,
      roomId: 'main',
    };
  clinic.write({
    revision: 0,
    services: [],
    patients: [
      {
        id: 'p',
        name: 'Вымышленный клиент',
        visits: [],
        appointments: [
          a,
          { ...a, id: 'staff-a', time: '13:00', staffId: users.staff.accountId },
          { ...a, id: 'past', date: '2020-01-01' },
        ],
      },
    ],
  });
  const workspace = platform.workspaceSettings(owner.organizationId);
  platform.saveWorkspace(
    owner.organizationId,
    owner.accountId,
    {
      ...workspace,
      rooms: workspace.rooms.map((r) => ({
        ...r,
        staffMode: 'multiple',
        staffIds: [owner.accountId, users.staff.accountId],
      })),
    },
    () => clinic.read(),
  );
  clinic.close();
  platform.close();
  await require('./helpers/working-days.cjs').workingDays(
    dir,
    'owner@example.test',
    password,
    ['2030-01-01'],
    [owner.accountId, users.staff.accountId],
  );
  const bot = {
    messages: [],
    async initialize() {
      return { username: 'synthetic_manual_bot' };
    },
    async send(chatId, text, markup) {
      this.messages.push({ chatId, text, markup });
    },
    async answer() {},
  };
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: bot,
    telegramAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await server.telegramRuntime.initialize();
  const base = 'http://127.0.0.1:' + server.address().port,
    cookies = {},
    contexts = {};
  t.after(async () => {
    windows.forEach((w) => {
      w.dispatchEvent(new w.Event('pagehide'));
      w.close();
    });
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function req(route, role = 'owner', body, method = body ? 'POST' : 'GET') {
    const res = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        Cookie: cookies[role] || '',
        ...contexts[role],
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json(), res };
  }
  for (const name of Object.keys(users)) {
    const r = await req('/api/auth/login', name, { email: name + '@example.test', password });
    assert.equal(r.status, 200);
    cookies[name] = r.res.headers.get('set-cookie').split(';')[0];
    contexts[name] = authContextHeaders(r.data);
  }
  async function appointment(id = 'a', role = 'owner') {
    return (await req('/api/cabinet/patient?id=p', role)).data.patients[0].appointments.find(
      (a) => a.id === id,
    );
  }
  async function confirm(id = 'a', role = 'owner', confirmed = true, key) {
    return req('/api/appointments/confirmation', role, {
      patientId: 'p',
      appointmentId: id,
      confirmed,
      expectedFingerprint: key || (await appointment(id, role)).confirmationKey,
    });
  }
  async function ui(width) {
    const errors = [],
      calls = [],
      vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push(e.message));
    const w = new JSDOM(fs.readFileSync(assetPath('index.html'), 'utf8'), {
      url: base,
      runScripts: 'outside-only',
      virtualConsole: vc,
      pretendToBeVisual: true,
    }).window;
    windows.push(w);
    w.fetch = (route, options = {}) => {
      calls.push(route);
      return fetch(base + route, {
        ...options,
        headers: { ...options.headers, Origin: base, Cookie: cookies.owner },
      });
    };
    w.AbortController = AbortController;
    w.structuredClone = structuredClone;
    w.matchMedia = (query) => ({
      matches:
        [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)].every(([, kind, value]) =>
          kind === 'min' ? width >= Number(value) : width <= Number(value),
        ) &&
        (/width:/.test(query) || width <= 700),
      addEventListener() {},
    });
    w.confirm = () => true;
    require('./helpers/action-confirmation.cjs').installActionConfirmation(w);
    require('./helpers/client-bundle.cjs').evaluateClient(w);
    await until(() => !w.document.body.classList.contains('app-loading'));
    return { w, errors, calls, $: (s) => w.document.querySelector(s) };
  }
  return { dir, users, req, appointment, confirm, ui, server, bot, a };
}
test('manual confirmation works without Telegram binding, is idempotent, persistent and server-owned', async (t) => {
  const f = await fixture(t),
    before = (await f.req('/api/cabinet')).data;
  const first = await f.confirm();
  assert.equal(first.status, 200);
  assert.ok(first.data.manualConfirmedAt);
  assert.equal(first.data.manualConfirmedBy, 'Тестовый владелец');
  assert.equal(first.data.telegramConfirmedAt, null);
  const second = await f.confirm();
  assert.equal(second.status, 200);
  assert.equal(second.data.manualConfirmedAt, first.data.manualConfirmedAt);
  const data = (await f.req('/api/cabinet')).data;
  assert.equal(data.revision, before.revision);
  assert.equal(data.patients[0].visits.length, 0);
  const independent = createPlatformStore(path.join(f.dir, 'platform'));
  try {
    assert.equal(
      independent.appointmentConfirmations.read(
        f.users.owner.organizationId,
        'p',
        f.a,
        'Europe/Moscow',
      ).manualConfirmedAt,
      first.data.manualConfirmedAt,
    );
  } finally {
    independent.close();
  }
  data.patients[0].appointments.find((a) => a.id === 'staff-a').manualConfirmedAt = 123;
  data.patients[0].appointments.find((a) => a.id === 'staff-a').manualConfirmedBy = 'Forged';
  assert.equal((await f.req('/api/cabinet', 'owner', data, 'PUT')).status, 200);
  assert.equal((await f.appointment('staff-a')).manualConfirmedAt, null);
  assert.equal((await f.confirm('a', 'owner', false)).status, 200);
  assert.equal((await f.appointment()).manualConfirmedAt, null);
  assert.equal(f.bot.messages.length, 0);
});
test('manual confirmation enforces organization, staff, active plan, future record and current fingerprint', async (t) => {
  const f = await fixture(t),
    key = (await f.appointment()).confirmationKey;
  assert.equal((await f.confirm('a', 'staff', true, key)).status, 404);
  assert.equal((await f.confirm('staff-a', 'staff')).status, 200);
  assert.equal((await f.confirm('a', 'admin')).status, 200);
  assert.equal((await f.confirm('a', 'other', true, key)).status, 404);
  assert.equal((await f.confirm('a', 'global', true, key)).status, 403);
  assert.equal((await f.confirm('past')).status, 400);
  assert.equal((await f.confirm('a', 'owner', true, '0'.repeat(64))).status, 409);
  const data = (await f.req('/api/cabinet')).data,
    a = data.patients[0].appointments.find((a) => a.id === 'a');
  a.status = 'completed';
  a.completedVisitId = 'done';
  data.patients[0].visits.push({
    id: 'done',
    date: a.date,
    procedure: a.service,
    staffId: a.staffId,
    appointmentId: a.id,
    photos: [],
  });
  assert.equal((await f.req('/api/cabinet', 'owner', data, 'PUT')).status, 200);
  assert.equal((await f.confirm()).status, 400);
  const platform = createPlatformDatabase(path.join(f.dir, 'platform'));
  try {
    platform.db
      .prepare("UPDATE subscriptions SET status='suspended' WHERE organization_id=?")
      .run(f.users.owner.organizationId);
  } finally {
    platform.db.close();
  }
  assert.equal((await f.confirm('staff-a')).status, 403);
});
test('rescheduling, room/service changes, deletion and timezone changes invalidate manual receipts permanently', async (t) => {
  const f = await fixture(t);
  const workspace = (await f.req('/api/workspace')).data;
  const { members, canEdit, canEditStaffRules, canEditRoomAssignments, canEditRoomOverlap, ...values } = workspace;
  const reply = await f.req('/api/workspace', 'owner', {
    ...values,
    roomLayout: 'multiple',
    rooms: [...values.rooms, { ...values.rooms[0], id: 'second', name: 'Второй кабинет' }],
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  for (const [field, value] of [
    ['time', '12:15'],
    ['duration', 60],
    ['roomId', 'second'],
    ['service', 'Другая услуга'],
  ]) {
    assert.equal((await f.confirm()).status, 200);
    let data = (await f.req('/api/cabinet')).data,
      a = data.patients[0].appointments.find((a) => a.id === 'a'),
      old = a[field];
    a[field] = value;
    assert.equal((await f.req('/api/cabinet', 'owner', data, 'PUT')).status, 200);
    assert.equal((await f.appointment()).manualConfirmedAt, null);
    data = (await f.req('/api/cabinet')).data;
    data.patients[0].appointments.find((a) => a.id === 'a')[field] = old;
    assert.equal((await f.req('/api/cabinet', 'owner', data, 'PUT')).status, 200);
    assert.equal((await f.appointment()).manualConfirmedAt, null);
  }
  await f.confirm();
  const settings = (await f.req('/api/telegram/settings')).data.settings;
  for (const timeZone of ['Asia/Yerevan', settings.timeZone])
    assert.equal(
      (await f.req('/api/telegram/settings', 'owner', { ...settings, timeZone })).status,
      200,
    );
  assert.equal((await f.appointment()).manualConfirmedAt, null);
  await f.confirm();
  let data = (await f.req('/api/cabinet')).data;
  const old = data.patients[0].appointments.find((a) => a.id === 'a');
  data.patients[0].appointments = data.patients[0].appointments.filter((a) => a.id !== 'a');
  assert.equal((await f.req('/api/cabinet', 'owner', data, 'PUT')).status, 200);
  data = (await f.req('/api/cabinet')).data;
  data.patients[0].appointments.push(old);
  assert.equal((await f.req('/api/cabinet', 'owner', data, 'PUT')).status, 200);
  assert.equal((await f.appointment()).manualConfirmedAt, null);
});
test('manual confirmation cancels queued requests without sending a message and preserves independent client confirmation', async (t) => {
  const f = await fixture(t);
  const link = await f.req('/api/telegram/link', 'owner', { patientId: 'p' });
  const token = new URL(link.data.url).searchParams.get('start');
  await f.server.telegramRuntime.handleUpdate({
    message: { chat: { id: '123', type: 'private' }, from: { id: '123' }, text: '/start ' + token },
  });
  await f.req('/api/telegram/settings', 'owner', {
    enabled: true,
    leadMinutes: 1440,
    timeZone: 'Europe/Moscow',
    showServices: false,
  });
  assert.equal(
    (await f.req('/api/telegram/remind', 'owner', { patientId: 'p', appointmentId: 'a' })).status,
    200,
  );
  const count = f.bot.messages.length;
  assert.equal((await f.confirm()).status, 200);
  await f.server.telegramRuntime.tick();
  assert.equal(f.bot.messages.length, count);
  assert.equal((await f.req('/api/telegram/settings')).data.queue.cancelled, 1);
  assert.equal(
    (await f.req('/api/telegram/remind', 'owner', { patientId: 'p', appointmentId: 'a' })).status,
    409,
  );
  await f.confirm('a', 'owner', false);
  await f.req('/api/telegram/remind', 'owner', { patientId: 'p', appointmentId: 'a' });
  await f.server.telegramRuntime.tick();
  const callback = f.bot.messages.at(-1).markup.inline_keyboard[0][0].callback_data;
  await f.server.telegramRuntime.handleUpdate({
    callback_query: {
      id: 'cb',
      from: { id: '123' },
      message: { chat: { id: '123', type: 'private' } },
      data: callback,
    },
  });
  assert.ok((await f.appointment()).telegramConfirmedAt);
  assert.equal((await f.confirm()).status, 409);
  await f.confirm('a', 'owner', false);
  assert.ok((await f.appointment()).telegramConfirmedAt);
});
for (const width of [390, 1440])
  test(
    'manual controls work in card and calendar editor, protect unsaved changes and keep single room hidden at ' +
      width,
    async (t) => {
      const f = await fixture(t),
        h = await f.ui(width),
        { $, w } = h;
      $('[data-view="clients"]').click();
      await until(() => $('[data-patient="p"]'));
      $('[data-patient="p"]').click();
      await until(() => $('[data-manual-confirm="a"]'));
      w.confirm = () => false;
      $('[data-manual-confirm="a"]').click();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal((await f.appointment()).manualConfirmedAt, null);
      w.confirm = () => true;
      $('[data-manual-confirm="a"]').click();
      await until(() =>
        $('[data-appointment-row="a"] .appointment-status').textContent.includes('вручную'),
      );
      assert.equal($('#editor').open, false);
      assert.equal($('[data-telegram-remind="a"]'), null);
      $('[data-telegram-edit="a"]').click();
      await until(() => $('#editor').open);
      assert.equal($('#appointment-room').type, 'hidden');
      assert.equal($('#appointment-room-field'), null);
      assert.equal($('#appointment-room').value, 'main');
      assert.equal($('#editor [data-manual-confirm]'), null);
      $('[name="time"]').value = '12:15';
      w.confirm = () => false;
      $('#cancel-editor').click();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal($('#editor').open, true);
      assert.ok((await f.appointment()).manualConfirmedAt);
      w.confirm = () => true;
      $('#cancel-editor').click();
      await until(() => !$('#editor').open);
      $('[data-card-appointment="a"]').click();
      await until(() => $('#editor [data-confirm-value="false"]'));
      const undo = $('#editor [data-manual-confirm="a"]');
      assert.match(undo.textContent, /Снять/);
      undo.click();
      await until(() => $('#editor [data-confirm-value="true"]'));
      assert.equal($('#editor').open, true);
      assert.equal((await f.appointment()).manualConfirmedAt, null);
      $('#cancel-editor').click();
      $('[data-view="settings"]').click();
      await until(() => $('#telegram-settings') && $('#organization-time-zone-form'));
      $('#telegram-settings').closest('details').querySelector(':scope > summary').click();
      await until(() => $('#telegram-settings-form'));
      await until(() => $('#organization-time-zone-form'));
      const form = $('#organization-time-zone-form');
      assert.equal(form.elements.timeZone.tagName, 'SELECT');
      assert.ok(
        [...form.elements.timeZone.options].some(
          (o) => o.value === 'Europe/Samara' && o.textContent.includes('Самара'),
        ),
      );
      form.elements.timeZone.value = 'Europe/Samara';
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(
        () => form.dataset.timeZone === 'Europe/Samara' && !form.elements.timeZone.disabled,
      );
      assert.equal(form.elements.timeZone.value, 'Europe/Samara');
      $('[data-view="calendar"]').click();
      await until(() => $('[data-calendar-mode="list"]'));
      $('[data-calendar-mode="list"]').click();
      const dateChoice = w.document.createElement('button');
      dateChoice.dataset.overviewDate = '2030-01-01';
      w.document.body.append(dateChoice);
      dateChoice.click();
      dateChoice.remove();
      await until(() => $('#global-view [data-calendar-state][data-appointment-id="a"]'));
      $('#global-view [data-calendar-state][data-appointment-id="a"]').click();
      await until(() => $('#editor').open && $('#editor [data-manual-confirm="a"]'));
      assert.equal($('#editor [data-manual-confirm="a"]').dataset.confirmValue, 'true');
      $('#editor [data-manual-confirm="a"]').click();
      await until(
        () =>
          $('#editor [data-confirm-value="false"]') &&
          !$('#editor [data-confirm-value="false"]').disabled,
        () => $('#form-content').textContent + '; ' + $('#toast')?.textContent,
      );
      $('#editor [data-edit-appointment-action]').click();
      await until(() => $('[name="notes"]'));
      assert.equal($('#editor [data-manual-confirm]'), null);
      $('[name="notes"]').value = 'Сохранённый комментарий';
      $('#editor-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await until(() => !$('#editor').open);
      await until(() =>
        $('#global-view [data-calendar-state][data-appointment-id="a"]')?.textContent.includes(
          'Подтверждена вручную',
        ),
      );
      const saved = await f.appointment();
      assert.ok(saved.manualConfirmedAt);
      assert.equal(saved.notes, 'Сохранённый комментарий');
      assert.equal(saved.appointmentId, undefined);
      assert.deepEqual(h.errors, []);
    },
  );
test('migration 004 backs up schema 3 with its key before preserving accounts and clinical data', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-confirmation-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let platform = createPlatformStore(dir);
  const owner = await platform.registerOwner({
    email: 'migration@example.test',
    password,
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(owner.verificationToken);
  platform.close();
  const old = createPlatformDatabase(dir);
  require('./helpers/platform-inspection.cjs').dropAdminSchema(old.db);
  old.db.exec(
    'DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; DROP TABLE appointment_manual_confirmations; PRAGMA user_version=3;',
  );
  old.db.close();
  platform = createPlatformStore(dir);
  try {
    assert.ok(await platform.login('migration@example.test', password));
  } finally {
    platform.close();
  }
  const names = fs
    .readdirSync(path.join(dir, 'migration-backups'))
    .filter((n) => n.startsWith('before-004-'));
  assert.equal(names.length, 1);
  const backup = path.join(dir, 'migration-backups', names[0]);
  assert.deepEqual(
    fs.readFileSync(path.join(backup, 'platform.key')),
    fs.readFileSync(path.join(dir, 'platform.key')),
  );
  const db = new DatabaseSync(path.join(backup, 'platform.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    db.close();
  }
});
