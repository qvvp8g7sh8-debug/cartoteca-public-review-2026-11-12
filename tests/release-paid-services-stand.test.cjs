const test = require('node:test');
const { nativePython } = require('../scripts/release/python.cjs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
test('paid image stand fault injections remain valid Python without executing any deployment', () => {
  const code = `import ast,runpy,tempfile
from pathlib import Path
module=runpy.run_path(${JSON.stringify(path.join(__dirname, 'helpers/release-stand-paid-services.py'))})
for failure in ['migration','startup','activation']:
 with tempfile.TemporaryDirectory(prefix='cartoteca-paid-stand-syntax-') as name:
  directory=Path(name)
  for filename in ['operations.py','paid_services.py']: (directory/filename).write_text('')
  module['inject'](directory,failure)
  for file in directory.glob('*.py'): ast.parse(file.read_text())
print('synthetic stand fault syntax PASS')
`;
  execFileSync(nativePython(), ['-I', '-c', code], {
    encoding: 'utf8',
    timeout: 10000,
  });
});

test('paid stand keeps ordinary app/backup tag and observed image, with fresh17 baseline', () => {
  const code = `import json,runpy,tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
m=runpy.run_path(${JSON.stringify(path.join(__dirname, 'helpers/release-stand-paid-services.py'))})
for ordinary in [True,False]:
 with tempfile.TemporaryDirectory(prefix='paid-tag-') as tmp:
  root=Path(tmp);tag='cartoteca:release-test' if ordinary else 'cartoteca-ci:previous'
  images={'cartoteca:release-test':'sha256:'+'b'*64,'cartoteca-ci:previous':'sha256:'+'a'*64}
  for name,service in [('compose.yaml','app'),('production.override.yaml','app'),('compose.backup.yaml','backup')]:
   (root/name).write_text(json.dumps({'services':{service:{'image':tag}}}))
  backup=(root/'compose.backup.yaml').read_bytes()
  app=lambda: json.loads((root/'production.override.yaml').read_text())['services']['app']
  stand=SimpleNamespace(root=root,compose=lambda *_:None,observed=lambda:{'Image':images[app()['image']]})
  with patch('urllib.request.urlopen',return_value=SimpleNamespace(status=200)):
   image=m['normal_entrypoint'](None,stand,19 if ordinary else 17,**({'ordinary':True} if ordinary else {}))
  assert app()['image']==tag and image==images[tag]
  assert (root/'compose.backup.yaml').read_bytes()==backup
  assert json.loads(backup)['services']['backup']['image']==app()['image']
  assert app()['environment']['CARTOTECA_MAX_SCHEMA']==('19' if ordinary else '17')
  assert app()['environment']['CARTOTECA_PAYMENT_NETWORK_ENABLED']=='0'
`;
  execFileSync(nativePython(), ['-I', '-c', code], {
    encoding: 'utf8',
    timeout: 10000,
  });
});
