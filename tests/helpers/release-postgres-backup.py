"""Native backup wrapper contract; every Docker invocation is a fake."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import unittest.mock
import sys
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('postgres_backup_job', ROOT / 'scripts/postgres-backup-job.py')
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)


class BackupJobTests(unittest.TestCase):
    def fixture(self, root):
        secrets = root / 'secrets'
        secrets.mkdir(mode=0o700)
        (secrets / 'postgres_owner_password').write_text('synthetic-private-password')
        (secrets / 'postgres_backup_key').write_bytes(b'x' * 32)
        (root / 'compose.postgres.backup.yaml').write_text('services: {}')
        config = {'root': str(root), 'project': 'synthetic-pg', 'image': 'sha256:' + 'a' * 64,
                  'secretDirectory': str(secrets)}
        file = root / 'operator.json'
        file.write_text(json.dumps(config))
        return file, config

    def test_explicit_config_builds_exact_one_shot_command_without_application_env(self):
        with tempfile.TemporaryDirectory(prefix='pg-backup-job123-') as temporary:
            file, config = self.fixture(Path(temporary))
            self.assertEqual(job.configuration(str(file)), config)
            expected = ['docker', 'compose', '--env-file', '/dev/null', '--project-directory', config['root'],
                        '-p', 'synthetic-pg-backup', '-f', config['root'] + '/compose.postgres.backup.yaml',
                        'run', '--rm', '--no-deps', '--pull', 'never', '--name', 'synthetic-pg-postgres-backup-run',
                        'backup', 'scripts/backup-agent.cjs', 'run', '--scheduled']
            self.assertEqual(job.command(config, 'run', True), expected)
            with unittest.mock.patch.dict(os.environ, {'MAX_BOT_TOKEN': 'private', 'CARTOTECA_PG_PASSWORD': 'private', 'DOCKER_HOST': 'tcp://outside.invalid'}):
                environment = job.environment(config)
            self.assertNotIn('MAX_BOT_TOKEN', environment)
            self.assertNotIn('CARTOTECA_PG_PASSWORD', environment)
            self.assertEqual(environment['DOCKER_HOST'], 'unix:///var/run/docker.sock')
            self.assertEqual(environment['COMPOSE_DISABLE_ENV_FILE'], '1')
            calls = []
            def fake(args, env, timeout):
                calls.append((args, env, timeout))
                return 1, json.dumps({'code': 'BACKUP_LOCAL_ONLY', 'exitCode': 1, 'severity': 'warning'}).encode()
            output, code = job.main(['check', '--config', str(file)], fake)
            self.assertEqual(code, 1)
            self.assertEqual(output['code'], 'BACKUP_LOCAL_ONLY')
            self.assertEqual(calls[0][0][-2:], ['scripts/backup-agent.cjs', 'check'])
            self.assertEqual(calls[0][2], 45)

    def test_ambiguous_config_and_commands_fail_before_any_docker_invocation(self):
        with tempfile.TemporaryDirectory(prefix='pg-backup-job123-') as temporary:
            file, config = self.fixture(Path(temporary))
            for change in [{'image': 'mutable:tag'}, {'project': '../foreign'}, {'password': 'private'}]:
                file.write_text(json.dumps({**config, **change}))
                with self.assertRaises(ValueError):
                    job.configuration(str(file))
            file.write_text(json.dumps(config))
            duplicate = json.dumps(config)[:-1] + ',"project":"other"}'
            file.write_text(duplicate)
            with self.assertRaises(ValueError):
                job.configuration(str(file))
            file.write_text(json.dumps(config))
            for args in [['status'], ['shell', '--config', str(file)], ['status', '--config', str(file), '--scheduled'],
                         ['run', '--config', str(file), '--scheduled', '--scheduled']]:
                with self.assertRaises(ValueError):
                    job.main(args, lambda *_: self.fail('Docker must not run'))
            link = Path(temporary) / 'linked.json'
            link.symlink_to(file)
            with self.assertRaises(ValueError):
                job.configuration(str(link))

    def test_only_own_pinned_container_can_be_stopped_and_no_native_drill_is_inferred(self):
        config = {'root': '/synthetic', 'project': 'synthetic-pg', 'image': 'sha256:' + 'a' * 64, 'secretDirectory': '/private'}
        for labels, image in [({'cartoteca.scope': 'foreign'}, config['image']),
                              ({'cartoteca.scope': 'postgres-backup-v1', 'cartoteca.postgres-project': 'synthetic-pg'}, 'sha256:' + 'b' * 64)]:
            calls = []
            def fake(args, *_):
                calls.append(args)
                return 0, (json.dumps(labels) + '\n' + image + '\n').encode()
            with self.assertRaises(ValueError):
                job.stop(config, fake)
            self.assertEqual(len(calls), 1)
        for value in [{'state': 'local_only'}, {'state': 'local_only', 'backend': 'postgres', 'verified': True,
                       'drill': {'backend': 'postgres', 'restored': True, 'started': False, 'notificationsPaused': True}}]:
            with self.assertRaises(ValueError):
                job.result('run', 0, json.dumps(value).encode())
        value, code = job.result('run', 0, b'{"state":"already_completed"}')
        self.assertEqual(code, 0)
        self.assertIs(value['newBackup'], False)
        self.assertNotIn('restoreDrill', value)


if __name__ == '__main__':
    unittest.main()
