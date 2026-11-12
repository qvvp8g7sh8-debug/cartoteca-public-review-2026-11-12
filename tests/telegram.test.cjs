const {
  createAppointmentStateReader,
} = require('../src/server/modules/notifications/appointment-state-reader.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');
const { configuredTelegram } = require('../src/server/modules/notifications/telegram-adapter.cjs');
const { fingerprint, startsAt } = require('../src/server/modules/notifications/appointments.cjs');
function fakeBot() {
  return {
    messages: [],
    answers: [],
    failure: null,
    async initialize() {
      return { username: 'cartoteca_test_bot' };
    },
    async send(chatId, text, markup) {
      if (this.failure) throw this.failure;
      this.messages.push({ chatId, text, markup });
      return { message_id: this.messages.length };
    },
    async answer(id, text) {
      this.answers.push({ id, text });
    },
  };
}
function start(chat, token, type = 'private') {
  return { message: { chat: { id: chat, type }, from: { id: chat }, text: '/start ' + token } };
}
function callback(chat, data) {
  return {
    callback_query: {
      id: 'cb',
      from: { id: chat },
      message: { chat: { id: chat, type: 'private' } },
      data,
    },
  };
}
const isReminder = (message) =>
  message.markup?.inline_keyboard
    .flat()
    .some((button) => button.callback_data.startsWith('confirm_'));
test('completed appointments cancel pending reminders and reject previously sent confirmation buttons', async (t) => {
  for (const mode of ['pending', 'sent']) {
    const f = await fixture(t);
    await f.link();
    if (mode === 'sent') await f.runtime.tick();
    else f.runtime.schedule();
    const stale = f.bot.messages.find(isReminder)?.markup.inline_keyboard[0][0].callback_data;
    const cabinet = f.clinic.read(),
      p = cabinet.patients[0],
      a = p.appointments[0];
    a.status = 'completed';
    a.completedVisitId = 'finished';
    p.visits.push({
      id: 'finished',
      date: a.date,
      time: a.time,
      procedure: a.service,
      staffId: a.staffId,
      appointmentId: a.id,
      photos: [],
    });
    f.clinic.write(cabinet);
    await f.runtime.tick();
    await f.runtime.tick();
    assert.equal(f.bot.messages.filter(isReminder).length, mode === 'sent' ? 1 : 0);
    if (stale) {
      await f.runtime.handleUpdate(callback('1001', stale));
      assert.match(f.bot.answers.at(-1).text, /больше не действует/);
    } else assert.equal(f.platform.telegram.counts(f.org).cancelled, 1);
  }
});
async function fixture(t) {
  const f = {
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-telegram-')),
    now: Date.parse('2030-01-01T08:00:00Z'),
    bot: fakeBot(),
  };
  f.platform = createPlatformStore(path.join(f.dir, 'platform'));
  f.owner = await f.platform.registerOwner({
    email: 'telegram-owner@example.test',
    password: 'Telegram-owner-test-password',
    displayName: 'Test',
    organizationName: 'Test',
  });
  f.platform.verifyEmail(f.owner.verificationToken);
  f.org = f.owner.organizationId;
  f.clinic = createStorage(path.join(f.dir, 'tenants', f.org));
  f.appointment = {
    id: 'a',
    date: '2030-01-01',
    time: '12:00',
    duration: 60,
    service: 'PRIVATE-PROCEDURE',
    notes: 'PRIVATE-NOTES',
    staffId: f.owner.accountId,
  };
  f.clinic.write({
    revision: 0,
    patients: [
      {
        id: 'p',
        name: 'PRIVATE-PATIENT',
        phone: 'PRIVATE-PHONE',
        visits: [],
        appointments: [f.appointment],
      },
      { id: 'other', name: 'Other', visits: [], appointments: [] },
    ],
    services: [],
  });
  f.platform.telegram.saveSettings(f.org, f.owner.accountId, {
    enabled: true,
    leadMinutes: 1440,
    timeZone: 'Europe/Moscow',
    showServices: false,
  });
  f.runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: (org) => {
      assert.equal(org, f.org);
      return f.clinic;
    },
    bot: f.bot,
    clock: () => f.now,
  });
  await f.runtime.initialize();
  f.link = async (chat = '1001', patient = 'p') => {
    const token = f.platform.telegram.issueLink(f.org, patient, f.owner.accountId, f.now);
    await f.runtime.handleUpdate(start(chat, token));
    return token;
  };
  t.after(() => {
    f.runtime.stop();
    f.platform.close();
    f.clinic.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  });
  f.appointmentState = {
    decorate: createAppointmentStateReader({
      platform: f.platform,
      store: f.platform.telegram,
      tenantStore: () => f.clinic,
    }),
  };
  return f;
}

