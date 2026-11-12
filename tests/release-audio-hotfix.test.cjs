const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash, objectHash, controllerHash } = require('../scripts/release/files.cjs');
const { validateUnitEvents } = require('../scripts/release/unit-report.cjs');
const {
  AUDIO_HOTFIX,
  AUDIO_HOTFIX_UI,
  AUDIO_HOTFIX_TESTS,
  CONTROLLER,
} = require('../scripts/release/verification-profile-policy.cjs');
const {
  assertSelectionMode,
  assertHotfixBase,
  classifyHotfixChanges,
  hotfixCoverage,
  buildProfile,
  scopePlan,
  validateScopedReport,
} = require('../scripts/release/verification-profile.cjs');
const { steps } = require('../scripts/release/plan.cjs');

const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: hash(text) });
const clone = (value) => JSON.parse(JSON.stringify(value));
const files = () => ({
  ...Object.fromEntries(AUDIO_HOTFIX_TESTS.map((name) => [name, entry('// synthetic test')])),
  ...Object.fromEntries([...AUDIO_HOTFIX_UI].map((name) => [name, entry('// synthetic client')])),
  'package-lock.json': entry('{}'),
  'tests/not-selected-backend.test.cjs': entry('// synthetic omitted test'),
  'src/server/application/example.cjs': entry('// synthetic unchanged server'),
});
const profile = (manifest = files()) => ({
  selectionMode: AUDIO_HOTFIX.selectionMode,
  scope: 'targeted',
  fullVerification: false,
  freshUnitFiles: [...AUDIO_HOTFIX_TESTS],
  freshSelection: { files: [...AUDIO_HOTFIX_TESTS] },
  coverage: hotfixCoverage(manifest),
});
const replace = (manifest, name) => ({
  ...manifest,
  [name]: entry('changed synthetic source: ' + name),
});

test('audio hotfix is an explicit finite mode pinned to the actually published source and image', () => {
  assert.equal(AUDIO_HOTFIX.selectionMode, 'client-audio-hotfix-v1');
  assert.equal(AUDIO_HOTFIX.id, 'assistant-mobile-20261018-43');
  assert.equal(
    AUDIO_HOTFIX.sourceHash,
    'a522b10daa1887315c392778291786fced073a5c78f2646df01498157d821682',
  );
  assert.equal(
    AUDIO_HOTFIX.imageId,
    'sha256:018094e72a666fa19f5068427057be2ebf340e9eac38d27c936746368e9d4980',
  );
  assert.doesNotThrow(() => assertSelectionMode(undefined));
  assert.doesNotThrow(() => assertSelectionMode(AUDIO_HOTFIX.selectionMode));
  for (const mode of ['', 'all', 'manual', 'client-audio-hotfix-v2'])
    assert.throws(() => assertSelectionMode(mode), /Unknown scoped selection mode/);
});

test('audio hotfix admits only its two client modules and three generated bundles', () => {
  assert.deepEqual([...AUDIO_HOTFIX_UI].sort(), [
    'app-assistant.js',
    'app-settings.js',
    'app.js',
    'src/client/modules/assistant-audio.js',
    'src/client/modules/assistant-trigger.js',
  ]);
  const before = files();
  for (const name of AUDIO_HOTFIX_UI) {
    const result = classifyHotfixChanges(before, replace(before, name));
    assert.deepEqual(result.blocked, []);
    assert.deepEqual(result.uiChanges, [name]);
  }
});

test('audio hotfix refuses server, dependencies, executor, shared contracts and other client changes', () => {
  const before = files();
  for (const name of [
    'src/server/application/example.cjs',
    'src/shared/assistant-contract.cjs',
    'src/client/modules/assistant-speech.js',
    'src/client/modules/assistant-presentation.js',
    'src/client/modules/voice-assistant.js',
    'src/client/modules/work-schedule-editor.js',
    'src/client/manifest.json',
    'src/client/contracts/ports.d.ts',
    'src/client/styles/voice-assistant.css',
    'ui-extra.css',
    'package.json',
    'package-lock.json',
    'Dockerfile',
    '.dockerignore',
    'compose.yaml',
    'scripts/build-client.cjs',
    'scripts/release/remote/operations.py',
    'scripts/release/unreviewed.cjs',
    'tests/browser/unreviewed.cjs',
    'tests/unreviewed-audio.test.cjs',
  ])
    assert.deepEqual(classifyHotfixChanges(before, replace(before, name)).blocked, [name], name);
});

