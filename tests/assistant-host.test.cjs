const { assetPath } = require('./helpers/interface-assets.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/client/core/assistant-host.js'), 'utf8');
function fixture() {
  const frames = [],
    idle = [],
    timers = new Map(),
    loads = [],
    installed = [],
    mounted = [],
    destroyed = [];
  let timerId = 0;
  const state = {
    account: { id: 'synthetic', organizationId: 'org' },
    multiUser: true,
    sessionReady: true,
    assistantGeneration: 0,
    assistantReady: false,
    assistantScope: null,
    assistantBundleId: 'same-source',
  };
  const factory = vm.runInNewContext(source + '\ncreateAssistantHost', {
    document: { hidden: false, querySelector: () => ({ content: '1111111111111111' }) },
    window: {
      requestAnimationFrame: (fn) => frames.push(fn),
      requestIdleCallback: (fn) => idle.push(fn),
      addEventListener() {},
    },
    setTimeout(fn) {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const api = factory(
    state,
    {
      toast() {},
      mountVoiceAssistant() {
        mounted.push(true);
      },
      destroyVoiceAssistant() {
        destroyed.push(true);
      },
    },
    (module) => installed.push(module),
    (url) => new Promise((resolve) => loads.push({ url, resolve })),
  );
  const scope = { enabled: true, organizationId: 'org', policyVersion: 1, demo: true };
  return {
    state,
    api,
    scope,
    frames,
    idle,
    timers,
    loads,
    installed,
    mounted,
    destroyed,
    run() {
      frames.shift()();
      frames.shift()();
      idle.shift()();
    },
    async deliver() {
      loads[0].resolve({ bundleId: 'same-source' });
      for (let i = 0; i < 14; i++) await Promise.resolve();
    },
  };
}
test('disabled, absent and foreign membership never schedule or import assistant code', () => {
  for (const scope of [
    undefined,
    { enabled: false },
    { enabled: true, organizationId: 'another' },
  ]) {
    const f = fixture();
    f.api.applyAssistantScope(scope);
    f.api.scheduleAssistantLoad();
    assert.equal(f.loads.length, 0);
    assert.equal(f.frames.length, 0);
    assert.equal(f.state.assistantReady, false);
  }
});
test('granted assistant automatically loads after visible calendar paint and idle without click', async () => {
  const f = fixture();
  f.api.applyAssistantScope(f.scope);
  assert.equal(f.loads.length, 0);
  f.run();
  assert.equal(f.loads.length, 1);
  assert.match(f.loads[0].url, /^\/app-assistant.js\?v=/);
  await f.deliver();
  assert.equal(f.installed.length, 1);
  assert.equal(f.mounted.length, 1);
  assert.equal(f.state.assistantReady, true);
});
test('revocation and organization change discard late imports and hide installed assistant', async () => {
  const f = fixture();
  f.api.applyAssistantScope(f.scope);
  f.run();
  f.api.applyAssistantScope({ enabled: false });
  await f.deliver();
  assert.equal(f.installed.length, 0);
  assert.equal(f.state.assistantReady, false);
  const g = fixture();
  g.api.applyAssistantScope(g.scope);
  g.run();
  await g.deliver();
  g.state.account = { id: 'synthetic', organizationId: 'another' };
  g.api.mountAssistant();
  assert.equal(g.destroyed.length, 1);
  assert.equal(g.state.assistantScope, null);
});
test('source version mismatch never installs assistant code', async () => {
  const f = fixture();
  f.api.applyAssistantScope(f.scope);
  f.run();
  f.loads[0].resolve({ bundleId: 'another-source' });
  for (let i = 0; i < 14; i++) await Promise.resolve();
  assert.equal(f.installed.length, 0);
  assert.equal(f.state.assistantReady, false);
});

test('same-organization role change invalidates installed assistant state and a role change during import cannot install stale code', async () => {
  const f = fixture();
  f.state.account.role = 'owner';
  f.api.applyAssistantScope(f.scope);
  f.run();
  await f.deliver();
  f.state.account.role = 'cosmetologist';
  f.api.mountAssistant();
  assert.equal(f.destroyed.length, 1);
  assert.equal(f.state.assistantReady, false);
  assert.equal(f.state.assistantScope, null);
  const g = fixture();
  g.state.account.role = 'owner';
  g.api.applyAssistantScope(g.scope);
  g.run();
  g.state.account.role = 'salon_admin';
  await g.deliver();
  assert.equal(g.installed.length, 0);
  assert.equal(g.state.assistantReady, false);
});
test('assistant delivery stays separate, protected and versioned', () => {
  const manifest = require('../src/client/manifest.json');
  assert.equal(
    manifest.factories.find((item) => item.factory === 'createAssistantHost').phase,
    undefined,
  );
  for (const factory of ['createAssistantAudio', 'createAssistantCommands', 'createVoiceAssistant'])
    assert.equal(manifest.factories.find((item) => item.factory === factory).phase, 'assistant');
  const initial = fs.readFileSync(assetPath('app.js'), 'utf8');
  const assistant = fs.readFileSync(assetPath('app-assistant.js'), 'utf8');
  assert.doesNotMatch(initial, /function createAssistantAudio\(|getUserMedia/);
  assert.match(assistant, /function createAssistantAudio\(/);
  assert.ok(
    require('../src/server/http/client-release.cjs').releaseFiles.includes('app-assistant.js'),
  );
  assert.ok(require('../scripts/release/files.cjs').allowed('dist/public/app-assistant.js'));
  assert.match(
    fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'),
    /^COPY dist\/public \.\/dist\/public$/m,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'src/client/pwa/service-worker.js'), 'utf8'),
    /app-assistant/,
  );
});
