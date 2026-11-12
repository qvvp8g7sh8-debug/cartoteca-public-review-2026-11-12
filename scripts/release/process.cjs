const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function cleanEnvironment(extra = {}) {
  const env = {};
  const allowed = new Set([
    'path',
    'systemroot',
    'windir',
    'comspec',
    'temp',
    'tmp',
    'tmpdir',
    'home',
    'userprofile',
    'appdata',
    'localappdata',
    'programfiles',
    'programfiles(x86)',
    'programdata',
    'pathext',
    // PowerShell otherwise rediscovers modules for every Add-Type call (25s+ on hosted Windows).
    'psmodulepath',
    'lang',
    'lc_all',
  ]);
  for (const [key, value] of Object.entries(process.env))
    if (allowed.has(key.toLowerCase())) env[key] = value;
  return { ...env, CI: '1', TZ: 'UTC', ...extra };
}

function npmCli() {
  const bin = path.dirname(process.execPath);
  for (const file of [
    path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js',
  ])
    if (fs.existsSync(file)) return file;
  throw Error('npm CLI is unavailable next to Node.js');
}

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
      env: cleanEnvironment(),
    });
    killer.on('error', () => child.kill());
    killer.on('close', (code) => {
      if (code !== 0) child.kill();
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function runProcess(command, args, { cwd, log, env = {}, signal, timeoutMs = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('Cancelled'));
    const started = Date.now();
    const descriptor = fs.openSync(log, 'wx');
    const child = spawn(command, args, {
      cwd,
      env: cleanEnvironment(env),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', descriptor, descriptor],
    });
    let timedOut = false,
      settled = false;
    const abort = () => stopTree(child);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    const finish = (error, code, exitSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fs.closeSync(descriptor);
      if (error) return reject(error);
      resolve({
        code,
        signal: exitSignal,
        durationMs: Date.now() - started,
        status: timedOut
          ? 'timed_out'
          : signal?.aborted
            ? 'cancelled'
            : code === 0
              ? 'passed'
              : 'failed',
      });
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code, exitSignal) => finish(null, code, exitSignal));
  });
}

async function pool(items, concurrency, operation, signal) {
  let next = 0,
    failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      try {
        while (!failed && !signal?.aborted && next < items.length) await operation(items[next++]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }),
  );
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
}

module.exports = { cleanEnvironment, npmCli, runProcess, pool };
