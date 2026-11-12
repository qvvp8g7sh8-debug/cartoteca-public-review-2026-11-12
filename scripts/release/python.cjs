const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Reuse an installed native runtime. Never invoke a Store installer alias.
function nativePython() {
  if (process.platform !== 'win32') return 'python3';
  const bundled = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python',
    'python.exe',
  );
  const candidates = [bundled];
  for (const directory of (process.env.PATH || '').split(path.delimiter))
    for (const name of ['python3.exe', 'python.exe'])
      candidates.push(path.join(directory.replace(/^"|"$/g, ''), name));
  for (const file of candidates) {
    if (!path.isAbsolute(file) || file.startsWith('\\\\')) continue;
    try {
      const info = fs.statSync(file);
      if (info.isFile() && info.size > 0) return file;
    } catch {}
  }
  throw Error('Existing native Python executable required; no install or silent skip');
}

module.exports = { nativePython };
