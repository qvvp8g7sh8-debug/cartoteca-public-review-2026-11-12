const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const acorn = require('acorn');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { allowed, copySnapshot, manifest } = require('../scripts/release/files.cjs');
const { runtimeFiles } = require('../scripts/release/deployment-plan.cjs');
const { files: webFiles, setupSources } = require('../src/shared/web-assets.cjs');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-dist-package-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cartoteca-dist-package-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const write = (name, bytes) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  return { directory, write };
}

test('publication acceptance compares strict frozen dist bytes and rejects missing outputs', (t) => {
  const f = fixture(t);
  const { publicAssetRoot } = require('../src/shared/web-assets.cjs');
  const code = fs.readFileSync(path.join(root, 'scripts/release/publication-check.cjs'), 'utf8');
  const ast = acorn.parse(code, { ecmaVersion: 'latest' });
  let read;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.name === 'fs' &&
      node.callee.property.name === 'readFileSync' &&
      code.slice(node.start, node.end).includes('endpoint.slice(1)')
    )
      read = node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  assert.ok(read, 'Missing actual publication resource read');
  for (const name of ['ui-extra.css', 'service-worker.js', 'booking.js']) {
    f.write(name, 'WRONG_ROOT_COPY');
    f.write('dist/public/' + name, 'EXACT_FROZEN_' + name);
    const evaluate = () =>
      vm.runInNewContext(code.slice(read.start, read.end), {
        path,
        fs,
        publicAssetRoot,
        candidate: { source: f.directory },
        endpoint: '/' + name,
      });
    assert.equal(evaluate().toString(), 'EXACT_FROZEN_' + name);
    fs.unlinkSync(path.join(publicAssetRoot(f.directory), name));
    assert.throws(evaluate, (error) => error.code === 'ENOENT');
  }
});

