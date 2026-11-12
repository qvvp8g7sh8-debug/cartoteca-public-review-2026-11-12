"""Explicit local synthetic helper checks; no Docker, SSH, network or real data."""
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location('read_budget_stand', HERE/'release-stand-read-budget.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

BOOTSTRAP = r'''
const fs=require('node:fs'),p='/data/platform';
require('/app/storage.cjs').createStorage('/data').close();
require('/app/platform-store.cjs').createPlatformStore(p).close();
const d=require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase(p);
try{
  for(const [n,f]of [['012-max-connections','migrateMaxConnections'],['013-notification-queue','migrateNotificationQueue'],
    ['014-notification-channels','migrateNotificationChannels'],['015-max-inbox','migrateMaxInbox'],
    ['016-staff-max','migrateStaffMax'],['017-staff-push','migrateStaffPush']])
    require('/app/src/server/migrations/'+n+'.cjs')[f](d,p);
}finally{d.closeWriter();d.db.close();}
const account=require('/app/platform-store.cjs').createPlatformStore(p,{notificationSchema:17});
try{account.importLegacyOwner({email:'owner@release-stand.invalid',displayName:'Synthetic owner',
  organizationName:'Synthetic stand',salt:'a'.repeat(32),passwordHash:'b'.repeat(128)});}finally{account.close();}
require('/app/src/server/infrastructure/backup/service.cjs').createBackupKey(process.env.STAND_TEST_KEY);
'''


class StandReadBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cartoteca-stand-read-budget-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.data = self.base/'source'
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('CARTOTECA_', 'STAND_'))}
        self.env.update(NODE_NO_WARNINGS='1', STAND_TEST_KEY=str(self.base/'keys/backup.key'))

    def js(self, code, data=None, flags=None, success=True):
        code = code.replace('/app/', ROOT.as_posix()+'/').replace('/data', (data or self.data).as_posix())
        result = subprocess.run([shutil.which('node') or 'node', '-e', code], cwd=ROOT,
                                capture_output=True, text=True, encoding='utf-8', timeout=90,
                                env={**self.env, **(flags or {})})
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def seed(self, failure=False):
        self.js(BOOTSTRAP)
        self.js(helper.SEED)
        self.js(helper.PERSISTENT_STATE)
        if failure:
            self.js(helper.PREPARATION_FAILURE)
        return json.loads(self.js(helper.OBSERVE).stdout)

    def prepare(self, destination, success=True):
        args = dict(source=str(self.data), destination=str(destination),
                    directory=str(self.base/'archives'), keyFile=self.env['STAND_TEST_KEY'], offline=True)
        return self.js("require('/app/src/server/migrations/prepare-booking-read-budget.cjs')"
                       '.prepareBookingReadBudgetCopy('+json.dumps(args)+')'
                       '.then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1})',
                       success=success)

    def test_helper_syntax_and_exact_37_stand_cases(self):
        for name in ('release-stand.py', 'release-stand-fixture.py', 'release-stand-read-budget.py', 'release-stand-booking-links.py'):
            ast.parse((HERE/name).read_text(encoding='utf-8'))
        tree = ast.parse((HERE/'release-stand.py').read_text(encoding='utf-8'))
        names = [n.args[1].value for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'scenario']
        self.assertEqual(len(names), 37)
        self.assertEqual(len(set(names)), 37)
        self.assertEqual({n for n in names if n.startswith('read-budget-')}, {
            'read-budget-17-after-disconnect', 'read-budget-17-without-migration',
            'read-budget-preparation-failure-keeps-schema17',
            'read-budget-gated-startup-failure-returns-schema17',
            'read-budget-activation-failure-keeps-new-data'})

    def test_forward_preserves_nonempty_sessions_jobs_counters_and_old_copy(self):
        before = self.seed()
        destination = self.base/'prepared'
        result = json.loads(self.prepare(destination).stdout)
        self.assertEqual(result['countersPreserved'], 2)
        self.assertTrue(result['sourceUnchanged'])
        self.assertTrue(Path(result['beforeArchive']).is_file())
        self.assertTrue(Path(result['preparedArchive']).is_file())
        helper.assert_state(before, json.loads(self.js(helper.OBSERVE, destination).stdout), True)
        helper.assert_state(before, json.loads(self.js(helper.OBSERVE).stdout), False)
        # The same helpers must work after an ordinary release already using ON.
        self.js(helper.PERSISTENT_STATE, destination, flags=helper.FLAGS)
        after = json.loads(self.js(helper.OBSERVE, destination).stdout)
        self.assertEqual(after['registration']['mode'], 'isolated')
        self.assertTrue(all(v['count'] > 0 for v in after['persistent'].values()))

    def test_valid_legacy_source_fails_only_copy_migration_and_stays_usable(self):
        before = self.seed(failure=True)
        destination = self.base/'failed'
        result = self.prepare(destination, success=False)
        self.assertIn('synthetic preparation failure', result.stderr)
        self.assertEqual((destination/'.restore-in-progress').read_text(),
                         'booking-read-budget-preparation-v1')
        helper.assert_state(before, json.loads(self.js(helper.OBSERVE).stdout), False)
        self.js("require('/app/platform-store.cjs').createPlatformStore('/data/platform',{notificationSchema:17}).close()")
        self.assertEqual(len(list((self.base/'archives').glob('*.enc'))), 1)

    def test_assertions_reject_empty_or_changed_persistent_state(self):
        before = self.seed()
        for field in ('sessions', 'notifications'):
            empty = copy.deepcopy(before)
            empty['persistent'][field]['count'] = 0
            with self.assertRaises(AssertionError):
                helper.assert_state(empty, empty, False)
            changed = copy.deepcopy(before)
            changed['persistent'][field]['sha256'] = '0'*64
            with self.assertRaises(AssertionError):
                helper.assert_state(before, changed, False)

    def test_activation_failure_latest_counter_and_retained_original(self):
        before = self.seed()
        destination = self.base/'active'
        self.prepare(destination)
        self.js("const d=new(require('node:sqlite').DatabaseSync)('/data/platform/booking-read-budget.sqlite');"
                "d.exec(\"UPDATE login_limits SET failures=failures+1 WHERE key='booking-budget:read-address:stand-synthetic'\");d.close()",
                destination)
        expected = copy.deepcopy(before)
        for row in expected['counters']:
            if row['key'] == 'booking-budget:read-address:stand-synthetic':
                row['failures'] += 1
        helper.assert_state(expected, json.loads(self.js(helper.OBSERVE, destination).stdout), True)
        helper.assert_state(before, json.loads(self.js(helper.OBSERVE).stdout), False)

    def test_offline_observe_allows_only_sidecars_and_refuses_outside_directory(self):
        class Stand:
            root = self.base
            new = 'synthetic-pinned-image'
        calls = []
        def command(*args):
            calls.append(args)
            return '{}'
        helper.observe(command, Stand(), offline=True)
        args = calls[0]
        self.assertIn('--read-only', args)
        self.assertIn('none', args)
        self.assertIn('type=bind,source='+str(self.base/'data')+',target=/data', args)
        self.assertEqual(helper.OBSERVE.count('readOnly:true'), 2)
        self.assertNotIn('immutable', helper.OBSERVE)
        with self.assertRaises(AssertionError):
            helper.observe(command, Stand(), offline=True, directory=self.base.parent/'other')


if __name__ == '__main__':
    unittest.main()
