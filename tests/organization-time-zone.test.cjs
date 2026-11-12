const { authContextHeaders } = require('./helpers/account-context.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs');
const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
const { createMultiServer } = require('../multi-server.cjs');
const { fingerprint } = require('../src/server/modules/notifications/appointments.cjs');
const password = 'Synthetic-zone-test-only';
async function owner(platform, email = 'zone@example.test') {
  const result = await platform.registerOwner({
    email,
    password,
    displayName: 'Synthetic',
    organizationName: 'Synthetic',
  });
  platform.verifyEmail(result.verificationToken);
  return result;
}

test('organization zone works without Telegram and invalidates stale receipts/jobs without changing appointments', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-org-zone-'));
  const platform = createPlatformStore(dir);
  t.after(() => {
    platform.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const account = await owner(platform),
    org = account.organizationId;
  const login = await platform.login('zone@example.test', password);
  assert.equal(platform.organizationTimeZone(org), 'Europe/Moscow');
  const appointment = {
    id: 'a',
    date: '2030-01-01',
    time: '10:00',
    service: 'Synthetic',
    duration: 30,
    staffId: account.accountId,
  };
  const unchanged = structuredClone(appointment);
  platform.appointmentConfirmations.set(
    org,
    'p',
    appointment,
    'Europe/Moscow',
    account.accountId,
    true,
  );
  const token = platform.telegram.issueLink(org, 'p', account.accountId);
  const recipient = platform.telegram.consumeLink(token, 'synthetic-chat', () => true);
  platform.telegram.enqueue(
    org,
    'p',
    appointment,
    fingerprint(appointment),
    recipient,
    Date.parse('2030-01-01T07:00:00Z'),
  );
  assert.deepEqual(
    platform.updateOrganizationTimeZone(login.token, {
      timeZone: 'Europe/Samara',
      expectedTimeZone: 'Europe/Moscow',
    }),
    { timeZone: 'Europe/Samara' },
  );
  assert.equal(
    platform.appointmentConfirmations.read(org, 'p', appointment, 'Europe/Samara'),
    null,
  );
  assert.equal(platform.telegram.claim(), null);
  assert.equal(platform.telegram.settings(org).timeZone, 'Europe/Samara');
  assert.equal(platform.telegram.settings(org).enabled, true); // Ready bindings, not the retired switch, enable delivery.
  assert.equal(platform.accountProfile(login.token).organization.timeZone, 'Europe/Samara');
  assert.deepEqual(appointment, unchanged);
  assert.throws(
    () =>
      platform.updateOrganizationTimeZone(login.token, {
        timeZone: 'Europe/Moscow',
        expectedTimeZone: 'Europe/Moscow',
      }),
    { status: 409 },
  );
  assert.throws(
    () =>
      platform.telegram.saveSettings(org, account.accountId, {
        enabled: false,
        leadMinutes: 60,
        timeZone: 'Europe/Moscow',
        expectedTimeZone: 'Europe/Moscow',
      }),
    { status: 409 },
  );
  platform.telegram.saveSettings(org, account.accountId, {
    enabled: false,
    leadMinutes: 60,
    timeZone: 'Europe/Samara',
  });
  const raw = createPlatformDatabase(dir);
  try {
    assert.equal(
      raw.open(
        raw.db.prepare('SELECT value FROM telegram_settings WHERE organization_id=?').get(org)
          .value,
      ).timeZone,
      undefined,
    );
    assert.equal(
      raw.open(raw.db.prepare('SELECT value FROM organizations WHERE id=?').get(org).value)
        .timeZone,
      'Europe/Samara',
    );
  } finally {
    raw.db.close();
  }
});

test('schema 6 migrates the exact legacy zone with a verified backup and retains passwords and confirmations', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-zone-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let platform = createPlatformStore(dir);
  const account = await owner(platform);
  const settings = {
    enabled: false,
    leadMinutes: 60,
    timeZone: 'Europe/Samara',
    showServices: true,
  };
  platform.telegram.saveSettings(account.organizationId, account.accountId, settings);
  const appointment = {
    id: 'a',
    date: '2030-01-01',
    time: '10:00',
    duration: 30,
    service: 'Synthetic',
  };
  platform.appointmentConfirmations.set(
    account.organizationId,
    'p',
    appointment,
    'Europe/Samara',
    account.accountId,
    true,
    12345,
  );
  platform.close();
  const old = createPlatformDatabase(dir);
  const prior = old.open(
    old.db.prepare('SELECT value FROM organizations WHERE id=?').get(account.organizationId).value,
  );
  delete prior.timeZone;
  old.db
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(old.seal(prior), account.organizationId);
  old.db
    .prepare('INSERT OR REPLACE INTO telegram_settings VALUES(?,?)')
    .run(account.organizationId, old.seal(settings));
  require('./helpers/platform-inspection.cjs').dropAdminSchema(old.db);
  old.db.exec(
    'DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; PRAGMA user_version=5',
  );
  old.db.close();
  platform = createPlatformStore(dir);
  try {
    assert.ok(await platform.login('zone@example.test', password));
    assert.equal(platform.organizationTimeZone(account.organizationId), 'Europe/Samara');
    assert.equal(
      platform.appointmentConfirmations.read(
        account.organizationId,
        'p',
        appointment,
        'Europe/Samara',
      ).manualConfirmedAt,
      12345,
    );
  } finally {
    platform.close();
  }
  const backups = fs.readdirSync(path.join(dir, 'migration-backups'));
  const zoneBackup = backups.find((name) => name.startsWith('before-006-'));
  assert.ok(zoneBackup);
  assert.equal(backups.filter((name) => name.startsWith('before-006-')).length, 1);
  assert.equal(backups.filter((name) => name.startsWith('before-007-')).length, 1);
  const snapshot = new DatabaseSync(
    path.join(dir, 'migration-backups', zoneBackup, 'platform.sqlite'),
    { readOnly: true },
  );
  try {
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 5);
  } finally {
    snapshot.close();
  }
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'migration-backups', zoneBackup, 'platform.key')),
    fs.readFileSync(path.join(dir, 'platform.key')),
  );
  platform = createPlatformStore(dir);
  platform.close();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'migration-backups')), backups);
});

