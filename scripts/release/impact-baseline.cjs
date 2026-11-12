const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { allowed, hash, objectHash, safePath } = require('./files.cjs');
const { readCandidate, writeJson, location } = require('./state.cjs');

function baseline(root, candidate, baselineId) {
  const recordFile = safePath(candidate.source, 'release-baseline.json');
  let record;
  try {
    record = baselineId
      ? { candidate: baselineId }
      : JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.candidate || ''))
      throw Error('Invalid baseline candidate');
    if (!baselineId && (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.sourceHash)))
      throw Error('Invalid published baseline');
    if (fs.existsSync(location(root, record.candidate))) {
      const previous = readCandidate(root, record.candidate);
      if (!baselineId && previous.data.sourceHash !== record.sourceHash)
        throw Error('Published baseline hash differs');
      return {
        known: true,
        id: previous.data.id,
        sourceHash: previous.data.sourceHash,
        origin: baselineId ? 'explicit-candidate' : 'published-record',
        files: previous.data.files,
        read: (name) => fs.readFileSync(safePath(previous.source, name), 'utf8'),
      };
    }
    if (baselineId || !/^[a-f0-9]{40}$/.test(record.commit || ''))
      throw Error('Baseline source unavailable');
    const git = (args, encoding, input) =>
      execFileSync('git', args, {
        cwd: root,
        encoding,
        input,
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
      });
    const entries = git(['ls-tree', '-rz', record.commit], 'utf8').split('\0').filter(Boolean);
    const contents = new Map(),
      files = {};
    const blobs = entries.map((entry) => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match || !allowed(match[2])) throw Error('Unsafe baseline tree');
      return { sha: match[1], name: match[2] };
    });
    const batch = git(
      ['cat-file', '--batch'],
      undefined,
      blobs.map((b) => b.sha).join('\n') + '\n',
    );
    let offset = 0;
    for (const blob of blobs) {
      const end = batch.indexOf(10, offset);
      const header = /^([a-f0-9]{40}) blob (\d+)$/.exec(
        batch.subarray(offset, end).toString('ascii'),
      );
      if (end < offset || !header || header[1] !== blob.sha) throw Error('Invalid Git blob batch');
      const size = Number(header[2]);
      offset = end + 1;
      const bytes = batch.subarray(offset, offset + size);
      if (bytes.length !== size || batch[offset + size] !== 10)
        throw Error('Truncated Git blob batch');
      offset += size + 1;
      contents.set(blob.name, bytes);
      files[blob.name] = { bytes: bytes.length, sha256: hash(bytes) };
    }
    if (offset !== batch.length) throw Error('Unexpected Git blob batch data');
    // Snapshot names use JS lexical ordering, not locale sorting.
    const canonical = Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [name, files[name]]),
    );
    if (objectHash(canonical) !== record.sourceHash)
      throw Error('Git baseline differs from published source');
    return {
      known: true,
      id: record.candidate,
      sourceHash: record.sourceHash,
      origin: 'published-git',
      files: canonical,
      read: (name) => contents.get(name).toString('utf8'),
    };
  } catch (error) {
    if (baselineId) throw error;
    return {
      known: false,
      reason: 'Published baseline missing, invalid or unavailable',
      files: {},
    };
  }
}

function recordPublished(root, id, result) {
  if (result.status !== 'completed' || result.published !== true || result.active !== false)
    return false;
  const candidate = readCandidate(root, id);
  if (
    candidate.data.github?.repository !== 'qvvp8g7sh8-debug/cartoteca' ||
    !/^[a-f0-9]{40}$/.test(candidate.data.github.head || '')
  )
    return false;
  if (candidate.data.github.submission) {
    const identity = candidate.data.github;
    if (
      !/^submission-\d+$/.test(identity.submission) ||
      identity.sourceHash !== candidate.data.sourceHash
    )
      return false;
    const report = JSON.parse(
      fs.readFileSync(safePath(candidate.directory, identity.submission + '/report.json'), 'utf8'),
    );
    if (
      report.status !== 'submitted' ||
      report.remoteVerified !== true ||
      report.candidate !== id ||
      report.sourceHash !== candidate.data.sourceHash ||
      report.repository !== identity.repository ||
      report.branch !== identity.branch ||
      report.commit !== identity.head
    )
      return false;
  }
  writeJson(safePath(root, 'release-baseline.json'), {
    version: 1,
    candidate: id,
    sourceHash: candidate.data.sourceHash,
    commit: candidate.data.github.head,
  });
  return true;
}
module.exports = { baseline, recordPublished };
