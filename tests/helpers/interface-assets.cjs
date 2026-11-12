const fs = require('node:fs');
const path = require('node:path');
const { files, publicAssetRoot } = require('../../src/shared/web-assets.cjs');

const publicRoot = publicAssetRoot(path.resolve(__dirname, '../..'));
function assetPath(name) {
  if (
    typeof name !== 'string' ||
    !files.includes(name) ||
    name.includes('\\') ||
    path.isAbsolute(name)
  )
    throw Error('Expected a relative interface asset path.');
  const target = path.resolve(publicRoot, name);
  if (!target.startsWith(publicRoot + path.sep))
    throw Error('Interface asset path escaped public root.');
  return target;
}
function readAsset(name) {
  return fs.readFileSync(assetPath(name), 'utf8');
}
module.exports = { publicRoot, assetPath, readAsset };
