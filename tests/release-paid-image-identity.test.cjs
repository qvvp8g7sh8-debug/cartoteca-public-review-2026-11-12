const test = require('node:test');
const { nativePython } = require('../scripts/release/python.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash } = require('../scripts/release/files.cjs');
const { matchesImage } = require('../scripts/release/paid-services-policy.cjs');
const { extractImageOci } = require('../scripts/release/image-base.cjs');
function image() {
  const config = JSON.stringify({
    architecture: 'amd64',
    os: 'linux',
    rootfs: { type: 'layers', diff_ids: [] },
  });
  const configId = 'sha256:' + hash(config);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: configId, size: Buffer.byteLength(config) },
    layers: [],
  });
  const manifestId = 'sha256:' + hash(manifest);
  return { requestedId: manifestId, configId, manifestId, config, manifest };
}
function fixture(identity) {
  const archiveSha256 = hash('synthetic packaged archive');
  return {
    selected: {
      report: { imageId: identity.requestedId, archive: { sha256: archiveSha256 } },
      identity,
    },
    report: {
      imageId: identity.configId,
      imageBinding: {
        requestedId: identity.requestedId,
        targetId: identity.configId,
        archiveSha256,
      },
    },
  };
}
test('paid stand retains actual Docker identity and accepts only both IDs of the selected OCI archive', () => {
  const identity = image(),
    { selected, report } = fixture(identity);
  assert.equal(matchesImage(report, selected), true);
  const reversed = { ...identity, requestedId: identity.configId };
  const reverse = fixture(reversed);
  reverse.report.imageId = identity.manifestId;
  reverse.report.imageBinding.targetId = identity.manifestId;
  assert.equal(matchesImage(reverse.report, reverse.selected), true);
  assert.equal(matchesImage({ imageId: identity.requestedId }, identity.requestedId), true);
  assert.equal(matchesImage(report, identity.requestedId), false);
  for (const change of [
    'archive',
    'requested',
    'unknown',
    'config',
    'manifest',
    'missing-proof',
    'missing-binding',
  ]) {
    const a = structuredClone(selected),
      b = structuredClone(report);
    if (change === 'archive') b.imageBinding.archiveSha256 = hash('different archive');
    if (change === 'requested')
      b.imageBinding.requestedId = 'sha256:' + hash('different packaged ID');
    if (change === 'unknown') {
      b.imageId = 'sha256:' + hash('unrelated image');
      b.imageBinding.targetId = b.imageId;
    }
    if (change === 'config') a.identity.config += ' ';
    if (change === 'manifest') a.identity.manifest += ' ';
    if (change === 'missing-proof') delete a.identity;
    if (change === 'missing-binding') delete b.imageBinding;
    assert.equal(matchesImage(b, a), false, change);
  }
});
test('OCI alias proof cannot switch configuration or runtime platform while keeping a manifest name', () => {
  const identity = image(),
    { selected, report } = fixture(identity);
  for (const architecture of ['arm64', 'amd64']) {
    const config = JSON.stringify({
      architecture,
      os: architecture === 'amd64' ? 'windows' : 'linux',
    });
    const configId = 'sha256:' + hash(config),
      manifest = JSON.stringify({
        schemaVersion: 2,
        config: { digest: configId, size: Buffer.byteLength(config) },
      });
    const manifestId = 'sha256:' + hash(manifest);
    assert.equal(
      matchesImage(
        {
          ...report,
          imageId: configId,
          imageBinding: { ...report.imageBinding, targetId: configId, requestedId: manifestId },
        },
        {
          ...selected,
          report: { ...selected.report, imageId: manifestId },
          identity: { config, configId, manifest, manifestId, requestedId: manifestId },
        },
      ),
      false,
    );
  }
});
test('selected compressed OCI archive yields independently verified manifest/config identities in both directions', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-synthetic-oci-proof-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const identity = image(),
    archive = path.join(folder, 'image.tar');
  const program = String.raw`import io,json,sys,tarfile
value=json.load(sys.stdin)
records={'index.json':json.dumps({'manifests':[{'digest':value['manifestId']}]}),'blobs/sha256/'+value['manifestId'].split(':')[1]:value['manifest'],'blobs/sha256/'+value['configId'].split(':')[1]:value['config']}
with tarfile.open(sys.argv[1],'w:gz') as output:
 for name,raw in records.items():
  data=raw.encode();info=tarfile.TarInfo(name);info.size=len(data);output.addfile(info,io.BytesIO(data))
`;
  const result = spawnSync(nativePython(), ['-B', '-c', program, archive], {
    input: JSON.stringify(identity),
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const requested of [identity.manifestId, identity.configId]) {
    const actual = await extractImageOci(archive, requested);
    assert.equal(actual.requestedId, requested);
    assert.equal(actual.configId, identity.configId);
    assert.equal(actual.manifestId, identity.manifestId);
  }
  await assert.rejects(() => extractImageOci(archive, 'sha256:' + hash('not present')));
});
