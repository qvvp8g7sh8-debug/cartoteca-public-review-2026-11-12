const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage.cjs');
const {
  writeReceipt,
  readReceipt,
  readOperationStatus,
} = require('../src/server/infrastructure/mutation-receipts.cjs');
const { routes } = require('../src/server/modules/cabinet/routes.cjs');

const user = { accountId: 'owner', organizationId: 'synthetic', role: 'owner' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-outcomes121-')),
    storage = createStorage(dir),
    patient = { id: 'p', name: 'Synthetic', visits: [], appointments: [] };
  t.after(() => {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  storage.write({ revision: 0, patients: [patient], services: [] });
  const body = { patients: [{ id: 'p', before: null, after: patient }], services: [] },
    saved = { revision: 1, patients: [patient], services: [] };
  const write = (id, value = saved) =>
    storage.transaction(() =>
      writeReceipt(storage, user, { id, hash: 'same-hash' }, value, body, true),
    );
  return { storage, body, saved, write };
}

test('compact commit proof survives a superseded replay without retaining clinical copies', (t) => {
  const f = fixture(t),
    id = 'synthetic-outcome-original';
  f.write(id);
  f.write('synthetic-outcome-later', { ...f.saved, revision: 2 });
  assert.equal(readReceipt(f.storage, user, id), null);
  const proof = readOperationStatus(f.storage, user, id);
  assert.equal(proof.status, 'committed');
  assert.equal(proof.revision, 1);
  assert.ok(Number.isSafeInteger(proof.committedAt));
  assert.throws(() => readReceipt(f.storage, user, id, 'same-hash'), { status: 409 });
  assert.throws(() => readReceipt(f.storage, user, id, 'different-hash'), { status: 409 });
  const index = f.storage.get('mutation-outcome-index');
  const stored = f.storage.get(index[0].key);
  assert.deepEqual(Object.keys(stored).sort(), ['committedAt', 'expires', 'hash', 'revision']);
  assert.doesNotMatch(JSON.stringify(stored), /Synthetic|patients|services|"p"/);
  for (const scope of [
    { ...user, accountId: 'another' },
    { ...user, organizationId: 'another' },
    { ...user, role: 'salon_admin' },
  ])
    assert.deepEqual(readOperationStatus(f.storage, scope, id), { status: 'unknown' });
});

test('oversized replay still has an atomic compact proof; rollback never creates a proof', (t) => {
  const f = fixture(t),
    id = 'synthetic-outcome-oversized';
  f.write(id, { ...f.saved, extra: 'x'.repeat(1024 * 1024) });
  assert.equal(readReceipt(f.storage, user, id), null);
  assert.equal(readOperationStatus(f.storage, user, id).status, 'committed');
  assert.throws(() => readReceipt(f.storage, user, id, 'same-hash'), { status: 409 });
  assert.throws(() =>
    f.storage.transaction(() => {
      writeReceipt(
        f.storage,
        user,
        { id: 'synthetic-outcome-rollback', hash: 'hash' },
        f.saved,
        f.body,
        true,
      );
      throw Error('synthetic rollback');
    }),
  );
  assert.deepEqual(readOperationStatus(f.storage, user, 'synthetic-outcome-rollback'), {
    status: 'unknown',
  });
  assert.equal(readOperationStatus(f.storage, user, id).status, 'committed');
});

test('compact history is bounded and expiration or eviction means unknown, never not committed', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 513; i++) f.write('synthetic-outcome-bound-' + i);
  assert.equal(f.storage.get('mutation-outcome-index').length, 512);
  assert.deepEqual(readOperationStatus(f.storage, user, 'synthetic-outcome-bound-0'), {
    status: 'unknown',
  });
  assert.equal(
    readOperationStatus(f.storage, user, 'synthetic-outcome-bound-512').status,
    'committed',
  );
  const index = f.storage.get('mutation-outcome-index'),
    key = index.at(-1).key;
  f.storage.set(key, { ...f.storage.get(key), expires: 0 });
  // Remove its replay too: expired compact proof cannot assert a negative result.
  f.storage.db.prepare('DELETE FROM meta WHERE key=?').run(key.replace(/:committed$/, ''));
  assert.deepEqual(readOperationStatus(f.storage, user, 'synthetic-outcome-bound-512'), {
    status: 'unknown',
  });
});

test('lightweight status uses fresh scope and point metadata only, with legacy fallback', async () => {
  const route = routes.find((row) => row.path === '/api/cabinet/operation'),
    keys = [],
    storage = {
      transaction: (run) => run(),
      get: (key) => {
        keys.push(key);
        return key.endsWith(':committed')
          ? null
          : { expires: Date.now() + 10000, saved: { revision: 7 } };
      },
      read: () => assert.fail('status must not read a cabinet'),
      readSelected: () => assert.fail('status must not read clinical rows'),
    };
  let asserted = 0;
  const context = {
    url: new URL(
      'http://synthetic/api/cabinet/operation?id=synthetic-operation-lightweight&statusOnly=1',
    ),
    current: user,
    tenantStore: () => storage,
    assertCurrent: () => {
      asserted++;
      return user;
    },
    appointmentState: { decorate: () => assert.fail('metadata must not decorate appointments') },
    json: (res, status, body) => ({ status, body }),
  };
  assert.deepEqual(await route.handle(context), {
    status: 200,
    body: { status: 'committed', revision: 7 },
  });
  assert.equal(asserted, 1);
  assert.equal(keys.length, 2);
  context.assertCurrent = () => {
    asserted++;
  };
  assert.deepEqual(await route.handle(context), {
    status: 200,
    body: { status: 'committed', revision: 7 },
  });
  assert.equal(asserted, 2, 'assertCurrent also supports an assertion-only bridge');
  keys.length = 0;
  context.assertCurrent = () => {
    throw Object.assign(Error('revoked'), { status: 403 });
  };
  await assert.rejects(async () => route.handle(context), { status: 403 });
  assert.equal(keys.length, 0);
});
