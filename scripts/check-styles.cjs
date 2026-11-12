const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { compactStyles } = require('./compact-styles.cjs');
function checkStyles(root, manifest) {
  for (const file of manifest.styles) {
    postcss.parse(fs.readFileSync(path.join(root, file), 'utf8'), { from: file });
  }
  return manifest.styles.length;
}
if (require.main === module) {
  console.log(
    'Standalone styles verified: ' +
      checkStyles(path.resolve(__dirname, '..'), require('../src/client/manifest.json')),
  );
}
module.exports = { checkStyles, compactStyles };
