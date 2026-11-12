"""Explicit offline notification migrations in a retained copy; no live schema edits."""
import json
import os
from pathlib import Path
import shutil


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class StaffMaxMigration:
    def __init__(self, ops):
        self.ops = ops
        self.journal = ops.directory / 'migration-state.json'
        self.schema = ops.config['schema']
        self.previous_schema = self.schema - 1
        self.push = ops.config.get('migration') == 'staff-push-16-to-17'
        self.structural = ops.config.get('migration') == 'structural-17-to-18'
        self.stage = ops.root / (('structural-' if self.structural else 'staff-push-' if self.push else 'staff-max-') + ops.request['run'])
        self.retained = ops.root / ('data-before-' + ops.request['run'])
        self.data = ops.root / 'data'

    def record(self, **changes):
        from agent import atomic
        state = json.loads(self.journal.read_text()) if self.journal.exists() else {}
        state.update(changes)
        atomic(self.journal, state)
        return state

    def override_environment(self, environment, gated):
        result = {**environment, 'CARTOTECA_MAX_SCHEMA': str(self.schema)}
        if gated:
            result['CARTOTECA_RELEASE_GATE'] = '1'
        if self.push or self.structural:
            result['CARTOTECA_PUSH_ENABLED'] = '1'
        if self.structural:
            result.update(CARTOTECA_CABINET_SCHEMA='2', CARTOTECA_SCHEDULED_NOTIFICATIONS='0' if gated else '1')
        return result

    def preflight(self):
        if self.stage.exists() or self.retained.exists():
            raise RuntimeError('MIGRATION_DESTINATION_EXISTS')
        current = self.ops.inspect()
        mounts = [m for m in current['Mounts'] if m['Destination'] == '/data']
        if len(mounts) != 1 or mounts[0]['Type'] != 'bind' or Path(mounts[0]['Source']) != self.data:
            raise RuntimeError('MIGRATION_DATA_MOUNT_MISMATCH')
        # Parse only the small override. Preserve placeholders/env_file references, not secrets.
        document = json.loads(self.ops.command([
            'docker', 'compose', '--project-directory', str(self.ops.root),
            '-f', str(self.ops.root / 'production.override.yaml'), 'config',
            '--format', 'json', '--no-env-resolution', '--no-interpolate',
            '--no-normalize', '--no-path-resolution', '--no-consistency']))
        document.pop('name', None)
        app = document.get('services', {}).get('app', {})
        if app.get('image') != current['Config']['Image']:
            raise RuntimeError('MIGRATION_OVERRIDE_IMAGE_MISMATCH')
        environment = app.get('environment', {})
        if not isinstance(environment, dict) or 'CARTOTECA_RELEASE_GATE' in environment:
            raise RuntimeError('MIGRATION_OVERRIDE_NOT_SUPPORTED')
        app['image'] = 'cartoteca:release-' + self.ops.request['run']
        app['environment'] = self.override_environment(environment, gated=True)
        (self.ops.directory / 'gated-production.override.yaml').write_text(json.dumps(document))
        app['environment'] = self.override_environment(environment, gated=False)
        (self.ops.directory / 'enabled-production.override.yaml').write_text(json.dumps(document))
        # Backup has no web/bot credentials; use its configured bind volumes and key path.
        backup = json.loads(self.ops.compose('config', '--format', 'json', backup=True))['services']['backup']
        mounts = {v['target']: v for v in backup.get('volumes', [])}
        secret_targets = [target for target in ['/secrets', '/secrets/backup.key'] if target in mounts]
        if len(secret_targets) != 1:
            raise RuntimeError('MIGRATION_KEY_MOUNT_UNSUPPORTED')
        secret_target = secret_targets[0]
        selected = ['/data', '/backups', secret_target]
        for target in selected:
            volume = mounts.get(target, {})
            source = Path(volume.get('source', '/nonexistent'))
            if volume.get('type') != 'bind' or not source.is_absolute() or any(p.is_symlink() for p in [source, *source.parents]):
                raise RuntimeError('MIGRATION_BACKUP_MOUNT_INVALID')
            if not (source.is_file() if target == '/secrets/backup.key' else source.is_dir()):
                raise RuntimeError('MIGRATION_BACKUP_MOUNT_INVALID')
        if Path(mounts['/data']['source']) != self.data:
            raise RuntimeError('MIGRATION_BACKUP_DATA_MISMATCH')
        size = 0
        for parent, folders, files in os.walk(self.data):
            for name in [*folders, *files]:
                if (Path(parent) / name).is_symlink():
                    raise RuntimeError('LINKED_MIGRATION_SOURCE')
            size += sum((Path(parent) / name).stat().st_size for name in files)
        for directory in [self.ops.root, Path(mounts['/backups']['source'])]:
            if shutil.disk_usage(directory).free < size * 3 + 256 * 1024 * 1024:
                raise RuntimeError('INSUFFICIENT_MIGRATION_SPACE')
        key = backup.get('environment', {}).get('BACKUP_KEY_FILE')
        if key != '/secrets/backup.key':
            raise RuntimeError('MIGRATION_KEY_PATH_UNSUPPORTED')
        self.record(volumes={k: mounts[k]['source'] for k in selected}, committed=False)

    def stop(self):
        self.ops.assert_previous()
        self.ops.compose('stop', '-t', '45', 'app')
        if self.ops.inspect()['State']['Running']:
            raise RuntimeError('MIGRATION_SOURCE_STILL_RUNNING')
        self.record(stopped=True)

    def prepare(self):
        if self.ops.inspect()['State']['Running']:
            raise RuntimeError('MIGRATION_SOURCE_STILL_RUNNING')
        containers = self.ops.command(['docker', 'ps', '-q']).decode().split()
        for container in containers:
            inspected = json.loads(self.ops.command(['docker', 'inspect', container]))[0]
            if any(m.get('Source') == str(self.data) for m in inspected.get('Mounts', [])):
                raise RuntimeError('ANOTHER_MIGRATION_WRITER_RUNNING')
        owner = self.data.stat()
        self.stage.mkdir(mode=0o700)
        os.chown(self.stage, owner.st_uid, owner.st_gid)
        state = json.loads(self.journal.read_text())
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--memory=900m', '--cpus=2', '--tmpfs', '/tmp:size=256m,mode=1777']
        for target, source in state['volumes'].items():
            args += ['--mount', 'type=bind,source=' + source + ',target=' + target + (',readonly' if target.startswith('/secrets') else '')]
        args += ['--mount', 'type=bind,source=' + str(self.stage) + ',target=/prepared',
                 '--entrypoint', 'node', self.ops.image_id, 'scripts/prepare-structural-upgrade.cjs' if self.structural else 'scripts/prepare-staff-push-upgrade.cjs' if self.push else 'scripts/prepare-staff-max-upgrade.cjs',
                 '--source', '/data', '--destination', '/prepared/data', '--backups', '/backups', '--key', '/secrets/backup.key']
        if self.structural:
            args += ['--offline']
        result = json.loads(self.ops.command(args, timeout=1830))
        if result.get('schema') != self.schema or result.get('sourceUnchanged') is not True or result.get('sessionsRevoked') is not False:
            raise RuntimeError('MIGRATION_COPY_NOT_CONFIRMED')
        if self.structural and (result.get('cabinetSchema') != 2 or not isinstance(result.get('cabinets'), int)):
            raise RuntimeError('MIGRATION_CABINETS_NOT_CONFIRMED')
        if (self.stage / 'data/.restore-in-progress').exists():
            raise RuntimeError('MIGRATION_COPY_INCOMPLETE')
        self.record(prepared=True)

    def install(self):
        if self.ops.inspect()['State']['Running']:
            raise RuntimeError('MIGRATION_SOURCE_STILL_RUNNING')
        state = json.loads(self.journal.read_text())
        if not state.get('prepared') or self.retained.exists():
            raise RuntimeError('MIGRATION_COPY_NOT_CONFIRMED')
        self.record(installing=True)
        self.data.rename(self.retained)
        sync_directory(self.ops.root)
        (self.stage / 'data').rename(self.data)
        sync_directory(self.ops.root)
        self.record(installed=True)

    def activate(self):
        # Durable point of no automatic data rollback BEFORE allowing writers/delivery.
        self.record(committed=True)
        self.ops.replace_configs(phase='enabled')
        self.ops.compose('up', '-d', '--no-build', '--no-deps', 'app')
        self.ops.wait_ready(self.ops.image_id)
        if self.gated():
            raise RuntimeError('MIGRATION_GATE_STILL_ACTIVE')

    def gated(self):
        return 'CARTOTECA_RELEASE_GATE=1' in self.ops.inspect()['Config'].get('Env', [])

    def rollback_data(self):
        state = json.loads(self.journal.read_text())
        if state.get('committed'):
            raise RuntimeError('MIGRATION_COMMITTED_KEEP_CURRENT_DATA')
        current = self.ops.inspect()
        if self.retained.exists():
            if current['State']['Running'] and not self.gated():
                raise RuntimeError('MIGRATION_WRITERS_MAY_BE_ACTIVE')
            self.ops.compose('stop', '-t', '45', 'app')
            if self.data.exists():
                # Retain the failed new schema; never delete or overwrite either copy.
                if (self.stage / 'failed-data').exists():
                    raise RuntimeError('MIGRATION_FAILED_COPY_EXISTS')
                self.data.rename(self.stage / 'failed-data')
            self.retained.rename(self.data)
            sync_directory(self.ops.root)
        self.record(rolledBack=True)
