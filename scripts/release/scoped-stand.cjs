const fs = require('node:fs');
const assert = require('node:assert/strict');
const { safePath, hash, objectHash, controllerHash } = require('./files.cjs');
const { read, loadBaseline } = require('./scoped-evidence.cjs');
const { NAMES, POLICY } = require('./verification-profile-policy.cjs');
const { validateMapping } = require('./scoped-image.cjs');
const { AUDIO_SESSION } = require('./verification-audio-session-policy.cjs');
const { ASSISTANT_BEHAVIOR } = require('./verification-assistant-behavior-policy.cjs');

function stage(row, names) {
  assert.ok(Array.isArray(row.stages), 'Missing fresh publication stages');
  const states = new Map(row.stages.map((item) => [item.stage, item.status]));
  for (const name of names)
    assert.equal(states.get(name), 'passed', 'Fresh publication stage did not pass: ' + name);
  return states;
}
function validateFresh(fresh, candidate, profile, binding) {
  assert.equal(fresh.candidate, candidate.data.id, 'Fresh stand candidate differs');
  assert.equal(fresh.sourceHash, candidate.data.sourceHash, 'Fresh stand source differs');
  assert.equal(fresh.profile, 'assistant-ui', 'Fresh stand profile missing');
  assert.equal(fresh.profileHash, profile.profileHash, 'Fresh stand profile differs');
  assert.equal(fresh.imageId, binding.innerImageId, 'Fresh stand used a different inner image');
  assert.equal(fresh.passed, true, 'Fresh publication stand failed');
  const behavior = profile.selectionMode === ASSISTANT_BEHAVIOR.selectionMode;
  if (profile.selectionMode === AUDIO_SESSION.selectionMode || behavior)
    require('./verification-audio-session.cjs').validateAudioHttp(
      fresh.audioSessionHttp,
      candidate,
      profile,
      binding,
    );
  else assert.equal(fresh.audioSessionHttp, undefined, 'Unexpected audio HTTP proof');
  if (behavior)
    require('./verification-assistant-behavior.cjs').validateBehaviorHttp(
      fresh.assistantBehaviorHttp,
      candidate,
      profile,
      binding,
    );
  else assert.equal(fresh.assistantBehaviorHttp, undefined, 'Unexpected behavior HTTP proof');
  assert.deepEqual(
    fresh.scenarios?.map((row) => row.scenario),
    NAMES.slice(33),
    'Fresh publication coverage differs',
  );
  const expectedStatuses = ['completed', 'completed', 'rolled_back', 'needs_attention'];
  for (const [index, row] of fresh.scenarios.entries()) {
    assert.equal(row.passed, true, 'Fresh publication scenario failed');
    assert.equal(row.schema, 17, 'Fresh publication schema differs');
    assert.equal(row.status, expectedStatuses[index], 'Fresh publication outcome differs');
    assert.equal(row.disconnected, true, 'Fresh publication disconnect recovery missing');
    for (const [key, value] of Object.entries({
      schema: 17,
      readBudgetVersion: 1,
      bookingLinksVersion: 1,
      personalReservationsPreserved: true,
      noSqlMigration: true,
      noDataRollback: true,
    }))
      assert.equal(
        row.publicationGate?.[key],
        value,
        'Fresh publication invariant differs: ' + key,
      );
    assert.equal(
      row.publicationGate.retainedLatestData,
      index === 3,
      'Fresh latest-data policy differs',
    );
    const common = ['preflight', 'backup-before', 'recheck-previous', 'restore-backup-timer'];
    if (index < 2)
      stage(row, [
        ...common,
        'save-configuration',
        'switch',
        'public-checks',
        'publication-activate',
        'public-checks-activated',
        'backup-after',
      ]);
    else if (index === 2) {
      const states = stage(row, [...common, 'rollback']);
      assert.notEqual(
        states.get('publication-activate'),
        'passed',
        'Startup fault unexpectedly activated',
      );
    } else {
      stage(row, [...common, 'switch', 'public-checks', 'publication-quarantine']);
      assert.ok(
        !row.stages.some((item) => item.stage === 'rollback'),
        'Committed data was rolled back',
      );
    }
  }
  assert.deepEqual(
    fresh.scenarios[1].personalCalendarApi,
    {
      personalCreated: true,
      manualOverlapBlocked: true,
      publicOverlapBlocked: true,
      neighboringTimeAvailable: true,
      noPatientOrAppointmentCreated: true,
    },
    'Fresh application/API smoke missing',
  );
}
function artifactBinding(candidate, profile, binding) {
  assert.equal(binding?.version, 1, 'Missing fresh image binding');
  assert.equal(binding.candidate, candidate.data.id, 'Image binding candidate differs');
  assert.equal(binding.sourceHash, candidate.data.sourceHash, 'Image binding source differs');
  assert.equal(binding.profileHash, profile.profileHash, 'Image binding profile differs');
  assert.match(
    binding.artifactFile || '',
    /^image-\d+\/image\.json$/,
    'Invalid packaged-image proof path',
  );
  assert.match(binding.innerImageId || '', /^sha256:[a-f0-9]{64}$/, 'Invalid inner image identity');
  assert.equal(
    binding.standHelperSha256,
    candidate.data.files['tests/helpers/release-stand-assistant-ui.py']?.sha256,
    'Fresh stand adapter changed',
  );
  const bytes = read(safePath(candidate.directory, binding.artifactFile));
  const image = JSON.parse(bytes);
  assert.equal(image.id, candidate.data.id, 'Fresh image candidate differs');
  assert.equal(image.sourceHash, candidate.data.sourceHash, 'Fresh image source differs');
  assert.equal(image.status, 'packaged', 'Fresh image is not packaged');
  assert.equal(
    image.imageId,
    binding.requestedImageId,
    'Requested image differs from immutable artifact',
  );
  assert.match(image.imageId || '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(
    image.archive?.sha256,
    binding.archiveSha256,
    'Fresh image archive identity differs',
  );
  assert.equal(image.archive?.bytes, binding.archiveBytes, 'Fresh image archive size differs');
  assert.match(image.archive.sha256 || '', /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(image.archive.bytes) && image.archive.bytes > 0);
  assert.ok(
    ['build', 'smoke', 'export'].every((name) => image.steps?.[name]?.status === 'passed'),
    'Fresh image checks incomplete',
  );
  validateMapping(binding.ociMapping, image.imageId, binding.innerImageId, image.archive.sha256);
  require('./image-base.cjs').validateImageBase(candidate, image);
  // The normal artifact reader verifies archive bytes before transport/publication.
  // This binds the inner Docker identity observed after that exact archive was loaded.
  return {
    file: binding.artifactFile,
    sha256: hash(bytes),
    imageId: image.imageId,
    archive: image.archive,
  };
}
function composeStand(candidate, freshReport, binding) {
  const { verifyProfile } = require('./verification-profile.cjs');
  const profile = verifyProfile(null, candidate);
  assert.ok(profile, 'Scoped publication profile required');
  const artifact = artifactBinding(candidate, profile, binding);
  validateFresh(freshReport, candidate, profile, binding);
  const { baseline, proofs } = loadBaseline(candidate.directory);
  const inherited = proofs.stand.report.scenarios.slice(0, 33);
  const origin = {
    candidate: profile.baseline.id,
    sourceHash: profile.baseline.sourceHash,
    imageId: profile.baseline.imageId,
    reportSha256: proofs.stand.proof.sha256,
  };
  const behavior = profile.selectionMode === ASSISTANT_BEHAVIOR.selectionMode;
  const audio = profile.selectionMode === AUDIO_SESSION.selectionMode || behavior;
  let productionBridge;
  if (behavior) {
    const { behaviorBase } = require('./verification-assistant-behavior.cjs').loadBehaviorInputs(
      candidate,
    );
    productionBridge =
      require('./verification-assistant-behavior-bridge.cjs').validateBehaviorBridge(
        candidate,
        behaviorBase,
        baseline,
        proofs,
      );
    assert.deepEqual(
      profile.productionBridge,
      productionBridge,
      'Production50 inheritance bridge changed',
    );
  } else
    assert.equal(profile.productionBridge, undefined, 'Unexpected production inheritance bridge');
  return {
    version: 1,
    kind: 'assistant-ui-scoped-stand',
    policy: POLICY,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    profile: 'assistant-ui',
    profileHash: profile.profileHash,
    imageId: artifact.imageId,
    ...(audio
      ? { selectionMode: profile.selectionMode, scope: 'targeted', fullVerification: false }
      : {}),
    ...(audio ? { audioSessionHttp: freshReport.audioSessionHttp } : {}),
    ...(behavior ? { assistantBehaviorHttp: freshReport.assistantBehaviorHttp } : {}),
    passed: true,
    scenarios: [
      ...inherited.map((row) => ({ ...row, execution: 'inherited', origin })),
      ...freshReport.scenarios.map((row) => ({
        ...row,
        execution: 'fresh',
        origin: {
          candidate: candidate.data.id,
          sourceHash: candidate.data.sourceHash,
          imageId: binding.innerImageId,
        },
      })),
    ],
    provenance: {
      inherited: {
        ...origin,
        scenarios: 33,
        protectedHash: profile.fingerprints.protected,
        ...(behavior ? { productionBridge } : {}),
      },
      fresh: { scenarios: 4, report: freshReport, reportHash: objectHash(freshReport), binding },
      controllerHash: controllerHash(candidate.data.files),
      artifact,
    },
  };
}
function validateScopedStand(root, candidate, report) {
  const fresh = report.provenance?.fresh;
  assert.ok(fresh, 'Scoped stand provenance missing');
  const expected = composeStand(candidate, fresh.report, fresh.binding);
  assert.deepEqual(report, expected, 'Scoped stand proof changed');
  return true;
}
module.exports = { composeStand, validateScopedStand, artifactBinding, validateFresh };
