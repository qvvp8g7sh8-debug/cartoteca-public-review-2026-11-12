const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./auth-store.cjs');
const { createMultiServer } = require('./multi-server.cjs');
const { PRIVACY_VERSION } = require('./src/shared/privacy-consent.cjs');
const consent = { privacyConsent: true, privacyConsentVersion: PRIVACY_VERSION };

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-multi-'));
  const old = createStore(dataDir);
  await old.setup('legacy@example.ru', 'legacy-secure-password', 'seed');
  old.write({
    revision: 0,
    patients: [{ id: 'p1', name: 'Существующий клиент', visits: [], appointments: [] }],
    services: [],
  });
  old.close();
  const outbox = [];
  const server = createMultiServer({
    dataDir,
    sendMail: async (email, url, meta) => outbox.push({ email, url, ...meta }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const contexts = new Map();
  async function request(route, { method = 'GET', body, cookie = '' } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        ...(body
          ? { 'Content-Type': 'application/json', 'X-Cartoteca-Request': '1', Origin: origin }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...contexts.get(cookie),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    const nextCookie = response.headers.getSetCookie?.()[0]?.split(';')[0] ||
      response.headers.get('set-cookie')?.split(';')[0] || '';
    if (route === '/api/auth/login' && response.ok && result.user && nextCookie)
      contexts.set(nextCookie, {
        'X-Cartoteca-Account-Id': result.user.id,
        'X-Cartoteca-Organization-Id': result.organizationId || '',
      });
    return {
      response,
      result,
      cookie: nextCookie,
    };
  }
  return { origin, request, outbox, dataDir };
}

test('migrates the existing owner and cabinet into the first organization', async (t) => {
  const { request } = await fixture(t);
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'legacy@example.ru', password: 'legacy-secure-password' },
  });
  assert.equal(login.response.status, 200);
  const cabinet = await request('/api/cabinet', { cookie: login.cookie });
  assert.equal(cabinet.response.status, 200);
  assert.equal(cabinet.result.patients[0].name, 'Существующий клиент');
});

test('registers and verifies an isolated owner cabinet', async (t) => {
  const { request, outbox } = await fixture(t);
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'new@example.ru',
      password: 'new-owner-secure-password',
      displayName: 'Новый владелец',
      organizationName: 'Новый кабинет',
      ...consent,
    },
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.result.verificationUrl, undefined);
  const token = new URL(outbox.at(-1).url).hash.split('=')[1];
  const before = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'new@example.ru', password: 'new-owner-secure-password' },
  });
  assert.equal(before.response.status, 403);
  assert.equal(
    (await request('/api/auth/verify-email', { method: 'POST', body: { token } })).response.status,
    200,
  );
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'new@example.ru', password: 'new-owner-secure-password' },
  });
  assert.equal(login.response.status, 200);
  const cabinet = await request('/api/cabinet', { cookie: login.cookie });
  assert.equal(cabinet.result.patients.length, 0);
});

