const {
  createAppointmentStateReader,
} = require('../src/server/modules/notifications/appointment-state-reader.cjs');
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs');
const {
  createTelegramRuntime,
} = require('../src/server/modules/notifications/telegram-runtime.cjs');
const {
  appointmentMessage,
  previewMessage,
  senderTitle,
} = require('../src/server/modules/notifications/telegram-messages.cjs');
const {
  fingerprint,
  serviceFingerprint,
  settingsRule,
} = require('../src/server/modules/notifications/appointments.cjs');
const callback = (chat, data, message = null) => ({
  callback_query: {
    id: 'test-callback',
    from: { id: chat },
    message: {
      chat: { id: chat, type: 'private' },
      ...(message ? { message_id: message.message_id, reply_markup: message.markup } : {}),
    },
    data,
  },
});
const button = (message, prefix) =>
  message.markup?.inline_keyboard.flat().find((item) => item.callback_data.startsWith(prefix))
    ?.callback_data;
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-bot-messages-'));
  const f = {
    dir,
    now: Date.parse('2030-01-01T08:00:00Z'),
    platform: createPlatformStore(path.join(dir, 'platform')),
    bot: {
      messages: [],
      answers: [],
      cleared: [],
      async clearButtons(chatId, messageId) {
        const message = this.messages.find((item) => item.message_id === messageId);
        this.cleared.push({ chatId, messageId });
        if (message) message.markup = { inline_keyboard: [] };
      },
      async initialize() {
        return { username: 'message_test_bot' };
      },
      async send(chatId, text, markup) {
        this.messages.push({ chatId, text, markup, message_id: this.messages.length + 1 });
      },
      async answer(id, text) {
        this.answers.push(text);
      },
    },
  };
  f.owner = await f.platform.registerOwner({
    email: 'message-owner@example.test',
    password: 'Message-test-password',
    displayName: 'Собственник',
    organizationName: 'Тестовая студия',
    businessType: 'salon',
    city: 'Казань',
    phone: '+7 900 111-22-33',
  });
  f.platform.verifyEmail(f.owner.verificationToken);
  f.org = f.owner.organizationId;
  const invite = f.platform.createInvitation({
    organizationId: f.org,
    invitedBy: f.owner.accountId,
    role: 'cosmetologist',
  });
  f.staff = await f.platform.acceptInvitation({
    token: invite.token,
    email: 'message-staff@example.test',
    password: 'Message-staff-password',
    displayName: 'Тестовый специалист',
  });
  f.clinic = createStorage(path.join(dir, 'tenants', f.org));
  f.appointment = {
    id: 'a',
    date: '2030-01-01',
    time: '12:00',
    duration: 90,
    service: 'Legacy service',
    staffId: f.staff.accountId,
    serviceItems: [
      {
        id: 's1',
        name: 'Тестовая чистка',
        category: 'cleansing',
        duration: 60,
        product: 'PRIVATE-PRODUCT',
        price: 5000,
      },
      { id: 's2', name: 'Тестовый уход', category: 'care', duration: 30, product: '', price: 1000 },
    ],
    notes: 'PRIVATE-NOTES',
  };
  f.clinic.write({
    revision: 0,
    patients: [
      {
        id: 'p',
        name: 'PRIVATE-PATIENT',
        phone: 'PRIVATE-PHONE',
        appointments: [f.appointment],
        visits: [{ id: 'v', date: '2020-01-01', procedure: 'PRIVATE-HISTORY', photos: [] }],
      },
    ],
    services: [],
  });
  assert.equal(f.platform.telegram.settings(f.org).showServices, true);
  f.settings = (showServices) =>
    f.platform.telegram.saveSettings(f.org, f.owner.accountId, {
      enabled: true,
      leadMinutes: 1440,
      timeZone: 'Europe/Moscow',
      showServices,
    });
  f.settings();
  f.runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: () => f.clinic,
    bot: f.bot,
    clock: () => f.now,
  });
  await f.runtime.initialize();
  f.link = async (chat = '1001') => {
    const token = f.platform.telegram.issueLink(f.org, 'p', f.owner.accountId, f.now);
    await f.runtime.handleUpdate({
      message: { chat: { id: chat, type: 'private' }, from: { id: chat }, text: '/start ' + token },
    });
  };
  f.consent = async (allow) => {
    const token = f.platform.telegram.consentToken(f.org, 'p');
    await f.runtime.handleUpdate(callback('1001', `svc${allow ? 1 : 0}_${token}`));
  };
  f.extraClinics = [];
  t.after(() => {
    f.runtime.stop();
    for (const clinic of f.extraClinics) clinic.close();
    f.platform.close();
    f.clinic.close();
    fs.rmSync(dir, { recursive: true, force: true });
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
test('message formatting uses only public sender and selected service snapshots, with private fields excluded', () => {
  const identity = {
    organization: { name: 'Студия Пример', businessType: 'salon' },
    specialist: 'Пример Специалиста',
  };
  const appointment = {
    date: '2030-01-08',
    time: '14:30',
    duration: 90,
    service: 'Wrong legacy title',
    serviceItems: [{ name: 'Чистка', product: 'PRIVATE' }, { name: 'Уход' }],
    notes: 'PRIVATE',
    patientName: 'PRIVATE',
    phone: 'PRIVATE',
  };
  const settings = { timeZone: 'Europe/Moscow', showServices: true };
  const text = appointmentMessage(identity, appointment, settings, { showServices: true });
  assert.match(text, /^Студия Пример\n/);
  assert.match(text, /Специалист: Пример Специалиста/);
  assert.match(text, /Услуги: Чистка, Уход/);
  assert.match(text, /90 минут/);
  assert.doesNotMatch(text, /PRIVATE|Wrong legacy/);
  for (const message of [
    text,
    previewMessage(identity, settings),
    appointmentMessage(identity, appointment, settings, { showServices: true, confirmed: true }),
  ]) {
    assert.doesNotMatch(message, /Часовой пояс|Europe\/Moscow/);
    assert.match(message, /08\.01\.2030 в 14:30/);
    assert.match(message, /90 минут/);
  }
  assert.doesNotMatch(appointmentMessage(identity, appointment, settings), /Услуги:|Чистка|Уход/);
  assert.match(previewMessage(identity, settings), /Консультация, Уход/);
  assert.equal(senderTitle({ organization: { name: 'Юлия', businessType: 'individual' } }), 'Юлия');
  assert.equal(
    senderTitle({ organization: { name: 'Косметолог Юлия', businessType: 'individual' } }),
    'Косметолог Юлия',
  );
  assert.doesNotMatch(
    appointmentMessage(
      { organization: { name: 'Юлия', businessType: 'individual' }, specialist: 'Юлия' },
      appointment,
      settings,
    ),
    /Специалист:/,
  );
  assert.equal(
    settingsRule({ enabled: true, leadMinutes: 60, timeZone: 'UTC' }).showServices,
    true,
  );
  assert.equal(
    settingsRule({ enabled: true, leadMinutes: 60, timeZone: 'UTC', showServices: false })
      .showServices,
    false,
  );
  assert.throws(
    () => settingsRule({ enabled: true, leadMinutes: 60, timeZone: 'UTC', showServices: 'true' }),
    { status: 400 },
  );
  const hostile = appointmentMessage(
    { organization: { name: 'Имя\nPRIVATE-INJECT' } },
    {
      ...appointment,
      serviceItems: Array.from({ length: 100 }, () => ({ name: 'x'.repeat(1000) })),
    },
    settings,
    { showServices: true },
  );
  assert.ok(hostile.length < 4096);
});
test('services show without initial permission, client can hide and restore them, and forged changes fail', async (t) => {
  const f = await fixture(t);
  await f.link();
  const welcome = f.bot.messages[0];
  assert.match(welcome.text, /Тестовая студия/);
  assert.match(welcome.text, /экране блокировки/);
  assert.doesNotMatch(welcome.text, /Тестовая чистка|PRIVATE/);
  await f.runtime.tick();
  let reminder = f.bot.messages.find((m) => button(m, 'confirm_'));
  assert.match(reminder.text, /Тестовый специалист/);
  assert.match(reminder.text, /90 минут/);
  assert.match(reminder.text, /Услуги: Тестовая чистка, Тестовый уход/);
  assert.doesNotMatch(reminder.text, /PRIVATE|5000|Legacy/);
  assert.equal(button(welcome, 'svc1_'), undefined);
  assert.match(welcome.text, /Названия услуг включены/);
  assert.doesNotMatch(welcome.text, /разрешени/);
  const hide = button(reminder, 'svc0_');
  assert.ok(Buffer.byteLength(hide) <= 64);
  await f.runtime.handleUpdate(callback('9999', hide));
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  const forged = callback('1001', hide);
  forged.callback_query.from.id = '9999';
  await f.runtime.handleUpdate(forged);
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  const grouped = callback('1001', hide);
  grouped.callback_query.message.chat.type = 'group';
  await f.runtime.handleUpdate(grouped);
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  await f.runtime.handleUpdate(callback('1001', hide));
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, false);
  const consent = button(f.bot.messages.at(-1), 'svc1_');
  assert.ok(consent);
  await f.runtime.handleUpdate(callback('1001', consent));
  reminder = f.bot.messages.at(-1);
  assert.match(reminder.text, /Услуги: Тестовая чистка, Тестовый уход/);
  assert.doesNotMatch(reminder.text, /PRIVATE|5000|Legacy/);
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  const count = f.bot.messages.length;
  await f.runtime.handleUpdate(callback('1001', consent));
  assert.equal(f.bot.messages.length, count);
  const confirmData = button(reminder, 'confirm_'),
    beforeConfirmation = f.bot.messages.length;
  await f.runtime.handleUpdate(callback('1001', confirmData, reminder));
  assert.equal(f.bot.messages.length, beforeConfirmation);
  assert.match(f.bot.answers.at(-1), /Спасибо! Вы подтвердили запись/);
  assert.equal(button(reminder, 'confirm_'), undefined);
  assert.equal(f.bot.cleared.at(-1).messageId, reminder.message_id);
  assert.ok(
    f.platform.telegram.confirmed(
      f.org,
      'p',
      fingerprint(f.appointment),
      serviceFingerprint(f.appointment),
    ),
  );
  await f.runtime.handleUpdate(callback('1001', confirmData, reminder));
  assert.equal(f.bot.messages.length, beforeConfirmation);
  await f.consent(false);
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, false);
  const data = f.clinic.read();
  data.patients[0].appointments[0].time = '13:00';
  f.clinic.write(data);
  await f.runtime.tick();
  assert.doesNotMatch(f.bot.messages.at(-1).text, /Тестовая чистка|PRIVATE/);
});
test('owner switch is respected, new links default to visible and old privacy buttons cannot affect a new chat', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.consent(true);
  const old = button(f.bot.messages[0], 'svc0_');
  f.settings(false);
  await f.runtime.tick();
  assert.doesNotMatch(f.bot.messages.at(-1).text, /Тестовая чистка|PRIVATE/);
  f.platform.close();
  f.platform = createPlatformStore(path.join(f.dir, 'platform'));
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  assert.equal(f.platform.telegram.settings(f.org).showServices, false);
  f.runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: () => f.clinic,
    bot: f.bot,
    clock: () => f.now,
  });
  await f.runtime.initialize();
  f.platform.telegram.unlink(f.org, 'p', f.owner.accountId);
  f.settings(true);
  await f.link('2002');
  await f.runtime.handleUpdate(callback('1001', old));
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  await f.runtime.handleUpdate(callback('2002', old));
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
  await f.runtime.tick();
  assert.match(f.bot.messages.at(-1).text, /Тестовая чистка/);
  assert.doesNotMatch(f.bot.messages.at(-1).text, /PRIVATE/);
});
test('same-time service changes invalidate confirmation and stale buttons while legacy confirmation hashes stay compatible', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.consent(true);
  await f.runtime.tick();
  const old = f.bot.messages.at(-1),
    stamp = fingerprint(f.appointment);
  await f.runtime.handleUpdate(callback('1001', button(old, 'confirm_')));
  assert.ok(f.platform.telegram.confirmed(f.org, 'p', stamp, serviceFingerprint(f.appointment)));
  const data = f.clinic.read();
  data.patients[0].appointments[0].serviceItems[0].name = 'Новая услуга';
  f.clinic.write(data);
  assert.equal(fingerprint(data.patients[0].appointments[0]), stamp);
  assert.equal(
    f.appointmentState.decorate(f.clinic.read(), f.org).patients[0].appointments[0]
      .telegramConfirmedAt,
    null,
  );
  await f.runtime.handleUpdate(callback('1001', button(old, 'confirm_')));
  assert.match(f.bot.answers.at(-1), /больше не действует/);
  await f.runtime.tick();
  const fresh = f.bot.messages.at(-1);
  assert.match(fresh.text, /Новая услуга/);
  assert.notEqual(button(fresh, 'confirm_'), button(old, 'confirm_'));
  await f.runtime.handleUpdate(callback('1001', button(fresh, 'confirm_')));
  assert.ok(
    f.appointmentState.decorate(f.clinic.read(), f.org).patients[0].appointments[0]
      .telegramConfirmedAt,
  );
});
test('sender identity is organization-scoped and public profile changes affect future messages', async (t) => {
  const f = await fixture(t);
  const other = await f.platform.registerOwner({
    email: 'other-identity@example.test',
    password: 'Other-message-password',
    displayName: 'OTHER-PRIVATE-NAME',
    organizationName: 'OTHER-PRIVATE-ORG',
  });
  assert.equal(f.platform.telegram.messageIdentity(f.org, other.accountId).specialist, '');
  const login = await f.platform.login(
    'message-owner@example.test',
    'Message-test-password',
    '',
    '127.0.0.1',
  );
  f.platform.updateAccountProfile(login.token, {
    displayName: 'Собственник',
    organization: {
      name: 'Новое название студии',
      businessType: 'salon',
      city: 'Казань',
      phone: '+7 900 111-22-33',
    },
  });
  await f.link();
  await f.runtime.tick();
  assert.match(f.bot.messages.at(-1).text, /^Новое название студии/);
  assert.doesNotMatch(f.bot.messages.at(-1).text, /OTHER-PRIVATE|111-22-33/);
});

