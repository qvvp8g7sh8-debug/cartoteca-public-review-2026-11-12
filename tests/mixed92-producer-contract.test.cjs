// Exercise the real route handlers/storage/ACL/receipts without opening a socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bookingFixture } = require('./helpers/booking-fixture.cjs');
const { createClient, safeErrorMessage } = require('../scripts/benchmark-mixed92-client.cjs');
const { createPhoto } = require('../scripts/benchmark-mixed92-fixture.cjs');
const auth = require('../src/server/modules/auth/routes.cjs').routes;
const queries = require('../src/server/modules/cabinet/queries.cjs').routes;
const mutations = require('../src/server/modules/cabinet/routes.cjs').routes;

async function bridge(t, { loseFirstSave = false } = {}) {
  const f = await bookingFixture({ patients: 2, history: 1, appointments: 2 });
  t.after(f.close);
  const invitation = f.platform.createInvitation({
    organizationId: f.org,
    invitedBy: f.owner.accountId,
    role: 'cosmetologist',
  });
  const password = 'Synthetic-organizations-password-2026';
  const staff = await f.platform.acceptInvitation({
    token: invitation.token,
    email: 'mixed92-contract-staff@example.test',
    password,
    displayName: 'Synthetic staff',
  });
  const staffLogin = await f.platform.login('mixed92-contract-staff@example.test', password);
  const state = f.storage.read();
  for (const [index, patient] of state.patients.entries()) {
    patient.id = 'p-0-' + index;
    for (const row of patient.appointments) row.roomId = 'main';
    if (index === 1) {
      patient.createdBy = staff.accountId;
      for (const row of [...patient.visits, ...patient.appointments]) row.staffId = staff.accountId;
    }
  }
  f.storage.write(state);
  f.platform.saveWorkspace(
    f.org,
    f.owner.accountId,
    {
      revision: 0,
      enabled: true,
      mode: 'shared',
      roomLayout: 'single',
      rooms: [
        {
          id: 'main',
          name: 'Synthetic room',
          active: true,
          preventOverlap: true,
          staffMode: 'multiple',
          staffIds: [f.owner.accountId, staff.accountId],
        },
      ],
    },
    () => state,
  );
  const actors = [
    {
      id: f.owner.accountId,
      cookie: 'cartoteca_v2_session=' + f.token,
      email: 'owner@classic.test',
      role: 'owner',
      patient: 'p-0-0',
    },
    {
      id: staff.accountId,
      cookie: 'cartoteca_v2_session=' + staffLogin.token,
      email: 'mixed92-contract-staff@example.test',
      role: 'cosmetologist',
      patient: 'p-0-1',
    },
  ].map((actor, ordinal) => ({ ...actor, index: 0, ordinal, org: f.org }));
  const data = {
    actors,
    organizations: [f.org],
    first: f.date,
    cards: 2,
    password: 'Synthetic-classic-password-2026',
  };
  // Fixture owner and invited staff deliberately use independent passwords.
  let lost = false;
  const fetchImpl = async (input, options) => {
    const url = new URL(input),
      route = [...auth, ...queries, ...mutations].find(
        (route) => route.method === options.method && route.path === url.pathname,
      );
    assert.ok(route, url.pathname);
    const headers = Object.fromEntries(
      Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    const token = headers.cookie.split('=')[1],
      current = f.platform.session(token);
    let cookie;
    const context = {
      req: { headers, aborted: false },
      url,
      current,
      token,
      platform: f.platform,
      tenantStore(org) {
        assert.equal(org, f.org);
        return f.storage;
      },
      assertCurrent() {
        const fresh = f.platform.session(token);
        assert.equal(fresh?.accountId, current.accountId);
        assert.equal(fresh?.organizationId, f.org);
      },
      async readBody() {
        return JSON.parse(options.body);
      },
      clientAddress: () => 'synthetic-loopback',
      setCookie(_res, value) {
        cookie = value;
      },
      appointmentState: { decorate: (value) => value },
      json(_res, status, value) {
        return new Response(JSON.stringify(value), {
          status,
          headers: cookie ? { 'Set-Cookie': 'cartoteca_v2_session=' + cookie + '; HttpOnly' } : {},
        });
      },
    };
    try {
      const response = await route.handle(context);
      if (loseFirstSave && !lost && route.path === '/api/cabinet/changes') {
        lost = true;
        throw Error('Synthetic post-commit response lost');
      }
      return response;
    } catch (error) {
      if (!error.status) throw error;
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        status: error.status,
      });
    }
  };
  return { f, data, actors, fetchImpl, staffPassword: password };
}

