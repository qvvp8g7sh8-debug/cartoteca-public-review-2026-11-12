'use strict';
// Test-stand diagnostics only. Application/runtime modules never import this store.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
function privateStat(file, directory = false) {
  const stat = fs.lstatSync(file);
  assert(!stat.isSymbolicLink() && fs.realpathSync(file) === file);
  assert(directory ? stat.isDirectory() : stat.isFile());
  if (process.getuid) assert(stat.uid === process.getuid() && !(stat.mode & 0o077));
  return stat;
}
function createTestJournalStore(options) {
  assert.equal(options.production, false);
  assert.equal(options.testOnly, true);
  assert.equal(options.host, '127.0.0.1');
  assert(Number.isInteger(options.port) && options.port >= 0 && options.port <= 65535);
  const directory = path.resolve(options.directory),
    data = path.resolve(options.dataDirectory);
  privateStat(data, true);
  const markerPath = path.join(data, '.cartoteca-timeweb-manual-stand.json');
  assert(privateStat(markerPath).size <= 16384);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.identity, 'CARTOTECA-TIMEWEB-SYNTHETIC-MANUAL-WRITES-20261016');
  assert.equal(marker.directory, data);
  assert.equal(marker.syntheticOnly, true);
  assert.equal(marker.manualWritesEnabled, true);
  assert.equal(marker.noActualSave, false);
  assert(['starting', 'running'].includes(marker.state));
  if (process.getuid) assert.equal(marker.uid, process.getuid());
  assert.match(options.sourceHash, /^[a-f0-9]{64}$/u);
  const relative = path.relative(data, directory).split(path.sep);
  assert(
    relative.length === 3 &&
      relative[0] === 'manual-stand-reports' &&
      /^launch-[A-Za-z0-9_-]+$/u.test(relative[1]) &&
      relative[2] === 'voice-journal',
  );
  privateStat(path.dirname(directory), true);
  fs.mkdirSync(directory, { mode: 0o700 });
  privateStat(directory, true);
  const fileLimit = options.fileBytes ?? 2 * 1024 * 1024,
    fileCount = options.files ?? 8;
  assert(Number.isInteger(fileLimit) && fileLimit >= 4096 && fileLimit <= 16 * 1024 * 1024);
  assert(Number.isInteger(fileCount) && fileCount >= 2 && fileCount <= 32);
  const io = options.io || fs,
    journalId = randomUUID();
  let seq = 0,
    lastWrittenSeq = 0,
    droppedRecords = 0,
    evictedThroughSeq = 0,
    fault = null,
    closed = false,
    fd,
    index = 0,
    files = [];
  const fileName = (number) => 'assistant-' + String(number).padStart(6, '0') + '.ndjson';
  const safePath = (name) => {
    assert.match(name, /^assistant-\d{6}\.ndjson$/u);
    const target = path.join(directory, name);
    assert.equal(path.dirname(target), directory);
    return target;
  };
  function status() {
    return {
      journalId,
      healthy: !fault,
      closed,
      attemptedSeq: seq,
      lastWrittenSeq,
      droppedRecords,
      faultCode: fault,
      evictedThroughSeq,
      retainedFiles: files.map(({ name, firstSeq, lastSeq, bytes }) => ({
        name,
        firstSeq,
        lastSeq,
        bytes,
      })),
      fileLimit,
      fileCount,
    };
  }
  function stateFile() {
    const next = path.join(directory, 'state-' + randomUUID() + '.next'),
      final = path.join(directory, 'journal-state.json');
    const handle = io.openSync(next, 'wx', 0o600);
    try {
      io.writeFileSync(handle, JSON.stringify(status()) + '\n');
      io.fsyncSync(handle);
    } finally {
      io.closeSync(handle);
    }
    io.renameSync(next, final);
  }
  function faulted(error) {
    if (fault) return;
    fault = /^[A-Z0-9_]{1,40}$/u.test(error?.code || '') ? error.code : 'JOURNAL_IO_ERROR';
    try {
      options.onFault?.({ journalId, faultCode: fault, attemptedSeq: seq, droppedRecords });
    } catch {}
  }
  function write(row) {
    const value = { seq: ++seq, journalId, at: new Date().toISOString(), ...row };
    let raw = Buffer.from(JSON.stringify(value) + '\n');
    if (raw.length > fileLimit - 1024) {
      const originalBytes = raw.length;
      raw = Buffer.from(
        JSON.stringify({
          seq,
          journalId,
          at: value.at,
          kind: 'entry-overflow',
          requestId: value.requestId || null,
          originalKind: value.kind,
          originalBytes,
        }) + '\n',
      );
    }
    try {
      const current = files[files.length - 1];
      let written = 0;
      while (written < raw.length) {
        const n = io.writeSync(fd, raw, written, raw.length - written);
        assert(n > 0);
        written += n;
      }
      io.fsyncSync(fd);
      current.bytes += raw.length;
      current.lastSeq = seq;
      current.firstSeq ||= seq;
      lastWrittenSeq = seq;
      stateFile();
      return { written: true, seq };
    } catch (error) {
      droppedRecords++;
      faulted(error);
      return { written: false, seq };
    }
  }
  function rotate() {
    if (fd !== undefined) io.closeSync(fd);
    const name = fileName(++index);
    fd = io.openSync(safePath(name), 'wx', 0o600);
    let removed;
    if (files.length >= fileCount) {
      removed = files.shift();
      evictedThroughSeq = Math.max(evictedThroughSeq, removed.lastSeq);
    }
    files.push({ name, bytes: 0, firstSeq: null, lastSeq: null });
    write({
      kind: index === 1 ? 'journal-open' : 'rotation',
      sourceHash: options.sourceHash,
      syntheticOnly: true,
      production: false,
      evictedThroughSeq,
      removedFile: removed?.name || null,
    });
    if (removed && !fault) {
      const old = safePath(removed.name);
      privateStat(old);
      io.unlinkSync(old);
    }
  }
  function append(row) {
    if (closed || fault) {
      seq++;
      droppedRecords++;
      return { written: false, seq };
    }
    try {
      const size = Buffer.byteLength(JSON.stringify(row)) + 256;
      if (files[files.length - 1].bytes + size > fileLimit) rotate();
      if (fault) {
        seq++;
        droppedRecords++;
        return { written: false, seq };
      }
      return write(row);
    } catch (error) {
      seq++;
      droppedRecords++;
      faulted(error);
      return { written: false, seq };
    }
  }
  function close() {
    if (closed) return;
    append({ kind: 'journal-close', complete: !fault, evictedThroughSeq });
    closed = true;
    try {
      stateFile();
    } catch (error) {
      faulted(error);
    }
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {}
      fd = undefined;
    }
  }
  try {
    rotate();
  } catch (error) {
    faulted(error);
  }
  return { append, status, close, directory };
}
module.exports = { createTestJournalStore };
