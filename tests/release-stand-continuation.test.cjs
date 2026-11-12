const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  validateContinuation,
  writeAggregate,
  identity,
  pins,
  helperOverlay,
  scenarios,
} = require('../scripts/release/stand-continuation.cjs');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = (value) => Buffer.from(JSON.stringify(value));
const timings = (names) => names.map((stage) => ({ stage, status: 'passed', durationMs: 1 }));
function fixture() {
  const base = {
    schema: 17,
    readBudgetVersion: 1,
    bookingLinksVersion: 1,
    personalReservationsPreserved: true,
    noSqlMigration: true,
    noDataRollback: true,
  };
  const original = {
    candidate: identity.candidate,
    sourceHash: identity.sourceHash,
    passed: false,
    scenarios: scenarios.slice(0, 34).map((scenario) => ({ scenario, passed: true })),
  };
  const originalBytes = bytes(original),
    runtime = { beforeSha256: pins.runtime, afterSha256: pins.runtime },
    controller = { beforeSha256: pins.controller, afterSha256: pins.controller };
  const extra = {
    version: 1,
    ...identity,
    passed: true,
    originalReportSha256: hash(originalBytes),
    runtime,
    controller,
    helperOverlay: structuredClone(helperOverlay),
    scenarios: scenarios.slice(34).map((scenario, index) => ({
      scenario,
      passed: true,
      schema: 17,
      status: ['completed', 'rolled_back', 'needs_attention'][index],
      publicationGate: {
        ...base,
        retainedLatestData: index === 2,
        gatedBeforeActivation: index !== 1,
      },
      stages: timings(
        index === 0
          ? [
              'preflight',
              'save-configuration',
              'backup-before',
              'recheck-previous',
              'switch',
              'public-checks',
              'publication-activate',
              'public-checks-activated',
              'backup-after',
              'restore-backup-timer',
            ]
          : index === 1
            ? ['preflight', 'backup-before', 'recheck-previous', 'rollback', 'restore-backup-timer']
            : [
                'preflight',
                'backup-before',
                'recheck-previous',
                'switch',
                'public-checks',
                'publication-quarantine',
                'restore-backup-timer',
              ],
      ),
    })),
    gateFaults: {
      startup: { activationCommitted: false, rollbackPassed: true },
      activation: {
        activationCommitted: true,
        publicationCommitted: true,
        quarantinePassed: true,
        applicationRunning: false,
        oldImageRestored: false,
        currentDataRetained: true,
      },
    },
  };
  extra.scenarios[0].personalCalendarApi = {
    personalCreated: true,
    manualOverlapBlocked: true,
    publicOverlapBlocked: true,
    neighboringTimeAvailable: true,
    noPatientOrAppointmentCreated: true,
  };
  const receipt = {
    version: 1,
    identity: { ...identity },
    originalReportSha256: hash(originalBytes),
    runtime: { ...runtime },
    controller: { ...controller },
    helperOverlay: structuredClone(helperOverlay),
  };
  return {
    original,
    extra,
    receipt,
    run() {
      return validateContinuation(bytes(this.original), bytes(this.extra), this.receipt);
    },
  };
}

