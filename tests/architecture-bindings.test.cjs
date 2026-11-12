const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function check(t, sources, bookingSources = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-bindings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write(
    'scripts/check-architecture.cjs',
    fs.readFileSync(path.join(__dirname, '../scripts/check-architecture.cjs')),
  );
  write('src/client/state.js', 'function createState() { return {}; }');
  write(
    'src/client/manifest.json',
    JSON.stringify({
      state: 'src/client/state.js',
      factories: [],
      adminSources: [],
      bookingSources,
    }),
  );
  for (const [file, text] of Object.entries(sources)) write(file, text);
  write('scripts/check-styles.cjs', 'exports.checkStyles = () => {};');
  write('scripts/check-docs.cjs', 'exports.checkDocumentation = () => {};');
  write(
    'scripts/client-contracts.cjs',
    'exports.analyzeClient = () => ({}); exports.checkClientContracts = () => {};',
  );
  write(
    'scripts/check-types.cjs',
    'exports.checkTypes = () => { throw Error("fixture reached type stage"); };',
  );
  const result = spawnSync(process.execPath, ['scripts/check-architecture.cjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, NODE_PATH: path.join(__dirname, '../node_modules') },
  });
  assert.equal(result.error, undefined);
  return result.stderr;
}

test('architecture accepts standard event and weak collection constructors', (t) => {
  assert.match(
    check(t, {
      'src/client/sample.js':
        'new WeakSet(); new WeakMap(); new Event("test"); new CustomEvent("test");',
    }),
    /fixture reached type stage/,
  );
});

test('architecture accepts the standard Symbol binding while rejecting undeclared symbol-like names', (t) => {
  assert.match(
    check(t, {
      'src/server/symbol-binding.cjs':
        "const sentinel = Symbol('lease proof'); module.exports = { [sentinel]: true, iterator: Symbol.iterator };",
    }),
    /fixture reached type stage/,
  );
  assert.match(
    check(t, {
      'src/server/symbol-binding.cjs': "const sentinel = unknownSymbolName('lease proof');",
    }),
    /symbol-binding\.cjs: unbound references unknownSymbolName/,
  );
});

test('architecture resolves booking functions only in the declared bundle', (t) => {
  const sources = {
    'src/client/public/a.js': 'function flow() {}',
    'src/client/public/b.js': 'flow();',
  };
  assert.match(check(t, sources, Object.keys(sources)), /fixture reached type stage/);
  sources['src/client/outsider.js'] = 'flow();';
  assert.match(
    check(t, sources, ['src/client/public/a.js', 'src/client/public/b.js']),
    /outsider.js: unbound references flow/,
  );
});

test('architecture still rejects typos and duplicate public definitions', (t) => {
  assert.match(
    check(t, { 'src/client/sample.js': 'new WeakSett();' }),
    /unbound references WeakSett/,
  );
  const sources = {
    'src/client/public/a.js': 'function flow() {}',
    'src/client/public/b.js': 'function flow() {}',
  };
  assert.match(check(t, sources, Object.keys(sources)), /Duplicate booking factory flow/);
});
