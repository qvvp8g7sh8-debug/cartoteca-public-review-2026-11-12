"""Local synthetic stand-helper checks; no Docker, SSH, sockets or real data."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE/filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
helper = load('booking_links_stand', 'release-stand-booking-links.py')
budget_tests = load('budget_stand_tests', 'release-stand-read-budget.test.py')
publication_gate = load('publication_gate_stand', 'release-stand-publication-gate.py')


class StandBookingLinksTests(unittest.TestCase):
    setUp = budget_tests.StandReadBudgetTests.setUp
    js = budget_tests.StandReadBudgetTests.js
    prepare_budget = budget_tests.StandReadBudgetTests.prepare

    def seed(self):
        self.js(budget_tests.BOOTSTRAP)
        self.js(helper.budget.SEED)
        self.js(helper.budget.PERSISTENT_STATE)
        prepared = self.base/'budget-prepared'
        self.prepare_budget(prepared)
        self.data = prepared
        return dict(budget=json.loads(self.js(helper.budget.OBSERVE).stdout),
                    links=json.loads(self.js(helper.OBSERVE).stdout))

    def prepare(self, destination, success=True):
        args = dict(source=str(self.data), destination=str(destination),
                    directory=str(self.base/'links-archives'), keyFile=self.env['STAND_TEST_KEY'], offline=True)
        return self.js("require('/app/src/server/migrations/prepare-booking-public-links.cjs')"
                       '.prepareBookingPublicLinksCopy('+json.dumps(args)+')'
                       '.then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1})',
                       success=success)

    def test_exact_five_link_scenarios_and_fault_helper_syntax(self):
        tree = ast.parse((HERE/'release-stand.py').read_text(encoding='utf-8'))
        names = [n.args[1].value for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'scenario']
        self.assertEqual(len(set(names)), 37)
        self.assertEqual({n for n in names if n.startswith('booking-links-')}, {
            'booking-links-17-after-disconnect', 'booking-links-17-without-migration',
            'booking-links-preparation-failure-keeps-schema17',
            'booking-links-gated-startup-failure-returns-schema17',
            'booking-links-activation-failure-keeps-new-data'})
        for name in ('release-stand.py', 'release-stand-fixture.py', 'release-stand-booking-links.py'):
            ast.parse((HERE/name).read_text(encoding='utf-8'))

    def test_forward_preserves_budget_sessions_jobs_and_old_source(self):
        before = self.seed()
        destination = self.base/'prepared-links'
        result = json.loads(self.prepare(destination).stdout)
        self.assertEqual(result['componentVersion'], 1)
        self.assertEqual(result['platformVersion'], 17)
        self.assertTrue(result['sourceUnchanged'])
        self.assertTrue(Path(result['beforeArchive']).is_file())
        self.assertTrue(Path(result['preparedArchive']).is_file())
        helper.assert_state(before['links'], json.loads(self.js(helper.OBSERVE, destination).stdout), True)
        helper.assert_state(before['links'], json.loads(self.js(helper.OBSERVE).stdout), False)
        helper.budget.assert_state(before['budget'], json.loads(self.js(helper.budget.OBSERVE, destination).stdout), True)
        first = json.loads(self.js(helper.ALLOCATE, destination).stdout)
        self.assertEqual(first, json.loads(self.js(helper.ALLOCATE, destination).stdout))
        self.assertEqual(len(json.loads(self.js(helper.OBSERVE, destination).stdout)['links']), 2)

    def test_complete_stand_start_script_has_valid_javascript_without_execution(self):
        tree = ast.parse((HERE/'release-stand-fixture.py').read_text(encoding='utf-8'))
        node = next(n for n in ast.walk(tree) if isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute) and n.func.attr == 'write'
                    and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == 'start.cjs')
        code = eval(compile(ast.Expression(node.args[1]), '<stand-start>', 'eval'),
                    {'read_budget': helper.budget, 'booking_links': helper, 'publication_gate': publication_gate})
        result = subprocess.run([shutil.which('node') or 'node', '--check'], input=code,
                                capture_output=True, text=True, timeout=15, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_real_cli_refuses_occupied_copy_and_preserves_original(self):
        before = self.seed()
        destination = self.base/'occupied'
        destination.mkdir()
        marker = destination/'.restore-in-progress'
        marker.write_text('booking-public-links-preparation-v1')
        result = self.prepare(destination, success=False)
        self.assertIn('destination must be new', result.stderr)
        self.assertEqual(marker.read_text(), 'booking-public-links-preparation-v1')
        helper.assert_state(before['links'], json.loads(self.js(helper.OBSERVE).stdout), False)
        helper.budget.assert_state(before['budget'], json.loads(self.js(helper.budget.OBSERVE).stdout), True)

    def test_post_commit_address_is_preserved_and_stale_source_has_no_component(self):
        before = self.seed()
        destination = self.base/'active'
        self.prepare(destination)
        self.js(helper.POST_COMMIT, destination)
        active = json.loads(self.js(helper.OBSERVE, destination).stdout)
        helper.assert_state(before['links'], active, True, latest=True)
        helper.assert_state(before['links'], json.loads(self.js(helper.OBSERVE).stdout), False)
        altered = copy.deepcopy(active); altered['links'] = []
        with self.assertRaises(AssertionError):
            helper.assert_state(before['links'], altered, True, latest=True)
        with self.assertRaises(AssertionError):
            helper.assert_state(active, altered, True)

    def test_fault_injection_only_wraps_real_cli_after_stage_exists(self):
        directory = self.base/'worker'; directory.mkdir()
        source = '''class Operations:
    def command(self, args, **kwargs):
        self.calls.append(args)
        return 'real-command'
'''
        (directory/'operations.py').write_text(source)
        helper.inject_preparation_failure(directory)
        generated = (directory/'operations.py').read_text()
        ast.parse(generated)
        namespace = {'os': __import__('os')}
        exec(generated, namespace)
        ops = namespace['Operations'](); ops.calls = []
        stage = self.base/'prepared-stage'; stage.mkdir()
        ops.config = {'migration': 'booking-links-17'}
        ops.migration = type('Migration', (), {'stage': stage})()
        with patch.object(namespace['os'], 'chown', create=True):
            self.assertEqual(ops.command(['docker', 'inspect']), 'real-command')
            self.assertFalse((stage/'data').exists())
            self.assertEqual(ops.command(['docker', 'run', 'scripts/prepare-booking-public-links.cjs']), 'real-command')
        self.assertEqual((stage/'data/.restore-in-progress').read_text(), 'booking-public-links-preparation-v1')
        self.assertEqual(len(ops.calls), 2)

    def test_offline_observer_isolated_and_target_confined(self):
        class Stand:
            root = self.base
            new = 'synthetic-pinned-image'
        calls = []
        def command(*args):
            calls.append(args)
            return '{}'
        helper.observe(command, Stand(), offline=True)
        self.assertIn('--read-only', calls[0])
        self.assertIn('none', calls[0])
        self.assertIn('readOnly:true', helper.OBSERVE)
        self.assertNotIn('immutable', helper.OBSERVE)
        with self.assertRaises(AssertionError):
            helper.observe(command, Stand(), offline=True, directory=self.base.parent/'outside')


if __name__ == '__main__':
    unittest.main()