test('aggregate binds original 34 and supplemental 3 to image08 without mutating inputs', () => {
  const f = fixture(),
    original = bytes(f.original),
    extra = bytes(f.extra),
    receipt = structuredClone(f.receipt);
  const result = validateContinuation(original, extra, receipt);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.scenarios.map((row) => row.scenario),
    [...scenarios],
  );
  assert.equal(result.provenance.original.passed, false);
  assert.equal(result.provenance.original.sha256, hash(original));
  assert.equal(result.provenance.supplement.sha256, hash(extra));
  assert.equal(result.provenance.receiptSha256, hash(bytes(receipt)));
  assert.equal(result.imageId, identity.imageId);
  assert.deepEqual(original, bytes(f.original));
  assert.deepEqual(extra, bytes(f.extra));
  assert.deepEqual(receipt, f.receipt);
  result.scenarios[0].passed = false;
  assert.equal(f.original.scenarios[0].passed, true);
});
test('original failed report must contain exactly the unique first 34 passed cases', () => {
  for (const change of [
    (f) => (f.original.passed = true),
    (f) => f.original.scenarios.pop(),
    (f) => f.original.scenarios.push(f.extra.scenarios[0]),
    (f) => f.original.scenarios.reverse(),
    (f) => (f.original.scenarios[1] = f.original.scenarios[0]),
    (f) => (f.original.scenarios[0].passed = false),
  ]) {
    const f = fixture();
    change(f);
    f.receipt.originalReportSha256 = f.extra.originalReportSha256 = hash(bytes(f.original));
    assert.throws(() => f.run());
  }
});
test('supplement must contain exactly three distinct final cases in planned order', () => {
  for (const change of [
    (f) => f.extra.scenarios.pop(),
    (f) => f.extra.scenarios.push(f.original.scenarios[0]),
    (f) => f.extra.scenarios.reverse(),
    (f) => (f.extra.scenarios[1] = f.extra.scenarios[0]),
    (f) => (f.extra.scenarios[0].passed = false),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => f.run());
  }
});
test('evidence cannot transfer to candidate09, another source or another image', () => {
  for (const target of ['original', 'extra', 'receipt'])
    for (const key of ['candidate', 'sourceHash', 'imageId']) {
      const f = fixture(),
        value = target === 'receipt' ? f.receipt.identity : f[target];
      value[key] =
        key === 'candidate'
          ? 'interface-20261014-09'
          : key === 'imageId'
            ? 'sha256:' + '0'.repeat(64)
            : '0'.repeat(64);
      assert.throws(() => f.run());
    }
});
test('original raw byte hash and supplemental byte pins reject tampering', () => {
  const f = fixture();
  f.receipt.originalReportSha256 = '0'.repeat(64);
  assert.throws(() => f.run());
  const g = fixture();
  g.extra.originalReportSha256 = '0'.repeat(64);
  assert.throws(() => g.run());
  const h = fixture();
  h.receipt.supplementSha256 = hash(bytes(h.extra));
  assert.doesNotThrow(() => h.run());
  h.extra.scenarios[0].durationMs = 5;
  assert.throws(() => h.run());
  const i = fixture();
  assert.throws(() =>
    validateContinuation(
      Buffer.concat([bytes(i.original), Buffer.from(' ')]),
      bytes(i.extra),
      i.receipt,
    ),
  );
});
test('changed runtime or controller hashes fail even when both sides agree on a new value', () => {
  for (const name of ['runtime', 'controller'])
    for (const target of ['receipt', 'extra'])
      for (const phase of ['beforeSha256', 'afterSha256']) {
        const f = fixture();
        f[target][name][phase] = '1'.repeat(64);
        assert.throws(() => f.run());
      }
  const f = fixture();
  f.extra.runtime = f.receipt.runtime = {
    beforeSha256: '1'.repeat(64),
    afterSha256: '1'.repeat(64),
  };
  assert.throws(() => f.run());
});
test('helper overlay is pinned to BUSINESS_API only and validated AST proof', () => {
  for (const target of ['receipt', 'extra'])
    for (const patch of [
      { path: 'src/server/http/security.cjs' },
      { beforeSha256: '0'.repeat(64) },
      { afterSha256: '0'.repeat(64) },
      { astOnlyBusinessApi: false },
      { changes: ['BUSINESS_API', 'OBSERVE'] },
      { changes: [] },
    ]) {
      const f = fixture();
      Object.assign(f[target].helperOverlay, patch);
      assert.throws(() => f.run());
    }
});
test('all five business checks and schema/component/data preservation are mandatory', () => {
  for (const key of Object.keys(fixture().extra.scenarios[0].personalCalendarApi)) {
    const f = fixture();
    f.extra.scenarios[0].personalCalendarApi[key] = false;
    assert.throws(() => f.run());
    const g = fixture();
    delete g.extra.scenarios[0].personalCalendarApi[key];
    assert.throws(() => g.run());
  }
  for (const index of [0, 1, 2])
    for (const key of [
      'schema',
      'readBudgetVersion',
      'bookingLinksVersion',
      'noSqlMigration',
      'noDataRollback',
      'personalReservationsPreserved',
    ]) {
      const f = fixture();
      f.extra.scenarios[index].publicationGate[key] = 0;
      assert.throws(() => f.run());
    }
});
test('fault statuses, durable markers and stopped quarantine cannot be inferred or omitted', () => {
  for (const patch of [
    { activationCommitted: false },
    { publicationCommitted: false },
    { quarantinePassed: false },
    { applicationRunning: true },
    { oldImageRestored: true },
    { currentDataRetained: false },
  ]) {
    const f = fixture();
    Object.assign(f.extra.gateFaults.activation, patch);
    assert.throws(() => f.run());
  }
  const f = fixture();
  f.extra.gateFaults.startup.activationCommitted = true;
  assert.throws(() => f.run());
  const g = fixture();
  delete g.extra.gateFaults;
  assert.throws(() => g.run());
  for (const index of [1, 2]) {
    const h = fixture();
    h.extra.scenarios[index].status = 'completed';
    assert.throws(() => h.run());
  }
});
test('latest required stage results must pass and committed failure must not invoke rollback', () => {
  for (const index of [0, 1, 2]) {
    const f = fixture();
    f.extra.scenarios[index].stages.pop();
    assert.throws(() => f.run());
    const g = fixture();
    g.extra.scenarios[index].stages.push({ stage: 'restore-backup-timer', status: 'failed' });
    assert.throws(() => g.run());
  }
  const f = fixture();
  f.extra.scenarios[2].stages.push({ stage: 'rollback', status: 'failed' });
  assert.throws(() => f.run());
});
test('optional adapter hashes need explicit two-sided request/proof pins', () => {
  const f = fixture();
  f.receipt.adapter = f.extra.adapter = {
    requestSha256: 'a'.repeat(64),
    proofSha256: 'b'.repeat(64),
  };
  assert.doesNotThrow(() => f.run());
  f.extra.adapter = { ...f.extra.adapter, proofSha256: 'c'.repeat(64) };
  assert.throws(() => f.run());
  const g = fixture();
  g.extra.adapter = { requestSha256: 'a'.repeat(64) };
  assert.throws(() => g.run());
  const h = fixture();
  h.receipt.adapter = h.extra.adapter = { requestSha256: 'a'.repeat(64) };
  assert.throws(() => h.run());
});
test('writer creates a distinct aggregate and never overwrites original or existing output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-stand-continuation-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture(),
    names = ['original.json', 'supplement.json', 'receipt.json'].map((name) =>
      path.join(directory, name),
    );
  [f.original, f.extra, f.receipt].forEach((value, index) =>
    fs.writeFileSync(names[index], bytes(value)),
  );
  const before = names.map((file) => fs.readFileSync(file)),
    output = path.join(directory, 'aggregate.json');
  assert.throws(() => writeAggregate(...names, names[0]));
  assert.equal(writeAggregate(...names, output).scenarios.length, 37);
  assert.throws(() => writeAggregate(...names, output), /EEXIST/);
  names.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  assert.equal(JSON.parse(fs.readFileSync(names[0])).passed, false);
});
test('malformed, unbounded and ambiguous report inputs fail closed', () => {
  const f = fixture();
  for (const value of ['not-json', '[]', '', Buffer.alloc(4 * 1024 * 1024 + 1)])
    assert.throws(() => validateContinuation(value, bytes(f.extra), f.receipt));
  f.receipt.version = 2;
  assert.throws(() => f.run());
});
