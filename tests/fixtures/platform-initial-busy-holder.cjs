// Owned synthetic lock holder; no application server, provider or descendants.
'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
let db, releaseTimer, watchdog, finished = false, phase = 'validate';
const directory = process.argv[2], nonce = process.argv[3];
function send(value, done = () => {}) {
  if (process.connected) process.send(value, done); else done();
}
function finish(reason) {
  if (finished) return;
  finished = true; clearTimeout(releaseTimer); clearTimeout(watchdog);
  let error;
  try { if (db?.isTransaction) db.exec('COMMIT'); }
  catch (value) { error = value; }
  finally { try { db?.close(); } catch (value) { error ||= value; } }
  process.removeListener('message', message); process.removeListener('disconnect', disconnected);
  for (const [signal, handler] of signals) process.removeListener(signal, handler);
  process.exitCode = reason === 'release-after-delay' && !error ? 0 : 1;
  send({ kind: error ? 'holder-error' : 'released', reason, releasedAt: Date.now(), phase,
    name: error?.name || null, code: error?.code || null,
    errcode: Number.isInteger(error?.errcode) ? error.errcode : null }, () => { if (process.connected) process.disconnect(); });
}
function message(value) {
  if (value?.kind !== 'release-after-delay' || value.nonce !== nonce || releaseTimer || finished) return;
  phase = 'hold'; releaseTimer = setTimeout(() => finish('release-after-delay'), 250);
}
const disconnected = () => finish('parent-disconnected');
const signals = new Map(['SIGTERM', 'SIGINT'].map((signal) => {
  const handler = () => finish('parent-stop'); process.on(signal, handler); return [signal, handler];
}));
process.on('message', message); process.once('disconnect', disconnected);
try {
  if (process.argv.length !== 4 || path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('cartoteca-initial-busy-') || fs.lstatSync(directory).isSymbolicLink())
    throw Error('Owned synthetic directory required');
  const marker = JSON.parse(fs.readFileSync(path.join(directory, '.initial-busy-owned.json'), 'utf8'));
  if (marker.purpose !== 'initial-platform-read-lock' || marker.parentPid !== process.ppid || marker.nonce !== nonce)
    throw Error('Owned parent fixture required');
  phase = 'open'; db = new DatabaseSync(path.join(directory, 'platform.sqlite'), { timeout: 5000 });
  if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw Error('Synthetic DELETE journal required');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  phase = 'lock'; db.exec('BEGIN EXCLUSIVE');
  watchdog = setTimeout(() => finish('own-watchdog'), 8000);
  send({ kind: 'locked', lockedAt: Date.now(), schemaVersion: version, journalMode: 'delete' });
} catch (error) {
  send({ kind: 'holder-error', phase, name: error.name, code: error.code || null,
    errcode: Number.isInteger(error.errcode) ? error.errcode : null });
  finish('setup-error');
}
