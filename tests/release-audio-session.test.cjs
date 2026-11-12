const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hash, objectHash, controllerHash } = require('../scripts/release/files.cjs');
const {
  AUDIO_SESSION,
  AUDIO_SESSION_CLIENT,
  AUDIO_SESSION_SERVER,
  AUDIO_SESSION_BRIDGES,
  AUDIO_SESSION_INPUTS,
  AUDIO_SESSION_CONTROL,
  AUDIO_SESSION_TESTS,
  AUDIO_SESSION_HTTP,
} = require('../scripts/release/verification-audio-session-policy.cjs');
const session = require('../scripts/release/verification-audio-session.cjs');
const {
  assertSelectionMode,
  classifyHotfixChanges,
  scopePlan,
  validateScopedReport,
} = require('../scripts/release/verification-profile.cjs');
const { steps } = require('../scripts/release/plan.cjs');
const { validateUnitEvents } = require('../scripts/release/unit-report.cjs');
const clone = (value) => JSON.parse(JSON.stringify(value));
const entry = (text) => ({ bytes: Buffer.byteLength(text), sha256: hash(text) });
const files = () => ({
  ...Object.fromEntries(AUDIO_SESSION_TESTS.map((name) => [name, entry('// synthetic test')])),
  'package-lock.json': entry('{}'),
  'src/server/application/unchanged.cjs': entry('// protected'),
  'tests/not-selected.test.cjs': entry('// omitted'),
});
const selected = (manifest = files()) => ({
  selectionMode: AUDIO_SESSION.selectionMode,
  scope: 'targeted',
  fullVerification: false,
  freshUnitFiles: [...AUDIO_SESSION_TESTS],
  freshSelection: { files: [...AUDIO_SESSION_TESTS] },
  coverage: session.sessionCoverage(manifest),
});

test('audio-session mode pins published45 and leaves the historical hotfix closed', () => {
  assert.equal(AUDIO_SESSION.selectionMode, 'assistant-audio-session-v1');
  assert.equal(AUDIO_SESSION.id, 'assistant-mobile-20261018-45');
  assert.equal(
    AUDIO_SESSION.sourceHash,
    'd0da17ff9ca7cf8092befd3a00c2bebc06d25c65905954e2abae4c0db6b26ba9',
  );
  assert.equal(
    AUDIO_SESSION.imageId,
    'sha256:16407ec8a8b47fa6e2ef6acd8afb1f43250b22f5389a989186c4e9b574b3b331',
  );
  assert.doesNotThrow(() => assertSelectionMode(AUDIO_SESSION.selectionMode));
  for (const name of [
    'src/server/modules/assistant/pcm-audio.cjs',
    'src/client/modules/assistant-playback.js',
    'Dockerfile',
  ])
    assert.deepEqual(classifyHotfixChanges({}, { [name]: entry('new') }).blocked, [name]);
  for (const value of [
    undefined,
    {},
    {
      version: 1,
      id: AUDIO_SESSION.id,
      profile: 'assistant-ui',
      sourceHash: AUDIO_SESSION.sourceHash,
      files: {},
    },
  ])
    assert.throws(() => session.assertSessionBase(value));
});

test('new mode admits finite reviewed source and tests while rejecting unrelated code and deletions', () => {
  for (const name of [
    ...AUDIO_SESSION_CLIENT,
    ...AUDIO_SESSION_SERVER,
    ...AUDIO_SESSION_BRIDGES,
    ...AUDIO_SESSION_CONTROL,
    ...AUDIO_SESSION_TESTS,
  ])
    assert.deepEqual(
      session.classifySessionChanges({}, { [name]: entry('new') }).blocked,
      [],
      name,
    );
  for (const name of [
    'package.json',
    'package-lock.json',
    'Dockerfile.caddy',
    '.dockerignore',
    'src/server/modules/assistant/routes.cjs',
    'src/server/modules/assistant/speech-generation.cjs',
    'src/server/modules/assistant/runtime.cjs',
    'src/server/migrations/018-notification-schedule.cjs',
    'src/server/security/session.cjs',
    'src/shared/assistant-contract.cjs',
    'scripts/release/remote/operations.py',
    'scripts/release/remote/checks.py',
    'src/client/modules/assistant-capture.js',
    'tests/browser/main.cjs',
    'tests/assistant-unreviewed.test.cjs',
  ])
    assert.deepEqual(
      session.classifySessionChanges({}, { [name]: entry('new') }).blocked,
      [name],
      name,
    );
  assert.deepEqual(session.classifySessionChanges({ 'app.js': entry('before') }, {}).blocked, [
    'app.js',
  ]);
});