test('privacy choices are independent for two salons linked to the same Telegram chat', async (t) => {
  const f = await fixture(t);
  await f.link();
  await f.consent(false);
  const other = await f.platform.registerOwner({
    email: 'other-salon@example.test',
    password: 'Other-salon-password',
    displayName: 'Другой специалист',
    organizationName: 'Другая студия',
    businessType: 'salon',
  });
  f.platform.verifyEmail(other.verificationToken);
  const clinic = createStorage(path.join(f.dir, 'tenants', other.organizationId));
  f.extraClinics.push(clinic);
  clinic.write({
    revision: 0,
    patients: [
      {
        id: 'other-p',
        name: 'PRIVATE-OTHER-PATIENT',
        appointments: [{ ...f.appointment, staffId: other.accountId }],
        visits: [],
      },
    ],
    services: [],
  });
  f.platform.telegram.saveSettings(other.organizationId, other.accountId, {
    enabled: true,
    leadMinutes: 1440,
    timeZone: 'Europe/Moscow',
    showServices: true,
  });
  f.runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: (org) => (org === f.org ? f.clinic : clinic),
    bot: f.bot,
    clock: () => f.now,
  });
  await f.runtime.initialize();
  const token = f.platform.telegram.issueLink(
    other.organizationId,
    'other-p',
    other.accountId,
    f.now,
  );
  await f.runtime.handleUpdate({
    message: {
      chat: { id: '1001', type: 'private' },
      from: { id: '1001' },
      text: '/start ' + token,
    },
  });
  assert.equal(button(f.bot.messages.at(-1), 'svc1_'), undefined);
  assert.equal(f.platform.telegram.link(other.organizationId, 'other-p').servicesConsent, true);
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, false);
  const before = f.bot.messages.length;
  await f.runtime.handleUpdate({
    message: { chat: { id: '1001', type: 'private' }, from: { id: '1001' }, text: '/privacy' },
  });
  const choices = f.bot.messages.slice(before);
  assert.equal(choices.length, 2);
  assert.ok(choices.some((m) => m.text.startsWith('Тестовая студия') && button(m, 'svc1_')));
  assert.ok(choices.some((m) => m.text.startsWith('Другая студия') && button(m, 'svc0_')));
  for (const message of choices) assert.doesNotMatch(message.text, /PRIVATE|Тестовая чистка/);
});

