const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { cleanEnvironment } = require('./process.cjs');
const { readCandidate, writeJson, lock } = require('./state.cjs');
const { assertController, safePath, verifySnapshot } = require('./files.cjs');

// No token in argv/logs; use the user's existing Git credential helper, without prompting.
function git(args, cwd, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Submission cancelled'));
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      env: cleanEnvironment({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '',
      overflow = false;
    child.stderr.resume();
    child.stdout.on('data', (bytes) => {
      output += bytes;
      if (output.length > 2 * 1024 * 1024) {
        overflow = true;
        child.kill();
      }
    });
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 180000);
    const done = (error, code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error || code !== 0 || overflow || signal?.aborted)
        reject(Error('Git submission step failed; check authentication and branch state'));
      else resolve(output.trim());
    };
    child.once('error', (error) => done(error));
    child.once('close', (code) => done(null, code));
  });
}

function coordinates({ repository, baseRef, branch }) {
  if (
    repository !== 'qvvp8g7sh8-debug/cartoteca' ||
    !/^codex\/release-pipeline-[a-z0-9][a-z0-9-]{0,80}$/.test(branch || '') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,160}$/.test(baseRef || '') ||
    baseRef.includes('..') ||
    baseRef.endsWith('/') ||
    baseRef.endsWith('.lock')
  )
    throw Error('Explicit repository, base branch and new release branch are required');
}

async function submit(root, id, opts, signal, execute = git) {
  coordinates(opts);
  const candidate = readCandidate(root, id);
  assertController(root, candidate.data.files);
  const directory = safePath(candidate.directory, 'submission-' + Date.now());
  const release = lock(candidate.directory);
  const report = {
    version: 1,
    candidate: id,
    sourceHash: candidate.data.sourceHash,
    repository: opts.repository,
    branch: opts.branch,
    baseRef: opts.baseRef,
    status: 'preparing',
    publishesSite: false,
    startedAt: new Date().toISOString(),
    steps: [],
  };
  try {
    fs.mkdirSync(directory);
    const empty = path.join(directory, 'empty-config');
    fs.writeFileSync(empty, '');
    const hooks = path.join(directory, 'no-hooks');
    fs.mkdirSync(hooks);
    const common = [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.filemode=false',
      '-c',
      'core.attributesFile=' + empty,
      '-c',
      'core.hooksPath=' + hooks,
    ];
    const run = async (stage, args) => {
      const started = Date.now();
      try {
        const output = await execute([...common, ...args], directory, signal);
        report.steps.push({ stage, status: 'passed', durationMs: Date.now() - started });
        return output;
      } catch (error) {
        report.steps.push({ stage, status: 'failed', durationMs: Date.now() - started });
        throw error;
      }
    };
    await run('init', ['init', '--template=', '--object-format=sha1']);
    await run('remote', [
      'remote',
      'add',
      'origin',
      'https://github.com/' + opts.repository + '.git',
    ]);
    if (await run('branch-absent', ['ls-remote', '--heads', 'origin', 'refs/heads/' + opts.branch]))
      throw Error('Release branch already exists; never overwrite or force-push it');
    await run('base', ['fetch', '--no-tags', '--depth=1', 'origin', 'refs/heads/' + opts.baseRef]);
    report.parent = await run('parent', ['rev-parse', 'FETCH_HEAD']);
    if (!/^[a-f0-9]{40}$/.test(report.parent)) throw Error('Invalid parent commit');
    await run('empty-index', ['read-tree', '--empty']);
    const paths = path.join(directory, 'source-paths');
    fs.writeFileSync(paths, Object.keys(candidate.data.files).join('\0') + '\0');
    await run('index', [
      '--work-tree=' + candidate.source,
      'add',
      '-f',
      '--pathspec-from-file=' + paths,
      '--pathspec-file-nul',
    ]);
    report.tree = await run('tree', ['write-tree']);
    if (!/^[a-f0-9]{40}$/.test(report.tree)) throw Error('Invalid Git tree');
    const entries = (await run('tree-proof', ['ls-tree', '-rz', report.tree]))
      .split('\0')
      .filter(Boolean);
    const files = Object.keys(candidate.data.files);
    if (entries.length !== files.length) throw Error('Git tree coverage differs from snapshot');
    for (const entry of entries) {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match || !Object.hasOwn(candidate.data.files, match[2]))
        throw Error('Unexpected Git tree entry');
      const bytes = fs.readFileSync(safePath(candidate.source, match[2]));
      const blob = crypto
        .createHash('sha1')
        .update('blob ' + bytes.length + '\0')
        .update(bytes)
        .digest('hex');
      if (blob !== match[1]) throw Error('Git content differs from frozen source');
    }
    report.commit = await run('commit', [
      '-c',
      'user.name=Codex release pipeline',
      '-c',
      'user.email=release-pipeline@users.noreply.github.com',
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      report.tree,
      '-p',
      report.parent,
      '-m',
      'Release candidate ' + id,
    ]);
    if (!/^[a-f0-9]{40}$/.test(report.commit)) throw Error('Invalid release commit');
    verifySnapshot(candidate.source, candidate.data.files);
    report.status = 'pushing';
    writeJson(path.join(directory, 'report.json'), report);
    await run('push', ['push', 'origin', report.commit + ':refs/heads/' + opts.branch]);
    const head = await run('remote-proof', [
      'ls-remote',
      '--heads',
      'origin',
      'refs/heads/' + opts.branch,
    ]);
    if (head !== report.commit + '\trefs/heads/' + opts.branch)
      throw Error('Remote release head differs from submitted snapshot');
    verifySnapshot(candidate.source, candidate.data.files);
    report.remoteVerified = true;
    candidate.data.github = {
      repository: opts.repository,
      head: report.commit,
      branch: opts.branch,
      sourceHash: report.sourceHash,
      submission: path.basename(directory),
    };
    writeJson(path.join(candidate.directory, 'candidate.json'), candidate.data);
    report.status = 'submitted';
  } catch (error) {
    report.error = error.message;
    report.status = report.status === 'pushing' ? 'unknown' : 'failed';
  } finally {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
    if (fs.existsSync(directory)) writeJson(path.join(directory, 'report.json'), report);
    release();
  }
  return report;
}
module.exports = { submit, coordinates, git };