test('worklet bridges allow only the exact addition, including401 and protected skip lists', () => {
  const examples = [
    [
      'Dockerfile',
      'COPY app.js app-assistant.js ./\n',
      'COPY app.js assistant-playback-worklet.js app-assistant.js ./\n',
    ],
    [
      'scripts/build-client.cjs',
      "const a={'old.js':'src/old.js',};",
      "const a={'old.js':'src/old.js','assistant-playback-worklet.js':'src/client/worklets/assistant-playback-worklet.js',};",
    ],
    [
      'scripts/release/publication-check.cjs',
      "const a=[['/app.js',401],];",
      "const a=[['/app.js',401],['/assistant-playback-worklet.js',401],];",
    ],
    [
      'scripts/release/remote/probe.cjs',
      "const a=['app.js',];",
      "const a=['app.js','assistant-playback-worklet.js',];",
    ],
    [
      'src/server/http/static-files.cjs',
      "const a=['app.js',],b=['app.js',],c=['app.js',];",
      "const a=['app.js','assistant-playback-worklet.js',],b=['app.js','assistant-playback-worklet.js',],c=['app.js','assistant-playback-worklet.js',];",
    ],
  ];
  for (const [name, before, after] of examples) {
    const expected = name === 'Dockerfile' ? before : session.lexical(before);
    assert.equal(session.stripWorklet(name, after), expected);
    assert.throws(() => session.stripWorklet(name, before), /Missing or excessive/);
    assert.notEqual(session.stripWorklet(name, after + '\nthrow Error("unreviewed");'), expected);
  }
  assert.equal(
    session.stripWorklet(
      'src/server/http/static-files.cjs',
      "const a=['assistant-playback-worklet.js',],b=['assistant-playback-worklet.js',];['assistant-capture-worklet.js','assistant-playback-worklet.js',].includes(file)",
    ),
    session.lexical("const a=[],b=[];['assistant-capture-worklet.js'].includes(file)"),
  );
  assert.throws(() =>
    session.stripWorklet(
      'scripts/release/publication-check.cjs',
      "const a=[['/assistant-playback-worklet.js',200],];",
    ),
  );
  assert.throws(() =>
    session.stripWorklet(
      'scripts/build-client.cjs',
      "const a={'assistant-playback-worklet.js':'src/unreviewed.js',};",
    ),
  );
  assert.notEqual(session.lexical("throw Error('a b')"), session.lexical("throw Error('ab')"));
});

function manifest() {
  return {
    styles: ['src/client/styles/base.css'],
    factories: [
      { path: 'src/client/modules/other.js', factory: 'createOther', dependencies: [] },
      ...[...AUDIO_SESSION_CLIENT]
        .filter((n) => n.startsWith('src/client/modules/') && !n.endsWith('assistant-playback.js'))
        .map((n) => ({
          path: n,
          factory:
            'create' + path.basename(n, '.js').replace(/-([a-z])/g, (_m, v) => v.toUpperCase()),
          phase: 'assistant',
          dependencies: [],
        })),
    ],
  };
}
test('manifest permits only deferred audio factory wiring, retaining all unrelated factories and styles', () => {
  const before = manifest(),
    after = clone(before);
  after.factories.splice(1, 0, {
    path: 'src/client/modules/assistant-playback.js',
    factory: 'createAssistantPlayback',
    phase: 'assistant',
    dependencies: [],
  });
  after.factories.at(-1).dependencies = ['assistantPlayback'];
  assert.doesNotThrow(() => session.assertSessionManifest(before, after));
  for (const mutate of [
    (a) => {
      a.styles = [];
    },
    (a) => {
      a.factories[0].dependencies = ['assistantPlayback'];
    },
    (a) => {
      a.factories[1].phase = 'settings';
    },
    (a) => {
      a.factories[1].factory = 'createOther';
    },
    (a) => {
      a.factories[1].unreviewed = true;
    },
    (a) => {
      a.factories.push(a.factories[1]);
    },
    (a) => {
      a.factories.splice(2, 1);
    },
  ]) {
    const changed = clone(after);
    mutate(changed);
    assert.throws(() => session.assertSessionManifest(before, changed));
  }
});

