const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { createGzip, createGunzip } = require('node:zlib');
const tar = require('tar-stream');
const MAGIC = Buffer.from('CARTOBK2');
const COMPRESSED_MAGIC = Buffer.from('CARTOBK3');
const POSTGRES_MAGIC = Buffer.from('CARTOPG1');
function archiveKind(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe backup archive path.');
  const descriptor = fs.openSync(filename, 'r'),
    header = Buffer.alloc(8);
  try {
    if (fs.readSync(descriptor, header, 0, 8, 0) !== 8) return 'unknown';
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.equals(POSTGRES_MAGIC)) return 'postgres';
  if (header.equals(MAGIC) || header.equals(COMPRESSED_MAGIC)) return 'sqlite';
  return 'unknown';
}
const limits = { bytes: 1024 ** 4, entries: 1000000, fileBytes: 16 * 1024 ** 3 };
const validName = (name) =>
  /^(manifest\.json|platform\/(platform\.sqlite|platform\.key|booking-read-budget\.sqlite|assistant-state\.enc)|(?:tenants\/[a-zA-Z0-9_-]{1,120}\/)?(?:cabinet\.sqlite|encryption\.key|photos\/[a-f0-9]{32}\.enc))$/.test(
    name,
  );
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function writeArchive(
  directory,
  names,
  target,
  key,
  { compressed = true, backend = 'sqlite', validateName = validName } = {},
) {
  if (
    !['sqlite', 'postgres'].includes(backend) ||
    typeof validateName !== 'function' ||
    (backend === 'postgres' && !compressed)
  )
    throw Error('Unsupported archive backend.');
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv('aes-256-gcm', key, iv),
    pack = tar.pack();
  const header = Buffer.concat([
      backend === 'postgres' ? POSTGRES_MAGIC : compressed ? COMPRESSED_MAGIC : MAGIC,
      iv,
    ]),
    hash = crypto.createHash('sha256');
  hash.update(header);
  if (backend === 'postgres') cipher.setAAD(header);
  fs.writeFileSync(target, header, { flag: 'wx', mode: 0o600 });
  const measure = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const output = pipeline(
    ...[
      pack,
      ...(compressed ? [createGzip({ level: 1 })] : []),
      cipher,
      measure,
      fs.createWriteStream(target, { flags: 'a' }),
    ],
  );
  output.catch(() => {});
  try {
    for (const name of names) {
      if (!validateName(name)) throw Error('Unsafe archive name.');
      const file = path.join(directory, name),
        size = fs.statSync(file).size;
      await pipeline(
        fs.createReadStream(file),
        pack.entry({ name, size, type: 'file', mode: 0o600 }),
      );
    }
    pack.finalize();
    await output;
    const tag = cipher.getAuthTag();
    fs.appendFileSync(target, tag);
    hash.update(tag);
    return { sha256: hash.digest('hex'), bytes: fs.statSync(target).size };
  } catch (error) {
    pack.destroy(error);
    await output.catch(() => {});
    throw error;
  }
}
async function extractArchive(
  source,
  key,
  directory,
  bounds = limits,
  { backend = 'sqlite', validateName = validName } = {},
) {
  if (!['sqlite', 'postgres'].includes(backend) || typeof validateName !== 'function')
    throw Error('Unsupported archive backend.');
  const size = fs.statSync(source).size;
  if (size < 36 || size > bounds.bytes) throw Error('Invalid backup size.');
  const fd = fs.openSync(source, 'r'),
    header = Buffer.alloc(20),
    tag = Buffer.alloc(16);
  try {
    fs.readSync(fd, header, 0, 20, 0);
    fs.readSync(fd, tag, 0, 16, size - 16);
  } finally {
    fs.closeSync(fd);
  }
  const postgres = header.subarray(0, 8).equals(POSTGRES_MAGIC);
  const compressed = postgres || header.subarray(0, 8).equals(COMPRESSED_MAGIC);
  if (
    backend === 'postgres'
      ? !postgres
      : postgres || (!compressed && !header.subarray(0, 8).equals(MAGIC))
  )
    throw Error('Not a supported full backup.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAuthTag(tag);
  if (postgres) decipher.setAAD(header);
  const archive = path.join(directory, 'authenticated.tar'),
    recovered = path.join(directory, 'data');
  // Authentication must finish before parsing any names or writing recovered data.
  await pipeline(
    fs.createReadStream(source, { start: 20, end: size - 17 }),
    decipher,
    fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
  );
  fs.mkdirSync(recovered, { mode: 0o700 });
  const extract = tar.extract(),
    seen = new Set();
  let total = 0;
  extract.on('entry', (header, stream, next) => {
    stream.on('error', () => {}); // extract.destroy also destroys the current tar entry.
    total += header.size;
    const maximum = /\.key$/.test(header.name)
      ? 32
      : /\.enc$|^manifest\.json$/.test(header.name)
        ? 32 * 1024 * 1024
        : bounds.fileBytes;
    if (
      header.type !== 'file' ||
      !validateName(header.name) ||
      seen.has(header.name) ||
      seen.size >= bounds.entries ||
      !Number.isSafeInteger(header.size) ||
      header.size < 0 ||
      header.size > maximum ||
      total > bounds.bytes
    ) {
      extract.destroy(Error('Unsafe or excessive archive entry.'));
      stream.resume();
      return;
    }
    seen.add(header.name);
    const file = path.join(recovered, header.name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    pipeline(stream, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 })).then(
      () => next(),
      (error) => extract.destroy(error),
    );
  });
  let expanded = 0;
  const bounded = new Transform({
    transform(chunk, encoding, callback) {
      expanded += chunk.length;
      if (expanded > bounds.bytes) callback(Error('Excessive expanded backup size.'));
      else callback(null, chunk);
    },
  });
  await pipeline(
    ...[fs.createReadStream(archive), ...(compressed ? [createGunzip()] : []), bounded, extract],
  );
  if (!seen.has('manifest.json')) throw Error('Backup manifest is missing.');
  return { recovered, seen };
}
module.exports = { writeArchive, extractArchive, digest, validName, limits, archiveKind };
