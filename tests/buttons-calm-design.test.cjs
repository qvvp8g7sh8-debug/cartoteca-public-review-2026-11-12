const { readAsset } = require('./helpers/interface-assets.cjs');
// Prepared for the next requested check stage; no runtime data or real sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const root = path.resolve(__dirname, '..');
const source = 'src/client/styles/buttons-calm.css';
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('shared calm action material is screen-only, scoped and preserves selection/status controls', () => {
  const sheet = postcss.parse(read(source));
  sheet.walkRules((rule) => {
    assert.match(rule.selector, /\.workspace\.workspace-designed.*dialog.*\.booking-shell/s);
    let parent = rule.parent;
    while (parent && parent.type !== 'atrule') parent = parent.parent;
    assert.ok(parent?.params.startsWith('screen'));
    for (const node of rule.nodes) {
      if (node.prop === 'transform') assert.equal(node.value, 'none');
      assert.ok(!node.important);
    }
  });
  const base = sheet.nodes
    .find((node) => node.type === 'atrule' && node.params === 'screen')
    .nodes.find((rule) => rule.selector?.replace(/\s+/g, '').includes(':not(:where('));
  assert.ok(base);
  for (const excluded of [
    'connection-service',
    'patient-mark-button',
    'appointment-record-open',
    'client-contact-action',
    'aria-pressed',
    'role=',
  ]) {
    assert.ok(base.selector.includes(excluded));
  }
  const declarations = Object.fromEntries(
    base.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
  );
  assert.equal(declarations['min-height'], '44px');
  assert.equal(declarations['word-break'], 'normal');
  assert.equal(declarations.hyphens, 'none');
  assert.match(declarations['box-shadow'], /inset/);
  assert.ok(sheet.nodes.some((node) => node.params?.includes('forced-colors')));
  assert.ok(sheet.nodes.some((node) => node.params?.includes('prefers-reduced-motion')));
});

test('main and public booking bundles share the exact calm source without new asset URLs', () => {
  const manifest = JSON.parse(read('src/client/manifest.json'));
  const desktopStart = manifest.styles.findIndex((file) => file.endsWith('/desktop-shell.css'));
  assert.equal(manifest.styles[desktopStart - 1], source);
  assert.ok(
    manifest.styles.indexOf(source) >
      manifest.styles.indexOf('src/client/styles/services-calm.css'),
  );
  assert.ok(read('scripts/build-client.cjs').includes("load('" + source + "')"));
  assert.ok(
    readAsset('booking.css').replace(/\r\n/g, '\n').endsWith(read(source).replace(/\r\n/g, '\n')),
  );
  assert.doesNotMatch(read('src/client/public/booking.html'), /buttons\.css/);
});
