const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createMultiServer } = require('../multi-server.cjs');
const {
  createSupportRuntime,
  configuredSupportDelivery,
  supportMessage,
} = require('../src/server/modules/support/delivery.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const password = 'Synthetic-support-password-2026';
const body = () => ({
  requestId: crypto.randomUUID(),
  description: 'Не сохраняется вымышленная запись',
  diagnostics: {
    version: '1111111111111111',
    view: 'settings',
    width: 390,
    height: 844,
    online: true,
  },
});
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-support-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'support-user@example.test',
    password,
    displayName: 'Synthetic operator',
    organizationName: 'Synthetic clinic',
  });
  platform.verifyEmail(owner.verificationToken);
  const other = await platform.registerOwner({
    email: 'support-other@example.test',
    password,
    displayName: 'Other',
    organizationName: 'Other',
  });
  platform.verifyEmail(other.verificationToken);
  const admin = await platform.bootstrapGlobalAdmin({
    email: 'support-global@example.test',
    password,
    displayName: 'Global',
  });
  const current = { accountId: owner.accountId, organizationId: owner.organizationId };
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    platform.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, platform, current, owner, other, admin, closers };
}
test('support receipts are private, encrypted, idempotent and bounded with no clinical reads', async (t) => {
  const f = await fixture(t),
    first = body(),
    receipt = f.platform.support.create(f.current, first);
  assert.deepEqual(receipt.deliveries, { telegram: 'pending' });
  assert.equal(receipt.replyEmail, 'support-user@example.test');
  assert.equal(f.platform.support.create(f.current, first).id, receipt.id);
  assert.throws(
    () => f.platform.support.create(f.current, { ...first, description: 'Other text' }),
    { status: 409 },
  );
  assert.throws(() => f.platform.support.receipt(f.other.accountId, receipt.id), { status: 404 });
  assert.throws(() => f.platform.support.receipt(f.admin.accountId, receipt.id), { status: 404 });
  for (const invalid of [
    { ...body(), description: ' ' },
    { ...body(), description: 'x'.repeat(1501) },
    { ...body(), email: 'attacker@example.test' },
    { ...body(), diagnostics: { ...first.diagnostics, patient: 'NO' } },
    { ...body(), diagnostics: { ...first.diagnostics, view: 'cookie' } },
  ])
    assert.throws(() => f.platform.support.create(f.current, invalid), { status: 400 });
  const db = new DatabaseSync(path.join(f.dir, 'platform', 'platform.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
    for (const row of db.prepare('SELECT value FROM support_requests').all())
      assert.doesNotMatch(
        Buffer.from(row.value).toString('utf8'),
        /Synthetic|example\.test|Не сохраняется/,
      );
    assert.equal(
      db.prepare("SELECT detail FROM platform_audit WHERE event='support_request_created'").get()
        .detail,
      JSON.stringify({ requestId: receipt.id }),
    );
  } finally {
    db.close();
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'tenants')), false);
  f.platform.support.create(f.current, body());
  f.platform.support.create(f.current, body());
  assert.throws(() => f.platform.support.create(f.current, body()), { status: 429 });
  assert.equal(f.platform.support.create(f.current, first).id, receipt.id);
});
test('support queue survives worker competition, retry and expired leases without stale completion', async (t) => {
  const f = await fixture(t),
    first = body(),
    now = Date.now(),
    receipt = f.platform.support.create(f.current, first, now);
  const second = createPlatformStore(path.join(f.dir, 'platform'));
  f.closers.push(() => second.close());
  const job = f.platform.support.claim('telegram', now);
  assert.ok(job);
  assert.equal(second.support.claim('telegram', now), null);
  const recovered = second.support.claim('telegram', now + 120001);
  assert.ok(recovered);
  assert.equal(f.platform.support.finish(job, 'sent'), false);
  assert.equal(second.support.finish(recovered, 'pending', now + 180001), true);
  assert.equal(second.support.claim('telegram', now + 150000), null);
  let sent = 0,
    instant = now + 180002;
  const runtime = createSupportRuntime({
    store: f.platform.support,
    telegram: {
      initialize: async () => {},
      send: async (text) => {
        sent++;
        assert.match(text, /Synthetic clinic/);
        assert.match(text, /support-user@example.test/);
        assert.match(text, /390 × 844/);
      },
    },
    clock: () => instant,
  });
  await runtime.tick();
  assert.equal(sent, 1);
  assert.equal(
    f.platform.support.receipt(f.owner.accountId, receipt.id).deliveries.telegram,
    'sent',
  );
  await runtime.tick();
  assert.equal(sent, 1);
  assert.equal(f.platform.support.claim('email', instant), null);
});
test('Telegram and optional email have independent failure states and bounded attempts', async (t) => {
  const f = await fixture(t),
    now = Date.now(),
    receipt = f.platform.support.create(f.current, body(), now, { emailEnabled: true });
  let clock = now,
    email = 0,
    telegram = 0;
  const runtime = createSupportRuntime({
    store: f.platform.support,
    telegram: {
      initialize: async () => {},
      send: async () => {
        telegram++;
        throw Object.assign(Error('SECRET_PROVIDER_ERROR'), { providerCode: 403 });
      },
    },
    email: async () => {
      email++;
    },
    clock: () => clock,
  });
  await runtime.tick();
  assert.equal(telegram, 1);
  assert.equal(email, 1);
  assert.deepEqual(f.platform.support.receipt(f.owner.accountId, receipt.id).deliveries, {
    email: 'sent',
    telegram: 'failed',
  });
  const next = f.platform.support.create(f.current, body(), clock);
  const retries = createSupportRuntime({
    store: f.platform.support,
    telegram: {
      initialize: async () => {},
      send: async () => {
        throw Error('PRIVATE ERROR');
      },
    },
    clock: () => clock,
  });
  for (let n = 0; n < 5; n++) {
    await retries.tick();
    clock += 4000000;
  }
  assert.equal(
    f.platform.support.receipt(f.owner.accountId, next.id).deliveries.telegram,
    'failed',
  );
  assert.deepEqual(configuredSupportDelivery({}), { telegram: null, email: null });
  assert.deepEqual(
    configuredSupportDelivery({
      CARTOTECA_SUPPORT_BOT_TOKEN: '123456:abcdefghijklmnopqrstuv',
      TELEGRAM_BOT_TOKEN: '123456:abcdefghijklmnopqrstuv',
      CARTOTECA_SUPPORT_CHAT_ID: '123',
    }),
    { telegram: null, email: null },
  );
});
test('support HTTP uses session/CSRF, refuses identity injection and hides other users receipts', async (t) => {
  const f = await fixture(t),
    server = createMultiServer({
      dataDir: f.dir,
      telegramBot: null,
      sendMail: null,
      supportDelivery: {
        telegram: { initialize: async () => {}, send: async () => {} },
        email: null,
      },
      supportAutostart: false,
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  f.closers.push(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const contexts = new Map();
  const request = async (route, payload, cookie = '', origin = base) => {
    const r = await fetch(base + route, {
      method: payload ? 'POST' : 'GET',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...contexts.get(cookie),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await r.json(),
      issued = r.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && r.ok && issued)
      contexts.set(issued, authContextHeaders(data));
    return { status: r.status, data, cookie: issued };
  };
  assert.equal((await request('/api/app/info')).data.supportForm, true);
  assert.equal((await request('/api/support/requests', body())).status, 401);
  const owner = await request('/api/auth/login', { email: 'support-user@example.test', password });
  assert.equal(
    (await request('/api/support/requests', body(), owner.cookie, 'https://evil.test')).status,
    403,
  );
  const first = body(),
    accepted = await request('/api/support/requests', first, owner.cookie);
  assert.equal(accepted.status, 202);
  assert.equal(
    (await request('/api/support/requests', first, owner.cookie)).data.receipt.id,
    accepted.data.receipt.id,
  );
  const other = await request('/api/auth/login', { email: 'support-other@example.test', password });
  assert.equal(
    (await request('/api/support/requests?id=' + accepted.data.receipt.id, null, other.cookie))
      .status,
    404,
  );
  const own = await request(
    '/api/support/requests?id=' + accepted.data.receipt.id,
    null,
    owner.cookie,
  );
  assert.equal(own.status, 200);
  assert.doesNotMatch(JSON.stringify(own.data), /payload|description|token|chatId/);
});
test('support message is plain text and includes only submitted text, identity and allowed diagnostics', () => {
  const text = supportMessage({
    request_id: 'synthetic-id',
    payload: {
      displayName: 'Owner',
      email: 'reply@example.test',
      organization: 'Clinic',
      description: 'Question <not html>',
      diagnostics: null,
      patients: 'PRIVATE_PATIENT',
      token: 'PRIVATE_TOKEN',
    },
  });
  assert.match(text, /Question <not html>/);
  assert.doesNotMatch(text, /PRIVATE_|diagnostics|Раздел/);
});
