const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { manifest, objectHash, controllerHash, hash } = require('../scripts/release/files.cjs');
const { location, writeJson } = require('../scripts/release/state.cjs');
const { steps } = require('../scripts/release/plan.cjs');
const { status } = require('../scripts/release/status.cjs');

function candidateFixture(t, profile = 'full') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-profile-status-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = 'synthetic-current-release';
  const directory = location(root, id);
  const source = path.join(directory, 'source');
  for (const [name, text] of Object.entries({
    'tests/example.test.cjs': '// synthetic test',
    'scripts/release.cjs': '// synthetic release controller',
    'package.json': '{}',
    'package-lock.json': '{}',
    Dockerfile: 'FROM scratch',
  })) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const files = manifest(source);
  const sourceHash = objectHash(files);
  writeJson(path.join(directory, 'candidate.json'), { version: 1, id, profile, sourceHash, files });
  const reports = {};
  for (const target of ['windows', 'linux']) {
    const plan = steps(source, { target, unitWorkers: 1 });
    const report = {
      version: 1,
      candidate: id,
      sourceHash,
      target,
      status: 'passed',
      environment: {
        os: target === 'windows' ? 'win32' : 'linux',
        node: 'v24.19.0',
        arch: 'x64',
        lockHash: hash('{}'),
        controllerHash: controllerHash(files),
        browsers: target === 'windows' ? { chromium: '1' } : { chromium: '1', webkit: '1' },
        ...(target === 'linux' ? { caddyHash: hash('synthetic caddy') } : {}),
      },
      settings: { unitWorkers: 1 },
      planHash: objectHash(plan),
      steps: plan.map((step) => ({ id: step.id, inputHash: objectHash(step), status: 'passed' })),
    };
    const file = path.join(directory, 'reports', target, 'report.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, report);
    reports[target] = { file, report };
  }
  return { root, id, directory, reports };
}

function assertNotReady(f) {
  let ready = false;
  try {
    ready = status(f.root, f.id).readyToPackage;
  } catch {
    /* Fail closed is permitted. */
  }
  assert.equal(ready, false);
}

test('default full releases retain both complete native verification plans', (t) => {
  const f = candidateFixture(t);
  assert.equal(status(f.root, f.id).profile, 'full');
  assert.equal(status(f.root, f.id).readyToPackage, true);
  const { file, report } = f.reports.linux;
  writeJson(file, { ...report, steps: report.steps.filter((step) => step.id !== 'unit') });
  assertNotReady(f);
});

test('the assistant profile cannot borrow full reports when its profile proof is missing', (t) => {
  const f = candidateFixture(t, 'assistant-ui');
  assertNotReady(f);
});

test('unrecognized candidate profiles do not silently fall back to ready full verification', (t) => {
  const f = candidateFixture(t, 'unchecked');
  assertNotReady(f);
});

test('a full candidate cannot ignore an unexpected scoped receipt left beside its reports', (t) => {
  const f = candidateFixture(t);
  writeJson(path.join(f.directory, 'verification-profile.json'), {
    profile: 'assistant-ui',
    readyToPackage: true,
  });
  assertNotReady(f);
});
