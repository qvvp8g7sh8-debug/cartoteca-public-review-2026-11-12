const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStorage } = require('../src/server/infrastructure/cabinet-storage.cjs');
const { readCabinetSnapshot } = require('../src/server/infrastructure/cabinet-read-snapshot.cjs');
const { writeReceipt } = require('../src/server/infrastructure/mutation-receipts.cjs');
const { routes } = require('../src/server/modules/cabinet/routes.cjs');
const {
  currentSuggestedClients,
} = require('../src/server/modules/assistant/language/names/name-directory.cjs');
const {
  correlatedClientMatches,
} = require('../src/server/modules/assistant/language/names/name-correlated-directory.cjs');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'cartoteca-pure-read131-'));
  const storage = createStorage(directory);
  t.after(() => {
    storage.close();
    assert.equal(path.dirname(directory), parent);
    assert.equal(fs.realpathSync(directory), directory);
    assert.ok(path.basename(directory).startsWith('cartoteca-pure-read131-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const current = {
    accountId: 'owner',
    organizationId: 'synthetic-org',
    role: 'owner',
    sessionId: randomUUID(),
  };
  const patient = {
    id: 'visible',
    firstName: 'Anna',
    lastName: 'Ivanova',
    name: 'Anna Ivanova',
    createdBy: 'owner',
    visits: [],
    appointments: [],
  };
  const saved = storage.write({ revision: 0, patients: [patient], services: [] });
  const identity = { id: randomUUID(), hash: 'synthetic-body-identity' };
  storage.transaction(() =>
    writeReceipt(
      storage,
      current,
      identity,
      saved,
      { patients: [{ id: patient.id, before: null, after: patient }], services: [] },
      true,
    ),
  );
  let snapshots = 0;
  const original = storage.readOnlySnapshot;
  storage.readOnlySnapshot = (read) => {
    snapshots++;
    storage.db.exec('PRAGMA query_only=ON');
    try {
      return original(read);
    } finally {
      storage.db.exec('PRAGMA query_only=OFF');
    }
  };
  return { storage, current, patient, identity, snapshots: () => snapshots };
}
async function operation(f, suffix = '', actor = f.current, assertCurrent = () => {}) {
  let result;
  const route = routes.find((r) => r.path === '/api/cabinet/operation' && r.method === 'GET');
  await route.handle({
    current: actor,
    tenantStore: (org) => {
      assert.equal(org, actor.organizationId);
      return f.storage;
    },
    url: new URL('http://synthetic.invalid/api/cabinet/operation?id=' + f.identity.id + suffix),
    assertCurrent,
    appointmentState: { decorate: (value) => value },
    res: {},
    json(_res, status, body) {
      result = { status, body };
    },
  });
  return result;
}

test('pure snapshot selects native read-only authority and legacy fallback remains DEFERRED', () => {
  let calls = 0;
  const value = {};
  assert.equal(
    readCabinetSnapshot(
      {
        readOnlySnapshot(read) {
          calls++;
          return read();
        },
        transaction() {
          assert.fail('Do not fall back when read-only authority exists');
        },
      },
      () => value,
    ),
    value,
  );
  assert.equal(calls, 1);
  assert.equal(
    readCabinetSnapshot(
      {
        transaction(read, mode) {
          assert.equal(mode, 'DEFERRED');
          return read();
        },
      },
      () => value,
    ),
    value,
  );
  const failure = Error('Synthetic unavailable snapshot');
  assert.throws(
    () =>
      readCabinetSnapshot(
        {
          readOnlySnapshot() {
            throw failure;
          },
          transaction() {
            assert.fail('A failed read-only snapshot must not retry under a stronger mode');
          },
        },
        () => value,
      ),
    (error) => error === failure,
  );
});

test('operation receipt and compact status are pure, retain actor scope and never rewrite expiry', async (t) => {
  const f = fixture(t);
  const before = f.storage.db.prepare('SELECT key,hex(value) value FROM meta ORDER BY key').all();
  let guards = 0;
  const full = await operation(f, '', f.current, () => guards++);
  assert.equal(full.status, 200);
  assert.equal(full.body.status, 'committed');
  assert.equal(full.body.result.patients[0].id, f.patient.id);
  const compact = await operation(f, '&statusOnly=1', f.current, () => guards++);
  assert.equal(compact.body.status, 'committed');
  assert.doesNotMatch(JSON.stringify(compact.body), /Anna|Ivanova|patients|services/);
  for (const actor of [
    { ...f.current, accountId: 'other' },
    { ...f.current, role: 'cosmetologist' },
    { ...f.current, organizationId: 'foreign-org' },
  ])
    assert.deepEqual((await operation(f, '', actor)).body, { status: 'unknown' });
  assert.equal(guards, 2);
  assert.equal(f.snapshots(), 5);
  assert.deepEqual(
    f.storage.db.prepare('SELECT key,hex(value) value FROM meta ORDER BY key').all(),
    before,
  );
  const key = before.find(
    (row) => row.key.startsWith('mutation-operation:') && !row.key.endsWith(':committed'),
  ).key;
  f.storage.set(key, { ...f.storage.get(key), expires: 0 });
  const expired = f.storage.db.prepare('SELECT key,hex(value) value FROM meta ORDER BY key').all();
  assert.deepEqual((await operation(f)).body, { status: 'unknown' });
  assert.deepEqual(
    f.storage.db.prepare('SELECT key,hex(value) value FROM meta ORDER BY key').all(),
    expired,
  );
});

test('operation snapshot preserves fresh denial and conflicts with changed clinical data', async (t) => {
  const f = fixture(t);
  const denied = Object.assign(Error('Synthetic revoked account'), { status: 401 });
  await assert.rejects(
    operation(f, '', f.current, () => {
      throw denied;
    }),
    (error) => error === denied,
  );
  const state = f.storage.read();
  state.patients[0].notes = 'Synthetic later change';
  f.storage.write(state);
  await assert.rejects(operation(f), { status: 409 });
  assert.equal((await operation(f, '&statusOnly=1')).body.status, 'committed');
  assert.equal(f.storage.read().patients[0].notes, 'Synthetic later change');
});

test('name selection and whole-name correlation use pure summaries with fresh revocation guards', (t) => {
  const f = fixture(t);
  const context = { current: f.current, assertCurrent() {}, tenantStore: () => f.storage };
  const before = f.storage.read();
  assert.deepEqual(
    currentSuggestedClients(context, [f.patient.id, 'missing']).map((p) => p.id),
    [f.patient.id],
  );
  assert.deepEqual(
    correlatedClientMatches(context, 'Anna Ivanova').matches.map((p) => p.id),
    [f.patient.id],
  );
  assert.equal(f.snapshots(), 2);
  assert.deepEqual(f.storage.read(), before);
  let revoked = false;
  const original = f.storage.indexes.summaryRows;
  f.storage.indexes.summaryRows = (...args) => {
    const rows = original(...args);
    revoked = true;
    return rows;
  };
  context.assertCurrent = () => {
    if (revoked) throw Object.assign(Error('Synthetic revoked summary'), { status: 401 });
  };
  assert.throws(() => currentSuggestedClients(context, [f.patient.id]), { status: 401 });
  assert.deepEqual(f.storage.read(), before);
});

test('pure snapshot cannot silently write or retry when its authority rejects a write', (t) => {
  const f = fixture(t);
  assert.throws(
    () => readCabinetSnapshot(f.storage, () => f.storage.set('accidental-write', true)),
    /readonly|read-only/i,
  );
  assert.equal(f.storage.get('accidental-write'), null);
});
