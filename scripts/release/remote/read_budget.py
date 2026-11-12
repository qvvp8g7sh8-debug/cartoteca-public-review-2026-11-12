"""Explicit schema17 offline read-budget activation; retained source, never stale rollback."""
import json
import os
from pathlib import Path
import re
import shutil
import stat

from migration import StaffMaxMigration


FLAGS = {'CARTOTECA_SHARED_CABINET_WRITES': '1', 'CARTOTECA_ISOLATED_READ_BUDGETS': '1',
         'CARTOTECA_READ_BUDGET_VERSION': '1'}


def store_check_code(enabled, fence, expected_schema=17):
    if type(expected_schema) is not int or expected_schema not in [17, 19]:
        raise RuntimeError('INVALID_READ_BUDGET_SCHEMA')
    # Read-only checks emit only component identity, never counters, credentials or rows.
    return ('const enabled=' + json.dumps(enabled) + ',fence=' + json.dumps(fence) + ',expectedSchema=' + str(expected_schema) + ';' + r'''
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const s=require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
const dir='/data/platform',open=p=>new DatabaseSync(p,{readOnly:true});
function integrity(db){
 db.exec('PRAGMA busy_timeout=5000');
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
    db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Integrity');
}
const db=open(dir+'/platform.sqlite');let record;
try{
 integrity(db);
 if(db.prepare('PRAGMA user_version').get().user_version!==expectedSchema)throw Error('Schema');
 record=s.assertMode(db,dir,enabled);
 if(record){const budget=open(dir+'/'+s.filename);try{integrity(budget)}finally{budget.close()}}
 const file=dir+'/write-fence.sqlite';
 if(fence){
  if(!fs.existsSync(file)||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Fence');
  const gate=open(file);try{
   integrity(gate);
   if(gate.prepare('PRAGMA journal_mode').get().journal_mode!=='delete'||
      gate.prepare('SELECT count(*) n FROM fence').get().n!==0)throw Error('Fence');
  }finally{gate.close()}
 }else if(fs.existsSync(file))throw Error('Unexpected fence');
}finally{db.close()}
console.log(JSON.stringify({componentVersion:record?.version??null,mode:record?.mode??'legacy',storeId:record?.store_id??null}));
''')


def validate_store_result(result, enabled):
    if not isinstance(result, dict) or result.get('mode') != ('isolated' if enabled else 'legacy'):
        raise RuntimeError('READ_BUDGET_STORE_NOT_CONFIRMED')
    identity = result.get('storeId')
    if identity is None and not enabled and result.get('componentVersion') is None:
        return result
    if type(result.get('componentVersion')) is not int or result['componentVersion'] != 1 or not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9-]{36}', identity):
        raise RuntimeError('READ_BUDGET_STORE_NOT_CONFIRMED')
    return result


def check_active(ops, current, expected_schema=None):
    expected_schema = ops.config.get('schema', 17) if expected_schema is None else expected_schema
    environment = dict(item.split('=', 1) for item in current['Config'].get('Env', []) if '=' in item)
    if any(environment.get(name) != value for name, value in FLAGS.items()):
        raise RuntimeError('READ_BUDGET_CONFIGURATION_MISMATCH')
    result = json.loads(ops.command(['docker', 'exec', ops.config['container'], 'node', '-e', store_check_code(True, True, expected_schema)]))
    validate_store_result(result, True)
    if type(ops.migration) is ReadBudgetMigration:
        prepared = json.loads(ops.migration.journal.read_text())
        if result['storeId'] != prepared.get('storeId'):
            raise RuntimeError('READ_BUDGET_STORE_CHANGED')


def check_release_mode(ops, current):
    if ops.config.get('migration') == 'read-budget-17':
        return  # The transition's own preflight requires source OFF and no fence.
    environment = dict(item.split('=', 1) for item in current['Config'].get('Env', []) if '=' in item)
    if any(environment.get(name, '0') != '0' for name in FLAGS) and ops.config.get('readBudgetVersion') != 1:
        raise RuntimeError('READ_BUDGET_RELEASE_PIN_REQUIRED')
    if ops.config.get('readBudgetVersion') == 1:
        if ops.config.get('migration') == 'paid-services-17-to-19':
            check_active(ops, current, expected_schema=17)
        else:
            check_active(ops, current)


