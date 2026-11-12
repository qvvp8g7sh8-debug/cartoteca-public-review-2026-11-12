const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../scripts/release/files.cjs');
const { compareImageBase, imageConfig } = require('../scripts/release/image-base.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
function config() {
  return {
    architecture: 'amd64',
    os: 'linux',
    rootfs: {
      type: 'layers',
      diff_ids: Array.from({ length: 10 }, (_, i) => 'sha256:' + hash('layer-' + i)),
    },
    history: [
      ...Array.from({ length: 9 }, (_, i) => ({ created_by: 'synthetic base step ' + i })),
      { created_by: 'COPY src ./src # buildkit' },
    ],
    config: {
      User: 'node',
      Env: [],
      WorkingDir: '/app',
      Entrypoint: [],
      Cmd: ['node', 'multi-server.cjs'],
    },
  };
}
function record(value, oci = false) {
  const raw = JSON.stringify(value),
    configId = 'sha256:' + hash(raw);
  if (!oci)
    return { requestedId: configId, configId, config: raw, manifestId: null, manifest: null };
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: configId, size: Buffer.byteLength(raw) },
    layers: [],
  });
  const manifestId = 'sha256:' + hash(manifest);
  return { requestedId: manifestId, configId, config: raw, manifestId, manifest };
}

test('changed application source layers reuse only the identical pre-source OS and dependency prefix', () => {
  const baseline = config(),
    current = clone(baseline);
  current.rootfs.diff_ids[9] = 'sha256:' + hash('new source layer');
  const proof = compareImageBase(record(current, true), record(baseline, true));
  assert.equal(proof.layers, 9);
  assert.deepEqual(proof.diffIds, baseline.rootfs.diff_ids.slice(0, 9));
});

test('changed OS, Node or production dependency layers require full verification', () => {
  const baseline = config();
  for (const index of [0, 3, 8]) {
    const current = clone(baseline);
    current.rootfs.diff_ids[index] = 'sha256:' + hash('foreign dependency layer');
    assert.throws(() => compareImageBase(record(current), record(baseline)), /full verification/);
  }
});

test('missing, ambiguous or shifted source boundaries cannot reuse a mutable base', () => {
  const baseline = config();
  const mutations = [
    (current) => {
      current.history[9].created_by = 'RUN unknown operation';
    },
    (current) => {
      current.history[8].created_by = 'COPY src ./src # buildkit';
    },
    (current) => {
      current.history[9].empty_layer = true;
    },
    (current) => {
      current.history.pop();
    },
    (current) => {
      current.rootfs.diff_ids.pop();
    },
  ];
  for (const mutate of mutations) {
    const current = clone(baseline);
    mutate(current);
    assert.throws(() => compareImageBase(record(current), record(baseline)));
  }
});

test('runtime platform, user, environment, command and working directory remain pinned', () => {
  const baseline = config();
  for (const mutate of [
    (current) => {
      current.architecture = 'arm64';
    },
    (current) => {
      current.os = 'windows';
    },
    (current) => {
      current.config.User = 'root';
    },
    (current) => {
      current.config.Env = ['UNEXPECTED=1'];
    },
    (current) => {
      current.config.Cmd = ['node', 'foreign.cjs'];
    },
    (current) => {
      current.config.WorkingDir = '/foreign';
    },
  ]) {
    const current = clone(baseline);
    mutate(current);
    assert.throws(
      () => compareImageBase(record(current), record(baseline)),
      /configuration changed/,
    );
  }
});

test('raw image metadata and OCI manifest/config links must match their content digests', () => {
  const valid = record(config(), true);
  assert.equal(imageConfig(valid).os, 'linux');
  for (const patch of [
    { config: valid.config + ' ' },
    { manifest: valid.manifest + ' ' },
    { configId: 'sha256:' + hash('foreign') },
    { manifestId: 'sha256:' + hash('foreign') },
    { requestedId: 'sha256:' + hash('foreign') },
  ])
    assert.throws(() => imageConfig({ ...valid, ...patch }));
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: 'sha256:' + hash('wrong config'), size: Buffer.byteLength(valid.config) },
  });
  const manifestId = 'sha256:' + hash(manifest);
  assert.throws(
    () => imageConfig({ ...valid, manifest, manifestId, requestedId: manifestId }),
    /config link/,
  );
});