test('legacy implicit hiding becomes visible without rewriting rows while an explicit opt-out survives restart', async (t) => {
  const f = await fixture(t);
  await f.link();
  const { createPlatformDatabase } = require('../src/server/infrastructure/platform-database.cjs');
  const syntheticDb = createPlatformDatabase(path.join(f.dir, 'platform'));
  try {
    const row = syntheticDb.db
      .prepare('SELECT value FROM telegram_links WHERE organization_id=? AND patient_id=?')
      .get(f.org, 'p');
    const old = syntheticDb.open(row.value);
    old.servicesConsent = false;
    delete old.servicesConsentAt;
    const encrypted = syntheticDb.seal(old);
    syntheticDb.db
      .prepare('UPDATE telegram_links SET value=? WHERE organization_id=? AND patient_id=?')
      .run(encrypted, f.org, 'p');
    assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, true);
    assert.deepEqual(
      Buffer.from(
        syntheticDb.db
          .prepare('SELECT value FROM telegram_links WHERE organization_id=? AND patient_id=?')
          .get(f.org, 'p').value,
      ),
      encrypted,
    );
    await f.runtime.tick();
    assert.match(f.bot.messages.at(-1).text, /Услуги: Тестовая чистка, Тестовый уход/);
    syntheticDb.db
      .prepare('UPDATE telegram_links SET value=? WHERE organization_id=? AND patient_id=?')
      .run(syntheticDb.seal({ ...old, servicesConsentAt: 0 }), f.org, 'p');
    assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, false);
  } finally {
    syntheticDb.db.close();
  }
  await f.consent(false);
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, false);
  f.platform.close();
  f.platform = createPlatformStore(path.join(f.dir, 'platform'));
  assert.equal(f.platform.telegram.link(f.org, 'p').servicesConsent, false);
  f.runtime = createTelegramRuntime({
    platform: f.platform,
    tenantStore: () => f.clinic,
    bot: f.bot,
    clock: () => f.now,
  });
  await f.runtime.initialize();
  const data = f.clinic.read();
  data.patients[0].appointments[0].time = '13:00';
  f.clinic.write(data);
  await f.runtime.tick();
  assert.doesNotMatch(f.bot.messages.at(-1).text, /Тестовая чистка|PRIVATE/);
});
