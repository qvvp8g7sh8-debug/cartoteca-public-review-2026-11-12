const fs = require('node:fs');
const assert = require('node:assert/strict');
const { safePath, hash, objectHash, controllerHash } = require('./files.cjs');
const { BASELINE, POLICY, NAMES, documentation } = require('./verification-profile-policy.cjs');
const { read, testNames, validateBaselineProof } = require('./scoped-evidence.cjs');
const {
  AUDIO_SESSION,
  AUDIO_SESSION_CLIENT,
  AUDIO_SESSION_SERVER,
  AUDIO_SESSION_BRIDGES,
  AUDIO_SESSION_INPUTS,
  AUDIO_SESSION_CONTROL,
  AUDIO_SESSION_TESTS,
  AUDIO_SESSION_HTTP,
} = require('./verification-audio-session-policy.cjs');
const normalize = (value) => value.replace(/\r\n/g, '\n');
function assertSessionBase(data) {
  assert.ok(data && data.version === 1 && data.files, 'Missing published audio-session base');
  assert.equal(data.id, AUDIO_SESSION.id, 'Unqualified audio-session base');
  assert.equal(data.profile, 'assistant-ui', 'Published audio-session base profile differs');
  assert.equal(data.sourceHash, AUDIO_SESSION.sourceHash, 'Published45 source differs');
  assert.equal(objectHash(data.files), AUDIO_SESSION.sourceHash, 'Published45 manifest changed');
  return data;
}
function classifySessionChanges(before, after) {
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
    else if (
      AUDIO_SESSION_CLIENT.has(name) ||
      AUDIO_SESSION_SERVER.has(name) ||
      AUDIO_SESSION_BRIDGES.includes(name) ||
      AUDIO_SESSION_TESTS.includes(name)
    )
      result.uiChanges.push(name);
    else if (AUDIO_SESSION_CONTROL.has(name)) result.controllerChanges.push(name);
    else if (documentation(name)) result.documentationChanges.push(name);
    else result.blocked.push(name);
  }
  return result;
}
function sessionCoverage(files, selected = AUDIO_SESSION_TESTS) {
  assert.deepEqual(selected, AUDIO_SESSION_TESTS, 'Audio-session test selection changed');
  const tests = testNames(files);
  for (const name of selected)
    assert.ok(tests.includes(name), 'Missing required audio-session test: ' + name);
  return {
    executedUnitFiles: [...selected],
    inheritedUnitFiles: [],
    notRunUnitFiles: tests.filter((name) => !selected.includes(name)),
  };
}
// Preserve literal contents while ignoring source formatting. The allowed edits are
// removed first; comparison is of all remaining lexical text, never just imports.
function lexical(text) {
  return (
    normalize(text)
      .match(
        /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[^\s]/g,
      )
      ?.filter((token) => !token.startsWith('//') && !token.startsWith('/*'))
      .join('') || ''
  );
}
function stripWorklet(name, text) {
  const source = normalize(text);
  let matches = 0;
  let stripped;
  if (name === 'Dockerfile') {
    stripped = source.replace(/ assistant-playback-worklet\.js/g, () => {
      matches++;
      return '';
    });
  } else if (name === 'scripts/check-architecture.cjs') {
    stripped = source;
    for (const rule of [
      /const\s+playbackWorkletSource\s*=\s*path\.join\(\s*root\s*,\s*'src\/client\/worklets\/assistant-playback-worklet\.js'\s*\)\s*;/g,
      /const\s+playbackWorkletGlobals\s*=\s*new\s+Set\(\s*\[\s*'AudioWorkletProcessor'\s*,\s*'registerProcessor'\s*,\s*'Int16Array'\s*,\s*'Float32Array'\s*,\s*'sampleRate'\s*,?\s*\]\s*\)\s*;/g,
      /!\(\s*file\s*===\s*playbackWorkletSource\s*&&\s*playbackWorkletGlobals\.has\(\s*n\s*\)\s*\)\s*&&/g,
    ]) {
      let count = 0;
      stripped = stripped.replace(rule, () => {
        count++;
        return '';
      });
      assert.equal(count, 1, 'Invalid scoped playback-worklet architecture bridge');
    }
    return lexical(stripped);
  } else {
    const rule =
      name === 'scripts/build-client.cjs'
        ? /'assistant-playback-worklet\.js'\s*:\s*'src\/client\/worklets\/assistant-playback-worklet\.js'\s*,/g
        : name === 'scripts/release/publication-check.cjs'
          ? /\[\s*'\/assistant-playback-worklet\.js'\s*,\s*401\s*\]\s*,/g
          : /'assistant-playback-worklet\.js'\s*,/g;
    stripped = source.replace(rule, () => {
      matches++;
      return '';
    });
  }
  const expected = name === 'src/server/http/static-files.cjs' ? 3 : 1;
  assert.equal(matches, expected, 'Missing or excessive exact worklet bridge: ' + name);
  if (name === 'Dockerfile') return stripped;
  const tokens = lexical(stripped);
  // Formatting the newly extended version-guard array may add a trailing comma.
  // Normalize only that exact expression, not arbitrary array or object syntax.
  return name === 'src/server/http/static-files.cjs'
    ? tokens.replace(
        "'assistant-capture-worklet.js',].includes(file)",
        "'assistant-capture-worklet.js'].includes(file)",
      )
    : tokens;
}
function assertSessionManifest(before, after) {
  const paths = [...AUDIO_SESSION_CLIENT].filter((name) => name.startsWith('src/client/modules/'));
  const allowed = new Set(paths);
  const strip = (value) => ({
    ...value,
    factories: value.factories.filter((factory) => !allowed.has(factory.path)),
  });
  assert.deepEqual(strip(after), strip(before), 'Unrelated client manifest changed');
  const previous = new Map(before.factories.map((factory) => [factory.path, factory]));
  const seen = new Set();
  for (const factory of after.factories.filter((item) => allowed.has(item.path))) {
    assert.ok(!seen.has(factory.path), 'Duplicate audio-session factory');
    seen.add(factory.path);
    assert.deepEqual(
      Object.keys(factory).sort(),
      ['dependencies', 'factory', 'path', 'phase'],
      'Unexpected audio factory field',
    );
    assert.equal(factory.phase, 'assistant', 'Audio playback must remain deferred');
    assert.equal(
      factory.factory,
      previous.get(factory.path)?.factory || 'createAssistantPlayback',
      'Changed factory identity',
    );
    assert.ok(
      Array.isArray(factory.dependencies) &&
        factory.dependencies.every((name) => /^[a-zA-Z][\w]*$/.test(name)),
      'Invalid audio dependency',
    );
    assert.equal(
      new Set(factory.dependencies).size,
      factory.dependencies.length,
      'Duplicate audio dependency',
    );
  }
  for (const name of paths) assert.ok(seen.has(name), 'Missing audio-session factory: ' + name);
}
function assertSessionInputs(candidate, base, inputs) {
  assert.deepEqual(
    Object.keys(inputs || {}).sort(),
    AUDIO_SESSION_INPUTS,
    'Audio-session input sidecar differs',
  );
  for (const name of AUDIO_SESSION_INPUTS) {
    assert.equal(typeof inputs[name], 'string', 'Invalid audio-session base input');
    assert.equal(
      hash(normalize(inputs[name])),
      base.files[name]?.sha256,
      'Published45 input changed: ' + name,
    );
    const current = read(safePath(candidate.source, name)).toString('utf8');
    assert.equal(
      hash(normalize(current)),
      candidate.data.files[name]?.sha256,
      'Candidate audio input changed: ' + name,
    );
    if (name === 'src/client/manifest.json')
      assertSessionManifest(JSON.parse(inputs[name]), JSON.parse(current));
    else
      assert.equal(
        stripWorklet(name, current),
        name === 'Dockerfile' ? normalize(inputs[name]) : lexical(inputs[name]),
        'Changes exceed the exact worklet asset bridge: ' + name,
      );
  }
  const source = read(
    safePath(candidate.source, 'src/client/worklets/assistant-playback-worklet.js'),
  ).toString('utf8');
  assert.equal(
    candidate.data.files['assistant-playback-worklet.js']?.sha256,
    hash(normalize(source)),
    'Generated playback worklet differs',
  );
}
function sessionFingerprints(files) {
  const rows = Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en'));
  const except = new Set([
    ...AUDIO_SESSION_CLIENT,
    ...AUDIO_SESSION_SERVER,
    ...AUDIO_SESSION_BRIDGES,
    ...AUDIO_SESSION_CONTROL,
    ...AUDIO_SESSION_TESTS,
  ]);
  const select = (predicate) =>
    objectHash(Object.fromEntries(rows.filter(([name]) => predicate(name))));
  return {
    protected: select((name) => !except.has(name) && !documentation(name)),
    backend: select(
      (name) =>
        (name.startsWith('src/server/') || name.startsWith('src/shared/')) &&
        !AUDIO_SESSION_SERVER.has(name),
    ),
    dependencies: select((name) =>
      ['package.json', 'package-lock.json', 'Dockerfile.caddy', '.dockerignore'].includes(name),
    ),
    protocol: select(
      (name) =>
        (name.startsWith('src/server/http/') ||
          name.startsWith('src/server/application/') ||
          name.startsWith('src/shared/')) &&
        !AUDIO_SESSION_SERVER.has(name),
    ),
    fixtures: select(
      (name) =>
        (name.startsWith('tests/helpers/') && !AUDIO_SESSION_CONTROL.has(name)) ||
        name.startsWith('tests/browser/'),
    ),
    executor: select(
      (name) =>
        (name.startsWith('scripts/release/remote/') ||
          name === 'scripts/release/image-check.cjs') &&
        name !== 'scripts/release/remote/probe.cjs',
    ),
    toolchain: select(
      (name) =>
        name.startsWith('scripts/') &&
        !AUDIO_SESSION_CONTROL.has(name) &&
        !AUDIO_SESSION_BRIDGES.includes(name),
    ),
  };
}
function buildSessionProfile(candidate, baseline, proofs, base, inputs) {
  assertSessionBase(base);
  const changes = classifySessionChanges(base.files, candidate.data.files);
  assert.deepEqual(changes.blocked, [], 'Changes exceed the audio-session scope');
  assertSessionInputs(candidate, base, inputs);
  const current = sessionFingerprints(candidate.data.files),
    previous = sessionFingerprints(base.files);
  assert.deepEqual(current, previous, 'Non-audio dependencies changed; full verification required');
  // Only the non-audio runtime/executor components below inherit full41's33 cases.
  const qualified = sessionFingerprints(baseline.data.files);
  for (const name of ['backend', 'dependencies', 'protocol', 'fixtures', 'executor', 'toolchain'])
    assert.equal(current[name], qualified[name], 'Inherited full41 component changed: ' + name);
  const native = validateBaselineProof(baseline, proofs);
  for (const target of ['windows', 'linux'])
    native[target] = { ...native[target], inheritedFiles: [], protectedHash: current.protected };
  const freshUnitFiles = [...AUDIO_SESSION_TESTS];
  const body = {
    version: 1,
    policy: POLICY,
    profile: 'assistant-ui',
    selectionMode: AUDIO_SESSION.selectionMode,
    scope: 'targeted',
    fullVerification: false,
    productionBase: { ...AUDIO_SESSION },
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
    freshSelection: {
      files: freshUnitFiles,
      uncertain: [],
      dependencyHash: objectHash(freshUnitFiles),
      method: AUDIO_SESSION.selectionMode,
    },
    coverage: sessionCoverage(candidate.data.files),
    inheritedNative: native,
    qualification: {
      controllerHash: controllerHash(candidate.data.files),
      changedController: changes.controllerChanges,
      freshReleaseTests: freshUnitFiles.filter((name) => name.startsWith('tests/release-')),
      productionInputsHash: objectHash(inputs),
      nonAudioComponents: [
        'backend',
        'dependencies',
        'protocol',
        'fixtures',
        'executor',
        'toolchain',
      ],
    },
    standPartition: {
      inherited: NAMES.slice(0, 33),
      fresh: NAMES.slice(33),
      freshAudioHttp: [...AUDIO_SESSION_HTTP],
    },
    inheritedStand: proofs.stand.proof,
    baselineImage: proofs.image.proof,
    evidence: proofs.evidence,
  };
  return { ...body, profileHash: objectHash(body) };
}
function prepareSessionInputs(root, candidate, location) {
  const directory = location(root, AUDIO_SESSION.id);
  const base = assertSessionBase(JSON.parse(read(safePath(directory, 'candidate.json'))));
  const inputs = Object.fromEntries(
    AUDIO_SESSION_INPUTS.map((name) => [
      name,
      read(safePath(safePath(directory, 'source'), name)).toString('utf8'),
    ]),
  );
  assertSessionInputs(candidate, base, inputs);
  for (const [name, data] of [
    ['verification-audio-session-base.json', base],
    ['verification-audio-session-inputs.json', inputs],
  ])
    fs.writeFileSync(safePath(candidate.directory, name), JSON.stringify(data, null, 2) + '\n', {
      flag: 'wx',
    });
  return { sessionBase: base, sessionInputs: inputs };
}
function loadSessionInputs(candidate) {
  return {
    sessionBase: assertSessionBase(
      JSON.parse(read(safePath(candidate.directory, 'verification-audio-session-base.json'))),
    ),
    sessionInputs: JSON.parse(
      read(safePath(candidate.directory, 'verification-audio-session-inputs.json')),
    ),
  };
}
function validateSessionUnit(text, target) {
  assert.ok(['windows', 'linux'].includes(target), 'Audio-session raw proof needs native target');
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const browser = rows.filter(
    (row) =>
      row.type === 'test:summary' &&
      String(row.file || '')
        .replaceAll('\\', '/')
        .endsWith('tests/assistant-playback-browser.test.cjs'),
  );
  assert.equal(browser.length, 1, 'Missing exact audio browser unit summary');
  const counts = browser[0].counts;
  if (target === 'windows') {
    assert.equal(counts?.skipped, 0, 'Windows audio browser check cannot be skipped');
    assert.ok(
      counts?.passed >= 1 && counts.failed === 0,
      'Windows audio browser check did not pass',
    );
  } else {
    assert.equal(counts?.passed, 0, 'Linux audio browser check must remain explicitly unexecuted');
    assert.equal(counts?.skipped, 1, 'Linux audio browser omission must be reported');
    assert.equal(counts?.tests, 1, 'Linux audio browser scope changed');
  }
}
function validateAudioHttp(proof, candidate, profile, binding) {
  assert.equal(proof?.version, 1, 'Missing fresh audio HTTP proof');
  assert.equal(proof.candidate, candidate.data.id, 'Audio HTTP candidate differs');
  assert.equal(proof.sourceHash, candidate.data.sourceHash, 'Audio HTTP source differs');
  assert.equal(proof.profileHash, profile.profileHash, 'Audio HTTP profile differs');
  assert.equal(proof.imageId, binding.innerImageId, 'Audio HTTP image differs');
  assert.equal(
    proof.helperSha256,
    candidate.data.files['tests/helpers/release-stand-audio-session.cjs']?.sha256,
    'Audio HTTP helper differs',
  );
  assert.equal(proof.syntheticOnly, true, 'Audio HTTP check must use synthetic data');
  assert.equal(proof.externalProviderRequests, 0, 'Audio HTTP check contacted a live provider');
  assert.deepEqual(
    proof.cases?.map((row) => row.case),
    AUDIO_SESSION_HTTP,
    'Audio HTTP coverage differs',
  );
  assert.ok(
    proof.cases.every((row) => row.passed === true),
    'Fresh audio HTTP check failed',
  );
  assert.equal(proof.passed, true, 'Fresh audio HTTP proof failed');
}
module.exports = {
  assertSessionBase,
  classifySessionChanges,
  sessionCoverage,
  lexical,
  stripWorklet,
  assertSessionManifest,
  assertSessionInputs,
  sessionFingerprints,
  buildSessionProfile,
  prepareSessionInputs,
  loadSessionInputs,
  validateAudioHttp,
  validateSessionUnit,
};
