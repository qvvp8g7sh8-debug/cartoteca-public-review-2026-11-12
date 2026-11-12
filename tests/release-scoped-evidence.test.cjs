const test = require('node:test');
const assert = require('node:assert/strict');
const { hash, objectHash, controllerHash } = require('../scripts/release/files.cjs');
const { validateUnitEvents } = require('../scripts/release/unit-report.cjs');
const {
  validateBaselineProof,
  environmentIdentity,
} = require('../scripts/release/scoped-evidence.cjs');
const { NAMES } = require('../scripts/release/verification-profile-policy.cjs');

const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: hash(text) });
const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  const files = {
    'package-lock.json': entry('{}'),
    'scripts/release.cjs': entry('// synthetic controller'),
    'src/server/application/example.cjs': entry('// synthetic server'),
    'tests/backend.test.cjs': entry('// synthetic backend test'),
  };
  const baseline = {
    data: {
      version: 1,
      profile: 'full',
      id: 'synthetic-full-baseline',
      sourceHash: objectHash(files),
      files,
    },
  };
  const counts = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
  const unitText =
    [
      { type: 'test:summary', file: 'tests/backend.test.cjs', counts },
      { type: 'test:summary', counts },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n';
  const summary = validateUnitEvents(unitText, ['tests/backend.test.cjs']);
  const proof = (file) => ({ file, bytes: 100, sha256: hash('synthetic proof: ' + file) });
  const proofs = { native: {}, evidence: [] };
  for (const target of ['windows', 'linux']) {
    proofs.native[target] = {
      unitText,
      unitProof: proof(target + '-unit.jsonl'),
      reportProof: proof(target + '-report.json'),
      report: {
        version: 1,
        candidate: baseline.data.id,
        sourceHash: baseline.data.sourceHash,
        target,
        status: 'passed',
        selectedPhase: 'all',
        settings: { unitShards: 1 },
        environment: {
          node: 'v24.19.0',
          os: target === 'windows' ? 'win32' : 'linux',
          arch: 'x64',
          osRelease: 'synthetic-kernel-1',
          lockHash: files['package-lock.json'].sha256,
          controllerHash: controllerHash(files),
          ...(target === 'linux'
            ? { caddy: 'synthetic-caddy-1', caddyHash: hash('synthetic caddy') }
            : {}),
        },
        steps: [
          {
            id: 'unit',
            status: 'passed',
            inputHash: hash('synthetic unit step'),
            details: 'unit.jsonl',
            unitSummary: summary,
          },
        ],
      },
    };
  }
  proofs.image = {
    proof: proof('image.json'),
    report: {
      id: baseline.data.id,
      sourceHash: baseline.data.sourceHash,
      status: 'packaged',
      imageId: 'sha256:' + 'a'.repeat(64),
      archive: { sha256: hash('synthetic archive'), bytes: 100 },
      steps: Object.fromEntries(
        ['build', 'smoke', 'export'].map((name) => [name, { status: 'passed' }]),
      ),
    },
  };
  proofs.stand = {
    proof: proof('stand-report.json'),
    report: {
      sourceHash: baseline.data.sourceHash,
      imageId: proofs.image.report.imageId,
      passed: true,
      scenarios: NAMES.map((scenario) => ({ scenario, passed: true })),
    },
  };
  return { baseline, proofs };
}

test('baseline proof preserves original native environment and evidence references', () => {
  const f = fixture();
  const result = validateBaselineProof(f.baseline, f.proofs);
  for (const target of ['windows', 'linux']) {
    assert.equal(result[target].candidate, f.baseline.data.id);
    assert.equal(result[target].sourceHash, f.baseline.data.sourceHash);
    assert.deepEqual(result[target].report, f.proofs.native[target].reportProof);
    assert.deepEqual(result[target].unit, f.proofs.native[target].unitProof);
    assert.deepEqual(result[target].summary.files, ['tests/backend.test.cjs']);
    assert.deepEqual(
      result[target].environment,
      environmentIdentity(f.proofs.native[target].report.environment),
    );
  }
});

