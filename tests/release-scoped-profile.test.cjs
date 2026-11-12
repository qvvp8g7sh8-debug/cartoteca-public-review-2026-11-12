const test = require('node:test');
const assert = require('node:assert/strict');
const { hash, objectHash } = require('../scripts/release/files.cjs');
const profileModule = () => require('../scripts/release/verification-profile.cjs');

const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: hash(text) });
const base = () => ({
  Dockerfile: entry('FROM synthetic:1'),
  'package.json': entry('{"private":true}'),
  'package-lock.json': entry('{"lockfileVersion":3}'),
  'src/client/modules/assistant-audio.js': entry('// original audio'),
  'src/client/modules/assistant-speech.js': entry('// original speech'),
  'src/client/core/module-ports.js': entry('// ordinary shared ports'),
  'src/server/application/assistant-runtime.cjs': entry('// server permissions and writes'),
  'src/shared/assistant-contract.cjs': entry('// request validation'),
  'scripts/release/remote/operations.py': entry('# deployment executor'),
  'scripts/release/remote/checks.py': entry('# image/runtime checks'),
  'scripts/release/remote/migration.py': entry('# migration and restore'),
  'tests/helpers/release-stand.py': entry('# stand scenario runner'),
  'tests/helpers/release-stand-fixture.py': entry('# synthetic stand fixture'),
  'docs/RELEASES.md': entry('# release policy'),
});
const replace = (files, file) => ({
  ...files,
  [file]: entry('changed synthetic content: ' + file),
});

test('assistant-only classification admits the actual player change without accepting unrelated source', () => {
  const { classifyChanges } = profileModule();
  const before = base();
  const after = replace(before, 'src/client/modules/assistant-audio.js');
  const result = classifyChanges(before, after);
  assert.equal(result.blocked.length, 0);
  assert.ok(result.uiChanges.length > 0);
  assert.equal(result.controllerChanges.length, 0);
  assert.equal(result.documentationChanges.length, 0);
});

test('unknown frontend code and helper paths cannot inherit backend verification', () => {
  const { classifyChanges } = profileModule();
  for (const file of [
    'src/client/modules/not-reviewed-assistant.js',
    'src/client/modules/work-schedule-editor.js',
    'src/client/core/module-ports.js',
    'src/client/modules/assistant-audio-worker-unreviewed.js',
    'scripts/release/remote/unreviewed.py',
    'scripts/release/unreviewed-admission.cjs',
    'tests/helpers/unreviewed-release-fixture.cjs',
    '.github/workflows/release.yml',
  ]) {
    const before = base();
    const result = classifyChanges(before, replace(before, file));
    assert.ok(result.blocked.length > 0, file);
  }
});

test('backend, dependency, deployment and scenario changes require the full profile', () => {
  const { classifyChanges } = profileModule();
  for (const file of [
    'Dockerfile',
    'package.json',
    'package-lock.json',
    'scripts/build-client.cjs',
    'scripts/check-architecture.cjs',
    'src/server/application/assistant-runtime.cjs',
    'src/shared/assistant-contract.cjs',
    'scripts/release/remote/operations.py',
    'scripts/release/remote/checks.py',
    'scripts/release/remote/migration.py',
    'tests/helpers/release-stand.py',
    'tests/helpers/release-stand-fixture.py',
  ]) {
    const before = base();
    const result = classifyChanges(before, replace(before, file));
    assert.ok(result.blocked.length > 0, file);
  }
});

test('deleting a declared assistant source is not treated as a harmless UI-only change', () => {
  const { classifyChanges } = profileModule();
  const before = base();
  const after = { ...before };
  delete after['src/client/modules/assistant-audio.js'];
  assert.ok(classifyChanges(before, after).blocked.length > 0);
});

test('protected fingerprints ignore assistant bytes but detect changed backend inputs', () => {
  const { fingerprints } = profileModule();
  const before = base();
  assert.deepEqual(
    fingerprints(before),
    fingerprints(replace(before, 'src/client/modules/assistant-audio.js')),
  );
  assert.deepEqual(fingerprints(before), fingerprints(replace(before, 'docs/RELEASES.md')));
  for (const file of [
    'Dockerfile',
    'package-lock.json',
    'scripts/build-client.cjs',
    'scripts/check-architecture.cjs',
    'src/server/application/assistant-runtime.cjs',
    'src/shared/assistant-contract.cjs',
    'scripts/release/remote/operations.py',
    'tests/helpers/release-stand.py',
    'tests/helpers/release-stand-fixture.py',
  ])
    assert.notEqual(
      objectHash(fingerprints(before)),
      objectHash(fingerprints(replace(before, file))),
      file,
    );
});

test('protected fingerprints are stable under manifest key reordering', () => {
  const { fingerprints } = profileModule();
  const before = base();
  const reversed = Object.fromEntries(Object.entries(before).reverse());
  assert.deepEqual(fingerprints(before), fingerprints(reversed));
});

