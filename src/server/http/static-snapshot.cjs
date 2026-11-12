const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync, brotliCompressSync, constants } = require('node:zlib');
const { files } = require('../../shared/web-assets.cjs');
const { releaseFiles, versionedHtml, pinClientRelease } = require('./client-release.cjs');
const snapshots = new Map();
const transformedHtml = new Set([
  'index.html',
  'login.html',
  'admin.html',
  'booking.html',
  'privacy.html',
  'consent.html',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const signature = (root) =>
  files
    .map((file) => {
      const stat = fs.statSync(path.join(root, file));
      if (!stat.isFile()) throw Error('Static resource is not a regular file.');
      return stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs;
    })
    .join('|');

// Called before listen. No disk metadata checks or compression on the request path.
// Rebuilding files requires a process restart; existing processes retain exact bytes.
function prepareStatic(root) {
  if (snapshots.has(root)) return snapshots.get(root);
  const before = signature(root);
  const contents = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file))]));
  if (before !== signature(root))
    throw Error('Interface resources changed during startup. Restart after build.');
  const hash = createHash('sha256');
  for (const file of releaseFiles) hash.update(file + '\0').update(contents.get(file));
  const version = hash.digest('hex').slice(0, 16);
  const resources = Object.fromEntries([...contents].map(([file, bytes]) => [file, digest(bytes)]));
  const assets = new Map();
  for (const [file, source] of contents) {
    const identity = transformedHtml.has(file)
      ? Buffer.from(versionedHtml(source.toString('utf8'), version, resources))
      : source;
    const representations = { identity };
    if (/\.(?:html|js|css|txt|xml|webmanifest)$/.test(file) && identity.length >= 256) {
      const gzip = gzipSync(identity, { level: 6 });
      const br = brotliCompressSync(identity, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      });
      if (gzip.length < identity.length) representations.gzip = gzip;
      if (br.length < identity.length) representations.br = br;
    }
    assets.set(file, representations);
  }
  const snapshot = { version, resources, assets };
  snapshots.set(root, snapshot);
  pinClientRelease(root, version);
  return snapshot;
}

function selectEncoding(header = '', representations) {
  const preferences = new Map();
  for (const part of String(header).toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    if (!name) continue;
    const parameter = parameters
      .map((value) => value.trim())
      .find((value) => value.startsWith('q='));
    const quality = parameter ? Number(parameter.slice(2)) : 1;
    preferences.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = (name) =>
    preferences.get(name) ??
    (name === 'identity' ? (preferences.get('*') === 0 ? 0 : 1) : (preferences.get('*') ?? 0));
  return ['br', 'gzip', 'identity']
    .filter((name) => representations[name] && quality(name) > 0)
    .sort((left, right) => quality(right) - quality(left))[0];
}
module.exports = { prepareStatic, selectEncoding };
