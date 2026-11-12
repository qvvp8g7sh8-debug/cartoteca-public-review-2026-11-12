const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function checkTypes(root) {
  const digest = crypto.createHash('sha256');
  function visit(relative) {
    const target = path.join(root, relative);
    for (const name of fs.readdirSync(target).sort()) {
      const next = relative + '/' + name;
      if (fs.statSync(path.join(root, next)).isDirectory()) visit(next);
      else if (/\.(?:js|ts)$/.test(name))
        digest.update(next).update(fs.readFileSync(path.join(root, next)));
    }
  }
  visit('src/client');
  visit('tests/contracts');
  for (const file of [
    'tsconfig.contracts.json',
    'package-lock.json',
    'scripts/check-types.cjs',
    'node_modules/typescript/package.json',
  ])
    digest.update(file).update(fs.readFileSync(path.join(root, file)));
  digest.update(process.version).update(process.platform).update(process.arch);
  const inputHash = digest.digest('hex');
  // Opt-in, fixed candidate-local receipt. Standalone checks always compile.
  const cached = process.env.CARTOTECA_RELEASE_TYPES_CACHE === '1';
  const receipt = path.join(root, 'work/release-types.json');
  if (cached && fs.existsSync(receipt)) {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (previous.inputHash === inputHash && previous.status === 'passed') {
      console.log('Types: reused successful compilation for identical inputs.');
      return;
    }
  }
  const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.contracts.json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0)
    throw Error(
      'Typed client contracts failed:\n' + (result.stdout || result.stderr || result.error),
    );
  if (cached) {
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({ inputHash, status: 'passed' }));
  }
  console.log('Types: commands and negative fixtures passed.');
}
if (require.main === module) checkTypes(path.resolve(__dirname, '..'));
module.exports = { checkTypes };
