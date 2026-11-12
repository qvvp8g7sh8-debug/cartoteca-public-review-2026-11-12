const fs = require('node:fs');
const { nativePython } = require('./python.cjs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { safePath, hash } = require('./files.cjs');
const { cleanEnvironment } = require('./process.cjs');
const EXTRACT = String.raw`
import hashlib,json,re,sys,tarfile
records={};total=0;count=0
with tarfile.open(sys.argv[1],mode='r|*') as archive:
    for member in archive:
        count+=1
        assert count<=10000 and not member.name.startswith('/') and '..' not in member.name.split('/')
        name=member.name.removeprefix('./')
        if not member.isfile() or member.size>512*1024:continue
        if not (name in ['manifest.json','index.json'] or re.fullmatch(r'(?:blobs/sha256/[a-f0-9]{64}|[a-f0-9]{64}\.json)',name)):continue
        value=archive.extractfile(member).read(member.size+1)
        assert len(value)==member.size
        if value.lstrip()[:1] not in [b'{',b'[']:continue
        assert name not in records
        total+=len(value);assert total<=4*1024*1024
        records[name]=value
requested=sys.argv[2];raw=records.get('blobs/sha256/'+requested.split(':')[1])
manifest=None;config=None
if raw:
    item=json.loads(raw)
    if item.get('schemaVersion')==2 and isinstance(item.get('config'),dict):
        manifest=raw;config=records.get('blobs/sha256/'+item['config']['digest'].split(':')[1])
    elif 'rootfs' in item:config=raw
if config is None:
    listing=json.loads(records['manifest.json']);assert len(listing)==1
    config=records[listing[0]['Config']]
assert config is not None
config_id='sha256:'+hashlib.sha256(config).hexdigest()
if manifest is None and 'index.json' in records:
    listing=json.loads(records['index.json']);assert len(listing['manifests'])==1
    candidate=records.get('blobs/sha256/'+listing['manifests'][0]['digest'].split(':')[1])
    if candidate is not None and json.loads(candidate).get('config',{}).get('digest')==config_id:manifest=candidate
manifest_id='sha256:'+hashlib.sha256(manifest).hexdigest() if manifest is not None else None
assert requested in [config_id,manifest_id]
print(json.dumps(dict(requestedId=requested,configId=config_id,manifestId=manifest_id,
    manifest=manifest.decode() if manifest is not None else None,config=config.decode())))
`;
function imageConfig(record) {
  assert.match(record?.requestedId || '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof record.config, 'string', 'Missing raw image configuration');
  assert.ok(Buffer.byteLength(record.config) <= 512 * 1024);
  const configId = 'sha256:' + hash(Buffer.from(record.config));
  assert.equal(record.configId, configId, 'Image config digest changed');
  if (record.requestedId !== configId) {
    assert.equal(typeof record.manifest, 'string', 'Missing requested-image manifest');
    assert.ok(Buffer.byteLength(record.manifest) <= 512 * 1024);
    const manifestId = 'sha256:' + hash(Buffer.from(record.manifest));
    assert.equal(record.manifestId, manifestId, 'Image manifest digest changed');
    assert.equal(record.requestedId, manifestId, 'Requested image identity changed');
    const manifest = JSON.parse(record.manifest);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.config?.digest, configId, 'Manifest config link changed');
    assert.equal(manifest.config?.size, Buffer.byteLength(record.config));
  }
  return JSON.parse(record.config);
}
function beforeSource(config) {
  assert.equal(config.rootfs?.type, 'layers');
  const ids = config.rootfs.diff_ids;
  assert.ok(
    Array.isArray(ids) &&
      ids.length > 9 &&
      ids.every((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
  );
  assert.ok(Array.isArray(config.history) && config.history.length > 0);
  let layers = 0,
    boundary = null;
  for (const row of config.history) {
    assert.equal(typeof row.created_by, 'string');
    if (
      /\bCOPY\s+(?:src\s+|dir:[a-f0-9]+\s+in\s+)\.\/src\/?(?:\s+#\s*buildkit)?\s*$/.test(
        row.created_by,
      )
    ) {
      assert.equal(boundary, null, 'Ambiguous first source-copy boundary');
      assert.notEqual(row.empty_layer, true);
      boundary = layers;
    }
    if (row.empty_layer !== true) layers++;
  }
  assert.equal(layers, ids.length, 'Image history/layer count differs');
  // Initial policy is deliberately pinned to the reviewed Node24/bookworm Dockerfile.
  assert.equal(boundary, 9, 'Unreviewed base/dependency layer boundary');
  return ids.slice(0, boundary);
}
function runtimeConfig(config) {
  const result = {
    architecture: config.architecture,
    os: config.os,
    variant: config.variant || null,
  };
  for (const key of [
    'User',
    'Env',
    'WorkingDir',
    'Entrypoint',
    'Cmd',
    'ExposedPorts',
    'Volumes',
    'StopSignal',
    'Healthcheck',
  ])
    result[key] = config.config?.[key] ?? null;
  return result;
}
function compareImageBase(current, baseline) {
  const oldConfig = imageConfig(baseline),
    newConfig = imageConfig(current);
  const prefix = beforeSource(oldConfig);
  assert.deepEqual(
    beforeSource(newConfig),
    prefix,
    'Base OS, Node, production dependencies or public CA changed; full verification required',
  );
  assert.deepEqual(
    runtimeConfig(newConfig),
    runtimeConfig(oldConfig),
    'Image execution configuration changed; full verification required',
  );
  return {
    boundary: 'before-first-copy-src',
    layers: prefix.length,
    diffIds: prefix,
    platform: { os: newConfig.os, architecture: newConfig.architecture },
    runtimeConfigHash: hash(Buffer.from(JSON.stringify(runtimeConfig(newConfig)))),
  };
}
async function extractImageOci(archive, requestedId) {
  assert.match(requestedId || '', /^sha256:[a-f0-9]{64}$/);
  const info = fs.lstatSync(archive);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2 * 1024 ** 3);
  const result = spawnSync(nativePython(), ['-B', '-c', EXTRACT, archive, requestedId], {
    env: cleanEnvironment(),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, 'Bounded image configuration extraction failed');
  const record = JSON.parse(result.stdout);
  imageConfig(record);
  return record;
}
function qualifyImageBase(candidate, current) {
  const profile = require('./verification-profile.cjs').verifyProfile(null, candidate);
  assert.ok(profile, 'Scoped image proof requires an explicit profile');
  const baselineBytes = require('./scoped-evidence.cjs').read(
    safePath(candidate.directory, 'verification-baseline/image-oci.json'),
  );
  const baseline = JSON.parse(baselineBytes);
  assert.equal(baseline.requestedId, profile.baseline.imageId, 'Baseline image identity changed');
  return {
    profileHash: profile.profileHash,
    baselineEvidenceSha256: hash(baselineBytes),
    baselineImageId: baseline.requestedId,
    comparison: compareImageBase(current, baseline),
  };
}
function proofFor(candidate, report, current) {
  assert.equal(current.requestedId, report.imageId, 'Packaged image identity differs');
  return {
    version: 1,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    requestedImageId: report.imageId,
    archive: report.archive,
    ...qualifyImageBase(candidate, current),
    current,
  };
}
function writeImageBase(candidate, report, current, directory) {
  const target = path.join(directory, 'image-base-proof.json');
  fs.writeFileSync(target, JSON.stringify(proofFor(candidate, report, current), null, 2) + '\n', {
    flag: 'wx',
  });
  const bytes = fs.readFileSync(target);
  return {
    file: path.relative(candidate.directory, target).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: hash(bytes),
  };
}
function validateImageBase(candidate, report) {
  const entry = report.imageBase;
  assert.match(
    entry?.file || '',
    /^image-\d+\/image-base-proof\.json$/,
    'Missing scoped image base proof',
  );
  assert.equal(
    path.posix.dirname(entry.file),
    path.posix.dirname(report.archive.file),
    'Image proof directory differs',
  );
  const bytes = require('./scoped-evidence.cjs').read(safePath(candidate.directory, entry.file));
  assert.equal(bytes.length, entry.bytes, 'Image base proof size changed');
  assert.equal(hash(bytes), entry.sha256, 'Image base proof changed');
  const proof = JSON.parse(bytes);
  assert.deepEqual(
    proof,
    proofFor(candidate, report, proof.current),
    'Image base provenance changed',
  );
  return proof;
}
module.exports = {
  imageConfig,
  beforeSource,
  runtimeConfig,
  compareImageBase,
  extractImageOci,
  qualifyImageBase,
  writeImageBase,
  validateImageBase,
};