test('invalid legacy timezone rolls migration back instead of silently changing organization time', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-zone-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const platform = createPlatformStore(dir),
    account = await owner(platform);
  platform.close();
  const old = createPlatformDatabase(dir);
  const profile = old.open(
    old.db.prepare('SELECT value FROM organizations WHERE id=?').get(account.organizationId).value,
  );
  delete profile.timeZone;
  old.db
    .prepare('UPDATE organizations SET value=? WHERE id=?')
    .run(old.seal(profile), account.organizationId);
  old.db
    .prepare('INSERT INTO telegram_settings VALUES(?,?)')
    .run(account.organizationId, old.seal({ timeZone: 'invalid-zone' }));
  require('./helpers/platform-inspection.cjs').dropAdminSchema(old.db);
  old.db.exec(
    'DROP TABLE staff_notification_jobs; DROP TABLE staff_telegram_tokens; DROP TABLE staff_telegram_links; DROP TABLE booking_requests; DROP TABLE email_invitations; PRAGMA user_version=5',
  );
  old.db.close();
  assert.throws(() => createPlatformStore(dir), /Неизвестный часовой пояс/);
  const check = createPlatformDatabase(dir);
  try {
    assert.equal(check.db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(
      check.open(
        check.db.prepare('SELECT value FROM organizations WHERE id=?').get(account.organizationId)
          .value,
      ).timeZone,
      undefined,
    );
  } finally {
    check.db.close();
  }
});

test('independent timezone HTTP checks roles, scope, stale writes and malformed values without a configured bot', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-zone-http-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const main = await owner(platform);
  await owner(platform, 'other-zone@example.test');
  for (const role of ['salon_admin', 'cosmetologist']) {
    const invite = platform.createInvitation({
      organizationId: main.organizationId,
      invitedBy: main.accountId,
      role,
    });
    await platform.acceptInvitation({
      token: invite.token,
      email: role + '@example.test',
      password,
      displayName: 'Synthetic',
    });
  }
  await platform.bootstrapGlobalAdmin({
    email: 'global-zone@example.test',
    password,
    displayName: 'Synthetic',
  });
  platform.close();
  const server = createMultiServer({
    dataDir: dir,
    sendMail: null,
    telegramBot: null,
    telegramAutostart: false,
    supportAutostart: false,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const authContexts = new Map();
  async function request(route, cookie = '', values) {
    const response = await fetch(base + route, {
      method: values ? 'POST' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        ...authContexts.get(cookie),
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
      },
      body: values ? JSON.stringify(values) : undefined,
    });
    const data = await response.json(),
      nextCookie = response.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && response.status === 200)
      authContexts.set(nextCookie, authContextHeaders(data));
    return { status: response.status, data, cookie: nextCookie };
  }
  const cookies = {};
  for (const email of [
    'zone@example.test',
    'other-zone@example.test',
    'salon_admin@example.test',
    'cosmetologist@example.test',
    'global-zone@example.test',
  ])
    cookies[email] = (await request('/api/auth/login', '', { email, password })).cookie;
  const cookie = cookies['zone@example.test'];
  assert.equal(
    (
      await request('/api/cabinet/time-zone', cookie, {
        timeZone: 'Europe/Samara',
        expectedTimeZone: 'Europe/Moscow',
      })
    ).status,
    200,
  );
  assert.equal((await request('/api/cabinet/bootstrap', cookie)).data.timeZone, 'Europe/Samara');
  assert.equal(
    (await request('/api/cabinet/time-zone', cookies['other-zone@example.test'])).data.timeZone,
    'Europe/Moscow',
  );
  assert.equal(
    (
      await request('/api/cabinet/time-zone', cookies['salon_admin@example.test'], {
        timeZone: 'Asia/Kamchatka',
        expectedTimeZone: 'Europe/Samara',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/api/cabinet/time-zone', cookies['cosmetologist@example.test'], {
        timeZone: 'Europe/Moscow',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request('/api/cabinet/time-zone', cookies['global-zone@example.test'], {
        timeZone: 'Europe/Moscow',
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/cabinet/time-zone', '', { timeZone: 'Europe/Moscow' })).status,
    401,
  );
  for (const values of [
    { timeZone: 'invalid-zone' },
    { timeZone: true },
    { timeZone: 'Europe/Moscow', organizationId: 'foreign' },
  ])
    assert.equal((await request('/api/cabinet/time-zone', cookie, values)).status, 400);
  assert.equal(
    (
      await request('/api/cabinet/time-zone', cookie, {
        timeZone: 'Europe/Moscow',
        expectedTimeZone: 'Europe/Samara',
      })
    ).status,
    409,
  );
  assert.equal(
    (await request('/api/telegram/settings', cookie)).data.settings.timeZone,
    'Asia/Kamchatka',
  );
  assert.equal(
    (await request('/api/account/profile', cookie)).data.organization.timeZone,
    'Asia/Kamchatka',
  );
});