test('mixed92 login follows the real user response, and owner/staff saves obey actual ACL with expiring old receipts', async (t) => {
  const b = await bridge(t);
  const client = createClient(b.data, { base: 'http://127.0.0.1:4173', fetchImpl: b.fetchImpl });
  await client.action('auth', b.actors[0], 0);
  const staffClient = createClient(
    { ...b.data, password: b.staffPassword },
    { base: 'http://127.0.0.1:4173', fetchImpl: b.fetchImpl },
  );
  await staffClient.action('auth', b.actors[1], 1);
  await client.action('save', b.actors[0], 2);
  await client.action('save', b.actors[1], 3);
  await client.action('save', b.actors[0], 4);
  await client.action('save', b.actors[1], 5);
  const result = await client.reconcile();
  assert.equal(result.committed, 4);
  assert.equal(result.receiptConfirmed, 4);
  assert.equal(result.unknown, 0);
  assert.equal(result.mismatched, 0);
  assert.equal(result.latestCardsVerified, 2);
  const read = b.f.storage.readSelected(['p-0-1']).patients[0];
  assert.equal(read.notes || '', '');
  assert.equal(read.appointments[0].notes, 'Synthetic mixed92 5');
});

test('mixed92 verifies actual upload receipt immediately and later validates the latest photo plus appointment note', async (t) => {
  const b = await bridge(t),
    jpeg = await createPhoto(require('sharp'));
  const client = createClient(b.data, {
    base: 'http://127.0.0.1:4173',
    fetchImpl: b.fetchImpl,
    jpeg,
  });
  await client.action('photo-upload', b.actors[0], 0);
  await client.action('save', b.actors[0], 1);
  await client.action('photo-upload', b.actors[0], 2);
  const result = await client.reconcile();
  assert.equal(result.committed, 3);
  assert.equal(result.receiptConfirmed, 3);
  assert.equal(result.unknown, 0);
  assert.equal(result.mismatched, 0);
  assert.equal(result.latestCardsVerified, 1);
});

test('real committed mutation with a lost response freezes the actor and reconciles without a duplicate write', async (t) => {
  const b = await bridge(t, { loseFirstSave: true });
  const client = createClient(b.data, { base: 'http://127.0.0.1:4173', fetchImpl: b.fetchImpl });
  await assert.rejects(client.action('save', b.actors[1], 0), /response lost/);
  await assert.rejects(client.action('save', b.actors[1], 1), /unknown outcome/);
  const result = await client.reconcile();
  assert.equal(result.attempted, 1);
  assert.equal(result.committed, 1);
  assert.equal(result.unknown, 0);
  assert.equal(result.mismatched, 0);
});

test('error examples are bounded and remove URL credentials, mail, bearer-like IDs and phone numbers', async () => {
  const token = 'a'.repeat(43),
    email = 'private@example.test';
  const message = safeErrorMessage(
    'Failure ' +
      email +
      ' https://u:p@example.test/?token=' +
      token +
      ' ' +
      token +
      ' +79181234567',
  );
  assert.doesNotMatch(message, /private@example|example\.test|a{43}|79181234567/);
  const user = { id: 'u', org: 'o', ordinal: 0, cookie: 'synthetic' };
  const client = createClient(
    { cards: 10 },
    {
      base: 'http://127.0.0.1:4173',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: 'Сотрудник не может изменять основные сведения клиента.',
            code: 'ACL_DENIED',
          }),
          { status: 403 },
        ),
    },
  );
  for (let n = 0; n < 40; n++)
    await assert.rejects(client.action('search', user, n), { status: 403 });
  const errors = client.errors();
  assert.ok(errors.examples.length <= 24);
  assert.ok(errors.examples.some((row) => row.status === 403 && row.code === 'ACL_DENIED'));
});

test('network failures report closed transport causes without leaking nested messages or identifiers', async () => {
  const actor = { id: 'synthetic-account', org: 'synthetic-org', cookie: 'synthetic-cookie' };
  const data = { cards: 1, actors: [actor], organizations: [actor.org] };
  for (const [causeCode, expected] of [
    ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT'],
    ['ECONNRESET', 'ECONNRESET'],
    ['PRIVATE_ACCOUNT_TOKEN', null],
  ]) {
    const client = createClient(data, {
      base: 'http://127.0.0.1:4173',
      fetchImpl: async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('private nested detail secret@example.test'), {
            code: causeCode,
          }),
        });
      },
    });
    await assert.rejects(client.action('search', actor, 0), /fetch failed/);
    const report = client.errors();
    assert.ok(report.examples.length > 0);
    for (const example of report.examples) assert.equal(example.networkCode, expected);
    assert.doesNotMatch(
      JSON.stringify(report),
      /private nested|secret@example|PRIVATE_ACCOUNT_TOKEN/,
    );
  }
});
