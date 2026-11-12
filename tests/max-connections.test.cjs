const test = require('node:test'),
  assert = require('node:assert/strict');
const { maxFixture } = require('./max-fixture.cjs');
const {
  createMaxConnections,
  MAX_USERNAME,
} = require('../src/server/modules/notifications/max-connections.cjs');
const { routes } = require('../src/server/modules/notifications/max-routes.cjs');
const noop = () => {};

test('MAX links are encrypted, personal, scoped by organization and replay-safe', (t) => {
  const f = maxFixture(t),
    issued = f.links.issue('org', 'p', 'owner', '123', noop, f.now);
  assert.equal(issued.expiresAt, f.now + 86400000);
  assert.equal(f.links.consume(issued.token, '123', '456', noop, f.now).repeated, false);
  assert.equal(f.links.consume(issued.token, '123', '456', noop, f.now).repeated, true);
  assert.throws(() => f.links.consume(issued.token, '123', '457', noop, f.now), { status: 409 });
  const other = f.links.issue('org', 'staff-p', 'staff', '123', noop, f.now);
  assert.throws(() => f.links.consume(other.token, '123', '456', noop, f.now), { status: 409 });
  const otherOrg = f.links.issue('other-org', 'p', 'outsider', '123', noop, f.now);
  assert.equal(f.links.consume(otherOrg.token, '123', '456', noop, f.now).repeated, false);
  const row = f.database.db
    .prepare('SELECT * FROM max_client_links WHERE organization_id=? AND patient_id=?')
    .get('org', 'p');
  assert.equal(f.database.open(row.value).userId, '456');
  assert.equal(Buffer.from(row.value).includes(Buffer.from('"userId":"456"')), false);
  assert.equal(JSON.stringify(f.service.status(f.owner, 'p')).includes('"userId"'), false);
});

test('new invitation revokes old, expiry and bot identity are rechecked', (t) => {
  const f = maxFixture(t),
    old = f.links.issue('org', 'p', 'owner', '123', noop, f.now);
  const fresh = f.links.issue('org', 'p', 'owner', '123', noop, f.now);
  assert.throws(() => f.links.consume(old.token, '123', '456', noop, f.now), { status: 400 });
  assert.throws(() => f.links.consume(fresh.token, '999', '456', noop, f.now), { status: 409 });
  assert.throws(() => f.links.consume(fresh.token, '123', '456', noop, fresh.expiresAt), {
    status: 400,
  });
  assert.equal(f.links.link('org', 'p'), null);
});

test('guard is inside the transaction; rollback leaves no token or binding', (t) => {
  const f = maxFixture(t),
    deny = () => {
      throw Error('synthetic revocation');
    };
  assert.throws(() => f.links.issue('org', 'p', 'owner', '123', deny, f.now), /revocation/);
  assert.equal(f.database.db.prepare('SELECT count(*) n FROM max_client_tokens').get().n, 0);
  const issued = f.links.issue('org', 'p', 'owner', '123', noop, f.now);
  assert.throws(() => f.links.consume(issued.token, '123', '456', deny, f.now), /revocation/);
  assert.equal(f.links.link('org', 'p'), null);
});

test('disconnect requires current binding and preserves Telegram and choice', (t) => {
  const f = maxFixture(t),
    issued = f.links.issue('org', 'p', 'owner', '123', noop, f.now);
  f.database.db
    .prepare('INSERT INTO telegram_links VALUES(?,?,?,?)')
    .run('org', 'p', 'synthetic-hash', f.database.seal({ chatId: '789' }));
  f.preferences.save(
    { org: 'org', patient: 'p', preference: 'manual', expectedRevision: 0, actor: 'owner' },
    noop,
    f.now,
  );
  f.links.consume(issued.token, '123', '456', noop, f.now);
  const current = f.links.link('org', 'p');
  assert.throws(() => f.links.unlink('org', 'p', 'outdated', 'owner', noop), { status: 409 });
  f.links.unlink('org', 'p', current.bindingId, 'owner', noop);
  assert.equal(f.links.link('org', 'p'), null);
  assert.equal(f.platform.telegram.link('org', 'p').chatId, '789');
  assert.equal(f.preferences.read('org', 'p').preference, 'manual');
  assert.throws(() => f.links.consume(issued.token, '123', '456', noop, f.now), { status: 400 });
});

