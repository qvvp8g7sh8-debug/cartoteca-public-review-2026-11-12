const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/release.cjs');
const { prepare } = require('../scripts/release/prepare.cjs');
const {
  ASSISTANT_BEHAVIOR,
  BEHAVIOR_TESTS,
} = require('../scripts/release/verification-assistant-behavior-policy.cjs');
const {
  assertSelectionMode,
  scopePlan,
  verifyProfile,
} = require('../scripts/release/verification-profile.cjs');

const selected = () => ({
  selectionMode: ASSISTANT_BEHAVIOR.selectionMode,
  scope: 'targeted',
  fullVerification: false,
  freshUnitFiles: [...BEHAVIOR_TESTS],
  freshSelection: { files: [...BEHAVIOR_TESTS] },
  coverage: { executedUnitFiles: [...BEHAVIOR_TESTS], inheritedUnitFiles: [] },
});
const plan = () =>
  ['architecture', 'format', 'diff', 'unit', 'browser-chromium'].map((id) => ({
    id,
    command: 'node',
    args: id === 'unit' ? ['--test', '--test-concurrency=4', 'old.test.cjs'] : [],
  }));

test('behavior selection is explicit preparation-only and cannot waive verification at publish', async () => {
  assert.doesNotThrow(() => assertSelectionMode('assistant-behavior-v1'));
  for (const mode of ['assistant-behavior', 'assistant-behavior-v2', 'none'])
    assert.throws(() => assertSelectionMode(mode), /selection/i);
  for (const command of ['verify', 'status', 'package', 'publish', 'resume'])
    await assert.rejects(
      main([
        command,
        '--id',
        'synthetic-never-created',
        '--selection-mode',
        ASSISTANT_BEHAVIOR.selectionMode,
      ]),
      /selection-mode.*prepare/i,
    );
  await assert.rejects(
    main([
      'prepare',
      '--id',
      'synthetic-never-created',
      '--profile',
      'full',
      '--selection-mode',
      ASSISTANT_BEHAVIOR.selectionMode,
    ]),
    /selection-mode.*prepare/i,
  );
  await assert.rejects(
    prepare('synthetic-never-created', 'never-created', undefined, {
      profile: 'assistant-ui',
      baselineId: 'synthetic',
      selectionMode: 'assistant-behavior-v2',
    }),
    /selection mode/i,
  );
});

test('behavior native plans retain exact finite units and platform-specific synthetic audio gates', () => {
  for (const target of ['windows', 'linux']) {
    const result = scopePlan(plan(), selected(), { target });
    assert.deepEqual(
      result.map((step) => step.id),
      ['architecture', 'format', 'diff', 'unit'],
    );
    const unit = result.find((step) => step.id === 'unit');
    assert.deepEqual(unit.unitFiles, BEHAVIOR_TESTS);
    assert.ok(unit.args.includes('--max-old-space-size=512'));
    assert.ok(unit.args.includes('--test-concurrency=1'));
    assert.equal(unit.args.includes('--test-concurrency=4'), false);
    assert.equal(unit.args.includes('old.test.cjs'), false);
    assert.deepEqual(unit.env, {
      CARTOTECA_PLAYBACK_BROWSER: target === 'windows' ? '1' : '0',
      CARTOTECA_BARGE_BUNDLE_BROWSER: target === 'windows' ? '1' : '0',
      ...(target === 'windows' ? { CARTOTECA_CHROMIUM_CHANNEL: 'msedge' } : {}),
    });
  }
  assert.throws(() => scopePlan(plan(), selected()), /native target/i);
  for (const patch of [
    { fullVerification: true },
    { scope: 'full' },
    { freshUnitFiles: BEHAVIOR_TESTS.slice(1) },
    { coverage: { executedUnitFiles: [...BEHAVIOR_TESTS], inheritedUnitFiles: ['old.test.cjs'] } },
  ])
    assert.throws(() => scopePlan(plan(), { ...selected(), ...patch }, { target: 'windows' }));
});

test('full or historical profiles reject an unexpected behavior production-base sidecar', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-behavior-sidecar-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const name of [
    'verification-assistant-behavior-base.json',
    'verification-assistant-behavior-published-stand.json',
    'verification-assistant-behavior-published-profile.json',
  ]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, '{}');
    assert.throws(
      () => verifyProfile(directory, { directory, data: { profile: 'full' } }),
      /unexpected assistant-behavior sidecar/i,
    );
    fs.unlinkSync(file);
  }
});
