const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlatformStore } = require('../../platform-store.cjs');
const { createMultiServer } = require('../../multi-server.cjs');
const { createPlatformDatabase } = require('../../src/server/infrastructure/platform-database.cjs');
const { createStorage } = require('../../storage.cjs');

async function createBillingBrowserFixture(
  t = null,
  { paymentNetworkEnabled = true, notificationSchema = 19 } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-billing-browser-')),
    platformDirectory = path.join(directory, 'platform'),
    password = 'Synthetic-billing-browser-2026';
  let seed = createPlatformStore(platformDirectory),
    database,
    platform,
    server,
    closed = false;
  t?.after(close);
  let rejectNext = false;
  const providerCalls = [],
    providerIds = new Map(),
    statuses = new Map();
  const owner = await seed.registerOwner({
    email: 'owner@billing.test',
    password,
    displayName: 'Тестовый владелец',
    organizationName: 'Синтетический кабинет А',
  });
  seed.verifyEmail(owner.verificationToken);
  const other = await seed.registerOwner({
    email: 'other@billing.test',
    password,
    displayName: 'Другой владелец',
    organizationName: 'Синтетический кабинет Б',
  });
  seed.verifyEmail(other.verificationToken);
  const admin = await seed.bootstrapGlobalAdmin({
    email: 'root@billing.test',
    password,
    displayName: 'Тестовый оператор',
  });
  seed.close();
  seed = null;
  database = createPlatformDatabase(platformDirectory);
  const template = database.open(
    database.db.prepare('SELECT value FROM accounts WHERE id=?').get(owner.accountId).value,
  );
  const staff = {};
  for (const role of ['salon_admin', 'cosmetologist']) {
    const id = crypto.randomUUID(),
      email = role + '@billing.test';
    database.db
      .prepare('INSERT INTO accounts VALUES(?,?,?,0,?,?)')
      .run(
        id,
        database.emailHash(email),
        database.seal({ ...template, email, displayName: 'Синтетический ' + role }),
        'active',
        Date.now(),
      );
    database.db
      .prepare('INSERT INTO memberships VALUES(?,?,?,?,?)')
      .run(owner.organizationId, id, role, 'active', Date.now());
    staff[role] = { accountId: id, organizationId: owner.organizationId, email };
  }
  const migrations = [
    ['012-max-connections', 'migrateMaxConnections'],
    ['013-notification-queue', 'migrateNotificationQueue'],
    ['014-notification-channels', 'migrateNotificationChannels'],
    ['015-max-inbox', 'migrateMaxInbox'],
    ['016-staff-max', 'migrateStaffMax'],
    ['017-staff-push', 'migrateStaffPush'],
    ['018-notification-schedule', 'migrateNotificationSchedule'],
    ['019-paid-services', 'migratePaidServices'],
  ];
  for (const [file, action] of migrations)
    require('../../src/server/migrations/' + file + '.cjs')[action](database, platformDirectory);
  if (notificationSchema === 20)
    require('../../src/server/migrations/020-multi-service-billing.cjs').migrateMultiServiceBilling(
      database,
      platformDirectory,
      { offline: true },
    );
  for (const account of [owner, other]) {
    const storage = createStorage(path.join(directory, 'tenants', account.organizationId));
    storage.write({ revision: 0, patients: [], services: [] });
    storage.close();
  }
  const legacy = createStorage(directory);
  legacy.write({ revision: 0, patients: [], services: [] });
  legacy.close();
  function dto(row) {
    const status = statuses.get(row.id) || 'pending';
    let paymentId = row.provider_payment_id || providerIds.get(row.id);
    if (!paymentId) {
      paymentId = crypto.randomUUID();
      providerIds.set(row.id, paymentId);
    }
    return {
      paymentId,
      status,
      succeeded: status === 'succeeded',
      amountKopecks: row.price_kopecks,
      currency: 'RUB',
      test: Boolean(row.test_mode),
      metadata: { checkoutId: row.id, organizationId: row.organization_id },
      receiptRegistration: 'succeeded',
      confirmationUrl:
        status === 'pending' ? 'https://payments.example.test/hosted/' + row.id : null,
    };
  }
  function latestOrder() {
    return database.db
      .prepare('SELECT * FROM billing_payment_orders ORDER BY created_at DESC,id DESC LIMIT 1')
      .get();
  }
  function paymentProviderFactory(config) {
    if (!config.testMode || config.secretKey !== 'synthetic-billing-secret')
      throw Error('Synthetic fixture refuses non-test merchant credentials');
    return {
      async createCheckout() {
        const row = latestOrder();
        providerCalls.push({ kind: 'create', orderId: row.id });
        if (rejectNext) {
          rejectNext = false;
          throw Object.assign(Error('Synthetic definite provider rejection'), {
            outcomeUnknown: false,
          });
        }
        return dto(row);
      },
      async readPayment(id) {
        const row = database.db
          .prepare('SELECT * FROM billing_payment_orders WHERE provider_payment_id=?')
          .get(id);
        providerCalls.push({ kind: 'read', orderId: row?.id });
        if (!row) throw Error('Synthetic payment does not exist');
        return dto(row);
      },
      async verifyWebhook(body) {
        const row = database.db
          .prepare('SELECT * FROM billing_payment_orders WHERE provider_payment_id=?')
          .get(body.object.id);
        providerCalls.push({ kind: 'verify', orderId: row?.id });
        if (!row) throw Error('Synthetic payment does not exist');
        return dto(row);
      },
    };
  }
  platform = createPlatformStore(platformDirectory, {
    notificationSchema,
    paymentNetworkEnabled,
    paymentProviderFactory,
  });
  const settings = platform.assistant.admin.view(admin.accountId);
  platform.assistant.admin.settings(admin.accountId, {
    expectedRevision: settings.revision,
    requestId: crypto.randomUUID(),
    reason: 'Synthetic browser setup',
    policy: { mode: 'selected' },
    providers: { stt: { provider: 'demo' }, llm: { provider: 'demo' }, tts: { provider: 'demo' } },
  });
  server = createMultiServer({
    dataDir: directory,
    notificationSchema,
    cabinetSchema: 0,
    production: false,
    processRole: 'combined',
    pushEnabled: false,
    maxEnabled: false,
    scheduledNotifications: false,
    telegramBot: null,
    telegramAutostart: false,
    supportDelivery: { telegram: null, email: null },
    supportAutostart: false,
    adminEmailAutostart: false,
    sendMail: async () => {},
    paymentProviderFactory,
    paymentNetworkEnabled,
    paymentFetch: async () => {
      throw Error('Synthetic fixture blocks all real provider HTTP');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function close() {
    if (closed) return;
    closed = true;
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    platform?.close();
    database?.db.close();
    seed?.close();
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith('cartoteca-billing-browser-')
    )
      throw Error('Unsafe synthetic billing fixture cleanup');
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return {
    directory,
    base,
    server,
    platform,
    database,
    password,
    owner,
    other,
    admin,
    staff,
    providerCalls,
    rejectNextCheckout() {
      rejectNext = true;
    },
    close,
    latestOrder,
    command: (extra) => ({
      requestId: crypto.randomUUID(),
      reason: 'Synthetic browser operation',
      ...extra,
    }),
    markPaid(id) {
      statuses.set(id, 'succeeded');
    },
    async configurePayments() {
      return platform.billing.payments.adminSettings(admin.accountId, {
        requestId: crypto.randomUUID(),
        reason: 'Synthetic test merchant only',
        expectedRevision: platform.billing.payments.config(admin.accountId).revision,
        configured: true,
        shopId: '12345',
        secretKey: 'synthetic-billing-secret',
        testMode: true,
        returnOrigin: 'https://cabinet.example.test',
        receiptConfig: {
          fiscalProvider: 'yookassa',
          purchaseModel: 'package',
          paymentMode: 'full_payment',
          vatCode: 1,
          taxSystemCode: 2,
          paymentSubject: 'service',
          description: 'Synthetic package only',
        },
      });
    },
  };
}
module.exports = { createBillingBrowserFixture };
