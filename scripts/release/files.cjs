const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { files: webFiles, staticSources, setupSources } = require('../../src/shared/web-assets.cjs');

const trees = ['src', 'scripts', 'tests', 'docs', 'icons', '.github', 'dist'];
const deliveryFiles = new Set([
  ...webFiles.map((name) => 'dist/public/' + name),
  ...Object.keys(setupSources).map((name) => 'dist/setup/' + name),
]);
const publicSources = new Set([...Object.values(staticSources), ...Object.values(setupSources)]);
const rootFiles = [
  // Public CA only, pinned and checked by image-check.cjs; never include other trust files.
  'trust/max-root.pem',
  'package.json',
  'package-lock.json',
  'release-baseline.json',
  'tsconfig.contracts.json',
  '.prettierrc.json',
  '.dockerignore',
  '.gitignore',
  'Dockerfile',
  'Dockerfile.caddy',
  'Caddyfile',
  'compose.yaml',
  'compose.backup.yaml',
  'compose.postgres.yaml',
  'compose.postgres.rehearsal.yaml',
  'compose.postgres.backup.yaml',
  'AGENTS.md',
  'ARCHITECTURE.md',
  'DEPLOYMENT.md',
  'multi-server.cjs',
  'serve.cjs',
  'auth-store.cjs',
  'platform-store.cjs',
  'storage.cjs',
  'mail.cjs',
  'backup.cjs',
  'backup-cli.cjs',
  'dikidi-adapter.cjs',
  'validation.cjs',
  'image-processing.cjs',
  'image-worker.cjs',
  'client-address.cjs',
  'wifi.cjs',
  'start-wifi.cjs',
  // Historical root-layout snapshots remain readable; current builds write dist/public.
  'index.html',
  'app.js',
  'app-settings.js',
  'app-assistant.js',
  'assistant-capture-worklet.js',
  'assistant-playback-worklet.js',
  'security.js',
  'login.html',
  'login.js',
  'style.css',
  'ui-extra.css',
  'auth.css',
  'admin.html',
  'admin.js',
  'admin.css',
  'concept-clients.html',
  'concept-card.html',
  'concept.css',
  'concept-links.css',
  'concept-card.js',
  'booking.html',
  'booking.js',
  'booking.css',
  'privacy.html',
  'consent.html',
  'legal.js',
  'legal.css',
  'manifest.webmanifest',
  'service-worker.js',
  'install-app.js',
  'install-app.css',
  'auth.test.cjs',
  'security.test.cjs',
  'wifi.test.cjs',
  'regression.test.cjs',
  'proxy.test.cjs',
  'ui.test.cjs',
  'admin-ui.test.cjs',
  'platform-store.test.cjs',
  'multi-server.test.cjs',
  // Historical documentation explicitly references this synthetic fixture.
  'work/test-mobile-client-ui.cjs',
];
const rootSet = new Set(rootFiles);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const objectHash = (value) => hash(JSON.stringify(value));