test('audio hotfix admits only finite selected tests, reviewed controller paths and documentation', () => {
  const before = files();
  for (const name of [
    ...AUDIO_HOTFIX_TESTS,
    ...CONTROLLER,
    'docs/STATUS.md',
    'docs/VOICE-ASSISTANT.md',
  ])
    assert.deepEqual(classifyHotfixChanges(before, replace(before, name)).blocked, [], name);
  const after = { ...before };
  delete after['src/client/modules/assistant-audio.js'];
  assert.deepEqual(classifyHotfixChanges(before, after).blocked, [
    'src/client/modules/assistant-audio.js',
  ]);
});

test('published base cannot be missing, substituted or reconstructed with a changed manifest', () => {
  for (const value of [
    undefined,
    {},
    { version: 1, files: {} },
    { version: 1, id: 'different-release', files: {} },
    {
      version: 1,
      id: AUDIO_HOTFIX.id,
      profile: 'full',
      sourceHash: AUDIO_HOTFIX.sourceHash,
      files: {},
    },
    {
      version: 1,
      id: AUDIO_HOTFIX.id,
      profile: 'assistant-ui',
      sourceHash: hash('foreign source'),
      files: {},
    },
    {
      version: 1,
      id: AUDIO_HOTFIX.id,
      profile: 'assistant-ui',
      sourceHash: AUDIO_HOTFIX.sourceHash,
      files: { 'app.js': entry('// modified manifest') },
    },
  ])
    assert.throws(() => assertHotfixBase(value));
});

test('hotfix profile cannot be built without its published base even when protected bytes match', () => {
  const manifest = files();
  const candidate = {
    data: { id: 'synthetic-hotfix', files: manifest, sourceHash: objectHash(manifest) },
  };
  assert.throws(
    () =>
      buildProfile(
        candidate,
        { data: { files: manifest } },
        {},
        {
          selectionMode: AUDIO_HOTFIX.selectionMode,
        },
      ),
    /Missing published audio hotfix base/,
  );
  assert.throws(
    () => buildProfile(candidate, { data: { files: manifest } }, {}, { selectionMode: 'manual' }),
    /Unknown scoped selection mode/,
  );
});

test('targeted coverage names every fresh file and every omitted file without inherited unit claims', () => {
  const coverage = hotfixCoverage(files());
  assert.equal(coverage.executedUnitFiles.length, 23);
  assert.deepEqual(coverage.executedUnitFiles, AUDIO_HOTFIX_TESTS);
  assert.deepEqual(coverage.inheritedUnitFiles, []);
  assert.deepEqual(coverage.notRunUnitFiles, ['tests/not-selected-backend.test.cjs']);
  assert.equal(new Set(coverage.executedUnitFiles).size, coverage.executedUnitFiles.length);
  assert.deepEqual([...coverage.executedUnitFiles].sort(), coverage.executedUnitFiles);
  for (const selected of [
    AUDIO_HOTFIX_TESTS.slice(1),
    [...AUDIO_HOTFIX_TESTS, 'tests/not-selected-backend.test.cjs'],
    [...AUDIO_HOTFIX_TESTS].reverse(),
  ])
    assert.throws(() => hotfixCoverage(files(), selected), /test selection changed/);
  const incomplete = files();
  delete incomplete[AUDIO_HOTFIX_TESTS[0]];
  assert.throws(() => hotfixCoverage(incomplete), /Missing required audio hotfix test/);
});

test('targeted plan keeps quality and unit work and does not run global browser matrices', () => {
  const plan = [
    { id: 'architecture', phase: 'quality', args: ['scripts/check-architecture.cjs', '--check'] },
    { id: 'format', phase: 'quality', args: ['prettier', '--check'] },
    { id: 'diff', phase: 'quality', args: ['diff', '--check'] },
    {
      id: 'unit',
      phase: 'tests',
      args: ['--test', '--test-concurrency=2', ...AUDIO_HOTFIX_TESTS, 'tests/omitted.test.cjs'],
    },
    { id: 'main-webkit-mobile', browserCoverage: { engine: 'webkit' } },
    { id: 'admin-chromium-desktop', browserCoverage: { engine: 'chromium' } },
  ];
  const selected = scopePlan(plan, profile());
  assert.deepEqual(
    selected.map((step) => step.id),
    ['architecture', 'format', 'diff', 'unit'],
  );
  const unit = selected.at(-1);
  assert.deepEqual(unit.unitFiles, AUDIO_HOTFIX_TESTS);
  assert.ok(unit.args.includes('--max-old-space-size=512'));
  assert.ok(unit.args.includes('--test-concurrency=1'));
  assert.ok(!unit.args.includes('tests/omitted.test.cjs'));
  assert.equal(plan.length, 6);
  for (const mutate of [
    (p) => {
      p.scope = 'full';
    },
    (p) => {
      p.fullVerification = true;
    },
    (p) => {
      p.freshUnitFiles.pop();
    },
    (p) => {
      p.coverage.executedUnitFiles.pop();
    },
    (p) => {
      p.coverage.inheritedUnitFiles = ['tests/omitted.test.cjs'];
    },
    (p) => {
      p.selectionMode = 'manual';
    },
  ]) {
    const changed = clone(profile());
    mutate(changed);
    assert.throws(() => scopePlan(plan, changed));
  }
  assert.throws(() =>
    scopePlan(
      plan.filter((step) => step.id !== 'architecture'),
      profile(),
    ),
  );
});

function reportFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-audio-hotfix-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'tests'), { recursive: true });
  const manifest = files();
  for (const name of Object.keys(manifest).filter((name) => name.endsWith('.test.cjs')))
    fs.writeFileSync(path.join(source, name), '// synthetic test\n');
  const candidate = {
    directory,
    source,
    data: {
      id: 'synthetic-audio-hotfix',
      files: manifest,
      sourceHash: objectHash(manifest),
    },
  };
  const inherited = {
    inheritedFiles: [],
    environment: {
      node: 'v24.19.0',
      os: 'win32',
      arch: 'x64',
      osRelease: 'synthetic-kernel',
      lockHash: manifest['package-lock.json'].sha256,
    },
  };
  const sealed = {
    ...profile(manifest),
    profileHash: hash('synthetic sealed profile'),
    inheritedNative: { windows: inherited },
  };
  const plan = scopePlan(steps(source, { target: 'windows', unitWorkers: 1 }), sealed);
  const counts = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
  const text =
    [
      ...AUDIO_HOTFIX_TESTS.map((file) => ({ type: 'test:summary', file, counts })),
      {
        type: 'test:summary',
        counts: { ...counts, tests: AUDIO_HOTFIX_TESTS.length, passed: AUDIO_HOTFIX_TESTS.length },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'unit.jsonl'), text);
  const report = {
    version: 1,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    target: 'windows',
    status: 'passed',
    profile: 'assistant-ui',
    profileHash: sealed.profileHash,
    selectionMode: sealed.selectionMode,
    scope: 'targeted',
    fullVerification: false,
    coverage: clone(sealed.coverage),
    inheritedBackend: clone(inherited),
    selectedPhase: 'all',
    settings: {
      unitWorkers: 1,
      unitShards: 1,
      verificationProfileHash: sealed.profileHash,
    },
    planHash: objectHash(plan),
    selectionHash: objectHash(plan),
    environment: { ...inherited.environment, controllerHash: controllerHash(manifest) },
    steps: [
      { id: 'dependencies', status: 'passed' },
      ...plan.map((step) => ({
        id: step.id,
        status: 'passed',
        inputHash: objectHash(step),
        ...(step.id === 'unit'
          ? { details: 'unit.jsonl', unitSummary: validateUnitEvents(text, AUDIO_HOTFIX_TESTS) }
          : {}),
      })),
    ],
  };
  return { candidate, sealed, report };
}

test('a targeted native report validates actual per-file raw evidence without claiming a full run', (t) => {
  const f = reportFixture(t);
  assert.equal(validateScopedReport(f.candidate, 'windows', f.report, f.sealed), true);
  for (const mutate of [
    (r) => {
      r.scope = 'full';
    },
    (r) => {
      r.fullVerification = true;
    },
    (r) => {
      r.selectionMode = 'manual';
    },
    (r) => {
      r.coverage.executedUnitFiles.pop();
    },
    (r) => {
      r.coverage.notRunUnitFiles = [];
    },
    (r) => {
      r.coverage.inheritedUnitFiles = ['tests/not-selected-backend.test.cjs'];
    },
    (r) => {
      r.planHash = hash('arbitrary shorter plan');
    },
    (r) => {
      r.selectionHash = hash('arbitrary shorter selection');
    },
    (r) => {
      r.steps.pop();
    },
    (r) => {
      r.steps.at(-1).unitSummary.counts.passed++;
    },
    (r) => {
      r.environment.osRelease = 'other environment';
    },
  ]) {
    const changed = clone(f.report);
    mutate(changed);
    assert.throws(() => validateScopedReport(f.candidate, 'windows', changed, f.sealed));
  }
  const claimed = clone(f.sealed);
  claimed.inheritedNative.windows.inheritedFiles = ['tests/not-selected-backend.test.cjs'];
  assert.throws(() => validateScopedReport(f.candidate, 'windows', f.report, claimed));
});
