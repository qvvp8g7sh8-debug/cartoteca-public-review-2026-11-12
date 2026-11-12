const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function plain(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()))
    throw Error('Unsafe migration asset path.');
  return stat;
}
function assetHash(file) {
  plain(file);
  const hash = crypto.createHash('sha256'),
    descriptor = fs.openSync(file, 'r'),
    buffer = Buffer.allocUnsafe(128 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}
function migrationAssets(source, stores) {
  source = fs.realpathSync(source);
  plain(source, true);
  const files = [];
  function add(relative, key = false) {
    const file = path.join(source, relative);
    plain(file);
    if (key && fs.statSync(file).size !== 32) throw Error('Existing encryption key is invalid.');
    files.push({ relative, sha256: assetHash(file), bytes: fs.statSync(file).size });
  }
  add('platform/platform.key', true);
  for (const name of ['assistant-state.enc'])
    if (fs.existsSync(path.join(source, 'platform', name))) add('platform/' + name);
  for (const store of stores.filter((s) => s.kind === 'cabinet' && !s.emptyOrigin)) {
    const relative = store.relativeDirectory === '.' ? '' : store.relativeDirectory + '/';
    add(relative + 'encryption.key', true);
    const photos = path.join(source, relative, 'photos');
    if (fs.existsSync(photos)) {
      plain(photos, true);
      for (const name of fs.readdirSync(photos).sort()) {
        if (!/^[a-f0-9]{32}\.enc$/.test(name)) throw Error('Unsupported photo asset filename.');
        add(relative + 'photos/' + name);
      }
    }
  }
  return files;
}
function copyMigrationAssets({ source, destination, files, profile, onCreate = () => {} }) {
  const target = path.resolve(destination),
    origin = path.resolve(source),
    relative = path.relative(origin, target);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) ||
    fs.existsSync(target)
  )
    throw Error('Migration needs a separate new asset destination.');
  plain(path.dirname(target), true);
  fs.mkdirSync(target, { mode: 0o700 });
  onCreate();
  for (const file of files) {
    const output = path.join(target, file.relative);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(origin, file.relative), output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
    if (
      assetHash(output) !== file.sha256 ||
      assetHash(path.join(origin, file.relative)) !== file.sha256
    )
      throw Error('Migration asset verification failed.');
  }
  for (const store of profile.stores.filter((s) => s.kind === 'cabinet' && s.emptyOrigin)) {
    const directory = path.join(target, store.relativeDirectory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'encryption.key'), crypto.randomBytes(32), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return target;
}
function publishProfile(destination, profile) {
  const target = path.join(destination, 'postgresql-runtime.json'),
    temporary = target + '.prepared';
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(profile, null, 2) + '\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
}
module.exports = { migrationAssets, copyMigrationAssets, publishProfile, assetHash, plain };
