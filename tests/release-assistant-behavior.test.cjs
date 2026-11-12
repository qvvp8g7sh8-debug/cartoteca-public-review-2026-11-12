const test = require('node:test');
const assert = require('node:assert/strict');
const { objectHash } = require('../scripts/release/files.cjs');
const policy = require('../scripts/release/verification-assistant-behavior-policy.cjs');
const behavior = require('../scripts/release/verification-assistant-behavior.cjs');
const {
  ASSISTANT_BEHAVIOR,
  BEHAVIOR_FILES,
  BEHAVIOR_CONTROL,
  BEHAVIOR_CORE,
  BEHAVIOR_TESTS,
  BEHAVIOR_HTTP,
} = policy;
const entry = (text) => ({
  bytes: Buffer.byteLength(text),
  sha256: require('../scripts/release/files.cjs').hash(text),
});
const copy = (value) => structuredClone(value);
function fixture() {
  const extras = Object.fromEntries(
    BEHAVIOR_TESTS.filter((name) => !BEHAVIOR_FILES[name]).map((name) => [
      name,
      entry('// existing or freshly qualified test'),
    ]),
  );
  const protectedFiles = {
    'package-lock.json': entry('{}'),
    'src/server/security/unchanged.cjs': entry('// unchanged'),
    'tests/not-selected.test.cjs': entry('// omitted'),
  };
  const before = { ...extras, ...protectedFiles };
  const files = { ...before, ...copy(BEHAVIOR_FILES) };
  return { base: { files: before }, candidate: { data: { files, sourceHash: objectHash(files) } } };
}
test('behavior mode pins published50 and all143 reviewed58 inputs without extending historical modes', () => {
  assert.equal(ASSISTANT_BEHAVIOR.selectionMode, 'assistant-behavior-v1');
  assert.equal(ASSISTANT_BEHAVIOR.id, 'assistant-audio-session-20261018-50');
  assert.equal(
    ASSISTANT_BEHAVIOR.sourceHash,
    '10ce506ae19dc28fa1aaf04335ab133b356d49c50938b36705a41dd44ad85a10',
  );
  assert.equal(
    ASSISTANT_BEHAVIOR.imageId,
    'sha256:ac7128cd15cd5fc194af7be569f1f7d643e2e737f379e85732b170b8557de292',
  );
  assert.equal(Object.keys(BEHAVIOR_FILES).length, 143);
  assert.equal(Object.keys(BEHAVIOR_FILES).filter((name) => name.endsWith('.test.cjs')).length, 60);
  assert.deepEqual(BEHAVIOR_CORE, [
    'src/shared/appointment-time.cjs',
    'src/server/modules/cabinet/validation.cjs',
  ]);
  for (const value of [
    undefined,
    {},
    {
      version: 1,
      id: ASSISTANT_BEHAVIOR.id,
      profile: 'assistant-ui',
      sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
      files: {},
    },
  ])
    assert.throws(() => behavior.assertBehaviorBase(value));
});
test('only the exact reviewed file digest is eligible, never an arbitrary assistant path or same-name replacement', () => {
  for (const [name, pin] of Object.entries(BEHAVIOR_FILES)) {
    assert.deepEqual(behavior.classifyBehaviorChanges({}, { [name]: pin }).blocked, [], name);
    assert.deepEqual(
      behavior.classifyBehaviorChanges({}, { [name]: entry('unreviewed replacement') }).blocked,
      [name],
      name,
    );
    assert.deepEqual(behavior.classifyBehaviorChanges({ [name]: pin }, {}).blocked, [name], name);
  }
  for (const name of [
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'compose.yaml',
    'src/server/modules/assistant/unreviewed.cjs',
    'src/server/security/session.cjs',
    'src/server/migrations/019.cjs',
    'src/server/modules/cabinet/writer.cjs',
    'src/server/infrastructure/data.cjs',
    'src/shared/another.cjs',
    'scripts/release/remote/agent.py',
    'scripts/release/remote/checks.py',
    'runtime/key',
    'private/data',
    'tests/assistant-unreviewed.test.cjs',
  ])
    assert.deepEqual(
      behavior.classifyBehaviorChanges({}, { [name]: entry('new') }).blocked,
      [name],
      name,
    );
  for (const name of BEHAVIOR_CONTROL)
    assert.deepEqual(
      behavior.classifyBehaviorChanges({}, { [name]: entry('freshly qualified controller') })
        .blocked,
      [],
      name,
    );
});
test('complete reviewed behavior set and protected production fingerprints are mandatory, including both core exceptions', () => {
  const f = fixture();
  assert.doesNotThrow(() => behavior.assertBehaviorInputs(f.candidate, f.base));
  for (const name of [
    'src/shared/appointment-time.cjs',
    'src/server/modules/cabinet/validation.cjs',
    'src/server/modules/assistant/service.cjs',
    'src/client/manifest.json',
  ]) {
    const candidate = copy(f.candidate);
    candidate.data.files[name] = entry('changed after review');
    candidate.data.sourceHash = objectHash(candidate.data.files);
    assert.throws(
      () => behavior.assertBehaviorInputs(candidate, f.base),
      /Reviewed58 input differs/u,
      name,
    );
  }
  const missing = copy(f.candidate);
  delete missing.data.files['src/server/modules/assistant/calendar-read-request.cjs'];
  missing.data.sourceHash = objectHash(missing.data.files);
  assert.throws(() => behavior.assertBehaviorInputs(missing, f.base), /Reviewed58 input differs/u);
  const unknown = copy(f.candidate);
  unknown.data.files['src/client/modules/work-time-editor.js'] = entry('unrelated schedule change');
  unknown.data.sourceHash = objectHash(unknown.data.files);
  assert.throws(() => behavior.assertBehaviorInputs(unknown, f.base), /finite50→58/u);
  const protectedChange = copy(f.candidate);
  protectedChange.data.files['package-lock.json'] = entry('{"changed":true}');
  assert.notEqual(
    behavior.behaviorFingerprints(protectedChange.data.files).dependencies,
    behavior.behaviorFingerprints(f.base.files).dependencies,
  );
  assert.equal(
    behavior.behaviorFingerprints(f.candidate.data.files).protected,
    behavior.behaviorFingerprints(f.base.files).protected,
  );
});
test('finite fresh native coverage includes every changed test plus booking/time/write guards and never inherits omitted units', () => {
  const f = fixture(),
    coverage = behavior.behaviorCoverage(f.candidate.data.files);
  assert.deepEqual(coverage.inheritedUnitFiles, []);
  assert.deepEqual(coverage.notRunUnitFiles, ['tests/not-selected.test.cjs']);
  assert.ok(BEHAVIOR_TESTS.length > 60 && BEHAVIOR_TESTS.length < 100);
  for (const name of Object.keys(BEHAVIOR_FILES).filter((name) => name.endsWith('.test.cjs')))
    assert.ok(BEHAVIOR_TESTS.includes(name), name);
  for (const name of [
    'tests/appointment-time.test.cjs',
    'tests/appointment-commands.test.cjs',
    'tests/assistant-appointment-save.test.cjs',
    'tests/assistant-production-autosave.test.cjs',
    'tests/assistant-executor-authority.test.cjs',
  ])
    assert.ok(BEHAVIOR_TESTS.includes(name), name);
  assert.throws(
    () => behavior.behaviorCoverage(f.candidate.data.files, BEHAVIOR_TESTS.slice(1)),
    /selection changed/u,
  );
  delete f.candidate.data.files['tests/assistant-executor-authority.test.cjs'];
  assert.throws(() => behavior.behaviorCoverage(f.candidate.data.files), /Missing required/u);
});
function unitRows(target) {
  return [
    ['assistant-barge-bundle-browser', 2],
    ['assistant-playback-browser', 1],
  ].map(([name, count]) => ({
    type: 'test:summary',
    file: 'C:\\synthetic\\tests\\' + name + '.test.cjs',
    counts: {
      tests: count,
      passed: target === 'windows' ? count : 0,
      failed: 0,
      skipped: target === 'windows' ? 0 : count,
    },
  }));
}
const unitText = (rows) => rows.map((row) => JSON.stringify(row)).join('\n');
test('native audio proof requires3 executed Windows cases and3 explicit Linux omissions, without physical microphone claims', () => {
  for (const target of ['windows', 'linux'])
    assert.doesNotThrow(() => behavior.validateBehaviorUnit(unitText(unitRows(target)), target));
  const skipped = unitRows('windows');
  skipped[0].counts = { tests: 2, passed: 1, failed: 0, skipped: 1 };
  assert.throws(() => behavior.validateBehaviorUnit(unitText(skipped), 'windows'));
  assert.throws(() =>
    behavior.validateBehaviorUnit(unitText(unitRows('windows').slice(1)), 'windows'),
  );
  const falseLinux = unitRows('linux');
  falseLinux[0].counts.passed = 2;
  assert.throws(() => behavior.validateBehaviorUnit(unitText(falseLinux), 'linux'));
  assert.throws(() =>
    behavior.validateBehaviorUnit(
      unitText([...unitRows('windows'), unitRows('windows')[0]]),
      'windows',
    ),
  );
});
test('fresh behavior HTTP receipt binds all10 synthetic cases to the exact image, helper, profile and candidate', () => {
  const candidate = {
    data: {
      id: 'synthetic',
      sourceHash: 'a'.repeat(64),
      files: { 'tests/helpers/release-stand-assistant-behavior.cjs': entry('// fixedhelper') },
    },
  };
  const profile = { profileHash: 'b'.repeat(64) },
    binding = { innerImageId: 'sha256:' + 'c'.repeat(64) };
  const proof = {
    version: 1,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    profileHash: profile.profileHash,
    imageId: binding.innerImageId,
    helperSha256: candidate.data.files['tests/helpers/release-stand-assistant-behavior.cjs'].sha256,
    syntheticOnly: true,
    externalProviderRequests: 0,
    passed: true,
    cases: BEHAVIOR_HTTP.map((name) => ({ case: name, passed: true })),
  };
  assert.equal(proof.cases.length, 10);
  assert.doesNotThrow(() => behavior.validateBehaviorHttp(proof, candidate, profile, binding));
  for (const patch of [
    { imageId: 'sha256:' + 'd'.repeat(64) },
    { sourceHash: 'd'.repeat(64) },
    { helperSha256: 'd'.repeat(64) },
    { externalProviderRequests: 1 },
    { syntheticOnly: false },
    { cases: proof.cases.slice(1) },
  ])
    assert.throws(() =>
      behavior.validateBehaviorHttp({ ...proof, ...patch }, candidate, profile, binding),
    );
});