test('verification indexes ignored build assets only from the explicit source manifest', (t) => {
  const f = fixture(t);
  f.write('.gitignore', 'dist/\nprivate/\n');
  f.write('dist/public/app.js', '// synthetic ready build\n');
  f.write('dist/setup/max-setup.html', '<html>Synthetic loopback setup</html>\n');
  f.write('private/excluded.txt', 'SYNTHETIC_EXCLUDED');
  const expected = Object.keys(manifest(f.directory)).sort();
  const pathspec = path.join(f.directory, 'source-paths');
  fs.writeFileSync(pathspec, expected.join('\0') + '\0');
  const git = (args) => {
    const result = spawnSync('git', ['-c', 'safe.directory=' + f.directory, ...args], {
      cwd: f.directory,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['-c', 'core.autocrlf=false', 'init', '--template=']);
  const code = fs.readFileSync(path.join(root, 'scripts/release/runner.cjs'), 'utf8');
  const ast = acorn.parse(code, { ecmaVersion: 'latest' });
  let call;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (
      node.type === 'CallExpression' &&
      node.callee.name === 'git' &&
      node.arguments[0]?.value === 'git-index'
    )
      call = node;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(ast);
  assert.ok(call, 'Missing actual verification index command');
  vm.runInNewContext(code.slice(call.start, call.end), {
    pathspec,
    git: (id, args) => {
      assert.equal(id, 'git-index');
      git(Array.from(args));
    },
  });
  assert.deepEqual(git(['ls-files', '-z']).split('\0').filter(Boolean).sort(), expected);
  assert.equal(git(['ls-files', 'private/excluded.txt']), '');
});

test('snapshot preserves only cataloged public build files and binary icons', (t) => {
  const f = fixture(t);
  f.write('dist/public/app.js', '// synthetic browser bundle\r\n');
  const png = Buffer.from([137, 80, 78, 71, 0, 13, 10, 255]);
  f.write('dist/public/icons/icon-192.png', png);
  f.write('src/client/static/icons/icon-192.png', png);
  f.write('dist/setup/max-setup.html', '<html>Synthetic setup</html>\r\n');
  f.write('private/not-a-source.js', 'SYNTHETIC_PRIVATE');
  const destination = path.join(f.directory, 'snapshot');
  fs.mkdirSync(destination);
  copySnapshot(f.directory, destination);
  assert.deepEqual(Object.keys(manifest(destination)), [
    'dist/public/app.js',
    'dist/public/icons/icon-192.png',
    'dist/setup/max-setup.html',
    'src/client/static/icons/icon-192.png',
  ]);
  assert.equal(
    fs.readFileSync(path.join(destination, 'dist/public/app.js'), 'utf8'),
    '// synthetic browser bundle\n',
  );
  assert.deepEqual(fs.readFileSync(path.join(destination, 'dist/public/icons/icon-192.png')), png);
  assert.deepEqual(
    fs.readFileSync(path.join(destination, 'src/client/static/icons/icon-192.png')),
    png,
  );
  for (const name of webFiles) assert.equal(allowed('dist/public/' + name), true, name);
  for (const name of [
    'dist/private/secret.js',
    'dist/public/unregistered.js',
    'dist/public/.env',
    'dist/public/icons/private.png',
    'dist/public/../app.js',
    'dist/public/app.js/token',
    'dist/public/platform.sqlite',
    'src/client/static/icons/private.png',
    'dist/setup/unregistered.html',
    'src/client/setup/private.js',
  ])
    assert.equal(allowed(name), false, name);
});

test('unexpected build output cannot silently enter a frozen snapshot', (t) => {
  const f = fixture(t);
  f.write('dist/public/app.js', '// synthetic');
  f.write('dist/public/unregistered.js', 'SYNTHETIC_NOT_A_PUBLIC_ASSET');
  assert.throws(() => manifest(f.directory), /Unexpected file in release source tree/);
});

test('snapshot rejects a linked public directory instead of following it', (t) => {
  const f = fixture(t);
  f.write('outside/app.js', '// synthetic');
  fs.mkdirSync(path.join(f.directory, 'dist'));
  fs.symlinkSync(
    path.join(f.directory, 'outside'),
    path.join(f.directory, 'dist/public'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assert.throws(() => manifest(f.directory), /Link in source tree/);
});

function currentRuntime() {
  const files = manifest(root);
  return { files, runtime: runtimeFiles({ source: root, data: { files } }) };
}

test('runtime delivery retains every backend module and public asset without development trees', () => {
  const { files, runtime } = currentRuntime();
  for (const name of Object.keys(files).filter((name) => /^src\/(?:server|shared)\//.test(name)))
    assert.equal(runtime[name], files[name].sha256, name);
  for (const name of webFiles)
    assert.equal(runtime['dist/public/' + name], files['dist/public/' + name]?.sha256, name);
  for (const name of Object.keys(setupSources)) {
    assert.ok(files['dist/setup/' + name], name);
    assert.equal(runtime['dist/setup/' + name], files['dist/setup/' + name].sha256, name);
    assert.equal(Object.hasOwn(runtime, 'dist/public/' + name), false, name);
  }
  for (const name of [
    'multi-server.cjs',
    'client-address.cjs',
    'image-processing.cjs',
    'image-worker.cjs',
    'scripts/backup-v2.cjs',
    'scripts/backup-agent.cjs',
    'scripts/start-workers.cjs',
    'scripts/start-background.cjs',
    'trust/max-root.pem',
  ])
    assert.ok(runtime[name], name);
  assert.equal(
    Object.keys(runtime).some((name) =>
      /^(?:src\/client\/|tests\/|docs\/|\.release\/|work\/|\.git\/|\.github\/)/.test(name),
    ),
    false,
  );
  for (const name of webFiles) assert.equal(Object.hasOwn(runtime, name), false, name);
});

test('all literal local runtime imports are present in the delivery inventory', () => {
  const { runtime } = currentRuntime();
  const missing = [];
  const visit = (node, importer, resolve) => {
    if (
      node?.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0].type === 'Literal' &&
      typeof node.arguments[0].value === 'string' &&
      node.arguments[0].value.startsWith('.')
    ) {
      const target = path.relative(root, resolve(node.arguments[0].value)).replaceAll('\\', '/');
      if (!Object.hasOwn(runtime, target)) missing.push(importer + ' -> ' + target);
    }
    for (const value of Object.values(node || {})) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, importer, resolve);
      } else if (value?.type) visit(value, importer, resolve);
    }
  };
  for (const name of Object.keys(runtime).filter((name) => name.endsWith('.cjs'))) {
    const filename = path.join(root, name);
    const ast = acorn.parse(fs.readFileSync(filename, 'utf8'), { ecmaVersion: 'latest' });
    visit(ast, name, createRequire(filename).resolve);
  }
  assert.deepEqual(missing, []);
});

test('Docker context starts closed and opens only reviewed runtime inputs', () => {
  const rules = fs
    .readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(rules[0], '**');
  const inclusions = new Set(
    rules.filter((line) => line.startsWith('!')).map((line) => line.slice(1)),
  );
  const { runtime } = currentRuntime();
  const sourceTrees = new Set(['src/server/**', 'src/shared/**']);
  const buildConfiguration = new Set(['Dockerfile', 'Dockerfile.caddy', 'Caddyfile']);
  for (const name of inclusions) {
    if (name.endsWith('/')) continue;
    assert.ok(
      sourceTrees.has(name) || buildConfiguration.has(name) || Object.hasOwn(runtime, name),
      'Unreviewed Docker context input: ' + name,
    );
  }
  for (const name of Object.keys(runtime)) {
    if (/^src\/(?:server|shared)\//.test(name)) continue;
    assert.equal(inclusions.has(name), true, 'Missing Docker context input: ' + name);
  }
  assert.ok(rules.indexOf('**/*.key') > rules.lastIndexOf('!src/server/**'));
  assert.ok(rules.indexOf('**/.env*') > rules.lastIndexOf('!src/shared/**'));
  for (const name of buildConfiguration) {
    assert.ok(fs.existsSync(path.join(root, name)), name);
    assert.equal(inclusions.has(name), true, name);
    assert.equal(Object.hasOwn(runtime, name), false, name);
  }
});

function previousBuildCommand({ modern, distExists, helperBroken = false }) {
  const source = fs.readFileSync(path.join(root, 'scripts/release/remote/operations.py'), 'utf8');
  const code = source.match(
    /build = self\.command\(\[.*?'-e', '([^']+)'\]\)\.decode\(\)\.strip\(\)/,
  )?.[1];
  assert.ok(code, 'Previous-image version command is missing');
  const roots = [],
    printed = [],
    helperCalls = [];
  const execute = () =>
    vm.runInNewContext(code, {
      require(name) {
        if (name === 'fs')
          return {
            existsSync: (target) => {
              if (target === '/app/src/shared/web-assets.cjs') return modern;
              assert.equal(target, '/app/dist/public');
              return distExists;
            },
          };
        if (name === '/app/src/shared/web-assets.cjs')
          return {
            publicAssetRoot(projectRoot) {
              assert.equal(projectRoot, '/app');
              helperCalls.push(projectRoot);
              if (helperBroken) throw Error('LAYOUT_HELPER_FAILED');
              return '/app/dist/public';
            },
          };
        assert.equal(name, '/app/src/server/http/client-release.cjs');
        return {
          clientRelease: async (assetRoot) => {
            roots.push(assetRoot);
            if (assetRoot === '/app/dist/public' && !distExists) throw Error('ENOENT dist/public');
            return '1234567890abcdef';
          },
        };
      },
      console: { log: (value) => printed.push(value) },
    });
  return { execute, roots, printed, helperCalls };
}

test('previous-image metadata preserves legacy root support without requiring the new helper', async () => {
  const result = previousBuildCommand({ modern: false, distExists: false });
  await result.execute();
  assert.deepEqual(result.roots, ['/app']);
  assert.deepEqual(result.helperCalls, []);
  assert.deepEqual(result.printed, ['1234567890abcdef']);
});

test('previous-image metadata resolves the new layout through its installed helper', async () => {
  const result = previousBuildCommand({ modern: true, distExists: true });
  await result.execute();
  assert.deepEqual(result.roots, ['/app/dist/public']);
  assert.deepEqual(result.helperCalls, ['/app']);
  assert.deepEqual(result.printed, ['1234567890abcdef']);
});

test('missing expected dist assets reject without trying the legacy root', async () => {
  const result = previousBuildCommand({ modern: true, distExists: false });
  await assert.rejects(async () => result.execute(), /ENOENT dist\/public/);
  assert.deepEqual(result.roots, ['/app/dist/public']);
  assert.deepEqual(result.helperCalls, ['/app']);
  assert.deepEqual(result.printed, []);
});

test('a broken layout helper rejects without trying the legacy root', async () => {
  const result = previousBuildCommand({ modern: true, distExists: true, helperBroken: true });
  await assert.rejects(async () => result.execute(), /LAYOUT_HELPER_FAILED/);
  assert.deepEqual(result.roots, []);
  assert.deepEqual(result.helperCalls, ['/app']);
  assert.deepEqual(result.printed, []);
});

test('an unrecognized mixed layout rejects instead of guessing a legacy build', async () => {
  const result = previousBuildCommand({ modern: false, distExists: true });
  await assert.rejects(async () => result.execute(), /UNRECOGNIZED_PUBLIC_LAYOUT/);
  assert.deepEqual(result.roots, []);
  assert.deepEqual(result.helperCalls, []);
  assert.deepEqual(result.printed, []);
});