test('owner manages staff and employees cannot delete cabinet data', async (t) => {
  const { request, outbox, dataDir } = await fixture(t);
  const owner = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'legacy@example.ru', password: 'legacy-secure-password' },
  });
  const ownerSession = await request('/api/auth/session', { cookie: owner.cookie });
  assert.equal(ownerSession.result.user.role, 'owner');
  assert.ok(ownerSession.result.user.id);
  const invitation = await request('/api/organization/invitations', {
    method: 'POST',
    cookie: owner.cookie,
    body: { email: 'cosmetologist@example.ru', role: 'cosmetologist' },
  });
  assert.equal(invitation.response.status, 201);
  assert.equal(invitation.result.inviteUrl, undefined);
  const token = new URL(outbox.at(-1).url).hash.split('=')[1];
  const accepted = await request('/api/auth/invitations/accept', {
    method: 'POST',
    body: {
      token,
      email: 'cosmetologist@example.ru',
      password: 'cosmetologist-password',
      passwordConfirmation: 'cosmetologist-password',
      displayName: 'Косметолог',
      ...consent,
    },
  });
  assert.equal(accepted.response.status, 200);
  const ownerCabinet = await request('/api/cabinet', { cookie: owner.cookie });
  await require('./tests/helpers/working-days.cjs').workingDays(dataDir,
    'legacy@example.ru', 'legacy-secure-password', ['2026-10-03'], [accepted.result.accountId]);
  ownerCabinet.result.patients[0].appointments.push({
    id: 'assigned',
    date: '2026-10-03',
    time: '10:00',
    duration: 60,
    staffId: accepted.result.accountId,
  });
  ownerCabinet.result.patients.push({
    id: 'owner-only',
    name: 'Другой клиент',
    visits: [],
    appointments: [],
  });
  assert.equal(
    (
      await request('/api/cabinet', {
        method: 'PUT',
        cookie: owner.cookie,
        body: ownerCabinet.result,
      })
    ).response.status,
    200,
  );
  const specialist = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'cosmetologist@example.ru', password: 'cosmetologist-password' },
  });
  assert.equal(specialist.response.status, 200);
  const specialistSession = await request('/api/auth/session', { cookie: specialist.cookie });
  assert.equal(specialistSession.result.user.role, 'cosmetologist');
  const before = await request('/api/cabinet', { cookie: specialist.cookie });
  assert.deepEqual(
    before.result.patients.map((patient) => patient.id),
    ['p1'],
  );
  assert.deepEqual(
    before.result.patients[0].appointments.map((appointment) => appointment.id),
    ['assigned'],
  );
  const deleted = await request('/api/cabinet', {
    method: 'PUT',
    cookie: specialist.cookie,
    body: { revision: before.result.revision, patients: [], services: before.result.services },
  });
  assert.equal(deleted.response.status, 403);
  assert.match(deleted.result.error, /только владелец/);
  const ownVisit = {
    id: 'own-visit',
    date: '2026-10-03',
    procedure: 'Уход',
    photos: [],
    staffId: specialistSession.result.user.id,
  };
  const changed = structuredClone(before.result);
  changed.patients[0].visits.push(ownVisit);
  const saved = await request('/api/cabinet', {
    method: 'PUT',
    cookie: specialist.cookie,
    body: changed,
  });
  assert.equal(saved.response.status, 200);
  const access = await request('/api/organization/access', { cookie: owner.cookie });
  assert.equal(access.response.status, 200);
  assert.equal(
    access.result.members.some((member) => member.role === 'cosmetologist'),
    true,
  );
  const suspended = await request('/api/organization/members', {
    method: 'POST',
    cookie: owner.cookie,
    body: { accountId: accepted.result.accountId, role: 'cosmetologist', status: 'suspended' },
  });
  assert.equal(suspended.response.status, 200);
  assert.equal((await request('/api/cabinet', { cookie: specialist.cookie })).response.status, 401);
});

test('free owner cannot save an eleventh patient', async (t) => {
  const { request, outbox } = await fixture(t);
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: {
      email: 'new@example.ru',
      password: 'new-owner-secure-password',
      displayName: 'Новый владелец',
      organizationName: 'Новый кабинет',
      ...consent,
    },
  });
  const token = new URL(outbox.at(-1).url).hash.split('=')[1];
  await request('/api/auth/verify-email', { method: 'POST', body: { token } });
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'new@example.ru', password: 'new-owner-secure-password' },
  });
  const patients = Array.from({ length: 11 }, (_, i) => ({
    id: 'p' + i,
    name: 'Клиент ' + i,
    visits: [],
    appointments: [],
  }));
  const save = await request('/api/cabinet', {
    method: 'PUT',
    cookie: login.cookie,
    body: { revision: 0, patients, services: [] },
  });
  assert.equal(save.response.status, 402);
  assert.match(save.result.error, /10 клиентов/);
});

test('blocks the HTTP login endpoint after five invalid attempts', async (t) => {
  const { request } = await fixture(t);
  for (let attempt = 1; attempt < 5; attempt++) {
    const failed = await request('/api/auth/login', {
      method: 'POST',
      body: { email: 'legacy@example.ru', password: 'wrong-password' },
    });
    assert.equal(failed.response.status, 401);
    assert.match(failed.result.error, new RegExp(`Осталось попыток: ${5 - attempt}`));
  }
  const blocked = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'legacy@example.ru', password: 'wrong-password' },
  });
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.response.headers.get('retry-after'), '900');
  const correctWhileBlocked = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'legacy@example.ru', password: 'legacy-secure-password' },
  });
  assert.equal(correctWhileBlocked.response.status, 429);
});
