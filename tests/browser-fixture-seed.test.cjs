const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createBrowserSeed, createFixture } = require('./browser/fixture.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
const contexts = new WeakMap();

async function request(fixture, route, { method = 'GET', body, cookie = '' } = {}) {
  const response = await fetch(fixture.base + route, {
    method,
    headers: {
      ...(body
        ? {
            Origin: fixture.base,
            'Content-Type': 'application/json',
            'X-Cartoteca-Request': '1',
          }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...contexts.get(fixture)?.get(cookie),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.getSetCookie?.()[0]?.split(';')[0] || '',
  };
}

async function login(fixture) {
  const response = await request(fixture, '/api/auth/login', {
    method: 'POST',
    body: { email: fixture.email, password: fixture.password },
  });
  assert.equal(response.status, 200, 'Synthetic owner must use the real HTTP login');
  assert.ok(response.cookie, 'Each case needs its own authenticated session');
  if (!contexts.has(fixture)) contexts.set(fixture, new Map());
  contexts.get(fixture).set(response.cookie, authContextHeaders(response.data));
  return response.cookie;
}

test('browser seed copies isolate live HTTP sessions and saved tenant data', async (t) => {
  const seed = createBrowserSeed(),
    fixtures = [];
  t.after(async () => {
    const cleanup = await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
    await seed.close();
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  });
  const first = await createFixture({ seed });
  fixtures.push(first);
  const second = await createFixture({ seed });
  fixtures.push(second);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.base, second.base);
  assert.equal(first.organizationId, second.organizationId, 'Both start from the same seed');
  const firstCookie = await login(first),
    secondCookie = await login(second);
  assert.notEqual(firstCookie, secondCookie);
  assert.equal(
    (await request(second, '/api/cabinet', { cookie: firstCookie })).status,
    401,
    'A session created in one clone cannot authenticate against another',
  );
  const before = await request(second, '/api/cabinet', {
    cookie: secondCookie,
  });
  assert.equal(before.status, 200);
  const changed = await request(first, '/api/cabinet', { cookie: firstCookie });
  assert.equal(changed.status, 200);
  changed.data.patients[0].designation = 'Изменено только в первом сценарии';
  const saved = await request(first, '/api/cabinet', {
    method: 'PUT',
    cookie: firstCookie,
    body: changed.data,
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await request(first, '/api/cabinet', { cookie: firstCookie })).data.patients[0].designation,
    'Изменено только в первом сценарии',
  );
  const unchanged = await request(second, '/api/cabinet', {
    cookie: secondCookie,
  });
  assert.equal(unchanged.data.patients[0].designation, before.data.patients[0].designation);
  assert.equal(unchanged.data.revision, before.data.revision);
  const third = await createFixture({ seed });
  fixtures.push(third);
  const thirdCookie = await login(third);
  assert.equal(
    (await request(third, '/api/cabinet', { cookie: thirdCookie })).data.patients[0].designation,
    before.data.patients[0].designation,
    'Seed itself remains unchanged',
  );
  await Promise.all([first.close(), first.close()]);
  assert.equal(fs.existsSync(first.directory), false);
  await assert.rejects(fetch(first.base + '/api/auth/session'));
  assert.equal(
    (await request(second, '/api/cabinet', { cookie: secondCookie })).status,
    200,
    'Closing one case cannot close another case',
  );
  await seed.close();
  await seed.close();
  await assert.rejects(createFixture({ seed }), /seed is closed/i);
  assert.equal(
    (await request(second, '/api/cabinet', { cookie: secondCookie })).status,
    200,
    'Seed cleanup cannot remove an active independent clone',
  );
});

test('standalone browser fixture retains independent owned-seed cleanup', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const cookie = await login(fixture);
  assert.equal((await request(fixture, '/api/cabinet', { cookie })).status, 200);
  assert.equal(fs.existsSync(fixture.directory), true);
  await fixture.close();
  await fixture.close();
  assert.equal(fs.existsSync(fixture.directory), false);
  await assert.rejects(fetch(fixture.base + '/api/auth/session'));
});