test('component fingerprints protect nonaudio backend, ACL, migrations, dependencies and executor', () => {
  const baseline = files(),
    prior = session.sessionFingerprints(baseline);
  for (const name of [
    ...AUDIO_SESSION_CLIENT,
    ...AUDIO_SESSION_SERVER,
    ...AUDIO_SESSION_BRIDGES,
    ...AUDIO_SESSION_CONTROL,
    ...AUDIO_SESSION_TESTS,
  ])
    assert.deepEqual(
      session.sessionFingerprints({ ...baseline, [name]: entry('changed') }),
      prior,
      name,
    );
  for (const name of [
    'src/server/application/unchanged.cjs',
    'src/server/security/permissions.cjs',
    'src/server/migrations/017-staff-push.cjs',
    'src/shared/assistant-contract.cjs',
    'package-lock.json',
    'scripts/release/remote/operations.py',
    'scripts/release/remote/checks.py',
    'tests/helpers/release-stand-fixture.py',
    'scripts/check-types.cjs',
  ])
    assert.notDeepEqual(
      session.sessionFingerprints({ ...baseline, [name]: entry('changed') }),
      prior,
      name,
    );
});

test('targeted plan records omitted tests honestly and runs only quality plus the fixed audio scope', () => {
  const f = files(),
    coverage = session.sessionCoverage(f);
  assert.deepEqual(coverage.inheritedUnitFiles, []);
  assert.deepEqual(coverage.notRunUnitFiles, ['tests/not-selected.test.cjs']);
  assert.deepEqual(coverage.executedUnitFiles, AUDIO_SESSION_TESTS);
  for (const names of [
    AUDIO_SESSION_TESTS.slice(1),
    [...AUDIO_SESSION_TESTS].reverse(),
    [...AUDIO_SESSION_TESTS, 'tests/other.test.cjs'],
  ])
    assert.throws(() => session.sessionCoverage(f, names));
  const plan = ['architecture', 'format', 'diff', 'unit', 'main-webkit-mobile'].map((id) => ({
    id,
    args: ['--test', 'tests/not-selected.test.cjs'],
  }));
  const actual = scopePlan(plan, selected(), { target: 'windows' });
  assert.deepEqual(
    actual.map((s) => s.id),
    ['architecture', 'format', 'diff', 'unit'],
  );
  assert.deepEqual(actual.at(-1).unitFiles, AUDIO_SESSION_TESTS);
  assert.deepEqual(actual.at(-1).env, {
    CARTOTECA_PLAYBACK_BROWSER: '1',
    CARTOTECA_CHROMIUM_CHANNEL: 'msedge',
  });
  assert.deepEqual(scopePlan(plan, selected(), { target: 'linux' }).at(-1).env, {
    CARTOTECA_PLAYBACK_BROWSER: '0',
  });
  assert.throws(() => scopePlan(plan, selected()), /explicit native target/);
  assert.ok(actual.at(-1).args.includes('--test-concurrency=1'));
  assert.ok(actual.at(-1).args.includes('--max-old-space-size=512'));
  assert.ok(!actual.at(-1).args.includes('tests/not-selected.test.cjs'));
  for (const mutate of [
    (p) => {
      p.scope = 'full';
    },
    (p) => {
      p.fullVerification = true;
    },
    (p) => {
      p.freshUnitFiles.pop();
    },
    (p) => {
      p.coverage.executedUnitFiles.pop();
    },
    (p) => {
      p.coverage.inheritedUnitFiles = ['tests/not-selected.test.cjs'];
    },
  ]) {
    const p = selected();
    mutate(p);
    assert.throws(() => scopePlan(plan, p, { target: 'windows' }));
  }
});

