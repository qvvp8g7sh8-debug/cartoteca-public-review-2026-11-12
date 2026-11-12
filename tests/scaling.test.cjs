const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { fork } = require('node:child_process');
const { createPlatformStore } = require('../platform-store.cjs'),
  { createStorage } = require('../storage.cjs');
const { authContextHeaders } = require('./helpers/account-context.cjs');
async function fixture(t, { clustered = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-scale-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'scale@example.test',
    password: 'Scale-test-password-2026',
    displayName: 'Test',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  const staff = [];
  for (let i = 0; i < 2; i++) {
    const invite = platform.createInvitation({
      organizationId: owner.organizationId,
      invitedBy: owner.accountId,
      role: 'cosmetologist',
    });
    staff.push(
      await platform.acceptInvitation({
        token: invite.token,
        email: `staff${i}@example.test`,
        password: 'Scale-staff-password-2026',
        displayName: 'Test staff',
      }),
    );
  }
  const store = createStorage(path.join(dir, 'tenants', owner.organizationId));
  const patients = ['p1', 'p2', 'shared'].map((id) => ({
    id,
    name: 'Synthetic ' + id,
    createdBy: owner.accountId,
    visits: [],
    appointments: [],
  }));
  patients[2].visits = staff.map((user, i) => ({
    id: 'visit' + i,
    date: '2020-01-01',
    staffId: user.accountId,
    procedure: 'Synthetic private ' + i,
    photos: [],
  }));
  store.write({ revision: 0, patients, services: [] });
  await require('./helpers/working-days.cjs').workingDays(
    dir,
    'scale@example.test',
    'Scale-test-password-2026',
    ['2030-01-01'],
    [owner, ...staff].map((user) => user.accountId),
  );
  const rootStore = createStorage(dir);
  rootStore.close();
  const children = [];
  t.after(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            child.send('stop');
          }),
      ),
    );
    store.close();
    platform.close();
    const cleanup = path.resolve(dir);
    assert.equal(path.dirname(cleanup), path.resolve(os.tmpdir()));
    assert.match(path.basename(cleanup), /^cartoteca-scale-/);
    fs.rmSync(cleanup, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  });
  const ports = [];
  let clusterPort;
  if (clustered) {
    const listener = require('node:net').createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    clusterPort = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
  }
  for (let i = 0; i < (clustered ? 1 : 2); i++)
    ports.push(
      await new Promise((resolve, reject) => {
        const entry = clustered
          ? path.join(__dirname, '../scripts/start-workers.cjs')
          : path.join(__dirname, 'helpers/process-server.cjs');
        const env = clustered
          ? {
              ...process.env,
              CARTOTECA_DATA_DIR: dir,
              PORT: String(clusterPort),
              BIND_HOST: '127.0.0.1',
              APP_ORIGIN: '',
              NODE_ENV: 'test',
              TELEGRAM_BOT_TOKEN: '',
              SMTP_HOST: '',
              WEB_CONCURRENCY: '2',
            }
          : process.env;
        const child = fork(entry, clustered ? [] : [dir], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env,
        });
        children.push(child);
        let diagnostic = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          diagnostic = (diagnostic + chunk).slice(-4096);
        });
        const startupError = (message) => Error(message + (diagnostic ? '\n' + diagnostic : ''));
        const timeout = setTimeout(() => {
          child.kill();
          reject(startupError('Test worker startup timeout after 30000 ms'));
        }, 30000);
        const ready = (message) => {
          if (message?.diagnostic) {
            diagnostic = (
              diagnostic +
              '\n' +
              (message.diagnostic.stack ||
                message.diagnostic.message ||
                message.diagnostic.code ||
                'Worker diagnostic')
            ).slice(-4096);
            clearTimeout(timeout);
            child.kill();
            reject(startupError('Test worker startup failed over IPC'));
            return;
          }
          if (!Number.isInteger(message?.port) || message.port < 1 || message.port > 65535) return;
          clearTimeout(timeout);
          child.removeListener('message', ready);
          if (clustered && message.workers !== 2) {
            child.kill();
            reject(startupError('Test worker reported an unexpected worker count'));
            return;
          }
          resolve(message.port);
        };
        child.on('message', ready);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(startupError('Test worker startup error: ' + error.message));
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          reject(startupError('Test worker exited before readiness: ' + (signal || code)));
        });
      }),
    );
  if (clustered) ports.push(ports[0]);
  const contexts = new Map();
  async function request(worker, route, body, cookie = '', method = body ? 'POST' : 'GET') {
    const base = 'http://127.0.0.1:' + ports[worker];
    const expected = contexts.get(cookie);
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        Cookie: cookie,
        ...expected,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json(),
      issued = response.headers.get('set-cookie')?.split(';')[0];
    if (route === '/api/auth/login' && response.ok && issued)
      contexts.set(issued, authContextHeaders(data));
    return { status: response.status, data, cookie: issued };
  }
  const cookies = [];
  for (const email of ['scale@example.test', 'staff0@example.test', 'staff1@example.test'])
    cookies.push(
      (
        await request(0, '/api/auth/login', {
          email,
          password: email.startsWith('scale')
            ? 'Scale-test-password-2026'
            : 'Scale-staff-password-2026',
        })
      ).cookie,
    );
  const read = async (worker = 0, role = 0) =>
    (await request(worker, '/api/cabinet', null, cookies[role])).data;
  const patch = (worker, before, after, role = 0) =>
    request(
      worker,
      '/api/cabinet/changes',
      { revision: 0, patients: [{ id: after?.id || before.id, before, after }], services: [] },
      cookies[role],
      'PATCH',
    );
  return { platform, owner, staff, store, request, cookies, read, patch };
}
test('independent server processes save unrelated records and reject same-record stale edits', async (t) => {
  const f = await fixture(t),
    baseline = await f.read();
  assert.equal(baseline.partialWrites, true);
  const encrypted = f.store.db.prepare('SELECT value FROM patients WHERE id=?').get('shared').value;
  const [a, b] = baseline.patients;
  const results = await Promise.all([
    f.patch(0, a, { ...a, notes: 'First' }),
    f.patch(1, b, { ...b, notes: 'Second' }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  for (const result of results) {
    assert.equal(result.data.patients.length, 1);
    assert.deepEqual(result.data.services, []);
  }
  const fresh = await f.read(1);
  assert.deepEqual(
    fresh.patients.slice(0, 2).map((p) => p.notes),
    ['First', 'Second'],
  );
  assert.deepEqual(
    f.store.db.prepare('SELECT value FROM patients WHERE id=?').get('shared').value,
    encrypted,
  );
  const prior = fresh.patients[0];
  const competing = await Promise.all([
    f.patch(0, prior, { ...prior, notes: 'A' }),
    f.patch(1, prior, { ...prior, notes: 'B' }),
  ]);
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
});
test('separate staff histories on one client merge without exposing or overwriting another staff history', async (t) => {
  const f = await fixture(t),
    first = (await f.read(0, 1)).patients[0],
    second = (await f.read(1, 2)).patients[0];
  assert.equal(first.visits.length, 1);
  assert.equal(second.visits.length, 1);
  const append = (patient, user, id) => ({
    ...patient,
    visits: [
      ...patient.visits,
      { id, date: '2020-02-01', staffId: user.accountId, procedure: 'New synthetic', photos: [] },
    ],
  });
  const results = await Promise.all([
    f.patch(0, first, append(first, f.staff[0], 'new0'), 1),
    f.patch(1, second, append(second, f.staff[1], 'new1'), 2),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    [200, 200],
  );
  for (let i = 0; i < 2; i++)
    assert.ok(
      results[i].data.patients[0].visits.every((visit) => visit.staffId === f.staff[i].accountId),
    );
  assert.equal((await f.read()).patients.find((p) => p.id === 'shared').visits.length, 4);
  assert.equal((await f.patch(1, first, null, 1)).status, 409);
  const own = (await f.read(1, 1)).patients[0];
  assert.equal((await f.patch(1, own, null, 1)).status, 403);
  const invisible = { id: 'p1', name: 'Invented', visits: [], appointments: [] };
  assert.equal((await f.patch(1, null, invisible, 1)).status, 403);
  const body = {
    revision: 0,
    patients: [],
    services: [{ id: 's', before: null, after: { id: 's', name: 'Denied', price: 10 } }],
  };
  assert.equal(
    (await f.request(1, '/api/cabinet/changes', body, f.cookies[1], 'PATCH')).status,
    403,
  );
});
test('different records cannot double-book a shared room across server processes', async (t) => {
  const f = await fixture(t),
    config = {
      revision: 0,
      enabled: true,
      mode: 'shared',
      rooms: [
        {
          id: 'room',
          name: 'Test room',
          active: true,
          staffIds: f.staff.map((user) => user.accountId),
        },
      ],
    };
  assert.equal((await f.request(0, '/api/workspace', config, f.cookies[0])).status, 200);
  const patients = (await f.read()).patients;
  const add = (p, i) => ({
    ...p,
    appointments: [
      {
        id: 'booking' + i,
        date: '2030-01-01',
        time: '10:00',
        duration: 60,
        roomId: 'room',
        staffId: f.staff[i].accountId,
        service: 'Synthetic service',
      },
    ],
  });
  const results = await Promise.all([
    f.patch(0, patients[0], add(patients[0], 0)),
    f.patch(1, patients[1], add(patients[1], 1)),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await f.read()).patients.flatMap((p) => p.appointments).length, 1);
});
test('partial writes reject malformed operations and preserve owner-only deletion', async (t) => {
  const f = await fixture(t),
    p = (await f.read()).patients[0];
  for (const body of [
    { revision: 0, patients: [], services: [], unknown: true },
    { revision: 0, patients: [{ id: p.id, before: p }], services: [] },
    {
      revision: 0,
      patients: [
        { id: p.id, before: p, after: p },
        { id: p.id, before: p, after: p },
      ],
      services: [],
    },
  ])
    assert.equal(
      (await f.request(0, '/api/cabinet/changes', body, f.cookies[0], 'PATCH')).status,
      400,
    );
  assert.equal((await f.patch(0, p, null)).status, 200);
  assert.equal(
    (await f.read()).patients.some((patient) => patient.id === p.id),
    false,
  );
});
test('worker launcher shares one HTTP port, uses common authentication and rejects conflicting parallel writes', async (t) => {
  const f = await fixture(t, { clustered: true }),
    baseline = await f.read();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const p = baseline.patients[i % 2];
      return f.patch(i % 2, p, { ...p, notes: 'Synthetic ' + i });
    }),
  );
  assert.equal(results.filter((result) => result.status === 200).length, 2);
  assert.equal(results.filter((result) => result.status === 409).length, 18);
  assert.ok((await f.read()).patients.slice(0, 2).every((p) => p.notes.startsWith('Synthetic')));
});
test('partial photo writes normalize images and immediately deny deleted references', async (t) => {
  const f = await fixture(t),
    prior = (await f.read()).patients[0];
  const data =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
  const result = await f.patch(0, prior, {
    ...prior,
    visits: [{ id: 'photo-visit', date: '2020-01-01', procedure: 'Synthetic', photos: [{ data }] }],
  });
  assert.equal(result.status, 200);
  const p = result.data.patients[0],
    reference = p.visits[0].photos[0].data;
  assert.match(reference, /^\/api\/photos\/[a-f0-9]{32}$/);
  assert.equal(f.store.photo(reference.split('/').pop()).mime, 'image/png');
  assert.equal((await f.patch(1, p, { ...p, visits: [] })).status, 200);
  assert.throws(() => f.store.photo(reference.split('/').pop()), { status: 404 });
});
test('revocation during asynchronous photo decoding prevents partial commit and leaves no new photo files', async (t) => {
  const f = await fixture(t),
    { saveMutation } = require('../src/server/modules/cabinet/mutations.cjs');
  const token = f.cookies[0].split('=')[1],
    current = f.platform.session(token),
    prior = (await f.read()).patients[0];
  const data =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==';
  let resume, decoded;
  const ready = new Promise((resolve) => (decoded = resolve)),
    paused = new Promise((resolve) => (resume = resolve)),
    prepare = f.store.prepareImages;
  f.store.prepareImages = async (...args) => {
    const result = await prepare(...args);
    decoded();
    await paused;
    return result;
  };
  const assertCurrent = () => {
    if (!f.platform.session(token))
      throw Object.assign(Error('Synthetic revoked'), { status: 401 });
  };
  const body = {
    revision: 0,
    patients: [
      {
        id: prior.id,
        before: prior,
        after: { ...prior, visits: [{ id: 'new-photo', date: '2020-01-01', photos: [{ data }] }] },
      },
    ],
    services: [],
  };
  const pending = saveMutation(
    { current, platform: f.platform, tenantStore: () => f.store, token, assertCurrent },
    body,
    { partial: true },
  );
  await ready;
  f.platform.logout(token);
  resume();
  await assert.rejects(pending, { status: 401 });
  assert.equal(f.store.read().patients[0].visits.length, 0);
  assert.deepEqual(fs.readdirSync(f.store.photoDir), []);
});
