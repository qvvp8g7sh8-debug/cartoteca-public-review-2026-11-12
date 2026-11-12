const fs = require('node:fs');
const assert = require('node:assert/strict');
const { safePath, hash, objectHash } = require('./files.cjs');
const { read, loadBaseline, validateBaselineProof } = require('./scoped-evidence.cjs');
const { BASELINE, NAMES } = require('./verification-profile-policy.cjs');
const { ASSISTANT_BEHAVIOR } = require('./verification-assistant-behavior-policy.cjs');

const PROFILE_HASH = '8ea6f565a5f1954dbf9238b471dfe78b4fde687062e7f064546aa952f5883379';
const PUBLISHED = Object.freeze({
  stand: Object.freeze({
    source: 'stand/stand-report.json',
    file: 'verification-assistant-behavior-published-stand.json',
    bytes: 127418,
    sha256: 'efa49a97dad87aa6b3f0c0cfadc2c439b98c3b7b16f8162ff3ab518f942ecf9e',
  }),
  profile: Object.freeze({
    source: 'verification-profile.json',
    file: 'verification-assistant-behavior-published-profile.json',
    bytes: 92038,
    sha256: 'f5bc8d4dd79ed7bb38a2dfa95fb10f8634fd97adb6be68df9a9dae0c74d9f875',
  }),
});

function pinned(bytes, pin) {
  assert.equal(bytes.length, pin.bytes, 'Published50 bridge evidence size changed');
  assert.equal(hash(bytes), pin.sha256, 'Published50 bridge evidence changed');
  return JSON.parse(bytes);
}

// Pure relationship check; authorization also requires the fixed raw pins below.
function validatePublishedInheritance(stand, profile, fullStand, origin) {
  const { profileHash, ...body } = profile;
  assert.equal(objectHash(body), profileHash, 'Published50 profile self-hash changed');
  assert.equal(profile.version, 1);
  assert.equal(profile.profile, 'assistant-ui');
  assert.equal(profile.selectionMode, 'assistant-audio-session-v1');
  assert.equal(profile.candidate, ASSISTANT_BEHAVIOR.id);
  assert.equal(profile.sourceHash, ASSISTANT_BEHAVIOR.sourceHash);
  assert.deepEqual(profile.baseline, {
    id: BASELINE.id,
    sourceHash: BASELINE.sourceHash,
    imageId: BASELINE.imageId,
  });
  assert.equal(profile.inheritedStand.sha256, origin.reportSha256);
  assert.equal(profile.inheritedStand.file, 'verification-baseline/stand-report.json');
  assert.equal(stand.kind, 'assistant-ui-scoped-stand');
  assert.equal(stand.candidate, ASSISTANT_BEHAVIOR.id);
  assert.equal(stand.sourceHash, ASSISTANT_BEHAVIOR.sourceHash);
  assert.equal(stand.imageId, ASSISTANT_BEHAVIOR.imageId);
  assert.equal(stand.profile, 'assistant-ui');
  assert.equal(stand.profileHash, profileHash);
  assert.equal(stand.selectionMode, profile.selectionMode);
  assert.equal(stand.scope, 'targeted');
  assert.equal(stand.fullVerification, false);
  assert.equal(stand.passed, true);
  assert.deepEqual(
    stand.scenarios?.map((row) => row.scenario),
    NAMES,
  );
  assert.ok(stand.scenarios.every((row) => row.passed === true));
  assert.deepEqual(stand.provenance?.inherited, {
    ...origin,
    scenarios: 33,
    protectedHash: profile.fingerprints.protected,
  });
  const binding = stand.provenance?.fresh?.binding;
  assert.equal(binding?.candidate, ASSISTANT_BEHAVIOR.id);
  assert.equal(binding.sourceHash, ASSISTANT_BEHAVIOR.sourceHash);
  assert.equal(binding.profileHash, profileHash);
  assert.equal(binding.requestedImageId, ASSISTANT_BEHAVIOR.imageId);
  assert.match(binding.innerImageId, /^sha256:[a-f0-9]{64}$/u);
  for (const [index, row] of stand.scenarios.slice(0, 33).entries()) {
    const { execution, origin: actualOrigin, ...payload } = row;
    assert.equal(execution, 'inherited', 'Published50 core execution origin changed');
    assert.deepEqual(actualOrigin, origin, 'Published50 core origin differs from full41');
    assert.deepEqual(
      payload,
      fullStand.scenarios[index],
      'Published50 core payload differs from full41',
    );
  }
  for (const row of stand.scenarios.slice(33)) {
    assert.equal(row.execution, 'fresh', 'Published50 publication proof was not fresh');
    assert.deepEqual(row.origin, {
      candidate: ASSISTANT_BEHAVIOR.id,
      sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
      imageId: binding.innerImageId,
    });
  }
  return true;
}