test('fresh audio HTTP evidence is bound to the exact image, helper and every successful synthetic case', () => {
  const candidate = {
    data: {
      id: 'synthetic-audio',
      sourceHash: hash('source'),
      files: { 'tests/helpers/release-stand-audio-session.cjs': entry('helper') },
    },
  };
  const profile = { profileHash: hash('profile') },
    binding = { innerImageId: 'sha256:' + hash('image') };
  const proof = {
    version: 1,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    profileHash: profile.profileHash,
    imageId: binding.innerImageId,
    helperSha256: candidate.data.files['tests/helpers/release-stand-audio-session.cjs'].sha256,
    syntheticOnly: true,
    externalProviderRequests: 0,
    passed: true,
    cases: AUDIO_SESSION_HTTP.map((id) => ({ case: id, passed: true })),
  };
  assert.doesNotThrow(() => session.validateAudioHttp(proof, candidate, profile, binding));
  for (const mutate of [
    (p) => {
      p.candidate = 'other';
    },
    (p) => {
      p.sourceHash = hash('other');
    },
    (p) => {
      p.profileHash = hash('other');
    },
    (p) => {
      p.imageId = 'sha256:' + hash('other');
    },
    (p) => {
      p.helperSha256 = hash('other');
    },
    (p) => {
      p.syntheticOnly = false;
    },
    (p) => {
      p.externalProviderRequests = 1;
    },
    (p) => {
      p.cases.pop();
    },
    (p) => {
      p.cases[0].passed = false;
    },
    (p) => {
      p.passed = false;
    },
  ]) {
    const changed = clone(proof);
    mutate(changed);
    assert.throws(() => session.validateAudioHttp(changed, candidate, profile, binding));
  }
});

