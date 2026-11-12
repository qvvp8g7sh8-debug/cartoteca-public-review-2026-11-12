const fs = require('node:fs');
const assert = require('node:assert/strict');
const { safePath, objectHash, controllerHash } = require('./files.cjs');
const { POLICY, NAMES, documentation } = require('./verification-profile-policy.cjs');
const { read, testNames, validateBaselineProof } = require('./scoped-evidence.cjs');
const {
  ASSISTANT_BEHAVIOR,
  BEHAVIOR_FILES,
  BEHAVIOR_CONTROL,
  BEHAVIOR_CORE,
  BEHAVIOR_TESTS,
  BEHAVIOR_HTTP,
} = require('./verification-assistant-behavior-policy.cjs');
function assertBehaviorBase(data) {
  assert.equal(data?.version, 1, 'Missing published50 behavior base');
  assert.equal(data.id, ASSISTANT_BEHAVIOR.id, 'Unqualified behavior production base');
  assert.equal(data.profile, 'assistant-ui', 'Published50 profile differs');
  assert.equal(data.sourceHash, ASSISTANT_BEHAVIOR.sourceHash, 'Published50 source differs');
  assert.equal(
    objectHash(data.files),
    ASSISTANT_BEHAVIOR.sourceHash,
    'Published50 manifest changed',
  );
  return data;
}
function classifyBehaviorChanges(before, after) {
  const result = {
    changed: [],
    uiChanges: [],
    controllerChanges: [],
    documentationChanges: [],
    blocked: [],
  };
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (objectHash(before[name] ?? null) === objectHash(after[name] ?? null)) continue;
    result.changed.push(name);
    if (!after[name]) result.blocked.push(name);
    else if (BEHAVIOR_FILES[name]) {
      (objectHash(after[name]) === objectHash(BEHAVIOR_FILES[name])
        ? result.uiChanges
        : result.blocked
      ).push(name);
    } else if (BEHAVIOR_CONTROL.has(name)) result.controllerChanges.push(name);
    else if (documentation(name)) result.documentationChanges.push(name);
    else result.blocked.push(name);
  }
  return result;
}
function behaviorCoverage(files, selected = BEHAVIOR_TESTS) {
  assert.deepEqual(selected, BEHAVIOR_TESTS, 'Behavior test selection changed');
  const tests = testNames(files);
  for (const name of selected)
    assert.ok(tests.includes(name), 'Missing required behavior test: ' + name);
  return {
    executedUnitFiles: [...selected],
    inheritedUnitFiles: [],
    notRunUnitFiles: tests.filter((name) => !selected.includes(name)),
  };
}
function behaviorFingerprints(files) {
  const rows = Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const except = (name) => Object.hasOwn(BEHAVIOR_FILES, name) || BEHAVIOR_CONTROL.has(name);
  const select = (predicate) =>
    objectHash(Object.fromEntries(rows.filter(([name]) => predicate(name))));
  return {
    protected: select((name) => !except(name) && !documentation(name)),
    backend: select((name) => /^(?:src\/server\/|src\/shared\/)/u.test(name) && !except(name)),
    dependencies: select((name) =>
      [
        'package.json',
        'package-lock.json',
        'Dockerfile',
        'Dockerfile.caddy',
        '.dockerignore',
        'compose.yaml',
        'compose.backup.yaml',
        'Caddyfile',
      ].includes(name),
    ),
    protocol: select(
      (name) =>
        /^(?:src\/server\/(?:http|application)\/|src\/shared\/)/u.test(name) && !except(name),
    ),
    fixtures: select(
      (name) => /^(?:tests\/helpers\/|tests\/browser\/)/u.test(name) && !except(name),
    ),
    executor: select(
      (name) =>
        name.startsWith('scripts/release/remote/') || name === 'scripts/release/image-check.cjs',
    ),
    toolchain: select((name) => name.startsWith('scripts/') && !BEHAVIOR_CONTROL.has(name)),
  };
}
function assertBehaviorInputs(candidate, base) {
  assert.equal(
    objectHash(candidate.data.files),
    candidate.data.sourceHash,
    'Behavior candidate manifest changed',
  );
  for (const [name, expected] of Object.entries(BEHAVIOR_FILES))
    assert.deepEqual(candidate.data.files[name], expected, 'Reviewed58 input differs: ' + name);
  const changes = classifyBehaviorChanges(base.files, candidate.data.files);
  assert.deepEqual(changes.blocked, [], 'Changes exceed the finite50→58 behavior scope');
  assert.deepEqual(
    behaviorFingerprints(candidate.data.files),
    behaviorFingerprints(base.files),
    'Protected production50 components changed',
  );
  behaviorCoverage(candidate.data.files);
  return changes;
}
function buildBehaviorProfile(candidate, baseline, proofs, base) {
  assertBehaviorBase(base);
  const changes = assertBehaviorInputs(candidate, base);
  const current = behaviorFingerprints(candidate.data.files);
  const native = validateBaselineProof(baseline, proofs);
  const productionBridge =
    require('./verification-assistant-behavior-bridge.cjs').validateBehaviorBridge(
      candidate,
      base,
      baseline,
      proofs,
    );
  for (const target of ['windows', 'linux'])
    native[target] = { ...native[target], inheritedFiles: [], protectedHash: current.protected };
  const body = {
    version: 1,
    policy: POLICY,
    profile: 'assistant-ui',
    selectionMode: ASSISTANT_BEHAVIOR.selectionMode,
    scope: 'targeted',
    fullVerification: false,
    productionBase: { ...ASSISTANT_BEHAVIOR },
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    baseline: {
      id: baseline.data.id,
      sourceHash: baseline.data.sourceHash,
      imageId: proofs.image.report.imageId,
    },
    changes,
    fingerprints: current,
    freshUnitFiles: [...BEHAVIOR_TESTS],
    freshSelection: {
      files: [...BEHAVIOR_TESTS],
      uncertain: [],
      dependencyHash: objectHash(BEHAVIOR_TESTS),
      method: ASSISTANT_BEHAVIOR.selectionMode,
    },
    coverage: behaviorCoverage(candidate.data.files),
    inheritedNative: native,
    productionBridge,
    qualification: {
      controllerHash: controllerHash(candidate.data.files),
      changedController: changes.controllerChanges,
      freshReleaseTests: BEHAVIOR_TESTS.filter((name) => name.startsWith('tests/release-')),
      productionInputsHash: objectHash(base.files),
      reviewedBehaviorInputsHash: objectHash(BEHAVIOR_FILES),
      protectedAgainstPublished50: true,
      exactCoreExceptions: BEHAVIOR_CORE.map((name) => ({ path: name, ...BEHAVIOR_FILES[name] })),
    },
    standPartition: {
      inherited: NAMES.slice(0, 33),
      fresh: NAMES.slice(33),
      freshAssistantHttp: [...BEHAVIOR_HTTP],
    },
    inheritedStand: proofs.stand.proof,
    baselineImage: proofs.image.proof,
    evidence: proofs.evidence,
  };
  return { ...body, profileHash: objectHash(body) };
}
function prepareBehaviorInputs(root, candidate, location) {
  const base = assertBehaviorBase(
    JSON.parse(read(safePath(location(root, ASSISTANT_BEHAVIOR.id), 'candidate.json'))),
  );
  assertBehaviorInputs(candidate, base);
  fs.writeFileSync(
    safePath(candidate.directory, 'verification-assistant-behavior-base.json'),
    JSON.stringify(base, null, 2) + '\n',
    { flag: 'wx' },
  );
  return { behaviorBase: base };
}
function loadBehaviorInputs(candidate) {
  return {
    behaviorBase: assertBehaviorBase(
      JSON.parse(read(safePath(candidate.directory, 'verification-assistant-behavior-base.json'))),
    ),
  };
}
function validateBehaviorUnit(text, target) {
  assert.ok(['windows', 'linux'].includes(target), 'Behavior proof needs native target');
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const [name, count] of [
    ['assistant-barge-bundle-browser', 2],
    ['assistant-playback-browser', 1],
  ]) {
    const found = rows.filter(
      (row) =>
        row.type === 'test:summary' &&
        String(row.file || '')
          .replaceAll('\\', '/')
          .endsWith('tests/' + name + '.test.cjs'),
    );
    assert.equal(found.length, 1, 'Missing exact native audio summary: ' + name);
    const counts = found[0].counts;
    assert.equal(counts?.tests, count, 'Native audio scope changed: ' + name);
    assert.equal(counts.failed, 0, 'Native audio failed: ' + name);
    assert.equal(
      counts.passed,
      target === 'windows' ? count : 0,
      'Native audio execution differs: ' + name,
    );
    assert.equal(
      counts.skipped,
      target === 'windows' ? 0 : count,
      'Native audio omission differs: ' + name,
    );
  }
}
function validateBehaviorHttp(proof, candidate, profile, binding) {
  assert.equal(proof?.version, 1, 'Missing fresh behavior HTTP proof');
  assert.equal(proof.candidate, candidate.data.id, 'Behavior HTTP candidate differs');
  assert.equal(proof.sourceHash, candidate.data.sourceHash, 'Behavior HTTP source differs');
  assert.equal(proof.profileHash, profile.profileHash, 'Behavior HTTP profile differs');
  assert.equal(proof.imageId, binding.innerImageId, 'Behavior HTTP image differs');
  assert.equal(
    proof.helperSha256,
    candidate.data.files['tests/helpers/release-stand-assistant-behavior.cjs']?.sha256,
    'Behavior HTTP helper differs',
  );
  assert.equal(proof.syntheticOnly, true, 'Behavior HTTP must use synthetic data');
  assert.equal(proof.externalProviderRequests, 0, 'Behavior HTTP contacted a live provider');
  assert.ok(BEHAVIOR_HTTP.length > 0, 'Behavior HTTP case contract missing');
  assert.deepEqual(
    proof.cases?.map((row) => row.case),
    BEHAVIOR_HTTP,
    'Behavior HTTP coverage differs',
  );
  assert.ok(
    proof.cases.every((row) => row.passed === true),
    'Fresh behavior HTTP failed',
  );
  assert.equal(proof.passed, true, 'Fresh behavior HTTP proof failed');
}
module.exports = {
  assertBehaviorBase,
  classifyBehaviorChanges,
  behaviorCoverage,
  behaviorFingerprints,
  assertBehaviorInputs,
  buildBehaviorProfile,
  prepareBehaviorInputs,
  loadBehaviorInputs,
  validateBehaviorUnit,
  validateBehaviorHttp,
};
