const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStorage } = require('../storage.cjs');
const {
  writeReceipt,
  readOperationStatus,
  readOperationStatusAsync,
} = require('../src/server/infrastructure/mutation-receipts.cjs');

const actor = { accountId: 'owner', organizationId: 'synthetic', role: 'owner' };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-status148-')),
    storage = createStorage(dir),
    patient = { id: 'p', name: 'Synthetic', visits: [], appointments: [] },
    body = { patients: [{ id: 'p', before: null, after: patient }], services: [] },
    saved = { revision: 1, patients: [patient], services: [] };
  t.after(() => {
    storage.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('cartoteca-status148-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  storage.write({ revision: 0, patients: [patient], services: [] });
  const write = (id, revision = 1, rollback = false) =>
    storage.transaction(() => {
      writeReceipt(storage, actor, { id, hash: 'synthetic' }, { ...saved, revision }, body, true);
      if (rollback) throw Error('rollback');
    });
  const fetches = [],
    ready = new Set(),
    asyncStorage = {
      async prefetchMeta(keys) {
        fetches.push(...keys);
        keys.forEach((key) => ready.add(key));
      },
      get(key) {
        assert.ok(ready.has(key), 'no unprepared SQL fallback');
        return storage.get(key);
      },
    };
  return { storage, write, asyncStorage, fetches };
}

test('async status confirms a superseded replay using only its compact proof', async (t) => {
  const f = fixture(t),
    id = 'synthetic-status148-original';
  f.write(id);
  f.write('synthetic-status148-later', 2);
  const result = await readOperationStatusAsync(f.asyncStorage, actor, id);
  assert.deepEqual(result, readOperationStatus(f.storage, actor, id));
  assert.equal(result.status, 'committed');
  assert.equal(result.revision, 1);
  assert.equal(f.fetches.length, 1);
  assert.match(f.fetches[0], /:committed$/);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic|patients|appointments/);
  for (const other of [
    { ...actor, accountId: 'other' },
    { ...actor, organizationId: 'other' },
    { ...actor, role: 'salon_admin' },
  ])
    assert.deepEqual(await readOperationStatusAsync(f.asyncStorage, other, id), {
      status: 'unknown',
    });
});

test('async status preserves legacy receipts, expiry and rollback as unknown', async (t) => {
  const f = fixture(t),
    id = 'synthetic-status148-legacy';
  f.write(id);
  const proofKey = f.storage.get('mutation-outcome-index').at(-1).key,
    receiptKey = proofKey.replace(/:committed$/, '');
  f.storage.db.prepare('DELETE FROM meta WHERE key=?').run(proofKey);
  assert.deepEqual(await readOperationStatusAsync(f.asyncStorage, actor, id), {
    status: 'committed',
    revision: 1,
  });
  assert.deepEqual(f.fetches, [proofKey, receiptKey]);
  f.storage.set(receiptKey, { ...f.storage.get(receiptKey), expires: 0 });
  assert.deepEqual(await readOperationStatusAsync(f.asyncStorage, actor, id), {
    status: 'unknown',
  });
  const rollback = 'synthetic-status148-rollback';
  assert.throws(() => f.write(rollback, 1, true), /rollback/);
  assert.deepEqual(await readOperationStatusAsync(f.asyncStorage, actor, rollback), {
    status: 'unknown',
  });
});

test('async status propagates a failed read once without a fallback or write', async () => {
  let calls = 0;
  await assert.rejects(
    readOperationStatusAsync(
      {
        async prefetchMeta() {
          calls++;
          throw Object.assign(Error('synthetic PG failure'), { code: 'SYNTHETIC_PG_FAILURE' });
        },
        get: () => assert.fail('failed prefetch must not read a cache'),
      },
      actor,
      'synthetic-status148-failure',
    ),
    { code: 'SYNTHETIC_PG_FAILURE' },
  );
  assert.equal(calls, 1);
});