def overlapping(left, right):
    left, right = Path(left).resolve(), Path(right).resolve()
    if left == right or left in right.parents or right in left.parents:
        return True
    # realpath also needs inode comparison for existing bind-mount aliases.
    for item, candidates in [(left, [right, *right.parents]), (right, [left, *left.parents])]:
        if item.exists() and any(other.exists() and item.samefile(other) for other in candidates):
            return True
    return False


class ReadBudgetMigration(StaffMaxMigration):
    def __init__(self, ops):
        super().__init__(ops)
        self.previous_schema = 17
        self.stage = ops.root / ('read-budget-' + ops.request['run'])

    def override_environment(self, environment, gated):
        # This component migration must not change schema gates or delivery settings.
        result = {**environment, **FLAGS}
        if gated:
            result['CARTOTECA_RELEASE_GATE'] = '1'
        return result

    def assert_other_writers_stopped(self, allow_current=False):
        current = self.ops.inspect()
        if not allow_current and current['State']['Running']:
            raise RuntimeError('MIGRATION_SOURCE_STILL_RUNNING')
        for container in self.ops.command(['docker', 'ps', '-q']).decode().split():
            inspected = json.loads(self.ops.command(['docker', 'inspect', container]))[0]
            if allow_current and inspected['Id'] == current['Id']:
                continue
            for mount in inspected.get('Mounts', []):
                source = mount.get('Source')
                # Includes read-only backup/background containers and parent/child binds.
                if source and Path(source).is_absolute() and any(overlapping(source, target) for target in [self.data, self.retained, self.stage]):
                    raise RuntimeError('ANOTHER_MIGRATION_WRITER_RUNNING')

    def assert_backup_paused(self):
        timer = self.ops.config['backupTimer']
        for unit in [timer, timer.removesuffix('.timer') + '.service']:
            active = self.ops.command(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']).strip()
            if active not in [b'inactive', b'failed']:
                raise RuntimeError('MIGRATION_BACKUP_NOT_PAUSED')

    def assert_source_tree(self):
        if any(p.is_symlink() for p in [self.data, *self.data.parents]):
            raise RuntimeError('LINKED_MIGRATION_SOURCE')
        size = 0
        for parent, folders, files in os.walk(self.data):
            for name in [*folders, *files]:
                item = (Path(parent) / name).lstat()
                if not (stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode)) or stat.S_ISREG(item.st_mode) and item.st_nlink != 1:
                    raise RuntimeError('LINKED_OR_SPECIAL_MIGRATION_SOURCE')
                if stat.S_ISREG(item.st_mode):
                    size += item.st_size
        return size

    def offline_store_check(self, directory, enabled, expected_schema=17, fence=False):
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                # SQLite readOnly connections may create disposable WAL/SHM sidecars.
                # A read-only bind breaks verification of a cleanly closed WAL database.
                '--mount', 'type=bind,source=' + str(directory) + ',target=/data',
                '--entrypoint', 'node', self.ops.image_id, '-e', store_check_code(enabled, fence, expected_schema)]
        return validate_store_result(json.loads(self.ops.command(args, timeout=120)), enabled)

    def assert_mount_isolation(self, volumes):
        paths = [Path(source) for source in volumes.values()] + [self.stage, self.retained]
        for index, left in enumerate(paths):
            if any(overlapping(left, right) for right in paths[index + 1:]):
                raise RuntimeError('MIGRATION_HOST_MOUNTS_OVERLAP')

    def preflight(self):
        environment = dict(item.split('=', 1) for item in self.ops.inspect()['Config'].get('Env', []) if '=' in item)
        if environment.get('CARTOTECA_SHARED_CABINET_WRITES', '0') != '0' or environment.get('CARTOTECA_ISOLATED_READ_BUDGETS', '0') != '0' or 'CARTOTECA_READ_BUDGET_VERSION' in environment:
            raise RuntimeError('READ_BUDGET_SOURCE_ALREADY_ENABLED')
        self.assert_other_writers_stopped(allow_current=True)
        size = self.assert_source_tree()
        self.offline_store_check(self.data, False)
        super().preflight()
        state = json.loads(self.journal.read_text())
        self.assert_mount_isolation(state['volumes'])
        # Both encrypted archives, copied data, snapshots and verification recovery coexist.
        for directory in [self.ops.root, Path(state['volumes']['/backups'])]:
            if shutil.disk_usage(directory).free < size * 8 + 512 * 1024 * 1024:
                raise RuntimeError('INSUFFICIENT_MIGRATION_SPACE')

    def stop(self):
        self.assert_backup_paused()
        self.assert_other_writers_stopped(allow_current=True)
        super().stop()
        self.assert_other_writers_stopped()

    def prepare(self):
        self.assert_backup_paused()
        self.assert_other_writers_stopped()
        self.assert_source_tree()
        self.offline_store_check(self.data, False)
        owner = self.data.stat()
        self.stage.mkdir(mode=0o700)
        os.chown(self.stage, owner.st_uid, owner.st_gid)
        state = json.loads(self.journal.read_text())
        self.assert_mount_isolation(state['volumes'])
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                '--tmpfs', '/tmp:size=256m,mode=1777']
        for target, source in state['volumes'].items():
            args += ['--mount', 'type=bind,source=' + source + ',target=' + target + (',readonly' if target.startswith('/secrets') else '')]
        args += ['--mount', 'type=bind,source=' + str(self.stage) + ',target=/prepared',
                 '--entrypoint', 'node', self.ops.image_id, 'scripts/prepare-booking-read-budget.cjs',
                 '--source', '/data', '--destination', '/prepared/data', '--backups', '/backups',
                 '--key', '/secrets/backup.key', '--offline']
        result = json.loads(self.ops.command(args, timeout=1830))
        if type(result.get('componentVersion')) is not int or result['componentVersion'] != 1 or result.get('mode') != 'isolated' or type(result.get('countersPreserved')) is not int or result['countersPreserved'] < 0 or result.get('sourceUnchanged') is not True or result.get('requiresStoppedSourceBeforeSwitch') is not True or result.get('enabledByDefault') is not False:
            raise RuntimeError('MIGRATION_COPY_NOT_CONFIRMED')
        archives = [result.get('beforeArchive'), result.get('preparedArchive')]
        if any(not isinstance(archive, str) for archive in archives) or len(set(archives)) != 2:
            raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
        for archive in archives:
            if not isinstance(archive, str) or not re.fullmatch(r'/backups/cartoteca-v2-[a-zA-Z0-9_.-]+\.enc', archive):
                raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
            file = Path(state['volumes']['/backups']) / Path(archive).name
            if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1 or file.stat().st_size == 0:
                raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
        if (self.stage / 'data/.restore-in-progress').exists():
            raise RuntimeError('MIGRATION_COPY_INCOMPLETE')
        proof = self.offline_store_check(self.stage / 'data', True)
        self.assert_other_writers_stopped()
        self.record(prepared=True, storeId=proof['storeId'], readBudgetVersion=1)

    def install(self):
        self.assert_backup_paused()
        self.assert_other_writers_stopped()
        super().install()

    def activate(self):
        self.assert_backup_paused()
        self.assert_other_writers_stopped(allow_current=True)
        super().activate()

    def rollback_data(self):
        if json.loads(self.journal.read_text()).get('committed'):
            raise RuntimeError('MIGRATION_COMMITTED_KEEP_CURRENT_DATA')
        self.assert_other_writers_stopped(allow_current=True)
        super().rollback_data()

    def quarantine(self):
        # Writers may already have committed. Close access, retain both copies/configs.
        self.ops.compose('stop', '-t', '45', 'app')
        if self.ops.inspect()['State']['Running']:
            raise RuntimeError('MIGRATION_SOURCE_STILL_RUNNING')
        self.record(activationFailed=True, currentDataRetained=True)