function allowed(name) {
  if (
    typeof name !== 'string' ||
    name.includes('\\') ||
    name.includes(':') ||
    name.split('/').some((x) => !x || x === '.' || x === '..')
  )
    return false;
  if (rootSet.has(name)) return true;
  // Generated delivery files have an exact public catalog, never arbitrary build output.
  if (name.startsWith('dist/')) return deliveryFiles.has(name);
  if (/^src\/client\/(?:static|setup)\//.test(name)) return publicSources.has(name);
  // Exact project scripts only; inclusion never executes the optional local installer.
  if (
    [
      'scripts/start-local.ps1',
      'scripts/setup-assistant-local-speech.ps1',
      'scripts/postgres-backup-job.py',
    ].includes(name)
  )
    return true;
  if (
    /^scripts\/release\/remote\/(?:agent|operations|checks|postgres|migration|paid_services|read_budget|booking_links|publication_gate|delivery)\.py$/.test(
      name,
    )
  )
    return true;
  if (
    /^tests\/helpers\/release-(?:remote|postgres-backup|stand|stand-assistant-ui|stand-fixture|stand-continuation|stand-read-budget(?:\.test)?|stand-booking-links(?:\.test)?|stand-publication-gate(?:\.test)?|stand-paid-services(?:\.test)?|delivery)\.py$/.test(
      name,
    )
  )
    return true;
  if (/^tests\/helpers\/release-paid-services-(?:remote|fakes|preparation)\.py$/.test(name))
    return true;
  if (/^[\w-]+\.test\.cjs$/.test(name)) return true;
  const parts = name.split('/');
  if (!trees.includes(parts[0]) || parts.length < 2) return false;
  if (
    parts.at(-1).startsWith('.') ||
    parts
      .slice(1, -1)
      .some((x) => /^(?:\.|runtime|private|data(?:-|$)|backups|node_modules)/i.test(x))
  )
    return false;
  if (parts[0] === 'icons') return /^icons\/[\w-]+\.(?:png|svg)$/.test(name);
  return /\.(?:cjs|mjs|js|json|ts|css|html|md|yaml|yml|svg|webmanifest|service|timer)$/.test(name);
}

function safePath(root, name) {
  const base = path.resolve(root);
  const target = path.resolve(base, name);
  if (!target.startsWith(base + path.sep)) throw Error('Path escapes release directory');
  let cursor = base;
  for (const part of ['', ...path.relative(base, target).split(path.sep)]) {
    cursor = part ? path.join(cursor, part) : cursor;
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw Error('Links are not allowed in release paths');
  }
  return target;
}

function names(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() &&
      !rootSet.has(entry.name) &&
      /^[\w-]+\.test\.cjs$/.test(entry.name)
    ) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error('Link in root test files');
      result.push(entry.name);
    } else if (
      entry.isFile() &&
      !rootSet.has(entry.name) &&
      !entry.name.startsWith('.') &&
      /\.(?:cjs|mjs|js|json|ts|css|html|yaml|yml|webmanifest)$/.test(entry.name)
    ) {
      throw Error('Add new root source to the explicit release list: ' + entry.name);
    }
  }
  function visit(directory) {
    const target = safePath(root, directory);
    if (!fs.existsSync(target)) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const name = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw Error('Link in source tree');
      if (entry.isDirectory()) {
        if (/^(?:\.|runtime|private|data(?:-|$)|backups|node_modules)/i.test(entry.name))
          throw Error('Private directory inside source tree');
        visit(name);
      } else if (entry.isFile() && allowed(name)) result.push(name);
      else throw Error('Unexpected file in release source tree: ' + name);
    }
  }
  trees.forEach(visit);
  for (const name of rootFiles) {
    const target = safePath(root, name);
    if (fs.existsSync(target)) {
      if (!fs.lstatSync(target).isFile()) throw Error('Expected source file');
      result.push(name);
    }
  }
  return result.sort();
}

function manifest(root) {
  return Object.fromEntries(
    names(root).map((name) => {
      const bytes = fs.readFileSync(safePath(root, name));
      return [name, { bytes: bytes.length, sha256: hash(bytes) }];
    }),
  );
}

function copySnapshot(root, destination) {
  const before = manifest(root);
  for (const [name, expected] of Object.entries(before)) {
    const bytes = fs.readFileSync(safePath(root, name));
    if (hash(bytes) !== expected.sha256) throw Error('Source changed during capture');
    const target = safePath(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const canonical = name.endsWith('.png')
      ? bytes
      : Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    fs.writeFileSync(target, canonical, { flag: 'wx' });
  }
  if (objectHash(before) !== objectHash(manifest(root)))
    throw Error('Source changed during capture');
  return before;
}

function verifySnapshot(root, expected) {
  if (!expected || Object.keys(expected).some((name) => !allowed(name)))
    throw Error('Invalid source manifest');
  if (objectHash(manifest(root)) !== objectHash(expected))
    throw Error('Candidate changed: prepare a new candidate');
}

function controllerHash(files) {
  return objectHash(
    Object.fromEntries(
      Object.entries(files).filter(
        ([name]) =>
          name === 'scripts/release.cjs' ||
          name === 'scripts/release-follow.cjs' ||
          name === 'scripts/check-types.cjs' ||
          name.startsWith('scripts/release/'),
      ),
    ),
  );
}

function assertController(root, files) {
  for (const [name, expected] of Object.entries(files)) {
    if (
      name !== 'scripts/release.cjs' &&
      name !== 'scripts/release-follow.cjs' &&
      name !== 'scripts/check-types.cjs' &&
      !name.startsWith('scripts/release/')
    )
      continue;
    const canonical = fs.readFileSync(safePath(root, name), 'utf8').replace(/\r\n/g, '\n');
    if (hash(canonical) !== expected.sha256)
      throw Error('Release controller changed: prepare a new candidate');
  }
}

module.exports = {
  hash,
  objectHash,
  allowed,
  safePath,
  names,
  manifest,
  copySnapshot,
  verifySnapshot,
  controllerHash,
  assertController,
};