test('full is the default policy and requires no inherited profile proof', () => {
  const { prepareProfile, verifyProfile } = profileModule();
  for (const data of [{ profile: 'full' }, {}]) {
    assert.equal(prepareProfile('unused-synthetic-root', { data }, { profile: 'full' }), null);
    assert.equal(verifyProfile('unused-synthetic-root', { directory: __dirname, data }), null);
  }
});

test('scoped plans keep every quality and browser step and replace only unit coverage', () => {
  const { scopePlan } = profileModule();
  const quality = {
    id: 'architecture',
    phase: 'quality',
    args: ['scripts/check-architecture.cjs', '--check'],
  };
  const browser = {
    id: 'main-webkit-mobile',
    phase: 'tests',
    browserCoverage: { suite: 'main', engine: 'webkit', functionalWidth: 390 },
    args: ['scripts/test-browsers.cjs'],
  };
  const selected = ['tests/assistant-audio.test.cjs', 'tests/assistant-speech.test.cjs'];
  const plan = [
    quality,
    {
      id: 'unit',
      phase: 'tests',
      args: ['--test', '--test-concurrency=2', ...selected, 'tests/unrelated-backend.test.cjs'],
    },
    browser,
  ];
  const result = scopePlan(plan, { freshUnitFiles: selected });
  assert.deepEqual(
    result.filter((step) => step.id !== 'unit'),
    [quality, browser],
  );
  const unit = result.find((step) => step.id === 'unit');
  assert.deepEqual(unit.unitFiles, selected);
  for (const file of selected) assert.ok(unit.args.includes(file), file);
  assert.equal(unit.args.includes('tests/unrelated-backend.test.cjs'), false);
  assert.ok(unit.args.includes('--test-concurrency=1'));
  assert.ok(unit.args.includes('--max-old-space-size=512'));
  assert.deepEqual(plan[1].args, [
    '--test',
    '--test-concurrency=2',
    ...selected,
    'tests/unrelated-backend.test.cjs',
  ]);
});

test('scoped selection rejects undeclared backend tests, duplicates, unsorted coverage and sharded plans', () => {
  const { scopePlan } = profileModule();
  const plan = [{ id: 'unit', phase: 'tests', args: ['--test', 'tests/assistant-audio.test.cjs'] }];
  for (const freshUnitFiles of [
    [],
    ['tests/unrelated-backend.test.cjs'],
    ['tests/assistant-audio.test.cjs', 'tests/assistant-audio.test.cjs'],
    ['tests/assistant-speech.test.cjs', 'tests/assistant-audio.test.cjs'],
  ])
    assert.throws(() => scopePlan(plan, { freshUnitFiles }));
  assert.throws(() =>
    scopePlan([{ id: 'unit-1', args: ['--test'] }], {
      freshUnitFiles: ['tests/assistant-audio.test.cjs'],
    }),
  );
  assert.strictEqual(scopePlan(plan, null), plan);
});

test('fresh test selection follows literal transitive client dependencies and inherits only closed backend tests', () => {
  const { selectFreshTests } = require('../scripts/release/scoped-tests.cjs');
  const source = {
    'src/client/modules/assistant-audio.js': 'module.exports = {};',
    'src/server/modules/pure.cjs': 'module.exports = (value) => value;',
    'tests/helpers/client-reader.cjs':
      "module.exports = require('../../src/client/modules/assistant-audio.js');",
    'tests/client-transitive.test.cjs': "const client = require('./helpers/client-reader.cjs');",
    'tests/backend-closed.test.cjs': "const pure = require('../src/server/modules/pure.cjs');",
  };
  const files = Object.fromEntries(
    Object.entries(source).map(([name, text]) => [name, entry(text)]),
  );
  const result = selectFreshTests(files, (name) => source[name], [
    'tests/client-transitive.test.cjs',
    'tests/backend-closed.test.cjs',
  ]);
  assert.deepEqual(result.files, ['tests/client-transitive.test.cjs']);
});

test('dynamic imports, filesystem helpers and their consumers always receive fresh coverage', () => {
  const { selectFreshTests } = require('../scripts/release/scoped-tests.cjs');
  const source = {
    'tests/helpers/runtime-reader.cjs':
      "module.exports = require('node:fs').readFileSync(process.argv[2]);",
    'tests/fs-dependent.test.cjs': "require('./helpers/runtime-reader.cjs');",
    'tests/dynamic-dependent.test.cjs': 'require(process.argv[2]);',
    'tests/import-dependent.test.cjs': 'import(process.argv[2]);',
  };
  const files = Object.fromEntries(
    Object.entries(source).map(([name, text]) => [name, entry(text)]),
  );
  const tests = Object.keys(source)
    .filter((name) => name.endsWith('.test.cjs'))
    .sort();
  assert.deepEqual(selectFreshTests(files, (name) => source[name], tests).files, tests);
});
