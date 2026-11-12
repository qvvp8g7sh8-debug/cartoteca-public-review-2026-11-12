const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {analyzeClient, checkClientContracts} = require('../scripts/client-contracts.cjs');
const root = path.resolve(__dirname, '..');
const manifest = require('../src/client/manifest.json');

test('module ports are read-only, restricted and resolved after composition', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'src/client/core/module-ports.js'), 'utf8'), context);
  const registry = {}, ports = context.createModulePorts(registry, ['save']);
  assert.throws(() => ports.save, /Unbound module port/);
  registry.save = () => 'saved';registry.unrelated = () => 'hidden';
  assert.equal(ports.save(), 'saved');
  assert.equal(ports.unrelated, undefined);
  assert.deepEqual(Object.keys(ports), ['save']);
  assert.equal(Object.isFrozen(ports), true);
});

test('architecture rejects missing/extra arguments and undeclared dependencies', () => {
  const analysis = analyzeClient(root, manifest);
  checkClientContracts(analysis, manifest);
  for (const count of [0, 2]) {
    assert.throws(() => checkClientContracts({...analysis, calls: [{file:'synthetic', name: 'saveVisitForm', count, spread:false}]}, manifest), /expects 1\.\.1/);
  }
  const changed = structuredClone(manifest);
  changed.factories[0].dependencies.push('unrelated');
  assert.throws(() => checkClientContracts(analysis, changed), /dependencies are stale/);
});

test('real save commands and negative contract fixtures pass strict type checking', () => {
  require('../scripts/check-types.cjs').checkTypes(root);
});
