const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cleanEnvironment } = require('./process.cjs');

// Remote commands consist only of quoted, validated values, never a user-supplied command.
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
function transport(config, directory, signal) {
  const common = [
    '-i',
    config.identityFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'UserKnownHostsFile=' + config.knownHostsFile,
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
  ];
  const destination = config.user + '@' + config.host;
  async function execute(name, binary, args, input) {
    if (signal?.aborted) throw Error('Cancelled before transport');
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env: cleanEnvironment(),
        windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '',
        exceeded = false,
        timedOut = false;
      child.stdout.on('data', (bytes) => {
        if (stdout.length + bytes.length > 2 * 1024 * 1024) {
          exceeded = true;
          child.kill();
        } else stdout += bytes;
      });
      // SSH/Compose diagnostics may contain configuration. Do not persist arbitrary stderr.
      child.stderr.resume();
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill();
        },
        name === 'transfer' ? 1800000 : name === 'transfer-direct' ? 600000 : 60000,
      );
      let settled = false;
      function done(error, code) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        fs.appendFileSync(
          path.join(directory, 'transport.jsonl'),
          JSON.stringify({
            stage: name,
            startedAt: new Date(start).toISOString(),
            durationMs: Date.now() - start,
            code: code ?? null,
            timedOut,
            cancelled: Boolean(signal?.aborted),
          }) + '\n',
        );
        if (error || code !== 0 || exceeded || timedOut || signal?.aborted)
          reject(
            Error('Transport failed at ' + name + '; reconcile remote status before retrying'),
          );
        else resolve(stdout.trim());
      }
      child.on('error', (error) => done(error));
      child.on('close', (code) => done(null, code));
      if (input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    });
  }
  const ssh = (name, args, input) =>
    execute(
      name,
      process.platform === 'win32' ? 'ssh.exe' : 'ssh',
      [...common, '-p', String(config.port), destination, args.map(quote).join(' ')],
      input,
    );
  return {
    ssh,
    upload: (files, remote) =>
      execute('transfer', process.platform === 'win32' ? 'scp.exe' : 'scp', [
        ...common,
        '-P',
        String(config.port),
        ...files,
        destination + ':' + remote + '/',
      ]),
  };
}
module.exports = { transport, quote };
