const fs = require('node:fs');
const { AUDIO_SESSION, AUDIO_SESSION_TESTS } = require('./verification-audio-session-policy.cjs');
const audioSession = require('./verification-audio-session.cjs');
const {
  ASSISTANT_BEHAVIOR,
  BEHAVIOR_TESTS,
} = require('./verification-assistant-behavior-policy.cjs');
const behavior = require('./verification-assistant-behavior.cjs');
const behaviorBridge = require('./verification-assistant-behavior-bridge.cjs');
const assert = require('node:assert/strict');
const { safePath, hash, objectHash, controllerHash } = require('./files.cjs');
const {
  BASELINE,
  POLICY,
  UI,
  CONTROLLER,
  NAMES,
  freshTest,
  documentation,
  AUDIO_HOTFIX,
  AUDIO_HOTFIX_UI,
  AUDIO_HOTFIX_TESTS,
} = require('./verification-profile-policy.cjs');
const {
  read,
  testNames,
  assertBaseline,
  copyBaseline,
  loadBaseline,
  validateBaselineProof,
  validateScopedReport,
} = require('./scoped-evidence.cjs');

function classifyChanges(beforeFiles, afterFiles) {
  const result = {
    changed: [],
    uiChanges: [],
    controllerChanges: [],
    documentationChanges: [],
    blocked: [],
  };
  for (const name of [
    ...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]),
  ].sort()) {
    if (objectHash(beforeFiles[name] ?? null) === objectHash(afterFiles[name] ?? null)) continue;
    result.changed.push(name);
    if (!afterFiles[name]) result.blocked.push(name);
    else if (UI.has(name) || freshTest(name)) result.uiChanges.push(name);
    else if (CONTROLLER.has(name)) result.controllerChanges.push(name);
    else if (documentation(name)) result.documentationChanges.push(name);
    else result.blocked.push(name);
  }
  return result;
}
function assertSelectionMode(selectionMode) {
  assert.ok(
    selectionMode === undefined ||
      selectionMode === AUDIO_HOTFIX.selectionMode ||
      selectionMode === AUDIO_SESSION.selectionMode ||
      selectionMode === ASSISTANT_BEHAVIOR.selectionMode,
    'Unknown scoped selection mode',
  );
}
function assertHotfixBase(data) {
  assert.ok(data && data.version === 1 && data.files, 'Missing published audio hotfix base');
  assert.equal(data.id, AUDIO_HOTFIX.id, 'Unqualified audio hotfix base');
  assert.equal(data.profile, 'assistant-ui', 'Published audio hotfix base profile differs');
  assert.equal(data.sourceHash, AUDIO_HOTFIX.sourceHash, 'Published audio hotfix source differs');
  assert.equal(
    objectHash(data.files),
    AUDIO_HOTFIX.sourceHash,
    'Published audio hotfix manifest changed',
  );
  return data;
}
function classifyHotfixChanges(beforeFiles, afterFiles) {
  const result = {
    changed: [],
    uiChanges: [],
    controllerChanges: [],
    documentationChanges: [],
    blocked: [],
  };
  const selectedTests = new Set(AUDIO_HOTFIX_TESTS);
  for (const name of [
    ...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]),
  ].sort()) {
    if (objectHash(beforeFiles[name] ?? null) === objectHash(afterFiles[name] ?? null)) continue;
    result.changed.push(name);
    if (!afterFiles[name]) result.blocked.push(name);
    else if (AUDIO_HOTFIX_UI.has(name) || selectedTests.has(name)) result.uiChanges.push(name);
    else if (CONTROLLER.has(name)) result.controllerChanges.push(name);
    else if (documentation(name)) result.documentationChanges.push(name);
    else result.blocked.push(name);
  }
  return result;
}
function hotfixCoverage(files, selected = AUDIO_HOTFIX_TESTS) {
  assert.deepEqual(selected, AUDIO_HOTFIX_TESTS, 'Audio hotfix test selection changed');
  const tests = testNames(files);
  for (const name of selected)
    assert.ok(tests.includes(name), 'Missing required audio hotfix test: ' + name);
  return {
    executedUnitFiles: [...selected],
    inheritedUnitFiles: [],
    notRunUnitFiles: tests.filter((name) => !selected.includes(name)),
  };
}
function fingerprints(files) {
  const rows = Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const select = (predicate) =>
    objectHash(Object.fromEntries(rows.filter(([name]) => predicate(name))));
  const protectedInput = (name) =>
    !UI.has(name) && !CONTROLLER.has(name) && !freshTest(name) && !documentation(name);
  return {
    protected: select(protectedInput),
    backend: select((name) => name.startsWith('src/server/') || name.startsWith('src/shared/')),
    dependencies: select((name) =>
      [
        'package.json',
        'package-lock.json',
        'Dockerfile',
        'Dockerfile.caddy',
        '.dockerignore',
      ].includes(name),
    ),
    protocol: select(
      (name) =>
        name.startsWith('src/server/http/') ||
        name.startsWith('src/server/application/') ||
        name.startsWith('src/shared/'),
    ),
    fixtures: select(
      (name) =>
        (name.startsWith('tests/helpers/') && !CONTROLLER.has(name)) ||
        name.startsWith('tests/browser/'),
    ),
    executor: select(
      (name) =>
        name.startsWith('scripts/release/remote/') || name === 'scripts/release/image-check.cjs',
    ),
    toolchain: select((name) => name.startsWith('scripts/') && !CONTROLLER.has(name)),
  };
}
function buildProfile(
  candidate,
  baseline,
  proofs,
  { selectionMode, hotfixBase, sessionBase, sessionInputs, behaviorBase } = {},
) {
  assertSelectionMode(selectionMode);
  if (selectionMode === ASSISTANT_BEHAVIOR.selectionMode)
    return behavior.buildBehaviorProfile(candidate, baseline, proofs, behaviorBase);
  if (selectionMode === AUDIO_SESSION.selectionMode)
    return audioSession.buildSessionProfile(
      candidate,
      baseline,
      proofs,
      sessionBase,
      sessionInputs,
    );
  const hotfix = selectionMode === AUDIO_HOTFIX.selectionMode;
  const changes = classifyChanges(baseline.data.files, candidate.data.files);
  assert.deepEqual(changes.blocked, [], 'Changes require the full verification profile');
  const previous = fingerprints(baseline.data.files),
    current = fingerprints(candidate.data.files);
  assert.deepEqual(current, previous, 'Protected dependencies changed; full verification required');
  let hotfixChanges = null;
  if (hotfix) {
    assertHotfixBase(hotfixBase);
    hotfixChanges = classifyHotfixChanges(hotfixBase.files, candidate.data.files);
    assert.deepEqual(hotfixChanges.blocked, [], 'Changes exceed the targeted audio hotfix');
  }
  const freshSelection = hotfix
    ? {
        files: [...AUDIO_HOTFIX_TESTS],
        uncertain: [],
        dependencyHash: objectHash(AUDIO_HOTFIX_TESTS),
        method: AUDIO_HOTFIX.selectionMode,
      }
    : candidate.source
      ? require('./scoped-tests.cjs').selectFreshTests(
          candidate.data.files,
          (name) => fs.readFileSync(safePath(candidate.source, name), 'utf8'),
          testNames(candidate.data.files),
        )
      : {
          files: testNames(candidate.data.files).filter(freshTest),
          uncertain: [],
          dependencyHash: objectHash([]),
        };
  const freshUnitFiles = freshSelection.files;
  assert.ok(freshUnitFiles.length > 0, 'Scoped verification needs fresh tests');
  const native = validateBaselineProof(baseline, proofs);
  const inheritedFiles = hotfix
    ? []
    : testNames(baseline.data.files).filter((name) => !freshUnitFiles.includes(name));
  for (const target of ['windows', 'linux'])
    native[target] = { ...native[target], inheritedFiles, protectedHash: current.protected };
  const body = {
    version: 1,
    policy: POLICY,
    profile: 'assistant-ui',
    ...(hotfix
      ? {
          selectionMode,
          scope: 'targeted',
          fullVerification: false,
          productionBase: { ...AUDIO_HOTFIX },
          hotfixChanges,
          coverage: hotfixCoverage(candidate.data.files, freshUnitFiles),
        }
      : {}),
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    baseline: {
      id: baseline.data.id,
      sourceHash: baseline.data.sourceHash,
      imageId: proofs.image.report.imageId,
    },
    changes,
    fingerprints: current,
    freshUnitFiles,
    freshSelection,
    inheritedNative: native,
    qualification: {
      controllerHash: controllerHash(candidate.data.files),
      changedController: changes.controllerChanges,
      freshReleaseTests: freshUnitFiles.filter((name) => name.startsWith('tests/release-')),
    },
    standPartition: { inherited: NAMES.slice(0, 33), fresh: NAMES.slice(33) },
    inheritedStand: proofs.stand.proof,
    baselineImage: proofs.image.proof,
    evidence: proofs.evidence,
  };
  return { ...body, profileHash: objectHash(body) };
}
function assertManifest(before, after) {
  const strip = (value) => ({
    ...value,
    factories: value.factories.map((factory) => {
      if (
        ![
          'src/client/modules/assistant-speech.js',
          'src/client/modules/voice-assistant.js',
        ].includes(factory.path)
      )
        return factory;
      return {
        ...factory,
        dependencies: factory.dependencies.filter(
          (name) => !['releaseAssistantAudio', 'unlockAssistantAudio'].includes(name),
        ),
      };
    }),
  });
  assert.deepEqual(
    strip(after),
    strip(before),
    'Client manifest changes exceed the reviewed audio dependency bridge',
  );
}
function assertInputs(candidate, baseline, proofs, selectionMode) {
  assertBaseline(baseline);
  assert.equal(
    objectHash(candidate.data.files),
    candidate.data.sourceHash,
    'Candidate manifest changed',
  );
  if (
    selectionMode !== AUDIO_SESSION.selectionMode &&
    selectionMode !== ASSISTANT_BEHAVIOR.selectionMode
  ) {
    const client = JSON.parse(read(safePath(candidate.source, 'src/client/manifest.json')));
    assertManifest(proofs.clientManifest, client);
  }
  const current = JSON.parse(read(safePath(candidate.source, 'release-baseline.json')));
  assert.deepEqual(
    current,
    { version: 1, candidate: BASELINE.id, sourceHash: BASELINE.sourceHash },
    'Publication baseline changed',
  );
}
function prepareProfile(root, candidate, { profile = 'full', baselineId, selectionMode } = {}) {
  assertSelectionMode(selectionMode);
  if (profile === 'full') {
    assert.equal(
      selectionMode,
      undefined,
      'Full verification cannot use an audio hotfix selection',
    );
    return null;
  }
  assert.equal(candidate.data.selectionMode, selectionMode, 'Candidate selection mode differs');
  assert.equal(profile, 'assistant-ui', 'Unknown verification profile');
  assert.equal(baselineId, BASELINE.id, 'Only the reviewed full41 baseline qualifies');
  const { location } = require('./state.cjs');
  const directory = location(root, baselineId);
  // The historical source is not executed. Its exact manifest and pinned raw
  // evidence suffice; a code-only transport need not include another checkout.
  const baseline = {
    directory,
    source: safePath(directory, 'source'),
    data: JSON.parse(read(safePath(directory, 'candidate.json'))),
  };
  const { proofs } = copyBaseline(baseline, candidate.directory);
  assertInputs(candidate, baseline, proofs, selectionMode);
  let hotfixBase;
  if (selectionMode === AUDIO_HOTFIX.selectionMode) {
    hotfixBase = assertHotfixBase(
      JSON.parse(read(safePath(location(root, AUDIO_HOTFIX.id), 'candidate.json'))),
    );
    fs.writeFileSync(
      safePath(candidate.directory, 'verification-hotfix-base.json'),
      JSON.stringify(hotfixBase, null, 2) + '\n',
      { flag: 'wx' },
    );
  }
  const session =
    selectionMode === AUDIO_SESSION.selectionMode
      ? audioSession.prepareSessionInputs(root, candidate, location)
      : {};
  const behaviorInputs =
    selectionMode === ASSISTANT_BEHAVIOR.selectionMode
      ? behavior.prepareBehaviorInputs(root, candidate, location)
      : {};
  if (selectionMode === ASSISTANT_BEHAVIOR.selectionMode)
    behaviorBridge.prepareBehaviorBridge(root, candidate, location);
  const receipt = buildProfile(candidate, baseline, proofs, {
    selectionMode,
    hotfixBase,
    ...session,
    ...behaviorInputs,
  });
  fs.writeFileSync(
    safePath(candidate.directory, 'verification-profile.json'),
    JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx' },
  );
  return receipt;
}
function verifyProfile(root, candidate) {
  assertSelectionMode(candidate.data.selectionMode);
  const file = safePath(candidate.directory, 'verification-profile.json');
  for (const name of [
    'verification-audio-session-base.json',
    'verification-audio-session-inputs.json',
  ])
    if (candidate.data.selectionMode !== AUDIO_SESSION.selectionMode)
      assert.ok(
        !fs.existsSync(safePath(candidate.directory, name)),
        'Unexpected audio-session sidecar',
      );
  if (candidate.data.selectionMode !== ASSISTANT_BEHAVIOR.selectionMode)
    for (const name of [
      'verification-assistant-behavior-base.json',
      'verification-assistant-behavior-published-stand.json',
      'verification-assistant-behavior-published-profile.json',
    ])
      assert.ok(
        !fs.existsSync(safePath(candidate.directory, name)),
        'Unexpected assistant-behavior sidecar',
      );
  if (!candidate.data.profile || candidate.data.profile === 'full') {
    assert.ok(!fs.existsSync(file), 'Full candidate contains unexpected scoped receipt');
    assert.equal(
      candidate.data.selectionMode,
      undefined,
      'Full candidate contains targeted selection',
    );
    assert.ok(
      !fs.existsSync(safePath(candidate.directory, 'verification-hotfix-base.json')),
      'Full candidate contains unexpected hotfix base',
    );
    return null;
  }
  assert.equal(candidate.data.profile, 'assistant-ui', 'Unknown candidate verification profile');
  const receipt = JSON.parse(read(file));
  const { baseline, proofs } = loadBaseline(candidate.directory);
  const selectionMode = candidate.data.selectionMode;
  assertInputs(candidate, baseline, proofs, selectionMode);
  const hotfixFile = safePath(candidate.directory, 'verification-hotfix-base.json');
  const hotfixBase =
    selectionMode === AUDIO_HOTFIX.selectionMode ? JSON.parse(read(hotfixFile)) : undefined;
  if (selectionMode !== AUDIO_HOTFIX.selectionMode)
    assert.ok(!fs.existsSync(hotfixFile), 'Scoped candidate contains an unexpected hotfix base');
  const session =
    selectionMode === AUDIO_SESSION.selectionMode ? audioSession.loadSessionInputs(candidate) : {};
  const behaviorInputs =
    selectionMode === ASSISTANT_BEHAVIOR.selectionMode
      ? behavior.loadBehaviorInputs(candidate)
      : {};
  const expected = buildProfile(candidate, baseline, proofs, {
    selectionMode,
    hotfixBase,
    ...session,
    ...behaviorInputs,
  });
  assert.deepEqual(receipt, expected, 'Scoped profile evidence changed');
  assert.equal(
    candidate.data.profileHash,
    expected.profileHash,
    'Candidate profile identity changed',
  );
  return expected;
}
function scopePlan(plan, profile, { target } = {}) {
  if (!profile) return plan;
  assertSelectionMode(profile.selectionMode);
  const hotfix = profile.selectionMode === AUDIO_HOTFIX.selectionMode;
  const session = profile.selectionMode === AUDIO_SESSION.selectionMode;
  const assistantBehavior = profile.selectionMode === ASSISTANT_BEHAVIOR.selectionMode;
  if (assistantBehavior) {
    assert.ok(
      ['windows', 'linux'].includes(target),
      'Assistant-behavior plan needs its explicit native target',
    );
    assert.equal(profile.scope, 'targeted', 'Assistant-behavior scope must be targeted');
    assert.equal(profile.fullVerification, false, 'Assistant-behavior cannot claim a full run');
    assert.deepEqual(
      profile.freshUnitFiles,
      BEHAVIOR_TESTS,
      'Assistant-behavior test selection changed',
    );
    assert.deepEqual(
      profile.coverage?.executedUnitFiles,
      BEHAVIOR_TESTS,
      'Assistant-behavior executed coverage changed',
    );
    assert.deepEqual(
      profile.coverage?.inheritedUnitFiles,
      [],
      'Assistant-behavior cannot inherit omitted unit work',
    );
  }
  if (session) {
    assert.ok(
      ['windows', 'linux'].includes(target),
      'Audio-session plan needs its explicit native target',
    );
    assert.equal(profile.scope, 'targeted', 'Audio-session scope must be targeted');
    assert.equal(profile.fullVerification, false, 'Audio-session cannot claim a full run');
    assert.deepEqual(
      profile.freshUnitFiles,
      AUDIO_SESSION_TESTS,
      'Audio-session test selection changed',
    );
    assert.deepEqual(
      profile.coverage?.executedUnitFiles,
      AUDIO_SESSION_TESTS,
      'Audio-session executed coverage changed',
    );
    assert.deepEqual(
      profile.coverage?.inheritedUnitFiles,
      [],
      'Audio-session cannot inherit omitted unit work',
    );
  }
  if (hotfix) {
    assert.equal(profile.scope, 'targeted', 'Audio hotfix must be reported as targeted');
    assert.equal(profile.fullVerification, false, 'Audio hotfix cannot claim a full run');
    assert.deepEqual(
      profile.freshUnitFiles,
      AUDIO_HOTFIX_TESTS,
      'Audio hotfix test selection changed',
    );
    assert.deepEqual(
      profile.coverage?.executedUnitFiles,
      AUDIO_HOTFIX_TESTS,
      'Audio hotfix executed coverage changed',
    );
    assert.deepEqual(
      profile.coverage?.inheritedUnitFiles,
      [],
      'Audio hotfix cannot inherit omitted unit work',
    );
  }
  const files = profile.freshUnitFiles;
  if (profile.freshSelection)
    assert.deepEqual(files, profile.freshSelection.files, 'Fresh dependency selection differs');
  assert.ok(
    Array.isArray(files) &&
      files.length > 0 &&
      files.every(
        (name) =>
          freshTest(name) ||
          (/^(?:[\w-]+|tests\/[\w-]+)\.test\.cjs$/.test(name) &&
            profile.freshSelection?.files.includes(name)),
      ),
    'Invalid fresh test selection',
  );
  assert.deepEqual(files, [...new Set(files)].sort(), 'Fresh selection must be unique and sorted');
  assert.equal(
    plan.filter((step) => step.id === 'unit').length,
    1,
    'Scoped profile needs one unit step',
  );
  assert.ok(!plan.some((step) => /^unit-/.test(step.id)), 'Scoped profile cannot be sharded');
  const selectedPlan =
    hotfix || session || assistantBehavior
      ? plan.filter((step) => ['architecture', 'format', 'diff', 'unit'].includes(step.id))
      : plan;
  if (hotfix || session || assistantBehavior)
    assert.deepEqual(
      selectedPlan.map((step) => step.id),
      ['architecture', 'format', 'diff', 'unit'],
      'Audio hotfix quality or unit plan is incomplete',
    );
  return selectedPlan.map((step) =>
    step.id !== 'unit'
      ? step
      : {
          ...step,
          unitFiles: [...files],
          ...(session || assistantBehavior
            ? {
                env:
                  target === 'windows'
                    ? {
                        CARTOTECA_PLAYBACK_BROWSER: '1',
                        ...(assistantBehavior ? { CARTOTECA_BARGE_BUNDLE_BROWSER: '1' } : {}),
                        CARTOTECA_CHROMIUM_CHANNEL: 'msedge',
                      }
                    : {
                        CARTOTECA_PLAYBACK_BROWSER: '0',
                        ...(assistantBehavior ? { CARTOTECA_BARGE_BUNDLE_BROWSER: '0' } : {}),
                      },
              }
            : {}),
          args: [
            '--max-old-space-size=512',
            ...step.args.filter(
              (arg) =>
                !arg.endsWith('.test.cjs') &&
                !arg.startsWith('--test-concurrency=') &&
                !arg.startsWith('--max-old-space-size='),
            ),
            '--test-concurrency=1',
            ...files,
          ],
        },
  );
}
function mergeStand(root, candidate, freshReport, binding) {
  return require('./scoped-stand.cjs').composeStand(candidate, freshReport, binding);
}
function validateScopedStand(root, candidate, report) {
  return require('./scoped-stand.cjs').validateScopedStand(root, candidate, report);
}
module.exports = {
  prepareProfile,
  verifyProfile,
  buildProfile,
  classifyChanges,
  fingerprints,
  assertSelectionMode,
  assertHotfixBase,
  classifyHotfixChanges,
  hotfixCoverage,
  scopePlan,
  validateScopedReport,
  mergeStand,
  composeStand: (...args) => require('./scoped-stand.cjs').composeStand(...args),
  validateScopedStand,
};
