const test = require('node:test');
const assert = require('node:assert/strict');
const {
  patientCapsuleBound197,
} = require('../src/server/infrastructure/postgres/patient-capsule-bound197.cjs');
const {
  validatePatientOperation197,
} = require('../src/server/infrastructure/postgres/patient-capsule-context197.cjs');

const scope = { kind: 'cabinet', storeId: 'one' };
const sources = [
  { scope, catalog: { version: 2 }, table: 'patients', where: 's.id=$2', values: ['p'] },
];
const packet = () => ({
  supported: true,
  patientPageEmpty165: true,
  sources: [{ source: 0, rows: 1, bytes: 1024, witness: 'a'.repeat(64) }],
  rows: [{ bucket: 'profile', id: 'p', value: Buffer.alloc(512) }],
});
test('197 admission counts owned packet and retains exact source proof', () => {
  const value = patientCapsuleBound197(packet(), sources);
  assert.equal(value.proofs[0].source, sources[0]);
  assert.equal(value.bound.sourceBounds.get('cabinet:patients').bytes, 1024);
  assert.match(value.bound.clinicalWitness, /^[a-f0-9]{64}$/);
  assert.equal(value.bound.patientPageEmpty165, true);
  assert.equal(value.byteLimit, 65536);
  assert.ok(value.retainedBytes > 512);
});
test('197 only metadata decline can choose the prior reader', () => {
  assert.equal(patientCapsuleBound197({ ...packet(), supported: false, rows: [] }, sources), null);
  assert.throws(() => patientCapsuleBound197({ ...packet(), supported: false }, sources), {
    code: 'POSTGRES_PATIENT_CAPSULE_BOUND197',
  });
});
test('197 rejects underadmitted or incomplete packets before projection', () => {
  for (const alter of [
    (p) => (p.sources[0].bytes = 65537),
    (p) => (p.sources[0].rows = 20001),
    (p) => (p.sources[0].source = 1),
    (p) => p.sources.pop(),
    (p) => (p.rows = Array(200).fill({})),
  ]) {
    const p = packet();
    alter(p);
    assert.throws(() => patientCapsuleBound197(p, sources), {
      code: 'POSTGRES_PATIENT_CAPSULE_BOUND197',
    });
  }
});
test('197 authority body decoding is deferred to fresh asset acceptance', () => {
  assert.doesNotThrow(() => validatePatientOperation197({}, {}, {}));
  let decoded = 0;
  assert.throws(
    () =>
      validatePatientOperation197(
        { patientCapsuleAuthority197: [{ fence_locked: false }] },
        {
          platformDecode197() {
            decoded++;
          },
        },
        { sessionId: 's' },
      ),
    { code: 'POSTGRES_BUSY' },
  );
  assert.equal(decoded, 0);
  assert.throws(
    () =>
      validatePatientOperation197(
        { patientCapsuleAuthority197: [{ fence_locked: true, id: null }] },
        {
          platformDecode197() {
            decoded++;
          },
        },
        { sessionId: 's' },
      ),
    { status: 401 },
  );
  assert.equal(decoded, 0);
});
