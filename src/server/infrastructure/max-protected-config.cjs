const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { safeTree, plainFile } = require('./backup/snapshot.cjs');
const { syncFile, syncDirectory } = require('./backup/durable.cjs');

function windowsCrypt(operation, value) {
  if (process.platform !== 'win32' || !['Protect', 'Unprotect'].includes(operation))
    return Promise.reject(Error('Protected MAX configuration requires this Windows account.'));
  const script = `try {
    $PSModuleAutoLoadingPreference = 'None';
    [void][System.Reflection.Assembly]::Load('System.Security, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
    $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd());
    $result = [System.Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Out.Write([Convert]::ToBase64String($result));
  } catch { exit 1 }`;
  return new Promise((resolve, reject) => {
    // Secrets travel only through anonymous pipes, never argv, shell text or logs.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '',
      done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error('Protected MAX configuration timed out.'));
    }, 10000);
    child.on('error', () => finish(Error('Windows protection is unavailable.')));
    child.stdin.on('error', () => finish(Error('Windows protection is unavailable.')));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('ascii');
      if (output.length > 32768) {
        child.kill();
        finish(Error('Invalid protected configuration.'));
      }
    });
    child.on('close', (code) => {
      if (code || !/^[A-Za-z0-9+/]+={0,2}$/.test(output))
        finish(Error('Unable to use protected MAX configuration.'));
      else finish(null, Buffer.from(output, 'base64'));
    });
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}
function createMaxProtectedConfig(filename, { crypt = windowsCrypt } = {}) {
  filename = path.resolve(filename);
  const parent = path.dirname(filename);
  function exists() {
    safeTree(parent);
    if (!fs.existsSync(filename)) return false;
    plainFile(filename);
    return true;
  }
  async function load() {
    if (!exists() || fs.statSync(filename).size > 16384) throw Error('MAX configuration missing.');
    const bytes = await crypt('Unprotect', fs.readFileSync(filename));
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      if (
        value.version !== 1 ||
        !/^[\x21-\x7e]{1,2048}$/.test(value.token || '') ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(value.webhookSecret || '')
      )
        throw Error('Invalid MAX configuration.');
      return value;
    } finally {
      bytes.fill(0);
    }
  }
  async function save(token, { replace = false } = {}) {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(token))
      throw Error('Invalid token format.');
    const previous = exists();
    if (previous && !replace) throw Error('Confirm replacement of saved configuration.');
    const before = previous ? fs.readFileSync(filename) : null;
    // Keep the webhook secret when replacing the token, to avoid silent subscription rotation.
    const webhookSecret = previous
      ? (await load()).webhookSecret
      : crypto.randomBytes(32).toString('base64url');
    const plain = Buffer.from(JSON.stringify({ version: 1, token, webhookSecret }));
    let encrypted;
    try {
      encrypted = await crypt('Protect', plain);
    } finally {
      plain.fill(0);
    }
    safeTree(parent);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    // Recheck after async encryption. Never overwrite a file that appeared during save.
    if (exists() !== previous) throw Error('Configuration changed; reopen setup.');
    if (previous && !fs.readFileSync(filename).equals(before))
      throw Error('Configuration changed; reopen setup.');
    const partial = filename + '.' + crypto.randomUUID() + '.partial';
    fs.writeFileSync(partial, encrypted, { flag: 'wx', mode: 0o600 });
    syncFile(partial);
    if (previous) fs.renameSync(partial, filename);
    else {
      fs.linkSync(partial, filename);
      fs.unlinkSync(partial);
    }
    syncDirectory(parent);
    return { saved: true };
  }
  return { exists, save, load };
}
module.exports = { createMaxProtectedConfig, windowsCrypt };