test('audio-session native validation requires actual raw results and forbids full or inherited-unit claims', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-session-proof-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  fs.mkdirSync(path.join(source, 'tests'), { recursive: true });
  const metadata = files();
  for (const name of Object.keys(metadata).filter((n) => n.endsWith('.test.cjs')))
    fs.writeFileSync(path.join(source, name), '// synthetic test');
  const candidate = {
    directory,
    source,
    data: { id: 'synthetic-audio', sourceHash: objectHash(metadata), files: metadata },
  };
  const inherited = {
    inheritedFiles: [],
    environment: {
      node: process.version,
      os: 'win32',
      arch: 'x64',
      osRelease: 'synthetic',
      lockHash: metadata['package-lock.json'].sha256,
    },
  };
  const profile = {
    ...selected(metadata),
    profileHash: hash('profile'),
    inheritedNative: { windows: inherited },
  };
  const plan = scopePlan(steps(source, { target: 'windows', unitWorkers: 1 }), profile, {
    target: 'windows',
  });
  const counts = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
  const raw =
    [
      ...AUDIO_SESSION_TESTS.map((file) => ({ type: 'test:summary', file, counts })),
      {
        type: 'test:summary',
        counts: {
          ...counts,
          tests: AUDIO_SESSION_TESTS.length,
          passed: AUDIO_SESSION_TESTS.length,
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n';
  fs.writeFileSync(path.join(directory, 'unit.jsonl'), raw);
  const report = {
    version: 1,
    candidate: candidate.data.id,
    sourceHash: candidate.data.sourceHash,
    target: 'windows',
    status: 'passed',
    profile: 'assistant-ui',
    profileHash: profile.profileHash,
    selectionMode: AUDIO_SESSION.selectionMode,
    scope: 'targeted',
    fullVerification: false,
    coverage: clone(profile.coverage),
    inheritedBackend: clone(inherited),
    selectedPhase: 'all',
    settings: { unitWorkers: 1, unitShards: 1 },
    planHash: objectHash(plan),
    selectionHash: objectHash(plan),
    environment: { ...inherited.environment, controllerHash: controllerHash(metadata) },
    steps: [
      { id: 'dependencies', status: 'passed' },
      ...plan.map((step) => ({
        id: step.id,
        status: 'passed',
        inputHash: objectHash(step),
        ...(step.id === 'unit'
          ? { details: 'unit.jsonl', unitSummary: validateUnitEvents(raw, AUDIO_SESSION_TESTS) }
          : {}),
      })),
    ],
  };
  assert.equal(validateScopedReport(candidate, 'windows', report, profile), true);
  for (const mutate of [
    (r) => {
      r.fullVerification = true;
    },
    (r) => {
      r.scope = 'full';
    },
    (r) => {
      r.coverage.inheritedUnitFiles = ['tests/not-selected.test.cjs'];
    },
    (r) => {
      r.steps.pop();
    },
    (r) => {
      r.steps.at(-1).unitSummary.counts.passed++;
    },
  ]) {
    const changed = clone(report);
    mutate(changed);
    assert.throws(() => validateScopedReport(candidate, 'windows', changed, profile));
  }
});

test('native audio browser raw coverage cannot silently skipWindows or pretendLinux execution', () => {
  const proof = (counts) =>
    JSON.stringify({
      type: 'test:summary',
      file: 'tests/assistant-playback-browser.test.cjs',
      counts,
    });
  const passed = { tests: 1, passed: 1, skipped: 0, failed: 0 },
    skipped = { tests: 1, passed: 0, skipped: 1, failed: 0 };
  assert.doesNotThrow(() => session.validateSessionUnit(proof(passed), 'windows'));
  assert.doesNotThrow(() => session.validateSessionUnit(proof(skipped), 'linux'));
  assert.throws(() => session.validateSessionUnit(proof(skipped), 'windows'), /cannot be skipped/);
  assert.throws(() => session.validateSessionUnit(proof(passed), 'linux'), /explicitly unexecuted/);
  assert.throws(() => session.validateSessionUnit(proof(passed), 'other'), /native target/);
  assert.throws(
    () => session.validateSessionUnit(proof(passed) + '\n' + proof(passed), 'windows'),
    /exact audio browser/,
  );
});

test('native targeted reports flow through real status and both package/artifact admission callers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-session-admission-'));
  const id = 'synthetic-audio-admission',
    directory = path.join(root, '.release/candidates', id),
    source = path.join(directory, 'source');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = {
    ...Object.fromEntries(AUDIO_SESSION_TESTS.map((name) => [name, '// synthetic test\n'])),
    'scripts/release.cjs': '// synthetic current controller\n',
    'package.json': '{}',
    'package-lock.json': '{}',
    Dockerfile: 'FROM scratch\n',
  };
  for (const [name, content] of Object.entries(inputs)) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (name === 'scripts/release.cjs') {
      const current = path.join(root, name);
      fs.mkdirSync(path.dirname(current), { recursive: true });
      fs.writeFileSync(current, content);
    }
  }
  const { manifest } = require('../scripts/release/files.cjs'),
    metadata = manifest(source),
    profileHash = hash('synthetic admitted profile');
  fs.writeFileSync(
    path.join(directory, 'candidate.json'),
    JSON.stringify({
      version: 1,
      id,
      profile: 'assistant-ui',
      selectionMode: AUDIO_SESSION.selectionMode,
      profileHash,
      sourceHash: objectHash(metadata),
      files: metadata,
    }),
  );
  const sealed = {
    ...selected(metadata),
    profileHash,
    baseline: { id: 'synthetic-qualified-full' },
    inheritedNative: {},
  };
  for (const target of ['windows', 'linux']) {
    const environment = {
      node: process.version,
      os: target === 'windows' ? 'win32' : 'linux',
      arch: 'x64',
      osRelease: 'synthetic',
      lockHash: metadata['package-lock.json'].sha256,
      ...(target === 'linux'
        ? { caddy: 'synthetic-caddy', caddyHash: hash('synthetic-caddy') }
        : {}),
    };
    sealed.inheritedNative[target] = { inheritedFiles: [], environment };
    const plan = scopePlan(steps(source, { target, unitWorkers: 1 }), sealed, { target });
    const passed = { tests: 1, passed: 1, skipped: 0, failed: 0, cancelled: 0, todo: 0 };
    const events = AUDIO_SESSION_TESTS.map((file) => ({
      type: 'test:summary',
      file,
      counts:
        target === 'linux' && file === 'tests/assistant-playback-browser.test.cjs'
          ? { ...passed, passed: 0, skipped: 1 }
          : passed,
    }));
    events.push({
      type: 'test:summary',
      counts: {
        ...passed,
        tests: AUDIO_SESSION_TESTS.length,
        passed: AUDIO_SESSION_TESTS.length - (target === 'linux' ? 1 : 0),
        skipped: target === 'linux' ? 1 : 0,
      },
    });
    const raw = events.map(JSON.stringify).join('\n') + '\n',
      folder = path.join(directory, 'reports', target);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'unit.jsonl'), raw);
    const report = {
      version: 1,
      candidate: id,
      sourceHash: objectHash(metadata),
      target,
      status: 'passed',
      profile: 'assistant-ui',
      profileHash,
      selectionMode: AUDIO_SESSION.selectionMode,
      scope: 'targeted',
      fullVerification: false,
      coverage: clone(sealed.coverage),
      inheritedBackend: clone(sealed.inheritedNative[target]),
      selectedPhase: 'all',
      settings: { unitWorkers: 1, unitShards: 1, verificationProfileHash: profileHash },
      planHash: objectHash(plan),
      selectionHash: objectHash(plan),
      environment: { ...environment, controllerHash: controllerHash(metadata) },
      steps: [
        { id: 'dependencies', status: 'passed' },
        ...plan.map((step) => ({
          id: step.id,
          status: 'passed',
          inputHash: objectHash(step),
          ...(step.id === 'unit'
            ? {
                details: 'reports/' + target + '/unit.jsonl',
                unitSummary: validateUnitEvents(raw, AUDIO_SESSION_TESTS),
              }
            : {}),
        })),
      ],
    };
    fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report));
  }
  const modules = [
    '../scripts/release/status.cjs',
    '../scripts/release/package.cjs',
    '../scripts/release/deployment-plan.cjs',
  ].map(require.resolve);
  const previous = modules.map((file) => [file, require.cache[file]]);
  for (const file of modules) delete require.cache[file];
  t.after(() => {
    t.mock.restoreAll();
    for (const [file, value] of previous) {
      if (value) require.cache[file] = value;
      else delete require.cache[file];
    }
  });
  t.mock.method(
    require('../scripts/release/verification-profile.cjs'),
    'verifyProfile',
    () => sealed,
  );
  let dockerCalls = 0;
  t.mock.method(require('../scripts/release/process.cjs'), 'runProcess', async (command, args) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 4), ['--context', 'default', 'build', '--tag']);
    dockerCalls++;
    throw Error('SYNTHETIC_DOCKER_BOUNDARY');
  });
  const ready = require('../scripts/release/status.cjs').status(root, id);
  assert.equal(ready.readyToPackage, true);
  assert.equal(ready.targets.windows.status, 'passed');
  assert.equal(ready.targets.linux.status, 'passed');
  const packaged = await require('../scripts/release/package.cjs').packageImage(root, id);
  assert.equal(dockerCalls, 1);
  assert.equal(packaged.status, 'failed');
  assert.equal(packaged.error, 'SYNTHETIC_DOCKER_BOUNDARY');
  assert.equal(await require('../scripts/release/deployment-plan.cjs').artifact(root, id), null);
});