test('partial, failed, foreign or inconsistent native proof never qualifies inherited backend work', () => {
  const mutations = [
    (p) => {
      p.native.windows.report.version = 2;
    },
    (p) => {
      p.native.windows.report.status = 'failed';
    },
    (p) => {
      p.native.windows.report.selectedPhase = 'unit';
    },
    (p) => {
      p.native.windows.report.candidate = 'another-candidate';
    },
    (p) => {
      p.native.windows.report.sourceHash = hash('old source');
    },
    (p) => {
      p.native.windows.report.target = 'linux';
    },
    (p) => {
      p.native.windows.report.environment.os = 'linux';
    },
    (p) => {
      p.native.windows.report.environment.controllerHash = hash('old controller');
    },
    (p) => {
      p.native.windows.report.environment.lockHash = hash('old dependency lock');
    },
    (p) => {
      p.native.windows.report.settings.unitShards = 2;
    },
    (p) => {
      p.native.windows.report.steps[0].status = 'failed';
    },
    (p) => {
      p.native.windows.report.steps.push(clone(p.native.windows.report.steps[0]));
    },
    (p) => {
      p.native.windows.report.steps = [];
    },
    (p) => {
      delete p.native.windows.report.steps[0].details;
    },
    (p) => {
      p.native.windows.report.steps[0].unitSummary.counts.passed = 0;
    },
    (p) => {
      p.native.windows.unitText += JSON.stringify({ type: 'test:fail' }) + '\n';
    },
    (p) => {
      p.native.windows.unitText = '';
    },
    (p) => {
      delete p.native.linux.report.environment.caddyHash;
    },
    (p) => {
      delete p.native.linux.report.environment.node;
    },
    (p) => {
      delete p.native.linux.report.environment.osRelease;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const f = fixture();
    mutate(f.proofs);
    assert.throws(
      () => validateBaselineProof(f.baseline, f.proofs),
      undefined,
      'mutation ' + index,
    );
  }
});

test('image identity, archive integrity metadata and completed build/smoke/export remain required', () => {
  const mutations = [
    (p) => {
      p.image.report.id = 'another-candidate';
    },
    (p) => {
      p.image.report.sourceHash = hash('another-source');
    },
    (p) => {
      p.image.report.imageId = 'mutable:latest';
    },
    (p) => {
      p.image.report.status = 'building';
    },
    (p) => {
      p.image.report.steps.build.status = 'failed';
    },
    (p) => {
      p.image.report.steps.smoke.status = 'failed';
    },
    (p) => {
      delete p.image.report.steps.export;
    },
    (p) => {
      p.image.report.archive.sha256 = 'invalid';
    },
    (p) => {
      p.image.report.archive.bytes = 0;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const f = fixture();
    mutate(f.proofs);
    assert.throws(
      () => validateBaselineProof(f.baseline, f.proofs),
      undefined,
      'mutation ' + index,
    );
  }
});

test('backend stand inheritance rejects a missing, duplicate, failed or foreign-image scenario report', () => {
  const mutations = [
    (p) => {
      p.stand.report.sourceHash = hash('another-source');
    },
    (p) => {
      p.stand.report.imageId = 'sha256:' + 'b'.repeat(64);
    },
    (p) => {
      p.stand.report.passed = false;
    },
    (p) => {
      p.stand.report.scenarios.pop();
    },
    (p) => {
      p.stand.report.scenarios.push(clone(p.stand.report.scenarios[0]));
    },
    (p) => {
      p.stand.report.scenarios[0].passed = false;
    },
    (p) => {
      p.stand.report.scenarios[0].scenario = 'unreviewed-case';
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const f = fixture();
    mutate(f.proofs);
    assert.throws(
      () => validateBaselineProof(f.baseline, f.proofs),
      undefined,
      'mutation ' + index,
    );
  }
});

test('execution identity pins runtime, operating system, architecture, lock and Linux toolchain', () => {
  const env = fixture().proofs.native.linux.report.environment;
  const expected = environmentIdentity(env);
  for (const key of ['node', 'os', 'arch', 'osRelease', 'lockHash', 'caddy', 'caddyHash']) {
    assert.notDeepEqual(environmentIdentity({ ...env, [key]: 'changed' }), expected, key);
  }
  assert.deepEqual(environmentIdentity({ ...env, availableCPUs: 2, jobs: 1 }), expected);
});

test('profile construction records inherited backend separately from all freshly required assistant and release tests', () => {
  const { buildProfile } = require('../scripts/release/verification-profile.cjs');
  const f = fixture();
  const files = {
    ...f.baseline.data.files,
    'src/client/modules/assistant-audio.js': entry('// reviewed audio change'),
    'tests/assistant-audio.test.cjs': entry('// fresh assistant tests'),
    'tests/release-profile-cli.test.cjs': entry('// fresh release admission tests'),
  };
  const candidate = {
    data: {
      id: 'synthetic-next-release',
      profile: 'assistant-ui',
      files,
      sourceHash: objectHash(files),
    },
  };
  const admitted = buildProfile(candidate, f.baseline, f.proofs);
  assert.deepEqual(admitted.freshUnitFiles, [
    'tests/assistant-audio.test.cjs',
    'tests/release-profile-cli.test.cjs',
  ]);
  for (const target of ['windows', 'linux']) {
    assert.deepEqual(admitted.inheritedNative[target].inheritedFiles, ['tests/backend.test.cjs']);
    assert.equal(admitted.inheritedNative[target].sourceHash, f.baseline.data.sourceHash);
  }
  assert.deepEqual(admitted.qualification.freshReleaseTests, [
    'tests/release-profile-cli.test.cjs',
  ]);
  assert.equal(admitted.standPartition.fresh.length, 4);
  assert.equal(admitted.standPartition.inherited.length, 33);
  const { profileHash, ...body } = admitted;
  assert.equal(profileHash, objectHash(body));
});

test('a profile cannot inherit backend results after a protected change or without fresh assistant tests', () => {
  const { buildProfile } = require('../scripts/release/verification-profile.cjs');
  const f = fixture();
  const fresh = {
    ...f.baseline.data.files,
    'tests/assistant-audio.test.cjs': entry('// fresh test'),
  };
  for (const files of [
    f.baseline.data.files,
    { ...fresh, 'package-lock.json': entry('{"changed":true}') },
    { ...fresh, 'src/server/application/example.cjs': entry('// changed writer') },
    { ...fresh, 'tests/helpers/release-stand.py': entry('# changed fixture') },
    { ...fresh, 'src/client/core/module-ports.js': entry('// changed shared module') },
  ]) {
    const candidate = {
      data: { id: 'synthetic-next-release', files, sourceHash: objectHash(files) },
    };
    assert.throws(() => buildProfile(candidate, f.baseline, f.proofs));
  }
});