test('out-of-order stop cannot remove a newer binding, nor can delayed start revive stopped bot', (t) => {
  const f = maxFixture(t),
    issued = f.links.issue('org', 'p', 'owner', '123', noop, f.now);
  f.links.stop('123', '456', f.now + 20, f.now);
  assert.throws(() => f.links.consume(issued.token, '123', '456', noop, f.now, f.now + 10), {
    status: 409,
  });
  f.links.consume(issued.token, '123', '456', noop, f.now, f.now + 30);
  assert.equal(f.links.stop('123', '456', f.now + 20, f.now), 0);
  assert.ok(f.links.link('org', 'p'));
  assert.equal(f.links.stop('123', '456', f.now + 40, f.now), 1);
});

test('service enforces visibility, issuer revocation, disabled mode and coordinator gate', async (t) => {
  const f = maxFixture(t);
  f.patients[0].name = 'PRIVATE_CLIENT';
  f.patients[0].phone = '+79990000000';
  const staff = { ...f.owner, accountId: 'staff', role: 'cosmetologist' };
  assert.throws(() => f.service.status(staff, 'p'), { status: 404 });
  assert.throws(() => f.service.status({ ...f.owner, role: '' }, 'p'), { status: 403 });
  assert.equal(f.service.status(staff, 'staff-p').canDisconnect, false);
  const invitation = await f.service.invitation(f.owner, 'p', noop);
  assert.ok(invitation.url.startsWith('https://max.ru/' + MAX_USERNAME + '?start='));
  assert.doesNotMatch(invitation.invitationText, /PRIVATE_CLIENT|79990000000/);
  const token = new URL(invitation.url).searchParams.get('start');
  f.database.db.prepare("UPDATE memberships SET status='suspended' WHERE account_id='owner'").run();
  assert.throws(() => f.service.consumeStarted(token, '456', f.now), { status: 403 });
  assert.throws(
    () =>
      f.service.savePreference(
        f.owner,
        { patientId: 'p', preference: 'max', expectedRevision: 0 },
        noop,
      ),
    { status: 410 },
  );
  const disabled = createMaxConnections({ platform: f.platform, tenantStore: f.tenantStore });
  assert.equal(disabled.status(f.owner, 'p').reason, 'migration_required');
  await assert.rejects(disabled.invitation(f.owner, 'p', noop), { status: 503 });
});

test('QR completion rechecks both access and the current invitation', async (t) => {
  const f = maxFixture(t);
  const replaced = createMaxConnections({
    platform: f.platform,
    tenantStore: f.tenantStore,
    links: f.links,
    botIdentity: f.identity,
    enabled: true,
    clock: () => f.now,
    makeQr: async () => {
      f.links.issue('org', 'p', 'owner', '123', noop, f.now);
      return 'synthetic-qr';
    },
  });
  await assert.rejects(replaced.invitation(f.owner, 'p', noop), { status: 409 });
  let checked = 0;
  await assert.rejects(
    f.service.invitation(f.owner, 'p', () => {
      if (++checked > 1) throw Error('changed access');
    }),
    /changed access/,
  );
});

test('preferences preserve legacy Telegram, use CAS and roll back async or failed coordination', (t) => {
  const f = maxFixture(t);
  assert.equal(f.preferences.read('org', 'p').preference, 'auto');
  f.database.db
    .prepare('INSERT INTO telegram_links VALUES(?,?,?,?)')
    .run('org', 'p', 'synthetic-hash', f.database.seal({ chatId: '789' }));
  assert.equal(f.preferences.read('org', 'p').preference, 'telegram');
  const values = {
    org: 'org',
    patient: 'p',
    preference: 'manual',
    expectedRevision: 0,
    actor: 'owner',
  };
  const result = f.preferences.save(values, noop, f.now);
  assert.equal(result.revision, 1);
  assert.equal(f.platform.telegram.link('org', 'p').chatId, '789');
  assert.throws(() => f.preferences.save(values, noop, f.now), { status: 409 });
  assert.throws(
    () =>
      f.preferences.save({ ...values, expectedRevision: 1, preference: 'max' }, noop, f.now, () =>
        Promise.resolve(),
      ),
    /Asynchronous/,
  );
  assert.equal(f.preferences.read('org', 'p').preference, 'manual');
});

test('HTTP preparation routes keep organization access and reject unknown body fields', async () => {
  assert.ok(routes.every((route) => route.access === 'organization'));
  const route = routes.find((route) => route.path === '/api/max/link');
  let calls = 0;
  await assert.rejects(
    route.handle({
      req: {},
      readBody: async () => ({ patientId: 'p', botId: '999' }),
      maxConnections: {
        invitation: async () => {
          calls++;
        },
      },
    }),
    { status: 400 },
  );
  assert.equal(calls, 0);
});