function validateBehaviorBridge(candidate, base, baseline, proofs) {
  // Re-evaluate the finite candidate -> published50 equivalence even for cached profiles.
  const behavior = require('./verification-assistant-behavior.cjs');
  behavior.assertBehaviorBase(base);
  behavior.assertBehaviorInputs(candidate, base);
  validateBaselineProof(baseline, proofs);
  assert.equal(baseline.data.id, BASELINE.id);
  assert.equal(baseline.data.sourceHash, BASELINE.sourceHash);
  assert.equal(proofs.image.report.imageId, BASELINE.imageId);
  const origin = {
    candidate: baseline.data.id,
    sourceHash: baseline.data.sourceHash,
    imageId: proofs.image.report.imageId,
    reportSha256: proofs.stand.proof.sha256,
  };
  const stand = pinned(read(safePath(candidate.directory, PUBLISHED.stand.file)), PUBLISHED.stand);
  const profile = pinned(
    read(safePath(candidate.directory, PUBLISHED.profile.file)),
    PUBLISHED.profile,
  );
  assert.equal(profile.profileHash, PROFILE_HASH, 'Published50 profile identity changed');
  assert.deepEqual(profile.inheritedStand, proofs.stand.proof, 'Published50 full41 proof changed');
  validatePublishedInheritance(stand, profile, proofs.stand.report, origin);
  const binding = stand.provenance.fresh.binding;
  require('./scoped-image.cjs').validateMapping(
    binding.ociMapping,
    ASSISTANT_BEHAVIOR.imageId,
    binding.innerImageId,
    binding.archiveSha256,
  );
  assert.equal(stand.provenance.artifact.imageId, ASSISTANT_BEHAVIOR.imageId);
  assert.equal(stand.provenance.artifact.archive.sha256, binding.archiveSha256);
  assert.equal(stand.provenance.artifact.archive.bytes, binding.archiveBytes);
  const body = {
    version: 1,
    published: {
      candidate: ASSISTANT_BEHAVIOR.id,
      sourceHash: ASSISTANT_BEHAVIOR.sourceHash,
      imageId: ASSISTANT_BEHAVIOR.imageId,
      standImageId: binding.innerImageId,
      profileHash: PROFILE_HASH,
      stand: {
        file: PUBLISHED.stand.file,
        bytes: PUBLISHED.stand.bytes,
        sha256: PUBLISHED.stand.sha256,
      },
      profile: {
        file: PUBLISHED.profile.file,
        bytes: PUBLISHED.profile.bytes,
        sha256: PUBLISHED.profile.sha256,
      },
    },
    inherited: { ...origin, report: proofs.stand.proof, scenarios: 33 },
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    protectedAgainstPublished50: behavior.behaviorFingerprints(base.files),
    publishedProtectedHash: profile.fingerprints.protected,
  };
  return { ...body, bridgeHash: objectHash(body) };
}

function prepareBehaviorBridge(root, candidate, location) {
  const published = location(root, ASSISTANT_BEHAVIOR.id);
  for (const pin of Object.values(PUBLISHED)) {
    const bytes = read(safePath(published, pin.source));
    pinned(bytes, pin);
    fs.writeFileSync(safePath(candidate.directory, pin.file), bytes, { flag: 'wx' });
  }
  const { baseline, proofs } = loadBaseline(candidate.directory);
  const { behaviorBase } = require('./verification-assistant-behavior.cjs').loadBehaviorInputs(
    candidate,
  );
  return validateBehaviorBridge(candidate, behaviorBase, baseline, proofs);
}

module.exports = {
  PUBLISHED,
  PROFILE_HASH,
  pinned,
  validatePublishedInheritance,
  prepareBehaviorBridge,
  validateBehaviorBridge,
};
