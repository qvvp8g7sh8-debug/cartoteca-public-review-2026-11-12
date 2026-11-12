const assert = require('node:assert/strict');
const { hash } = require('./files.cjs');

function validateMapping(mapping, requestedId, targetId, archiveSha256) {
  assert.ok(mapping && typeof mapping === 'object', 'Verified OCI image mapping missing');
  for (const key of ['manifest', 'config'])
    assert.ok(
      typeof mapping[key] === 'string' &&
        Buffer.byteLength(mapping[key]) > 0 &&
        Buffer.byteLength(mapping[key]) <= 1024 * 1024,
      'Invalid bounded raw OCI ' + key,
    );
  assert.equal(
    'sha256:' + hash(mapping.manifest),
    mapping.manifestId,
    'OCI manifest bytes changed',
  );
  assert.equal('sha256:' + hash(mapping.config), mapping.configId, 'OCI config bytes changed');
  assert.equal(mapping.requestedId, requestedId, 'OCI requested image differs');
  assert.equal(mapping.targetId, targetId, 'OCI loaded image differs');
  assert.equal(mapping.archiveSha256, archiveSha256, 'OCI archive differs');
  const ids = [mapping.manifestId, mapping.configId];
  assert.ok(
    ids.includes(requestedId) && ids.includes(targetId),
    'Image identity is not bound to OCI content',
  );
  const manifest = JSON.parse(mapping.manifest),
    config = JSON.parse(mapping.config);
  assert.equal(manifest.schemaVersion, 2, 'Unknown OCI manifest schema');
  assert.equal(manifest.config?.digest, mapping.configId, 'OCI manifest/config link differs');
  assert.equal(config.os, 'linux', 'OCI operating system differs');
  assert.equal(config.architecture, 'amd64', 'OCI architecture differs');
  assert.equal(config.rootfs?.type, 'layers', 'OCI filesystem proof missing');
  assert.ok(
    Array.isArray(config.rootfs.diff_ids) &&
      config.rootfs.diff_ids.every((id) => /^sha256:[a-f0-9]{64}$/.test(id)),
    'Invalid OCI filesystem layer identity',
  );
  assert.ok(
    Array.isArray(manifest.layers) && manifest.layers.length === config.rootfs.diff_ids.length,
    'OCI layer coverage differs',
  );
  return { manifest, config };
}
module.exports = { validateMapping };
