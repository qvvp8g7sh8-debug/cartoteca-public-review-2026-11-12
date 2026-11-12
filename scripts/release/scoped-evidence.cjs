const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { safePath, hash, objectHash, controllerHash } = require('./files.cjs');
const { validateUnitEvents } = require('./unit-report.cjs');
const { validateBrowserReport } = require('./browser-report.cjs');
const { BASELINE, PINS, NAMES, AUDIO_HOTFIX } = require('./verification-profile-policy.cjs');
const { AUDIO_SESSION } = require('./verification-audio-session-policy.cjs');
const { ASSISTANT_BEHAVIOR } = require('./verification-assistant-behavior-policy.cjs');

function read(file) {
  const stat = fs.lstatSync(file);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4 * 1024 * 1024,
    'Invalid bounded profile evidence',
  );
  return fs.readFileSync(file);
}
function testNames(files) {
  return Object.keys(files)
    .filter((name) => /^(?:[\w-]+|tests\/[\w-]+)\.test\.cjs$/.test(name))
    .sort();
}
function environmentIdentity(env) {
  const result = {};
  for (const key of ['node', 'os', 'arch', 'osRelease', 'lockHash', 'caddy', 'caddyHash'])
    if (env?.[key] !== undefined) result[key] = env[key];
  assert.ok(
    result.node && result.os && result.arch && result.osRelease && result.lockHash,
    'Missing inherited execution environment',
  );
  if (result.os === 'linux')
    assert.ok(result.caddy && result.caddyHash, 'Missing Linux toolchain proof');
  return result;
}
function assertBaseline(baseline) {
  assert.equal(baseline.data.version, 1, 'Unknown baseline metadata');
  assert.equal(baseline.data.id, BASELINE.id, 'Unqualified baseline');
  assert.equal(baseline.data.profile, 'full', 'Baseline must have full verification');
  assert.equal(baseline.data.sourceHash, BASELINE.sourceHash, 'Unqualified baseline source');
  assert.equal(objectHash(baseline.data.files), BASELINE.sourceHash, 'Baseline manifest changed');
}
function loadBaseline(directory) {
  const base = safePath(directory, 'verification-baseline');
  const data = JSON.parse(read(safePath(base, 'candidate.json')));
  const baseline = { data };
  assertBaseline(baseline);
  const proofs = { native: {}, evidence: [] };
  for (const [name, [, bytes, sha256]] of Object.entries(PINS)) {
    const value = read(safePath(base, name));
    assert.equal(value.length, bytes, 'Baseline evidence size changed: ' + name);
    assert.equal(hash(value), sha256, 'Baseline evidence changed: ' + name);
    const proof = { file: 'verification-baseline/' + name, bytes, sha256 };
    proofs.evidence.push(proof);
    const match = /^(windows|linux)-(report|unit)\.(?:json|jsonl)$/.exec(name);
    if (match) {
      const target = (proofs.native[match[1]] ||= {});
      if (match[2] === 'unit')
        Object.assign(target, { unitText: value.toString('utf8'), unitProof: proof });
      else Object.assign(target, { report: JSON.parse(value), reportProof: proof });
    } else if (name === 'image-oci.json') proofs.imageOci = JSON.parse(value);
    else proofs[name === 'image.json' ? 'image' : 'stand'] = { report: JSON.parse(value), proof };
  }
  const manifest = read(safePath(base, 'client-manifest.json'));
  assert.equal(
    hash(manifest),
    data.files['src/client/manifest.json'].sha256,
    'Baseline client manifest changed',
  );
  proofs.clientManifest = JSON.parse(manifest);
  return { baseline, proofs };
}
function copyBaseline(baseline, directory) {
  assertBaseline(baseline);
  const base = safePath(directory, 'verification-baseline');
  fs.mkdirSync(base); // Never overwrite existing qualification evidence.
  const copy = (source, name) =>
    fs.writeFileSync(safePath(base, name), read(source), { flag: 'wx' });
  copy(safePath(baseline.directory, 'candidate.json'), 'candidate.json');
  for (const [name, [relative]] of Object.entries(PINS))
    copy(safePath(baseline.directory, relative), name);
  copy(safePath(baseline.source, 'src/client/manifest.json'), 'client-manifest.json');
  return loadBaseline(directory);
}
function validateBaselineProof(baseline, proofs) {
  const tests = testNames(baseline.data.files);
  const result = {};
  for (const target of ['windows', 'linux']) {
    const { report, unitText, reportProof, unitProof } = proofs.native[target];
    assert.equal(report.version, 1, 'Only complete native reports qualify');
    assert.equal(report.candidate, baseline.data.id, 'Baseline report candidate differs');
    assert.equal(report.sourceHash, baseline.data.sourceHash, 'Baseline report source differs');
    assert.equal(report.target, target, 'Baseline report target differs');
    assert.equal(report.status, 'passed', 'Baseline native verification failed');
    assert.equal(report.selectedPhase, 'all', 'Partial native proof cannot qualify');
    assert.equal(report.settings?.unitShards, 1, 'Unexpected baseline sharding');
    assert.equal(
      report.environment?.os,
      target === 'windows' ? 'win32' : 'linux',
      'Wrong native OS proof',
    );
    assert.equal(
      report.environment?.controllerHash,
      controllerHash(baseline.data.files),
      'Baseline controller differs',
    );
    assert.equal(
      report.environment?.lockHash,
      baseline.data.files['package-lock.json'].sha256,
      'Baseline dependency lock differs',
    );
    assert.ok(
      report.steps?.length && report.steps.every((step) => step.status === 'passed'),
      'Incomplete baseline steps',
    );
    assert.equal(
      new Set(report.steps.map((step) => step.id)).size,
      report.steps.length,
      'Duplicate baseline step',
    );
    const unit = report.steps.find((step) => step.id === 'unit');
    assert.ok(unit && unit.details && unit.inputHash, 'Missing baseline unit proof');
    const summary = validateUnitEvents(unitText, tests);
    assert.deepEqual(summary, unit.unitSummary, 'Baseline raw unit evidence differs');
    result[target] = {
      candidate: baseline.data.id,
      sourceHash: baseline.data.sourceHash,
      report: reportProof,
      unit: unitProof,
      environment: environmentIdentity(report.environment),
      summary,
    };
  }
  const image = proofs.image.report;
  assert.equal(image.id, baseline.data.id, 'Baseline image candidate differs');
  assert.equal(image.sourceHash, baseline.data.sourceHash, 'Baseline image source differs');
  assert.equal(image.status, 'packaged', 'Baseline image not packaged');
  assert.match(image.imageId || '', /^sha256:[a-f0-9]{64}$/, 'Missing baseline image identity');
  assert.ok(
    ['build', 'smoke', 'export'].every((name) => image.steps?.[name]?.status === 'passed'),
    'Incomplete baseline image checks',
  );
  assert.match(image.archive?.sha256 || '', /^[a-f0-9]{64}$/, 'Missing baseline archive proof');
  assert.ok(
    Number.isSafeInteger(image.archive?.bytes) && image.archive.bytes > 0,
    'Missing baseline archive size',
  );
  const stand = proofs.stand.report;
  assert.equal(stand.sourceHash, baseline.data.sourceHash, 'Baseline stand source differs');
  assert.equal(stand.imageId, image.imageId, 'Baseline stand image differs');
  assert.equal(stand.passed, true, 'Baseline stand failed');
  assert.deepEqual(
    stand.scenarios?.map((row) => row.scenario),
    NAMES,
    'Baseline stand coverage differs',
  );
  assert.ok(
    stand.scenarios.every((row) => row.passed === true),
    'Baseline stand contains failure',
  );
  return result;
}
function validateScopedReport(candidate, target, report, profile) {
  const { steps } = require('./plan.cjs');
  const { scopePlan } = require('./verification-profile.cjs');
  const plan = scopePlan(steps(candidate.source, { target, unitWorkers: 1 }), profile, { target });
  assert.equal(report.version, 1, 'Scoped native report version differs');
  assert.equal(report.candidate, candidate.data.id, 'Scoped native candidate differs');
  assert.equal(report.sourceHash, candidate.data.sourceHash, 'Scoped native source differs');
  assert.equal(report.target, target, 'Scoped native target differs');
  assert.equal(report.profile, 'assistant-ui', 'Scoped profile missing');
  assert.equal(report.profileHash, profile.profileHash, 'Scoped profile changed');
  if (
    [
      AUDIO_HOTFIX.selectionMode,
      AUDIO_SESSION.selectionMode,
      ASSISTANT_BEHAVIOR.selectionMode,
    ].includes(profile.selectionMode)
  ) {
    const coverage =
      profile.selectionMode === ASSISTANT_BEHAVIOR.selectionMode
        ? require('./verification-assistant-behavior.cjs').behaviorCoverage
        : profile.selectionMode === AUDIO_SESSION.selectionMode
          ? require('./verification-audio-session.cjs').sessionCoverage
          : require('./verification-profile.cjs').hotfixCoverage;
    assert.equal(report.selectionMode, profile.selectionMode, 'Audio hotfix report mode changed');
    assert.equal(report.scope, 'targeted', 'Audio hotfix report must state targeted scope');
    assert.equal(
      report.fullVerification,
      false,
      'Audio hotfix report cannot claim full verification',
    );
    assert.deepEqual(
      profile.coverage,
      coverage(candidate.data.files, profile.freshUnitFiles),
      'Audio hotfix profile coverage changed',
    );
    assert.deepEqual(report.coverage, profile.coverage, 'Audio hotfix report coverage changed');
    assert.deepEqual(
      profile.inheritedNative[target].inheritedFiles,
      [],
      'Audio hotfix cannot claim inherited omitted unit tests',
    );
  } else {
    assert.equal(report.selectionMode, undefined, 'Unexpected scoped selection mode');
  }
  assert.deepEqual(
    report.inheritedBackend,
    profile.inheritedNative[target],
    'Inherited backend proof changed',
  );
  assert.deepEqual(
    environmentIdentity(report.environment),
    profile.inheritedNative[target].environment,
    'Execution toolchain changed; full verification required',
  );
  assert.equal(
    report.environment?.controllerHash,
    controllerHash(candidate.data.files),
    'Unqualified current controller',
  );
  assert.equal(report.selectedPhase, 'all', 'Scoped report must cover every selected phase');
  assert.equal(report.settings?.unitWorkers, 1, 'Scoped unit worker contract differs');
  assert.equal(report.settings?.unitShards, 1, 'Scoped report cannot be sharded');
  assert.equal(report.planHash, objectHash(plan), 'Scoped plan changed');
  assert.equal(report.selectionHash, objectHash(plan), 'Scoped selection changed');
  const allowed = new Set([
    'dependencies',
    'git-init',
    'git-index',
    'browser-install',
    ...plan.map((step) => step.id),
  ]);
  assert.ok(
    Array.isArray(report.steps) &&
      report.steps.every((step) => step.status === 'passed' && allowed.has(step.id)),
    'Scoped steps failed or contain unknown work',
  );
  assert.equal(
    new Set(report.steps.map((step) => step.id)).size,
    report.steps.length,
    'Duplicate scoped step',
  );
  assert.ok(
    report.steps.some((step) => step.id === 'dependencies'),
    'Fresh dependency installation missing',
  );
  for (const step of plan) {
    const record = report.steps.find((row) => row.id === step.id);
    assert.equal(record?.inputHash, objectHash(step), 'Missing or changed scoped step: ' + step.id);
    if (step.id === 'unit') {
      const summary = validateUnitEvents(
        read(safePath(candidate.directory, record.details)).toString('utf8'),
        profile.freshUnitFiles,
      );
      assert.deepEqual(summary, record.unitSummary, 'Fresh unit evidence changed');
      if (profile.selectionMode === AUDIO_SESSION.selectionMode)
        require('./verification-audio-session.cjs').validateSessionUnit(
          read(safePath(candidate.directory, record.details)).toString('utf8'),
          target,
        );
      if (profile.selectionMode === ASSISTANT_BEHAVIOR.selectionMode)
        require('./verification-assistant-behavior.cjs').validateBehaviorUnit(
          read(safePath(candidate.directory, record.details)).toString('utf8'),
          target,
        );
    }
    if (step.browserCoverage) {
      assert.ok(
        report.environment.browsers?.[step.browserCoverage.engine],
        'Fresh browser environment missing',
      );
      validateBrowserReport(
        JSON.parse(read(safePath(candidate.directory, record.details))),
        step.browserCoverage,
      );
    }
  }
  return true;
}
module.exports = {
  read,
  testNames,
  environmentIdentity,
  assertBaseline,
  loadBaseline,
  copyBaseline,
  validateBaselineProof,
  validateScopedReport,
};
