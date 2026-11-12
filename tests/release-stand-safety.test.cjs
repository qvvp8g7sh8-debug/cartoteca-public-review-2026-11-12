const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test(
  'dedicated Linux stand requires a private matching short-lived marker and candidate source',
  { skip: process.platform !== 'linux' },
  () => {
    const marker = {
      version: 1,
      purpose: 'cartoteca-synthetic-checks',
      disposable: true,
      machineId: 'synthetic-machine',
      expiresAt: '2026-10-19T00:00:00Z',
    };
    const valid = {
      marker,
      machineId: 'synthetic-machine',
      uid: 0,
      mode: 0o600,
      isLink: false,
      source: '/opt/cartoteca-checks/.release/candidates/synthetic/source',
    };
    const cases = [
      { ...valid, allowed: true },
      { ...valid, uid: 1000, allowed: false },
      { ...valid, mode: 0o644, allowed: false },
      { ...valid, isLink: true, allowed: false },
      { ...valid, machineId: 'another-machine', allowed: false },
      { ...valid, source: '/opt/cartoteca-v2', allowed: false },
      { ...valid, marker: { ...marker, disposable: false }, allowed: false },
      { ...valid, marker: { ...marker, purpose: 'production' }, allowed: false },
      { ...valid, marker: { ...marker, expiresAt: '2026-10-11T00:00:00Z' }, allowed: false },
      { ...valid, marker: { ...marker, expiresAt: '2027-10-19T00:00:00Z' }, allowed: false },
      { ...valid, marker: { ...marker, expiresAt: '2026-10-19T00:00:00' }, allowed: false },
      { ...valid, marker: {}, allowed: false },
    ];
    const script = `import importlib.util,json,sys
from datetime import datetime,timezone
spec=importlib.util.spec_from_file_location('fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for case in json.load(sys.stdin):
    try:
        result=module.validate_lab_marker(case['marker'],case['machineId'],datetime(2026,10,12,tzinfo=timezone.utc),case['uid'],case['mode'],case['isLink'],case['source'])
    except (RuntimeError,ValueError,TypeError): result=False
    assert result == case['allowed'], 'Unexpected stand authorization result'
print('12 synthetic authorization cases passed')
`;
    const result = spawnSync(
      'python3',
      ['-I', '-B', '-c', script, path.join(__dirname, 'helpers/release-stand-fixture.py')],
      {
        input: JSON.stringify(cases),
        encoding: 'utf8',
        timeout: 15000,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /12 synthetic authorization cases passed/);
  },
);
