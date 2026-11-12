const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHmac, createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const {
  preparePatientOperation197,
  validatePatientOperation197,
} = require('../src/server/infrastructure/postgres/patient-capsule-context197.cjs');
const {
  preparePatientCapsule197,
} = require('../src/server/infrastructure/postgres/read-patient-capsule197.cjs');
const { catalog197 } = require('../src/server/infrastructure/postgres/patient-capsule-plan197.cjs');

const accountId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const sessionId = '00000000-0000-4000-8000-000000000003';
const current198 = (role = 'owner') => ({
  accountId,
  organizationId,
  sessionId,
  role,
  globalAdmin: false,
  expiresAt: 2000000000000,
});
function cipher198() {
  const key = Buffer.alloc(32, 17),
    counters = { hash: 0, decode: 0 };
  return {
    counters,
    hash(value) {
      counters.hash++;
      return createHmac('sha256', key).update(value).digest('hex');
    },
    encode(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decode(value) {
      counters.decode++;
      const input = Buffer.from(value),
        cipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
      cipher.setAuthTag(input.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]).toString(),
      );
    },
  };
}
function fixture198({
  current = current198(),
  catalog = catalog197,
  assertActive = () => {},
} = {}) {
  const crypto = cipher198(),
    counts = { keyChecks: 0, catalogs: 0 };
  const scope = { kind: 'cabinet', storeId: organizationId, organizationId };
  const config = { dataDir: path.resolve('synthetic-assets198') },
    relativeDirectory = 'tenants/' + organizationId;
  const token = 'synthetic198-session-token';
  return {
    counts,
    crypto,
    current,
    token,
    prepare(target) {
      const url = new URL(target, 'http://localhost');
      return preparePatientOperation197({
        engine: {
          patientCapsuleCatalog197(value) {
            counts.catalogs++;
            assert.equal(value, scope);
            return catalog;
          },
        },
        scope,
        current,
        token,
        url,
        config,
        relativeDirectory,
        assertActive,
        keyCache: {
          async forOperation(directory, check) {
            counts.keyChecks++;
            assert.equal(directory, path.resolve(config.dataDir, relativeDirectory));
            check();
            return { cabinet: crypto, platform: crypto };
          },
        },
      });
    },
  };
}
const routes198 = [
  '/api/cabinet/patient?id=synthetic-patient&view=card',
  '/api/cabinet/patient/history?id=synthetic-patient',
  '/api/cabinet/patient/upcoming?id=synthetic-patient',
  '/api/cabinet/patient?id=synthetic-patient&view=appointment&appointmentId=synthetic-appointment',
];

