const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const manifest = require('../../src/client/manifest.json');
const factories = ['createWorkspaceView', 'createWorkspaceData', 'createWorkspaceSettings'];
function createWorkspaceSettingsHarness(state, baseActions, context) {
  const modules = factories.map((name) =>
    manifest.factories.find((entry) => entry.factory === name),
  );
  const source =
    fs.readFileSync(path.join(root, 'src/client/core/module-ports.js'), 'utf8') +
    '\n' +
    modules.map((entry) => fs.readFileSync(path.join(root, entry.path), 'utf8')).join('\n') +
    '\n;({createModulePorts,' +
    factories.join(',') +
    '})';
  const runtime = vm.runInNewContext(source, context);
  const registry = { ...baseActions };
  for (const entry of modules) {
    Object.assign(
      registry,
      runtime[entry.factory](state, runtime.createModulePorts(registry, entry.dependencies)),
    );
  }
  return registry;
}
module.exports = { createWorkspaceSettingsHarness };
