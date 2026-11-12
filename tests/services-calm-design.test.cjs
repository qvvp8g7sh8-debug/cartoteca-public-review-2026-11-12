// Prepared for the next requested check stage; no runtime data or real sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const root = path.resolve(__dirname, '..');

test('calm services layer stays within the catalogue and service editor on screen', () => {
  const sheet = postcss.parse(
    fs.readFileSync(path.join(root, 'src/client/styles/services-calm.css'), 'utf8'),
  );
  sheet.walkRules((rule) => {
    assert.match(rule.selector, /\.services-panel|\[data-editor-kind='service'\]/);
    assert.doesNotMatch(rule.selector, /calendar|public-booking|appointment-procedures|visit-procedures/);
    let parent = rule.parent;
    while (parent && parent.type !== 'atrule') parent = parent.parent;
    assert.ok(parent?.params.startsWith('screen'));
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/client/manifest.json'), 'utf8'));
  assert.ok(
    manifest.styles.indexOf('src/client/styles/services-calm.css') >
      manifest.styles.indexOf('src/client/styles/editor-design.css'),
  );
});
