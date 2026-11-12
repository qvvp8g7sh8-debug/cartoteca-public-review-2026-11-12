const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash, objectHash } = require('../scripts/release/files.cjs');
const { NAMES } = require('../scripts/release/verification-profile-policy.cjs');
const { validateFresh, artifactBinding } = require('../scripts/release/scoped-stand.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const baseValidation = t.mock.method(
    require('../scripts/release/image-base.cjs'),
    'validateImageBase',
    () => ({ syntheticIsolatedBaseProof: true }),
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-fresh-stand-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const helper = '# synthetic stand adapter';
  const files = {
    'tests/helpers/release-stand-assistant-ui.py': { bytes: helper.length, sha256: hash(helper) },
  };
  const candidate = {
    directory,
    data: { id: 'synthetic-assistant-release', sourceHash: objectHash(files), files },
  };
  const profile = { profileHash: hash('synthetic admitted profile') };
  const config = JSON.stringify({
    os: 'linux',
    architecture: 'amd64',
    rootfs: { type: 'layers', diff_ids: [] },
  });
  const configId = 'sha256:' + hash(config);
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configId }, layers: [] });
  const imageId = 'sha256:' + hash(manifest);
  const image = {
    id: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    imageId,
    status: 'packaged',
    archive: { sha256: hash('synthetic immutable archive'), bytes: 100 },
    steps: Object.fromEntries(
      ['build', 'smoke', 'export'].map((name) => [name, { status: 'passed' }]),
    ),
  };
  fs.mkdirSync(path.join(directory, 'image-100'));
  const imageFile = path.join(directory, 'image-100/image.json');
  fs.writeFileSync(imageFile, JSON.stringify(image));
  const binding = {
    version: 1,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    profileHash: profile.profileHash,
    artifactFile: 'image-100/image.json',
    innerImageId: configId,
    requestedImageId: imageId,
    archiveSha256: image.archive.sha256,
    archiveBytes: image.archive.bytes,
    ociMapping: {
      manifest,
      config,
      manifestId: imageId,
      configId,
      requestedId: imageId,
      targetId: configId,
      archiveSha256: image.archive.sha256,
    },
    standHelperSha256: files['tests/helpers/release-stand-assistant-ui.py'].sha256,
  };
  const common = ['preflight', 'backup-before', 'recheck-previous', 'restore-backup-timer'];
  const outcomes = ['completed', 'completed', 'rolled_back', 'needs_attention'];
  const fresh = {
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    profile: 'assistant-ui',
    profileHash: profile.profileHash,
    imageId: configId,
    passed: true,
    scenarios: NAMES.slice(33).map((scenario, index) => ({
      scenario,
      passed: true,
      schema: 17,
      status: outcomes[index],
      disconnected: true,
      publicationGate: {
        schema: 17,
        readBudgetVersion: 1,
        bookingLinksVersion: 1,
        personalReservationsPreserved: true,
        noSqlMigration: true,
        noDataRollback: true,
        retainedLatestData: index === 3,
      },
      stages: [
        ...common,
        ...(index < 2
          ? [
              'save-configuration',
              'switch',
              'public-checks',
              'publication-activate',
              'public-checks-activated',
              'backup-after',
            ]
          : index === 2
            ? ['rollback']
            : ['switch', 'public-checks', 'publication-quarantine']),
      ].map((stage) => ({ stage, status: 'passed' })),
      ...(index === 1
        ? {
            personalCalendarApi: {
              personalCreated: true,
              manualOverlapBlocked: true,
              publicOverlapBlocked: true,
              neighboringTimeAvailable: true,
              noPatientOrAppointmentCreated: true,
            },
          }
        : {}),
    })),
  };
  return { candidate, profile, fresh, binding, image, imageFile, baseValidation };
}

test('fresh stand evidence binds exactly four publication cases and a newly packaged image', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => validateFresh(f.fresh, f.candidate, f.profile, f.binding));
  const admitted = artifactBinding(f.candidate, f.profile, f.binding);
  assert.equal(admitted.imageId, f.image.imageId);
  assert.equal(admitted.sha256, hash(fs.readFileSync(f.imageFile)));
  assert.equal(f.fresh.scenarios.length, 4);
});

test('fresh stand rejects foreign candidate/source/profile/image and missing or duplicated publication cases', (t) => {
  const f = fixture(t);
  for (const mutate of [
    (p) => {
      p.candidate = 'another-candidate';
    },
    (p) => {
      p.sourceHash = hash('another source');
    },
    (p) => {
      p.profile = 'full';
    },
    (p) => {
      p.profileHash = hash('another profile');
    },
    (p) => {
      p.imageId = 'sha256:' + 'b'.repeat(64);
    },
    (p) => {
      p.passed = false;
    },
    (p) => {
      p.scenarios.pop();
    },
    (p) => {
      p.scenarios.push(clone(p.scenarios[0]));
    },
  ]) {
    const fresh = clone(f.fresh);
    mutate(fresh);
    assert.throws(() => validateFresh(fresh, f.candidate, f.profile, f.binding));
  }
});

