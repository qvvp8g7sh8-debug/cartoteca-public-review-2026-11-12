"""Add permanent booking addresses to an offline schema17/read-budget1 copy."""
import json
import os
from pathlib import Path
import re
import shutil

from migration import StaffMaxMigration
from read_budget import ReadBudgetMigration, check_active as check_budget


def component_code(enabled, expected_schema=17):
    if type(expected_schema) is not int or expected_schema not in [17, 19]:
        raise RuntimeError('INVALID_BOOKING_LINKS_SCHEMA')
    return 'const enabled=' + json.dumps(enabled) + ',expectedSchema=' + str(expected_schema) + ';' + r'''
const {DatabaseSync}=require('node:sqlite');
const links=require('/app/src/server/infrastructure/booking-public-links-schema.cjs');
const budget=require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
const db=new DatabaseSync('/data/platform/platform.sqlite',{readOnly:true});
try{
 db.exec('PRAGMA busy_timeout=5000');
 if(db.prepare('PRAGMA user_version').get().user_version!==expectedSchema||
    db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
    db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Schema');
 const component=links.validate(db),record=budget.assertMode(db,'/data/platform',true);
 if(Boolean(component)!==enabled)throw Error('Component');
 console.log(JSON.stringify({bookingLinksVersion:component?.version??null,
   readBudgetStoreId:record.store_id}));
}finally{db.close()}
'''


def validate_result(result, enabled):
    expected = 1 if enabled else None
    if not isinstance(result, dict) or result.get('bookingLinksVersion') != expected or (enabled and type(result.get('bookingLinksVersion')) is not int):
        raise RuntimeError('BOOKING_LINKS_COMPONENT_NOT_CONFIRMED')
    if not isinstance(result.get('readBudgetStoreId'), str) or not re.fullmatch(r'[a-f0-9-]{36}', result['readBudgetStoreId']):
        raise RuntimeError('BOOKING_LINKS_READ_BUDGET_NOT_CONFIRMED')
    return result


def check_active(ops, current, expected_schema=None):
    expected_schema = ops.config.get('schema', 17) if expected_schema is None else expected_schema
    check_budget(ops, current, expected_schema=expected_schema)
    result = validate_result(json.loads(ops.command(['docker', 'exec', ops.config['container'], 'node', '-e', component_code(True, expected_schema)])), True)
    if isinstance(ops.migration, BookingLinksMigration):
        prepared = json.loads(ops.migration.journal.read_text())
        if not prepared.get('prepared') or result['readBudgetStoreId'] != prepared.get('storeId'):
            raise RuntimeError('BOOKING_LINKS_READ_BUDGET_CHANGED')


def check_release_mode(ops, current):
    if ops.config.get('migration') == 'booking-links-17':
        return  # Candidate-image validation in migration preflight requires no component yet.
    if ops.config.get('bookingLinksVersion') == 1:
        if ops.config.get('migration') == 'paid-services-17-to-19':
            check_active(ops, current, expected_schema=17)
        else:
            check_active(ops, current)
        return
    # Older images need not contain the component module. Detect its presence without it.
    code = "const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite',{readOnly:true});try{console.log(d.prepare(\"SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'booking_public_links%'\").get().n)}finally{d.close()}"
    if ops.command(['docker', 'exec', ops.config['container'], 'node', '-e', code]).strip() != b'0':
        raise RuntimeError('BOOKING_LINKS_RELEASE_PIN_REQUIRED')


class BookingLinksMigration(ReadBudgetMigration):
    def __init__(self, ops):
        super().__init__(ops)
        self.stage = ops.root / ('booking-links-' + ops.request['run'])

    def override_environment(self, environment, gated):
        # Keep schema, delivery and existing shared/isolated budget flags unchanged.
        result = dict(environment)
        if gated:
            result['CARTOTECA_RELEASE_GATE'] = '1'
        return result

    def component_check(self, directory, enabled):
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                '--mount', 'type=bind,source=' + str(directory) + ',target=/data',
                '--entrypoint', 'node', self.ops.image_id, '-e', component_code(enabled)]
        return validate_result(json.loads(self.ops.command(args, timeout=120)), enabled)

    def preflight(self):
        check_budget(self.ops, self.ops.inspect())
        self.assert_other_writers_stopped(allow_current=True)
        size = self.assert_source_tree()
        source = self.component_check(self.data, False)
        StaffMaxMigration.preflight(self)
        state = json.loads(self.journal.read_text())
        self.assert_mount_isolation(state['volumes'])
        for directory in [self.ops.root, Path(state['volumes']['/backups'])]:
            if shutil.disk_usage(directory).free < size * 8 + 512 * 1024 * 1024:
                raise RuntimeError('INSUFFICIENT_MIGRATION_SPACE')
        self.record(storeId=source['readBudgetStoreId'])

    def prepare(self):
        self.assert_backup_paused()
        self.assert_other_writers_stopped()
        self.assert_source_tree()
        state = json.loads(self.journal.read_text())
        source = self.component_check(self.data, False)
        if source['readBudgetStoreId'] != state.get('storeId'):
            raise RuntimeError('BOOKING_LINKS_READ_BUDGET_CHANGED')
        owner = self.data.stat()
        self.stage.mkdir(mode=0o700)
        os.chown(self.stage, owner.st_uid, owner.st_gid)
        self.assert_mount_isolation(state['volumes'])
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                '--tmpfs', '/tmp:size=256m,mode=1777']
        for target, source in state['volumes'].items():
            args += ['--mount', 'type=bind,source=' + source + ',target=' + target + (',readonly' if target.startswith('/secrets') else '')]
        args += ['--mount', 'type=bind,source=' + str(self.stage) + ',target=/prepared',
                 '--entrypoint', 'node', self.ops.image_id, 'scripts/prepare-booking-public-links.cjs',
                 '--source', '/data', '--destination', '/prepared/data', '--backups', '/backups',
                 '--key', '/secrets/backup.key', '--offline']
        result = json.loads(self.ops.command(args, timeout=1830))
        if type(result.get('componentVersion')) is not int or result['componentVersion'] != 1 or result.get('platformVersion') != 17 or result.get('rollbackPreservesComponent') is not False or type(result.get('mappingsPreserved')) is not int or result['mappingsPreserved'] != 0 or result.get('sourceUnchanged') is not True or result.get('requiresStoppedSourceBeforeSwitch') is not True:
            raise RuntimeError('MIGRATION_COPY_NOT_CONFIRMED')
        archives = [result.get('beforeArchive'), result.get('preparedArchive')]
        if any(not isinstance(archive, str) for archive in archives) or len(set(archives)) != 2:
            raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
        for archive in archives:
            if not re.fullmatch(r'/backups/cartoteca-v2-[a-zA-Z0-9_.-]+\.enc', archive):
                raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
            file = Path(state['volumes']['/backups']) / Path(archive).name
            if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1 or file.stat().st_size == 0:
                raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
        if (self.stage / 'data/.restore-in-progress').exists():
            raise RuntimeError('MIGRATION_COPY_INCOMPLETE')
        proof = self.component_check(self.stage / 'data', True)
        budget = self.offline_store_check(self.stage / 'data', True)
        if proof['readBudgetStoreId'] != state.get('storeId') or budget['storeId'] != state.get('storeId'):
            raise RuntimeError('BOOKING_LINKS_READ_BUDGET_CHANGED')
        self.assert_other_writers_stopped()
        self.record(prepared=True, bookingLinksVersion=1)
