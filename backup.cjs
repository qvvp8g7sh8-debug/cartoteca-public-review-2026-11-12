const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar-stream');
const { pipeline } = require('node:stream/promises');
const { createStorage } = require('./storage.cjs');
const { DatabaseSync } = require('node:sqlite');
const MAGIC = Buffer.from('CARTOBK1');
function backupKey(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw Error('Invalid backup key');
  return key;
}
async function createBackup(storage, directory, keyFile) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = backupKey(keyFile);
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
  const target = path.join(directory, 'cartoteca-' + id + '.enc');
  const snapshot = path.join(directory, 'snapshot-' + id + '.sqlite');
  const partial = target + '.partial';
  const verification = path.join(directory, '.verified-' + id);
  let orphanCandidates=[];
  let output, pack;
  try {
    // VACUUM INTO makes a consistent SQLite snapshot including committed WAL pages.
    storage.db.exec("VACUUM INTO '" + snapshot.replace(/'/g, "''") + "'");
    const snapshotDb=new DatabaseSync(snapshot,{readOnly:true});
    let photos;
    try {
      if(snapshotDb.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Invalid snapshot');
      photos=snapshotDb.prepare('SELECT id FROM photos WHERE active=1').all().map(r=>r.id);
      const active=new Set(photos);
      orphanCandidates=fs.readdirSync(storage.photoDir).filter(n=>/^[a-f0-9]{32}\.enc$/.test(n)&&!active.has(n.slice(0,32)));
    } finally {snapshotDb.close();}
    const files = [['cabinet.sqlite', snapshot], ['encryption.key', path.join(storage.directory, 'encryption.key')], ...photos.map(id => ['photos/' + id + '.enc', path.join(storage.photoDir, id + '.enc')])];
    pack = tar.pack();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    fs.writeFileSync(partial, Buffer.concat([MAGIC, iv]), { flag: 'wx', mode: 0o600 });
    output = pipeline(pack, cipher, fs.createWriteStream(partial, { flags: 'a' }));
    // Attach a rejection handler immediately while archive entries are being produced.
    output.catch(() => {});
    for (const [name, file] of files) {
      const bytes = fs.readFileSync(file);
      await new Promise((resolve, reject) => pack.entry({ name, size: bytes.length, mode: 0o600, type: 'file' }, bytes, error => error ? reject(error) : resolve()));
    }
    pack.finalize(); await output;
    fs.appendFileSync(partial, cipher.getAuthTag());
    // Authenticate the completed archive before publishing it as a successful backup.
    await verifyArchive(partial, keyFile);
    // Check database, key and every referenced photograph by restoring the completed archive.
    await restoreBackup(partial,keyFile,verification);
    fs.renameSync(partial, target);
    storage.set('backupStatus', { time: Date.now(), ok: true }); storage.audit('backup_created');
    const retained = fs.readdirSync(directory).filter(n => /^cartoteca-[\dTZ-]+-[a-f0-9]{8}\.enc$/.test(n)).sort().reverse();
    for (const name of retained.slice(14)) fs.unlinkSync(path.join(directory, name));
    // Only files absent from the verified snapshot AND still inactive may be removed.
    // The transaction prevents another writer reactivating a candidate between check and removal.
    storage.transaction(()=>{
      for(const name of orphanCandidates){
        const photoId=name.slice(0,32);
        if(storage.db.prepare('SELECT active FROM photos WHERE id=?').get(photoId)?.active===1)continue;
        const file=path.join(storage.photoDir,name);
        if(fs.existsSync(file))fs.unlinkSync(file);
        storage.db.prepare('DELETE FROM photos WHERE id=? AND active=0').run(photoId);
      }
    });
    return target;
  } catch (error) {
    pack?.destroy(error);
    if (output) await output.catch(() => {});
    storage.set('backupStatus', { time: Date.now(), ok: false }); storage.audit('backup_failed');
    throw error;
  } finally {
    if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
    if (fs.existsSync(partial)) fs.unlinkSync(partial);
    if(path.dirname(path.resolve(verification))===path.resolve(directory)&&path.basename(verification).startsWith('.verified-')&&fs.existsSync(verification))fs.rmSync(verification,{recursive:true,force:true});
  }
}
async function decryptArchive(source, keyFile, destination) {
  const size = fs.statSync(source).size;
  if (size < 36) throw Error('Invalid backup');
  const fd = fs.openSync(source, 'r');
  const header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { fs.readSync(fd, header, 0, 20, 0); fs.readSync(fd, tag, 0, 16, size - 16); } finally { fs.closeSync(fd); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw Error('Invalid backup format');
  const key = fs.readFileSync(keyFile);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAuthTag(tag);
  const sink = destination ? fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }) : new (require('node:stream').Writable)({ write(chunk, encoding, callback) { callback(); } });
  await pipeline(fs.createReadStream(source, { start: 20, end: size - 17 }), decipher, sink);
}
async function verifyArchive(source, keyFile) { await decryptArchive(source, keyFile); return true; }
async function restoreBackup(source, keyFile, destination) {
  destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw Error('Restore destination must not exist');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.cartoteca-restore-'));
  const archive = path.join(stage, 'archive.tar');
  const recovered = path.join(stage, 'data'); fs.mkdirSync(recovered, { mode: 0o700 });
  let storage;
  try {
    // No extraction until GCM authentication has succeeded for the entire archive.
    await decryptArchive(source, keyFile, archive);
    const extract = tar.extract(); const seen = new Set();
    extract.on('entry', (header, stream, next) => {
      const valid = header.type === 'file' && /^(cabinet\.sqlite|encryption\.key|photos\/[a-f0-9]{32}\.enc)$/.test(header.name) && !seen.has(header.name);
      if (!valid) { extract.destroy(Error('Unsafe or duplicate archive entry')); stream.resume(); return; }
      seen.add(header.name);
      const target = path.join(recovered, header.name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      pipeline(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })).then(() => next(), error => extract.destroy(error));
    });
    await pipeline(fs.createReadStream(archive), extract);
    if (!seen.has('cabinet.sqlite') || !seen.has('encryption.key')) throw Error('Incomplete backup');
    storage = createStorage(recovered);
    if (storage.db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Database integrity check failed');
    const state = storage.read(); let photos = 0;
    for (const p of state.patients) for (const v of p.visits) for (const ph of v.photos || []) { storage.photo(ph.data.split('/').pop()); photos++; }
    storage.db.exec('DELETE FROM sessions; DELETE FROM limits;'); storage.set('reset', null); storage.set('mfaPending', null); storage.audit('backup_restored');
    storage.close(); storage = null;
    fs.renameSync(recovered, destination);
    return { patients: state.patients.length, photos };
  } finally {
    storage?.close();
    // Only this mkdtemp-created staging folder may be removed recursively.
    if (path.dirname(stage) === path.dirname(destination) && path.basename(stage).startsWith('.cartoteca-restore-')) fs.rmSync(stage, { recursive: true, force: true });
  }
}
module.exports = { createBackup, restoreBackup, verifyArchive };