test('cancelled and no-show appointments stop queued reminders and invalidate already sent buttons', async (t) => {
  for (const status of ['cancelled', 'no_show'])
    for (const mode of ['pending', 'sent']) {
      const f = await fixture(t);
      await f.link();
      if (mode === 'sent') await f.runtime.tick();
      else f.runtime.schedule();
      const stale = f.bot.messages.find(isReminder)?.markup.inline_keyboard[0][0].callback_data;
      const cabinet = f.clinic.read();
      cabinet.patients[0].appointments[0].status = status;
      f.clinic.write(cabinet);
      await f.runtime.tick();
      assert.equal(f.bot.messages.filter(isReminder).length, mode === 'sent' ? 1 : 0);
      if (stale) {
        await f.runtime.handleUpdate(callback('1001', stale));
        assert.match(f.bot.answers.at(-1).text, /больше не действует/);
      } else assert.equal(f.platform.telegram.counts(f.org).cancelled, 1);
      assert.equal(f.clinic.read().patients[0].visits.length, 0);
    }
});
test('private binding, persistent reminder deduplication and idempotent client confirmation without clinical disclosure', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.runtime.tick();
  await f.runtime.tick();
  const reminders = f.bot.messages.filter(isReminder);
  assert.equal(reminders.length, 1);
  assert.doesNotMatch(reminders[0].text, /PRIVATE-|PROCEDURE|PHONE|NOTES/);
  const data = reminders[0].markup.inline_keyboard[0][0].callback_data;
  await f.runtime.handleUpdate(callback('9999', data));
  assert.equal(f.platform.telegram.confirmed(f.org, 'p', fingerprint(f.appointment)), null);
  await f.runtime.handleUpdate(callback('1001', data));
  await f.runtime.handleUpdate(callback('1001', data));
  assert.equal(f.platform.telegram.confirmed(f.org, 'p', fingerprint(f.appointment)), f.now);
  assert.equal(f.clinic.read().revision, 1);
  assert.equal(
    f.appointmentState.decorate(f.clinic.read(), f.org).patients[0].appointments[0]
      .telegramConfirmedAt,
    f.now,
  );
});
test('links expire, regenerate, reject groups, duplicate patient chats and revoked issuers', async (t) => {
  const f = await fixture(t),
    old = f.platform.telegram.issueLink(f.org, 'p', f.owner.accountId, f.now),
    fresh = f.platform.telegram.issueLink(f.org, 'p', f.owner.accountId, f.now);
  await f.runtime.handleUpdate(start('1001', old));
  assert.equal(f.platform.telegram.link(f.org, 'p'), null);
  await f.runtime.handleUpdate(start('1001', fresh, 'group'));
  assert.equal(f.platform.telegram.link(f.org, 'p'), null);
  await f.runtime.handleUpdate(start('1001', fresh));
  assert.ok(f.platform.telegram.link(f.org, 'p'));
  const other = f.platform.telegram.issueLink(f.org, 'other', f.owner.accountId, f.now);
  await f.runtime.handleUpdate(start('1001', other));
  assert.equal(f.platform.telegram.link(f.org, 'other'), null);
  f.now += 86400001;
  await f.runtime.handleUpdate(start('2002', other));
  assert.equal(f.platform.telegram.link(f.org, 'other'), null);
  const next = f.platform.telegram.issueLink(f.org, 'other', f.owner.accountId, f.now);
  const admin = await f.platform.bootstrapGlobalAdmin({
    email: 'telegram-admin@example.test',
    password: 'Telegram-admin-test-password',
    displayName: 'Admin',
  });
  f.platform.admin.updateAccountAccess(admin.accountId, f.owner.accountId, {
    requestId: require('node:crypto').randomUUID(),
    expectedRevision: f.platform.admin.account(admin.accountId, f.owner.accountId).revision,
    reason: 'Тест отзыва доступа',
    status: 'suspended',
  });
  await f.runtime.handleUpdate(start('2002', next));
  assert.equal(f.platform.telegram.link(f.org, 'other'), null);
});
test('reschedule, delete, recovery pause and stop invalidate queued jobs and stale confirmation buttons', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.runtime.tick();
  const stale = f.bot.messages.find(isReminder).markup.inline_keyboard[0][0].callback_data;
  const cabinet = f.clinic.read();
  cabinet.patients[0].appointments[0].time = '13:00';
  f.clinic.write(cabinet);
  await f.runtime.handleUpdate(callback('1001', stale));
  assert.match(f.bot.answers.at(-1).text, /больше не действует/);
  f.runtime.schedule();
  // Simulate the persisted recovery pause on this temporary synthetic database.
  const recovery =
    require('../src/server/infrastructure/platform-database.cjs').createPlatformDatabase(
      path.join(f.dir, 'platform'),
    );
  try {
    recovery.db
      .prepare('UPDATE telegram_settings SET value=? WHERE organization_id=?')
      .run(recovery.seal({ ...f.platform.telegram.settings(f.org), restoredPaused: true }), f.org);
  } finally {
    recovery.db.close();
  }
  f.platform.telegram.saveSettings(f.org, f.owner.accountId, {
    enabled: true,
    leadMinutes: 1440,
    timeZone: 'Europe/Moscow',
  });
  assert.equal(f.platform.telegram.settings(f.org).enabled, false);
  await f.runtime.tick();
  assert.equal(f.platform.telegram.counts(f.org).cancelled, 1);
  f.platform.telegram.saveReminderPeriod(f.org, f.owner.accountId, {
    leadMinutes: 1440,
    expectedLeadMinutes: 1440,
    resumeRestored: true,
  });
  f.runtime.schedule();
  const erased = f.clinic.read();
  erased.patients[0].appointments = [];
  f.clinic.write(erased);
  await f.runtime.tick();
  assert.equal(f.bot.messages.filter(isReminder).length, 1);
  await f.runtime.handleUpdate({
    message: { chat: { id: '1001', type: 'private' }, from: { id: '1001' }, text: '/stop' },
  });
  assert.equal(f.platform.telegram.link(f.org, 'p'), null);
  assert.equal(f.platform.telegram.confirmed(f.org, 'p', fingerprint(f.appointment)), null);
});
test('failed sends survive database reopen and retry; disabling the organization prevents delivery', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.bot.failure = Object.assign(Error('Test network failure'), { status: 503 });
  await f.runtime.tick();
  assert.equal(f.platform.telegram.counts(f.org).pending, 1);
  f.runtime.stop();
  f.platform.close();
  f.platform = createPlatformStore(path.join(f.dir, 'platform'));
  f.now += 120000;
  f.bot.failure = null;
  f.runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: () => f.clinic,
    bot: f.bot,
    clock: () => f.now,
  });
  await f.runtime.initialize();
  await f.runtime.tick();
  assert.equal(f.platform.telegram.counts(f.org).sent, 1);
  const cabinet = f.clinic.read();
  cabinet.patients[0].appointments[0].time = '14:00';
  f.clinic.write(cabinet);
  f.runtime.schedule();
  const admin = await f.platform.bootstrapGlobalAdmin({
    email: 'pause-admin@example.test',
    password: 'Synthetic-global-password-2026',
    displayName: 'Operator',
  });
  f.platform.admin.updateOrganizationAccess(admin.accountId, f.org, {
    requestId: require('node:crypto').randomUUID(),
    expectedRevision: 0,
    reason: 'Тест паузы организации',
    status: 'suspended',
  });
  await f.runtime.tick();
  assert.equal(f.bot.messages.filter(isReminder).length, 1);
  assert.equal(f.platform.telegram.counts(f.org).cancelled, 1);
});
test('timezone conversion is independent of the host timezone, and changed timezone invalidates confirmation', async (t) => {
  assert.equal(
    startsAt({ date: '2030-01-01', time: '12:00' }, 'Europe/Moscow'),
    Date.parse('2030-01-01T09:00:00Z'),
  );
  assert.equal(
    startsAt({ date: '2030-01-01', time: '12:00' }, 'Asia/Yerevan'),
    Date.parse('2030-01-01T08:00:00Z'),
  );
  const f = await fixture(t);
  await f.link();
  await f.runtime.tick();
  const data = f.bot.messages.find(isReminder).markup.inline_keyboard[0][0].callback_data;
  f.platform.telegram.saveSettings(f.org, f.owner.accountId, {
    enabled: true,
    leadMinutes: 1440,
    timeZone: 'UTC',
  });
  await f.runtime.handleUpdate(callback('1001', data));
  assert.match(f.bot.answers.at(-1).text, /больше не действует/);
});
test('relinking uses a new recipient and invalidates previous buttons and confirmation', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.runtime.tick();
  const old = f.bot.messages.find(isReminder).markup.inline_keyboard[0][0].callback_data;
  await f.runtime.handleUpdate(callback('1001', old));
  f.platform.telegram.unlink(f.org, 'p', f.owner.accountId);
  await f.link('2002');
  await f.runtime.tick();
  const reminders = f.bot.messages.filter(isReminder);
  assert.equal(reminders.length, 2);
  assert.equal(reminders[1].chatId, '2002');
  assert.equal(f.platform.telegram.confirmed(f.org, 'p', fingerprint(f.appointment)), null);
  await f.runtime.handleUpdate(callback('1001', old));
  assert.match(f.bot.answers.at(-1).text, /больше не действует/);
  const fresh = reminders[1].markup.inline_keyboard[0][0].callback_data;
  f.now += 1;
  await f.runtime.handleUpdate(callback('2002', fresh));
  assert.equal(f.platform.telegram.confirmed(f.org, 'p', fingerprint(f.appointment)), f.now);
});
test('blocked chats and expired callback acknowledgements do not poison the incoming update queue', async (t) => {
  const f = await fixture(t);
  await f.link();
  f.bot.failure = Object.assign(Error('Blocked'), { status: 403 });
  await f.runtime.handleUpdate({
    message: { chat: { id: '1001', type: 'private' }, from: { id: '1001' }, text: '/stop' },
  });
  assert.equal(f.platform.telegram.link(f.org, 'p'), null);
  f.bot.answer = async () => {
    throw Object.assign(Error('Expired'), { providerCode: 400 });
  };
  await f.runtime.handleUpdate(callback('1001', 'confirm_' + 'x'.repeat(27)));
  f.platform.telegram.offset(42);
  f.platform.close();
  f.platform = createPlatformStore(path.join(f.dir, 'platform'));
  assert.equal(f.platform.telegram.offset(), 42);
});
test('schema migration backs up the pre-change database and key and preserves password login', async (t) => {
  const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs'),
    { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-telegram-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let p = createPlatformStore(dir);
  const owner = await p.registerOwner({
    email: 'migration@example.test',
    password: 'Migration-test-password-2026',
    displayName: 'Migration',
    organizationName: 'Test',
  });
  p.verifyEmail(owner.verificationToken);
  p.close();
  const old = createPlatformDatabase(dir);
  require('./helpers/platform-inspection.cjs').dropAdminSchema(old.db);
  old.db.exec(
    'DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; DROP TABLE support_deliveries; DROP TABLE support_requests; DROP TABLE telegram_settings; DROP TABLE telegram_links; DROP TABLE telegram_link_tokens; DROP TABLE telegram_jobs; DROP TABLE telegram_confirmations; DROP TABLE telegram_runtime; DROP TABLE appointment_manual_confirmations; PRAGMA user_version=2;',
  );
  old.db.close();
  p = createPlatformStore(dir);
  try {
    assert.ok(
      await p.login('migration@example.test', 'Migration-test-password-2026', '', '127.0.0.1'),
    );
  } finally {
    p.close();
  }
  const backups = fs.readdirSync(path.join(dir, 'migration-backups'));
  assert.equal(backups.length, 9);
  const backup = path.join(
    dir,
    'migration-backups',
    backups.find((name) => name.startsWith('before-003-')),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(backup, 'platform.key')),
    fs.readFileSync(path.join(dir, 'platform.key')),
  );
  const db = new DatabaseSync(path.join(backup, 'platform.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM accounts').get().n, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    db.close();
  }
  const supportBackup = path.join(
      dir,
      'migration-backups',
      backups.find((name) => name.startsWith('before-005-')),
    ),
    snapshot = new DatabaseSync(path.join(supportBackup, 'platform.sqlite'), { readOnly: true });
  try {
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(snapshot.prepare('SELECT count(*) n FROM accounts').get().n, 1);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(
      snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='support_requests'").get(),
      undefined,
    );
  } finally {
    snapshot.close();
  }
  p = createPlatformStore(dir);
  p.close();
  assert.equal(fs.readdirSync(path.join(dir, 'migration-backups')).length, backups.length);
});
test('adapter refuses existing webhook, sanitizes token errors and does not issue requests when unconfigured', async () => {
  assert.equal(configuredTelegram({ token: '' }), null);
  const token = '123456:' + 'x'.repeat(35),
    adapter = configuredTelegram({
      token,
      fetchImpl: async (url) => {
        throw Error(url);
      },
    });
  await assert.rejects(
    adapter.initialize(),
    (error) => error.status === 503 && !error.message.includes(token),
  );
  const webhook = configuredTelegram({
    token,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: url.endsWith('getMe')
          ? { is_bot: true, username: 'cartoteca_test_bot' }
          : { url: 'https://example.test/webhook' },
      }),
    }),
  });
  await assert.rejects(webhook.initialize(), { status: 409 });
});
test('HTTP checks roles and organization boundaries and cannot forge server-owned confirmation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-telegram-http-')),
    platform = createPlatformStore(path.join(dir, 'platform')),
    bot = fakeBot();
  const owner = await platform.registerOwner({
    email: 'one@example.test',
    password: 'Telegram-http-owner-password',
    displayName: 'Owner',
    organizationName: 'One',
  });
  platform.verifyEmail(owner.verificationToken);
  const other = await platform.registerOwner({
    email: 'two@example.test',
    password: 'Telegram-http-other-password',
    displayName: 'Other',
    organizationName: 'Two',
  });
  platform.verifyEmail(other.verificationToken);
  await platform.bootstrapGlobalAdmin({
    email: 'global@example.test',
    password: 'Telegram-http-global-password',
    displayName: 'Global',
  });
  const invitation = platform.createInvitation({
    organizationId: owner.organizationId,
    invitedBy: owner.accountId,
    role: 'cosmetologist',
    email: 'staff@example.test',
  });
  await platform.acceptInvitation({
    token: invitation.token,
    email: 'staff@example.test',
    password: 'Telegram-http-staff-password',
    displayName: 'Staff',
  });
  const clinic = createStorage(path.join(dir, 'tenants', owner.organizationId));
  clinic.write({
    revision: 0,
    patients: [
      {
        id: 'p',
        name: 'Test',
        createdBy: owner.accountId,
        visits: [],
        appointments: [{ id: 'a', date: '2030-01-01', time: '12:00', staffId: owner.accountId }],
      },
    ],
    services: [],
  });
  clinic.close();
  platform.close();
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: bot,
    telegramAutostart: false,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await server.telegramRuntime.initialize();
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const contexts = new Map();
  const request = (route, cookie, body, method = body ? 'POST' : 'GET') =>
    fetch(base + route, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie || '',
        ...contexts.get(cookie),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const login = async (email, password) => {
    const r = await request('/api/auth/login', '', { email, password });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    contexts.set(cookie, authContextHeaders(await r.json()));
    return cookie;
  };
  const own = await login('one@example.test', 'Telegram-http-owner-password'),
    second = await login('two@example.test', 'Telegram-http-other-password'),
    global = await login('global@example.test', 'Telegram-http-global-password'),
    staff = await login('staff@example.test', 'Telegram-http-staff-password');
  assert.equal((await request('/api/telegram/settings', global)).status, 403);
  assert.equal((await request('/api/telegram/settings', staff)).status, 403);
  const previewValues = {
    enabled: true,
    leadMinutes: 60,
    timeZone: 'Europe/Moscow',
    showServices: true,
  };
  assert.equal((await request('/api/telegram/preview', '', previewValues)).status, 401);
  assert.equal((await request('/api/telegram/preview', global, previewValues)).status, 403);
  assert.equal((await request('/api/telegram/preview', staff, previewValues)).status, 403);
  const preview = await request('/api/telegram/preview', own, previewValues);
  assert.equal(preview.status, 200);
  const previewText = (await preview.json()).preview;
  assert.match(previewText, /^One\n/);
  assert.match(previewText, /Консультация, Уход/);
  assert.doesNotMatch(previewText, /Косметолог|Two|patientId|chatId/);
  assert.equal(
    (await (await request('/api/telegram/settings', own)).json()).settings.showServices,
    true,
  );
  assert.equal(
    (await request('/api/telegram/preview', own, { ...previewValues, timeZone: 'wrong-zone' }))
      .status,
    400,
  );
  assert.equal(
    (await request('/api/telegram/preview', own, { ...previewValues, showServices: 'yes' })).status,
    400,
  );
  assert.equal((await request('/api/telegram/patient?patientId=p', staff)).status, 404);
  assert.equal((await request('/api/telegram/link', second, { patientId: 'p' })).status, 404);
  assert.equal(
    (
      await request('/api/telegram/settings', own, {
        enabled: true,
        leadMinutes: 60,
        timeZone: 'Europe/Moscow',
      })
    ).status,
    200,
  );
  assert.equal((await request('/api/telegram/link', '', { patientId: 'p' })).status, 401);
  assert.equal((await request('/api/telegram/link', global, { patientId: 'p' })).status, 403);
  assert.equal((await request('/api/telegram/link', staff, { patientId: 'p' })).status, 404);
  const response = await request('/api/telegram/link', own, { patientId: 'p' }),
    link = await response.json(),
    url = link.url,
    token = new URL(url).searchParams.get('start');
  assert.equal(response.status, 200);
  assert.equal(link.expiresInHours, 24);
  assert.equal(link.qrDataUrl, await require('qrcode').toDataURL(url, { width: 220, margin: 2 }));
  await server.telegramRuntime.handleUpdate(start('1001', token));
  assert.equal(
    (await request('/api/telegram/remind', own, { patientId: 'p', appointmentId: 'a' })).status,
    200,
  );
  await server.telegramRuntime.tick();
  const data = bot.messages.find(isReminder).markup.inline_keyboard[0][0].callback_data;
  await server.telegramRuntime.handleUpdate(callback('1001', data));
  const cabinet = await (await request('/api/cabinet', own)).json();
  assert.ok(cabinet.patients[0].appointments[0].telegramConfirmedAt);
  cabinet.patients[0].appointments[0].time = '13:00';
  cabinet.patients[0].appointments[0].telegramConfirmedAt = 123;
  await require('./helpers/working-days.cjs').workingDays(
    dir,
    'one@example.test',
    'Telegram-http-owner-password',
    ['2020-01-01', '2030-01-01', '2031-01-01'],
  );
  const saved = await request('/api/cabinet', own, cabinet, 'PUT');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).patients[0].appointments[0].telegramConfirmedAt, null);
  const exposed = await (await request('/api/telegram/patient?patientId=p', own)).json();
  const assertPrivate = (value) => {
    if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        assert.doesNotMatch(key, /chatId|chatHash|chat_hash|consentToken|callback|token/i);
        assertPrivate(item);
      }
    else assert.notEqual(value, '1001');
  };
  assertPrivate(exposed);
  assert.equal(exposed.notificationsEnabled, true);
  assert.equal(exposed.appointments[0].time, '13:00');
  assert.equal(exposed.appointments[0].canRemind, true);
  assert.equal(exposed.appointments[0].startsAt, Date.parse('2030-01-01T10:00:00Z'));
  assert.equal(exposed.appointments[0].deliveryStatus, null);
  assert.equal(exposed.appointments[0].confirmedAt, null);
  assert.equal(exposed.appointments[0].duration, 60);
  assert.equal(typeof exposed.appointments[0].service, 'string');
  assert.equal(exposed.appointments[0].upcoming, true);
  const many = await (await request('/api/cabinet', own)).json();
  // The pagination case deliberately permits parallel manual appointments.
  const workspace = await (await request('/api/workspace', own)).json();
  const {
    members,
    canEdit,
    canEditStaffRules,
    canEditRoomAssignments,
    canEditRoomOverlap,
    ...configuration
  } = workspace;
  configuration.rooms.forEach((room) => {
    room.preventOverlap = false;
  });
  assert.equal((await request('/api/workspace', own, configuration)).status, 200);
  many.patients[0].appointments.push(
    {
      id: 'overdue',
      date: '2020-01-01',
      time: '12:00',
      duration: 15,
      service: 'Past Procedure',
      staffId: owner.accountId,
    },
    ...Array.from({ length: 25 }, (_, i) => ({
      id: 'future-' + i,
      date: '2031-01-01',
      time: '12:00',
      duration: 30,
      service: 'Future Procedure',
      staffId: owner.accountId,
    })),
  );
  assert.equal((await request('/api/cabinet', own, many, 'PUT')).status, 200);
  const all = await (await request('/api/telegram/patient?patientId=p', own)).json();
  assert.equal(all.appointments.length, 27);
  assert.equal(all.appointments[0].appointmentId, 'overdue');
  assert.equal(all.appointments[0].service, 'Past Procedure');
  assert.equal(all.appointments[0].duration, 15);
  assert.equal(all.appointments[0].upcoming, false);
});
