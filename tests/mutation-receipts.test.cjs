const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMultiServer } = require('../multi-server.cjs');
const { createPlatformStore } = require('../platform-store.cjs');
const { createStorage } = require('../storage.cjs');
const { fork } = require('node:child_process');
const { authContextHeaders } = require('./helpers/account-context.cjs');

test('durable operation receipts replay once, survive restart and never overwrite later changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-receipts-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'receipt@example.test',
    password: 'Synthetic-receipt-password',
    displayName: 'Test',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  platform.close();
  let server, base, cookie, expected;
  const start = async () => {
    server = createMultiServer({
      dataDir: dir,
      sendMail: null,
      telegramBot: null,
      telegramAutostart: false,
      supportAutostart: false,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + server.address().port;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, 'X-Cartoteca-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'receipt@example.test',
        password: 'Synthetic-receipt-password',
      }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    expected = authContextHeaders(await login.json());
  };
  t.after(async () => {
    if (server.listening) await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await start();
  const send = (route, body, id) =>
    fetch(base + route, {
      method: body ? 'PATCH' : 'GET',
      headers: {
        Origin: base,
        Cookie: cookie,
        ...expected,
        'X-Cartoteca-Request': '1',
        'Content-Type': 'application/json',
        ...(id ? { 'X-Cartoteca-Operation': id } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const png = await require('sharp')({
    create: { width: 2, height: 2, channels: 3, background: '#aabbcc' },
  })
    .png()
    .toBuffer();
  const patient = {
    id: 'p',
    name: 'Synthetic',
    createdBy: owner.accountId,
    visits: [
      {
        id: 'photo-visit',
        date: '2020-01-01',
        procedure: 'Synthetic',
        staffId: owner.accountId,
        photos: [{ data: 'data:image/png;base64,' + png.toString('base64') }],
      },
    ],
    appointments: [],
  };
  const body = { revision: 0, patients: [{ id: 'p', before: null, after: patient }], services: [] };
  const id = 'synthetic-operation-create-1';
  const results = await Promise.all([
    send('/api/cabinet/changes', body, id),
    send('/api/cabinet/changes', body, id),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  const saved = await results[0].json();
  assert.equal(saved.revision, 1);
  const photo = saved.patients[0].visits[0].photos[0].data;
  assert.match(photo, /^\/api\/photos\/[a-f0-9]{32}$/);
  const receipt = await (await send('/api/cabinet/operation?id=' + id)).json();
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.result.patients.length, 1);
  assert.equal(receipt.result.patients[0].visits[0].photos[0].data, photo);
  assert.equal((await send('/api/cabinet/changes', { ...body, revision: 1 }, id)).status, 409);
  assert.equal((await send('/api/cabinet/changes', body, 'short')).status, 400);
  assert.equal(
    (await (await send('/api/cabinet/operation?id=unknown-operation-12345')).json()).status,
    'unknown',
  );
  assert.equal((await fetch(base + '/api/cabinet/operation?id=' + id)).status, 401);
  await new Promise((r) => server.close(r));
  await start();
  assert.equal((await send('/api/cabinet/changes', body, id)).status, 200);
  const current = (await (await send('/api/cabinet/patient?id=p')).json()).patients[0];
  const second = {
    revision: 1,
    patients: [{ id: 'p', before: current, after: { ...current, notes: 'Later update' } }],
    services: [],
  };
  assert.equal(
    (await send('/api/cabinet/changes', second, 'synthetic-operation-edit-2')).status,
    200,
  );
  assert.equal((await send('/api/cabinet/changes', body, id)).status, 409);
  assert.equal((await (await send('/api/cabinet/operation?id=' + id)).json()).status, 'unknown');
  const compact = await (await send('/api/cabinet/operation?id=' + id + '&statusOnly=1')).json();
  assert.equal(compact.status, 'committed');
  assert.equal(compact.revision, 1);
  assert.doesNotMatch(JSON.stringify(compact), /patients|services|Synthetic|photos/);
  const final = await (await send('/api/cabinet/patient?id=p')).json();
  assert.equal(final.revision, 2);
  assert.equal(final.patients[0].notes, 'Later update');
  const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  try {
    assert.equal(storage.db.prepare('SELECT COUNT(*) n FROM photos WHERE active=1').get().n, 1);
    assert.doesNotMatch(
      storage.db
        .prepare("SELECT hex(value) data FROM meta WHERE key LIKE 'mutation-operation:%'")
        .all()
        .map((r) => r.data)
        .join(''),
      /Synthetic/,
    );
    const { readReceipt } = require('../src/server/infrastructure/mutation-receipts.cjs');
    assert.equal(
      readReceipt(
        storage,
        { accountId: 'other', role: 'owner', organizationId: owner.organizationId },
        'synthetic-operation-edit-2',
      ),
      null,
    );
    assert.equal(
      readReceipt(
        storage,
        { accountId: owner.accountId, role: 'cosmetologist', organizationId: owner.organizationId },
        'synthetic-operation-edit-2',
      ),
      null,
    );
  } finally {
    storage.close();
  }
});

test('receipt retention is bounded, rolls back atomically and removes copies after legacy deletion', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-receipt-retention-'));
  const storage = createStorage(dir);
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const {
    writeReceipt,
    readReceipt,
  } = require('../src/server/infrastructure/mutation-receipts.cjs');
  const user = { accountId: 'owner', role: 'owner', organizationId: 'org' };
  const patients = Array.from({ length: 131 }, (_, i) => ({
    id: 'p' + i,
    name: 'Synthetic ' + i,
    visits: [],
    appointments: [],
  }));
  storage.write({ revision: 0, patients, services: [] });
  const body = (p) => ({
    revision: 0,
    patients: [{ id: p.id, before: null, after: p }],
    services: [],
  });
  const saved = (p) => ({ revision: 1, patients: [p], services: [], initialized: true });
  const identity = (i) => ({ id: 'synthetic-retention-' + i, hash: 'hash' + i });
  for (let i = 0; i < patients.length; i++)
    storage.transaction(() =>
      writeReceipt(storage, user, identity(i), saved(patients[i]), body(patients[i]), true),
    );
  assert.equal(storage.get('mutation-operation-index').length, 128);
  assert.equal(readReceipt(storage, user, identity(0).id), null);
  assert.ok(readReceipt(storage, user, identity(130).id));
  assert.throws(
    () =>
      storage.transaction(() => {
        writeReceipt(
          storage,
          user,
          identity('rollback'),
          saved(patients[130]),
          body(patients[130]),
          true,
        );
        throw Error('Synthetic rollback');
      }),
    /rollback/,
  );
  assert.equal(readReceipt(storage, user, identity('rollback').id), null);
  assert.ok(readReceipt(storage, user, identity(130).id));
  const deleted = {
    revision: 1,
    patients: [{ id: 'p130', before: patients[130], after: null }],
    services: [],
  };
  storage.transaction(() => {
    const result = storage.write(
      { revision: 1, patients: [], services: [] },
      { changedIds: { patients: ['p130'], services: [] }, insideTransaction: true },
    );
    writeReceipt(storage, user, null, result, deleted, true);
  });
  assert.equal(readReceipt(storage, user, identity(130).id), null);
  assert.equal(storage.get('mutation-operation-index').length, 127);
  const tooLarge = { ...saved(patients[0]), extra: 'x'.repeat(1024 * 1024) };
  storage.transaction(() =>
    writeReceipt(storage, user, identity('large'), tooLarge, body(patients[0]), true),
  );
  assert.equal(readReceipt(storage, user, identity('large').id), null);
});

test('independent workers deduplicate one operation and its receipt survives a hard process crash', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-operation-crash-'));
  const platform = createPlatformStore(path.join(dir, 'platform'));
  const owner = await platform.registerOwner({
    email: 'crash@example.test',
    password: 'Synthetic-crash-password',
    displayName: 'Test',
    organizationName: 'Test',
  });
  platform.verifyEmail(owner.verificationToken);
  const login = await platform.login('crash@example.test', 'Synthetic-crash-password');
  platform.close();
  const children = [],
    diagnostics = [];
  const spawn = async () => {
    const child = fork(path.join(__dirname, 'helpers/process-server.cjs'), [dir], {
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_SUPPORT_BOT_TOKEN: '',
        SMTP_HOST: '',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    child.on('message', (message) => {
      if (message.diagnostic) diagnostics.push(message.diagnostic);
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error('Synthetic worker startup timeout'));
      }, 10000);
      child.once('message', (m) => {
        clearTimeout(timer);
        resolve(m.port);
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    return { child, base: 'http://127.0.0.1:' + port };
  };
  t.after(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', resolve);
            child.send('stop');
          }),
      ),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const first = await spawn(),
    second = await spawn();
  const id = 'synthetic-cross-worker-operation';
  const body = {
    revision: 0,
    patients: [
      {
        id: 'p',
        before: null,
        after: {
          id: 'p',
          name: 'Synthetic',
          createdBy: owner.accountId,
          visits: [],
          appointments: [],
        },
      },
    ],
    services: [],
  };
  const send = (worker, route, values) =>
    fetch(worker.base + route, {
      method: values ? 'PATCH' : 'GET',
      headers: {
        Origin: worker.base,
        Cookie: 'cartoteca_v2_session=' + login.token,
        ...authContextHeaders(login),
        'Content-Type': 'application/json',
        'X-Cartoteca-Request': '1',
        'X-Cartoteca-Operation': id,
      },
      body: values ? JSON.stringify(values) : undefined,
    });
  const results = await Promise.all([
    send(first, '/api/cabinet/changes', body),
    send(second, '/api/cabinet/changes', body),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
    JSON.stringify(diagnostics),
  );
  await Promise.all(results.map((r) => r.json()));
  await new Promise((resolve) => {
    first.child.once('exit', resolve);
    first.child.kill('SIGKILL');
  });
  const replacement = await spawn();
  const receipt = await (await send(replacement, '/api/cabinet/operation?id=' + id)).json();
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.result.revision, 1);
  assert.equal((await send(replacement, '/api/cabinet/changes', body)).status, 200);
  const storage = createStorage(path.join(dir, 'tenants', owner.organizationId));
  try {
    assert.equal(storage.read().patients.length, 1);
    assert.equal(storage.get('revision'), 1);
    assert.equal(storage.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    storage.close();
  }
});