test('fresh stand requires correct outcomes, preservation of live data and actual application smoke', (t) => {
  const f = fixture(t);
  for (const mutate of [
    (p) => {
      p.scenarios[0].schema = 16;
    },
    (p) => {
      p.scenarios[0].status = 'rolled_back';
    },
    (p) => {
      p.scenarios[0].disconnected = false;
    },
    (p) => {
      p.scenarios[0].passed = false;
    },
    (p) => {
      p.scenarios[0].publicationGate.noSqlMigration = false;
    },
    (p) => {
      p.scenarios[0].publicationGate.noDataRollback = false;
    },
    (p) => {
      p.scenarios[0].publicationGate.personalReservationsPreserved = false;
    },
    (p) => {
      p.scenarios[0].publicationGate.readBudgetVersion = 2;
    },
    (p) => {
      p.scenarios[0].stages = p.scenarios[0].stages.filter((row) => row.stage !== 'backup-before');
    },
    (p) => {
      p.scenarios[1].personalCalendarApi.noPatientOrAppointmentCreated = false;
    },
    (p) => {
      p.scenarios[1].personalCalendarApi.manualOverlapBlocked = false;
    },
    (p) => {
      p.scenarios[2].stages.push({ stage: 'publication-activate', status: 'passed' });
    },
    (p) => {
      p.scenarios[3].publicationGate.retainedLatestData = false;
    },
    (p) => {
      p.scenarios[3].stages.push({ stage: 'rollback', status: 'passed' });
    },
  ]) {
    const fresh = clone(f.fresh);
    mutate(fresh);
    assert.throws(() => validateFresh(fresh, f.candidate, f.profile, f.binding));
  }
});

test('fresh image binding rejects changed identity, helper, archive metadata and unsafe proof paths', (t) => {
  const f = fixture(t);
  for (const patch of [
    { version: 2 },
    { candidate: 'another-candidate' },
    { sourceHash: hash('another source') },
    { profileHash: hash('another profile') },
    { artifactFile: '../image-100/image.json' },
    { innerImageId: 'mutable:latest' },
    { requestedImageId: 'sha256:' + 'b'.repeat(64) },
    { archiveSha256: hash('another archive') },
    { archiveBytes: 101 },
    { standHelperSha256: hash('changed helper') },
  ])
    assert.throws(() => artifactBinding(f.candidate, f.profile, { ...f.binding, ...patch }));
  for (const mutate of [
    (image) => {
      image.id = 'another-candidate';
    },
    (image) => {
      image.sourceHash = hash('another source');
    },
    (image) => {
      image.status = 'building';
    },
    (image) => {
      image.steps.smoke.status = 'failed';
    },
  ]) {
    const image = clone(f.image);
    mutate(image);
    fs.writeFileSync(f.imageFile, JSON.stringify(image));
    assert.throws(() => artifactBinding(f.candidate, f.profile, f.binding));
  }
});

test('OCI mapping rejects a coherently substituted inner image and corrupted blob links', (t) => {
  const f = fixture(t);
  const foreignId = 'sha256:' + 'b'.repeat(64);
  const foreignBinding = { ...f.binding, innerImageId: foreignId };
  const foreignFresh = { ...f.fresh, imageId: foreignId };
  assert.doesNotThrow(() => validateFresh(foreignFresh, f.candidate, f.profile, foreignBinding));
  assert.throws(() => artifactBinding(f.candidate, f.profile, foreignBinding));
  for (const patch of [
    { manifest: f.binding.ociMapping.manifest + ' ' },
    { config: f.binding.ociMapping.config + ' ' },
    { configId: foreignId },
    { manifestId: foreignId },
    { requestedId: foreignId },
    { targetId: foreignId },
    { archiveSha256: hash('another archive') },
  ])
    assert.throws(() =>
      artifactBinding(f.candidate, f.profile, {
        ...f.binding,
        ociMapping: { ...f.binding.ociMapping, ...patch },
      }),
    );
});

test('OCI identity validation rejects a fully rehashed image for an unsupported platform', (t) => {
  const f = fixture(t);
  for (const platform of [
    { os: 'windows', architecture: 'amd64' },
    { os: 'linux', architecture: 'arm64' },
  ]) {
    const config = JSON.stringify({ ...platform, rootfs: { type: 'layers', diff_ids: [] } });
    const configId = 'sha256:' + hash(config);
    const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configId }, layers: [] });
    const manifestId = 'sha256:' + hash(manifest);
    const mapping = {
      config,
      configId,
      manifest,
      manifestId,
      requestedId: manifestId,
      targetId: configId,
      archiveSha256: f.image.archive.sha256,
    };
    const binding = {
      ...f.binding,
      requestedImageId: manifestId,
      innerImageId: configId,
      ociMapping: mapping,
    };
    fs.writeFileSync(f.imageFile, JSON.stringify({ ...f.image, imageId: manifestId }));
    assert.throws(() => artifactBinding(f.candidate, f.profile, binding));
  }
});

test('stand admission always calls the independent packaged-image base validator', (t) => {
  const f = fixture(t);
  f.baseValidation.mock.mockImplementation(() => {
    throw Error('synthetic changed dependency base');
  });
  assert.throws(
    () => artifactBinding(f.candidate, f.profile, f.binding),
    /changed dependency base/,
  );
  assert.equal(f.baseValidation.mock.callCount(), 1);
});