test('198 owner/admin first point selections match canonical keyed semantics without touching the key cache', async () => {
  for (const role of ['owner', 'salon_admin'])
    for (const target of routes198) {
      const f = fixture198({ current: current198(role) });
      const expected = preparePatientCapsule197({
        url: new URL(target, 'http://localhost'),
        current: f.current,
        crypto: cipher198(),
        catalog: catalog197,
      });
      const result = await f.prepare(target);
      assert.deepEqual(result.selection, expected);
      assert.equal(result.current, f.current);
      assert.equal(result.token, f.token);
      assert.equal(f.counts.keyChecks, 0);
      assert.equal(f.crypto.counters.hash, 0);
      assert.equal(f.crypto.counters.decode, 0);
      assert.equal(f.counts.catalogs, 1);
    }
});
test('198 staff still checks current cabinet assets and derives its real keyed audience', async () => {
  for (const target of routes198) {
    const f = fixture198({ current: current198('cosmetologist') });
    const next = await f.prepare(target);
    assert.equal(f.counts.keyChecks, 1);
    assert.equal(next.selection.audience, cipher198().hash('staff:' + accountId));
    assert.ok(f.crypto.counters.hash >= 1);
  }
});
test('198 genuine encrypted history cursor retains key check, positions, mode and session scope validation', async () => {
  const f = fixture198(),
    crypto = f.crypto;
  const identity = crypto.hash(
    JSON.stringify([
      'patient-page145',
      organizationId,
      accountId,
      sessionId,
      'owner',
      'synthetic-patient',
      'history',
    ]),
  );
  const cursor = crypto
    .encode({ scope: identity, mode: 'history', revision: 7, visit: 51, outcome: 3, upcoming: 0 })
    .toString('base64url');
  const target = '/api/cabinet/patient/history?id=synthetic-patient&cursor=' + cursor;
  const next = await f.prepare(target);
  assert.equal(f.counts.keyChecks, 1);
  assert.equal(crypto.counters.decode, 1);
  assert.deepEqual(next.selection.cursor, { visit: 51, outcome: 3, upcoming: 0 });
  const foreign = fixture198({
    current: { ...current198(), sessionId: '00000000-0000-4000-8000-000000000004' },
  });
  await assert.rejects(foreign.prepare(target), (e) => e.status === 400);
  assert.equal(foreign.counts.keyChecks, 1);
  assert.equal(foreign.crypto.counters.decode, 1);
  await assert.rejects(
    f.prepare(target.replace('/history?', '/upcoming?')),
    (e) => e.status === 400,
  );
});
test('198 malformed/data-URI cursors cannot become an unkeyed first page', async () => {
  for (const cursor of ['data:application/json;base64,e30=', '@@invalid@@']) {
    const f = fixture198();
    await assert.rejects(
      f.prepare(
        '/api/cabinet/patient/history?id=synthetic-patient&cursor=' + encodeURIComponent(cursor),
      ),
      (e) => e.status === 400,
    );
    assert.equal(f.counts.keyChecks, 1);
    assert.equal(f.crypto.counters.decode, 0);
  }
});
test('198 invalid identifiers and missing session context preserve canonical errors', async () => {
  for (const target of [
    '/api/cabinet/patient?view=card',
    '/api/cabinet/patient/history?id=' + 'x'.repeat(121),
    '/api/cabinet/patient?id=synthetic-patient&view=appointment',
  ]) {
    const f = fixture198();
    await assert.rejects(f.prepare(target), (e) => e.status === 400);
    assert.equal(f.counts.keyChecks, 0);
  }
  for (const field of ['accountId', 'organizationId', 'sessionId']) {
    const current = current198();
    delete current[field];
    const f = fixture198({ current });
    await assert.rejects(f.prepare(routes198[0]), (e) => e.status === 403);
  }
});
test('198 incompatible capabilities and unsupported routes keep the original fallback without new asset work', async () => {
  for (const target of [
    '/api/cabinet/calendar',
    '/api/cabinet/patient?id=synthetic-patient',
    '/api/cabinet/patient?id=synthetic-patient&view=appointment&appointmentId=a&details=1',
  ]) {
    const f = fixture198();
    assert.equal(await f.prepare(target), null);
    assert.equal(f.counts.keyChecks, 0);
  }
  const absent = fixture198({ catalog: null });
  assert.equal(await absent.prepare(routes198[0]), null);
  assert.equal(absent.counts.keyChecks, 0);
  const partial = fixture198({ catalog: { version: 2, tables: { cabinet_history_entries: {} } } });
  await assert.rejects(partial.prepare(routes198[0]), (e) => e.status === 503);
});
test('198 no-assets branch still enforces cancellation and the separate fresh SQL-authority acceptance', async () => {
  const cancelled = Object.assign(Error('Synthetic cancelled'), { status: 499 });
  const f = fixture198({
    assertActive() {
      throw cancelled;
    },
  });
  await assert.rejects(f.prepare(routes198[0]), (e) => e === cancelled);
  assert.equal(f.counts.keyChecks, 0);
  let decoded = 0;
  const current = current198();
  const row = {
    fence_locked: true,
    id: sessionId,
    account_id: accountId,
    organization_id: organizationId,
    expires_at: Date.now() + 60000,
    global_admin: 0,
    account_status: 'active',
    membership_role: 'owner',
    membership_status: 'active',
    organization_status: 'active',
    account_value: Buffer.from('synthetic account'),
    session_value: Buffer.from('synthetic session'),
  };
  const prepared = {
    platformDecode197(value) {
      decoded++;
      assert.equal(value, row.account_value);
      return { displayName: 'Synthetic', email: 'synthetic@invalid.test' };
    },
  };
  const operation = { patientCapsuleAuthority197: [row], assertActive() {} };
  validatePatientOperation197(operation, prepared, current);
  assert.equal(decoded, 1);
  row.membership_status = 'revoked';
  assert.throws(
    () => validatePatientOperation197(operation, prepared, current),
    (e) => [401, 403].includes(e.status),
  );
  assert.equal(decoded, 1);
});