test('actual Python stand main serializes the exact JS identity contract under native clean environment', async (t) => {
  const { runProcess } = require('../scripts/release/process.cjs');
  const root = path.resolve(__dirname, '..'),
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cartoteca-python-audio-abi-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const python =
    process.platform === 'win32'
      ? path.join(
          os.homedir(),
          '.cache',
          'codex-runtimes',
          'codex-primary-runtime',
          'dependencies',
          'python',
          'python.exe',
        )
      : '/usr/bin/python3';
  assert.ok(
    fs.existsSync(python),
    'Existing native Python runtime required; no install or silent skip',
  );
  const nodeIdentity = String.raw`
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const file=process.argv[1],moduleValue={exports:{}},payload=JSON.parse(process.argv[2]);
try {
  vm.runInNewContext(fs.readFileSync(file,'utf8')+String.fromCharCode(10)+'identity(payload);',
    {require:createRequire(file),module:moduleValue,exports:moduleValue.exports,__filename:file,__dirname:path.dirname(file),Buffer,payload,console},
    {filename:file,timeout:2000});
  console.log(JSON.stringify({accepted:true}));
} catch(error) { console.log(JSON.stringify({accepted:false,code:error.code||error.name}));process.exitCode=1; }
`;
  const script = String.raw`
import ast,hashlib,json,sys,types,tempfile,subprocess
from pathlib import Path
adapter,helper,node,node_code=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3],sys.argv[4]
text=adapter.read_text(encoding='utf-8')
# The ABI harness never performs Linux locking; forbid it on either native OS.
def forbidden_lock(*args,**kwargs): raise AssertionError('No system locking in ABI unit test')
fcntl_stub=types.ModuleType('fcntl');fcntl_stub.flock=forbidden_lock
sys.modules['fcntl']=fcntl_stub
assignments=[x for x in ast.walk(ast.parse(text)) if isinstance(x,ast.Assign) and any(isinstance(v,ast.Name) and v.id=='audio_identity' for v in x.targets)]
assert len(assignments)==1
class StopAfterContract(Exception): pass
class ContractRejected(Exception): pass
real_run=subprocess.run

def run_case(mutant):
    code=text
    if mutant:
        lines=code.splitlines(keepends=True)
        lines[assignments[0].lineno-1]='            audio_identity = dict(identity, helperSha256=helper_sha)'+chr(10)
        code=''.join(lines)
    module=types.ModuleType('synthetic_audio_adapter');module.__file__=str(adapter)
    exec(compile(code,str(adapter),'exec'),module.__dict__)
    with tempfile.TemporaryDirectory(prefix='cartoteca-actual-python-abi-') as temp:
        base=Path(temp).resolve();source=base/'source';target=source/'tests/helpers/release-stand-audio-session.cjs';target.parent.mkdir(parents=True);target.write_bytes(helper.read_bytes());(base/'stand').mkdir()
        helper_sha=hashlib.sha256(target.read_bytes()).hexdigest()
        candidate={'profile':'assistant-ui','id':'synthetic-audio-contract','sourceHash':'a'*64,'profileHash':'b'*64,'files':{'tests/helpers/release-stand-audio-session.cjs':{'sha256':helper_sha}}}
        (base/'candidate.json').write_text(json.dumps(candidate))
        reached=[]
        def command(*args,**kwargs):
            if args[0]=='node':
                assert args[1:3]==('--max-old-space-size=192','-e')
                return json.dumps({'profileHash':candidate['profileHash'],'selectionMode':'assistant-audio-session-v1','standPartition':{'fresh':module.FRESH,'inherited':list(range(33))}})
            assert args[0:2]==('docker','run') and '--network' in args and 'none' in args and '--read-only' in args
            assert args[-3]=='/stand/audio-session.cjs' or args[-2]=='/stand/audio-session.cjs'
            payload=json.loads(args[-1]);reached.append('actual-node-identity')
            result=real_run([node,'-e',node_code,str(target),json.dumps(payload)],capture_output=True,text=True,timeout=10)
            outcome=json.loads(result.stdout)
            if result.returncode:
                assert result.returncode==1 and outcome=={'accepted':False,'code':'ERR_ASSERTION'},(result.stdout,result.stderr)
                raise ContractRejected()
            assert outcome=={'accepted':True},(result.stdout,result.stderr)
            raise StopAfterContract()
        def forbidden(*args,**kwargs): raise AssertionError('Publication fixture must not run in ABI unit test')
        module.command=command;module.fixture.Fixture=forbidden;module.scenario=forbidden
        before=sys.argv;sys.argv=['adapter',str(source),'sha256:'+'c'*64,str(base/'stand/report.json')]
        try:
            try: module.main()
            except StopAfterContract: outcome='accepted'
            except ContractRejected: outcome='rejected'
            else: raise AssertionError('Expected sentinel at exact identity boundary')
        finally: sys.argv=before
        assert reached==['actual-node-identity']
        return outcome
assert run_case(False)=='accepted'
assert run_case(True)=='rejected'
print(json.dumps({'actualPythonMain':True,'actualJsIdentity':True,'goodPayloadAccepted':True,'historicalExtraProfileRejected':True,'dockerInvocations':0,'providerRequests':0}))
`;
  const log = path.join(temporary, 'abi.txt');
  const result = await runProcess(
    python,
    [
      '-I',
      '-B',
      '-c',
      script,
      path.join(root, 'tests/helpers/release-stand-assistant-ui.py'),
      path.join(root, 'tests/helpers/release-stand-audio-session.cjs'),
      process.execPath,
      nodeIdentity,
    ],
    { cwd: root, log, timeoutMs: 25000 },
  );
  const output = fs.readFileSync(log, 'utf8');
  assert.equal(result.status, 'passed', output);
  assert.deepEqual(JSON.parse(output.trim()), {
    actualPythonMain: true,
    actualJsIdentity: true,
    goodPayloadAccepted: true,
    historicalExtraProfileRejected: true,
    dockerInvocations: 0,
    providerRequests: 0,
  });
});
