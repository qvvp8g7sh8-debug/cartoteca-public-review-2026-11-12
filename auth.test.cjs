const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./serve.cjs');

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-auth-test-'));
  let server = createServer({ dataDir: dir, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if(path.dirname(dir)===path.resolve(os.tmpdir()) && path.basename(dir).startsWith('cartoteca-auth-test-')) fs.rmSync(dir,{recursive:true,force:true});
  });
  return {
    dir,
    async restart() {
      await new Promise(resolve => server.close(resolve));
      server = createServer({ dataDir: dir, ...options });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    },
    async request(route, method = 'GET', body, cookie = '', headers = {}) {
      return fetch(base + route, {
        method, headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json', Cookie: cookie, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    }
  };
}
const credentials = { email: 'Owner@Example.test', password: 'A-long-test-password-2026' };
const cookie = res => res.headers.get('set-cookie').split(';')[0];
const state = { revision: 0, patients: [{ id: 'test-p', name: 'Тест', visits: [{ id: 'test-v', date: '2026-09-15', photos: [{ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==' }] }], appointments: [{ id: 'test-a', date:'2026-09-15', time: '09:15', duration: 90 }] }], services: [{ id: 's', name: 'Тестовая услуга', product: 'Средство', price: 1000 }] };

test('anonymous requests cannot read cabinet, app script, private files or DIKIDI', async t => {
  const f = await fixture(t);
  assert.match(await (await f.request('/')).text(), /auth-form/);
  assert.deepEqual(await (await f.request('/api/auth/session')).json(), { configured: false, user: null });
  for (const route of ['/api/cabinet', '/app.js', '/api/dikidi/clients', '/api/dikidi/status']) assert.equal((await f.request(route)).status, 401);
  for (const route of ['/data/cabinet.json', '/data/cabinet.json.backup', '/.env.local', '/auth-store.cjs']) assert.equal((await f.request(route)).status, 404);
  assert.equal((await f.request('/api/cabinet', 'PUT', state)).status, 401);
});

test('setup once, normalized email, cookie flags, wrong password and login', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/setup', 'POST', { ...credentials, password: 'short' })).status, 400);
  const setup = await f.request('/api/auth/setup', 'POST', credentials);
  assert.equal(setup.status, 200);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//);
  const sessionCookie = cookie(setup);
  assert.equal((await (await f.request('/api/auth/session', 'GET', undefined, sessionCookie)).json()).user.email, 'owner@example.test');
  assert.equal((await f.request('/api/auth/setup', 'POST', { email: 'second@example.test', password: credentials.password })).status, 409);
  assert.equal((await f.request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', { ...credentials, email: 'other@example.test' })).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', credentials)).status, 200);
  const stored = fs.readFileSync(path.join(f.dir, 'cabinet.sqlite'), 'utf8');
  assert.ok(!stored.includes(credentials.password));
  assert.ok(!stored.includes(credentials.email.toLowerCase()));
});

test('data and photos survive logout and restart; stale tab cannot overwrite newer data', async t => {
  const f = await fixture(t);
  const first = cookie(await f.request('/api/auth/setup', 'POST', credentials));
  assert.equal((await f.request('/api/cabinet', 'PUT', state, first)).status, 200);
  assert.equal((await f.request('/api/cabinet', 'PUT', { ...state, patients: [] }, first)).status, 409);
  const read = await (await f.request('/api/cabinet', 'GET', undefined, first)).json();
  assert.equal(read.patients[0].name,state.patients[0].name);
  const photo=read.patients[0].visits[0].photos[0].data;assert.match(photo,/^\/api\/photos\//);
  assert.equal((await f.request(photo)).status,401);
  assert.deepEqual(Buffer.from(await (await f.request(photo,'GET',undefined,first)).arrayBuffer()),Buffer.from(state.patients[0].visits[0].photos[0].data.split(',')[1],'base64'));
  assert.deepEqual(read.services, state.services);
  assert.equal(read.revision, 1);
  assert.equal((await f.request('/api/auth/logout', 'POST', {}, first)).status, 200);
  assert.equal((await f.request('/api/cabinet', 'GET', undefined, first)).status, 401);
  await f.restart();
  const login = await f.request('/api/auth/login', 'POST', credentials);
  assert.equal(login.status, 200);
  const second = cookie(login);
  assert.notEqual(second, first);
  const again = await (await f.request('/api/cabinet', 'GET', undefined, second)).json();
  assert.deepEqual(again, read);
  assert.equal((await f.request('/api/cabinet', 'PUT', { patients: [], services: [], revision: 1 }, second)).status, 200);
  assert.equal((await (await f.request('/api/cabinet', 'GET', undefined, second)).json()).patients.length, 0);
});

test('cross-site mutations and missing custom header are rejected even with a session', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/setup', 'POST', credentials, '', { Origin: 'https://evil.test' })).status, 403);
  const sessionCookie = cookie(await f.request('/api/auth/setup', 'POST', credentials));
  assert.equal((await f.request('/api/cabinet', 'PUT', state, sessionCookie, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request('/api/cabinet', 'PUT', state, sessionCookie, { 'X-Cartoteca-Request': '' })).status, 403);
  assert.equal((await f.request('/api/auth/logout', 'POST', {}, sessionCookie, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.request('/api/cabinet', 'GET', undefined, sessionCookie)).status, 200);
});

test('concurrent initial registrations cannot create a second owner', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request('/api/auth/setup', 'POST', credentials), f.request('/api/auth/setup', 'POST', { ...credentials, email: 'other@example.test' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});

test('repeated invalid logins are rate limited', async t => {
  const f = await fixture(t);
  await f.request('/api/auth/setup', 'POST', credentials);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/auth/login', 'POST', credentials)).status, 429);
});
