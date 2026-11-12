const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash } = require('../scripts/release/files.cjs');
const { BEHAVIOR_HTTP } = require('../scripts/release/verification-assistant-behavior-policy.cjs');
const helper = require('./helpers/release-stand-assistant-behavior.cjs');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'tests/helpers/release-stand-assistant-behavior.cjs');
const identity = () => ({
  candidate: 'synthetic-behavior-http',
  sourceHash: 'a'.repeat(64),
  profileHash: 'b'.repeat(64),
  imageId: 'sha256:' + 'c'.repeat(64),
  helperSha256: hash(fs.readFileSync(filename)),
});

test('behavior HTTP coverage and immutable helper identity match the finite policy', () => {
  assert.deepEqual(helper.CASES, BEHAVIOR_HTTP);
  assert.deepEqual(helper.identity(identity()), identity());
  for (const mutate of [
    (x) => {
      x.helperSha256 = 'f'.repeat(64);
    },
    (x) => {
      x.profile = 'assistant-ui';
    },
    (x) => {
      x.sourceHash = 'unknown';
    },
    (x) => {
      x.imageId = 'latest';
    },
  ]) {
    const value = identity();
    mutate(value);
    assert.throws(() => helper.identity(value));
  }
});
test(
  'actual HTTP producer exercises all10 behaviors with synthetic storage and fake model only',
  { timeout: 100000 },
  () => {
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=512', filename, JSON.stringify(identity())],
      { cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.ok(result.stdout.trim(), result.stderr);
    const proof = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(result.status, 0, result.stderr + '\n' + JSON.stringify(proof));
    assert.deepEqual(
      proof.cases,
      BEHAVIOR_HTTP.map((name) => ({ case: name, passed: true })),
    );
    assert.equal(proof.passed, true);
    assert.equal(proof.syntheticOnly, true);
    assert.equal(proof.externalProviderRequests, 0);
    for (const [key, value] of Object.entries(identity())) assert.equal(proof[key], value);
  },
);

test(
  'native Python adapter dispatches both isolated HTTP producers on one immutable image',
  { timeout: 30000 },
  () => {
    const python =
      process.platform === 'win32'
        ? path.join(
            os.homedir(),
            '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
          )
        : '/usr/bin/python3';
    assert.ok(fs.existsSync(python), 'Existing Python required; never install or silently skip');
    const script = String.raw`
import json,sys,types,tempfile,hashlib
from pathlib import Path
adapter,audio,behavior=map(Path,sys.argv[1:4])
fcntl=types.ModuleType('fcntl');fcntl.flock=lambda *a,**k: (_ for _ in ()).throw(AssertionError('No system locking'))
sys.modules['fcntl']=fcntl
module=types.ModuleType('synthetic_behavior_adapter');module.__file__=str(adapter)
exec(compile(adapter.read_text(),str(adapter),'exec'),module.__dict__)
with tempfile.TemporaryDirectory(prefix='cartoteca-behavior-abi-') as temp:
    base=Path(temp).resolve();source=base/'source';(base/'stand').mkdir()
    names=['tests/helpers/release-stand-audio-session.cjs','tests/helpers/release-stand-assistant-behavior.cjs']
    files={}
    for name,original in zip(names,[audio,behavior]):
        target=source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(original.read_bytes())
        files[name]={'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
    candidate=dict(id='synthetic-behavior-dispatch',profile='assistant-ui',sourceHash='a'*64,profileHash='b'*64,files=files)
    (base/'candidate.json').write_text(json.dumps(candidate));image='sha256:'+'c'*64;calls=[]
    def command(*args,**kwargs):
        if args[0]=='node':
            return json.dumps(dict(profileHash=candidate['profileHash'],selectionMode='assistant-behavior-v1',standPartition=dict(fresh=module.FRESH,inherited=list(range(33)))))
        assert args[0:2]==('docker','run')
        for flag,value in [('--network','none'),('--memory','512m'),('--cpus','1'),('--cap-drop','ALL'),('--security-opt','no-new-privileges')]:
            assert args[args.index(flag)+1]==value
        assert '--read-only' in args and args[args.index('--tmpfs')+1]=='/tmp:rw,noexec,nosuid,size=64m'
        index=len(calls);expected='/stand/'+('audio-session.cjs' if index==0 else 'assistant-behavior.cjs')
        assert args[-3: -1]==(image,expected)
        assert args[args.index('--mount')+1].endswith(',target='+expected+',readonly')
        payload=json.loads(args[-1]);assert set(payload)=={'candidate','sourceHash','profileHash','imageId','helperSha256'}
        assert payload==dict(candidate=candidate['id'],sourceHash=candidate['sourceHash'],profileHash=candidate['profileHash'],imageId=image,helperSha256=files[names[index]]['sha256'])
        calls.append(expected)
        return json.dumps(dict(payload,passed=True,syntheticOnly=True,externalProviderRequests=0,cases=[]))
    class Fixture:
        def __init__(self,src,img): assert src==str(source) and img==image;self.new=img;self.results=[]
        def reset(self,*a,**k): pass
        def fresh_data(self): pass
        def close(self): pass
    module.command=command
    module.fixture=types.SimpleNamespace(Fixture=Fixture,publication_gate=types.SimpleNamespace(prepare_baseline=lambda *a: None))
    module.scenario=lambda fixture,name,**kwargs:fixture.results.append(dict(scenario=name,passed=True))
    before=sys.argv;sys.argv=['adapter',str(source),image,str(base/'stand/report.json')]
    try: module.main()
    finally: sys.argv=before
    report=json.loads((base/'stand/report.json').read_text())
    assert report['passed'] is True and len(report['scenarios'])==4
    assert report['audioSessionHttp']['helperSha256']==files[names[0]]['sha256']
    assert report['assistantBehaviorHttp']['helperSha256']==files[names[1]]['sha256']
    assert calls==['/stand/audio-session.cjs','/stand/assistant-behavior.cjs']
    print(json.dumps(dict(dispatch=2,publicationScenarios=4,providerRequests=0,actualDockerInvocations=0)))
`;
    const result = spawnSync(
      python,
      [
        '-I',
        '-B',
        '-c',
        script,
        path.join(root, 'tests/helpers/release-stand-assistant-ui.py'),
        path.join(root, 'tests/helpers/release-stand-audio-session.cjs'),
        filename,
      ],
      { cwd: root, encoding: 'utf8', timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      dispatch: 2,
      publicationScenarios: 4,
      providerRequests: 0,
      actualDockerInvocations: 0,
    });
  },
);
