"""Full platform17→19 transition; retain old data only until durable writer admission."""
import json
import os
from pathlib import Path
import re
import shutil

from migration import StaffMaxMigration
from read_budget import ReadBudgetMigration, check_active as check_budget
from booking_links import check_active as check_links

MIGRATION = 'paid-services-17-to-19'
PAYMENT_FLAG = 'CARTOTECA_PAYMENT_NETWORK_ENABLED'


def assert_contract(config):
    if (config.get('schema') != 19 or config.get('paymentNetworkEnabled') is not False or
            any(type(config.get(name)) is not int or config[name] != 1 for name in
                ['readBudgetVersion', 'bookingLinksVersion', 'assistantSavingVersion'])):
        raise RuntimeError('INVALID_PAID_SERVICES_PINS')
    if config.get('migration') == MIGRATION:
        if 'publicationGate' in config:
            raise RuntimeError('INVALID_PAID_SERVICES_GATE')
    elif config.get('migration') is not None or config.get('publicationGate') is not True:
        raise RuntimeError('INVALID_PAID_SERVICES_GATE')


def environment(current):
    return dict(item.split('=', 1) for item in current['Config'].get('Env', []) if '=' in item)


def preserved_flags(current):
    values = environment(current)
    return {name: values.get(name, '0') for name in
            ['CARTOTECA_CABINET_SCHEMA', 'CARTOTECA_SCHEDULED_NOTIFICATIONS']}


def state_code(expected_schema):
    if type(expected_schema) is not int or expected_schema not in [17, 19]:
        raise RuntimeError('INVALID_PAID_SERVICES_SCHEMA')
    # Hash directory identities and public mappings; never emit credentials, rows or patient data.
    return 'const expected=' + str(expected_schema) + ';' + r'''
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),root='/data';
const budget=require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
const links=require('/app/src/server/infrastructure/booking-public-links-schema.cjs');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const db=new DatabaseSync(root+'/platform/platform.sqlite',{readOnly:true});
try{
 db.exec('PRAGMA busy_timeout=5000');
 if(db.prepare('PRAGMA user_version').get().user_version!==expected||
    db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||
    db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Schema');
 const record=budget.assertMode(db,root+'/platform',true),component=links.validate(db);
 if(record?.version!==1||component?.version!==1)throw Error('Components');
 if(expected===19)require('/app/src/server/modules/billing/prepared-schema.cjs').validatePaidSchema(db);
 const roots=[];if(fs.existsSync(root+'/cabinet.sqlite'))roots.push('');
 if(fs.existsSync(root+'/tenants'))for(const row of fs.readdirSync(root+'/tenants',{withFileTypes:true})){
  if(!row.isDirectory()||!/^[A-Za-z0-9_-]{1,120}$/.test(row.name))throw Error('Cabinet');
  roots.push('tenants/'+row.name);
 }
 const cabinets={};
 for(const relative of roots.sort()){
  const file=path.join(root,relative,'cabinet.sqlite'),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error('Cabinet');
  const cabinet=new DatabaseSync(file,{readOnly:true});
  try{const version=cabinet.prepare('PRAGMA user_version').get().user_version;
   if(![1,2].includes(version))throw Error('Cabinet schema');cabinets[hash(relative)]=version;
  }finally{cabinet.close()}
 }
 console.log(JSON.stringify({schema:expected,readBudgetVersion:record.version,
  readBudgetStoreId:record.store_id,bookingLinksVersion:component.version,
  publicLinksFingerprint:hash(db.prepare('SELECT * FROM booking_public_links ORDER BY code').all()),
  cabinets}));
}finally{db.close()}
'''


def validate_proof(proof, expected):
    if (not isinstance(proof, dict) or type(proof.get('schema')) is not int or
            proof['schema'] != expected or
            any(type(proof.get(name)) is not int or proof[name] != 1 for name in
                ['readBudgetVersion', 'bookingLinksVersion']) or
            not re.fullmatch(r'[a-f0-9-]{36}', proof.get('readBudgetStoreId', '')) or
            not re.fullmatch(r'[a-f0-9]{64}', proof.get('publicLinksFingerprint', '')) or
            not isinstance(proof.get('cabinets'), dict) or not proof['cabinets']):
        raise RuntimeError('PAID_SERVICES_STATE_NOT_CONFIRMED')
    for identity, version in proof['cabinets'].items():
        if not re.fullmatch(r'[a-f0-9]{64}', identity) or type(version) is not int or version not in [1, 2]:
            raise RuntimeError('PAID_SERVICES_CABINETS_NOT_CONFIRMED')
    return proof


def compare_components(before, after, exact=False):
    if (before['readBudgetStoreId'] != after['readBudgetStoreId'] or
            before['readBudgetVersion'] != after['readBudgetVersion'] or
            before['bookingLinksVersion'] != after['bookingLinksVersion'] or
            any(after['cabinets'].get(name) != version for name, version in before['cabinets'].items()) or
            (exact and (before['cabinets'] != after['cabinets'] or
                        before['publicLinksFingerprint'] != after['publicLinksFingerprint']))):
        raise RuntimeError('PAID_SERVICES_COMPONENTS_CHANGED')


def live_proof(ops, expected):
    return validate_proof(json.loads(ops.command(['docker', 'exec', ops.config['container'],
        'node', '-e', state_code(expected)])), expected)


def prepare_publication(gate, current):
    assert_contract(gate.ops.config)
    if environment(current).get(PAYMENT_FLAG) != '0':
        raise RuntimeError('PAYMENT_NETWORK_MUST_REMAIN_DISABLED')
    proof = live_proof(gate.ops, 19)
    gate.record(paidServices={'source': proof, 'prepared': proof,
                             'flags': preserved_flags(current), 'verified': True})


def check_active(ops, current):
    assert_contract(ops.config)
    values = environment(current)
    if values.get(PAYMENT_FLAG) != '0' or values.get('CARTOTECA_MAX_SCHEMA') != '19':
        raise RuntimeError('PAID_SERVICES_CONFIGURATION_MISMATCH')
    transition = ops.migration or getattr(ops, 'publication', None)
    state = json.loads(transition.journal.read_text()) if transition else {}
    saved = state.get('paidServices', {})
    if saved.get('verified') is not True or preserved_flags(current) != saved.get('flags'):
        raise RuntimeError('PAID_SERVICES_PRESERVATION_NOT_CONFIRMED')
    source = validate_proof(saved.get('source'), 17 if ops.migration else 19)
    prepared = validate_proof(saved.get('prepared'), 19)
    compare_components(source, prepared, exact=True)
    # Once admitted, legitimate new cabinets/mappings may appear. Existing cabinet
    # schemas and the durable component identity must still match the saved proof.
    compare_components(prepared, live_proof(ops, 19), exact=transition.gated())
    return {'paymentNetworkEnabled': False, 'platformOnly': True,
            'componentsPreserved': True, 'cabinetSchemaUnchanged': True,
            'scheduleModeUnchanged': True}


class PaidServicesMigration(ReadBudgetMigration):
    def __init__(self, ops):
        super().__init__(ops)
        self.previous_schema, self.schema = 17, 19
        self.stage = ops.root / ('paid-services-' + ops.request['run'])

    def override_environment(self, values, gated):
        return {**values, 'CARTOTECA_MAX_SCHEMA': '19', PAYMENT_FLAG: '0',
                'CARTOTECA_RELEASE_GATE': '1' if gated else '0'}

    def component_check(self, directory, expected):
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                '--mount', 'type=bind,source=' + str(directory) + ',target=/data',
                '--entrypoint', 'node', self.ops.image_id, '-e', state_code(expected)]
        return validate_proof(json.loads(self.ops.command(args, timeout=120)), expected)

    def preflight(self):
        assert_contract(self.ops.config)
        current = self.ops.inspect()
        if environment(current).get(PAYMENT_FLAG, '0') != '0':
            raise RuntimeError('PAYMENT_NETWORK_MUST_REMAIN_DISABLED')
        from checks import assistant_process
        assistant_process(current, gated=False)
        check_budget(self.ops, current, expected_schema=17)
        check_links(self.ops, current, expected_schema=17)
        self.assert_other_writers_stopped(allow_current=True)
        size = self.assert_source_tree()
        source = live_proof(self.ops, 17)
        StaffMaxMigration.preflight(self)
        state = json.loads(self.journal.read_text())
        self.assert_mount_isolation(state['volumes'])
        for directory in [self.ops.root, Path(state['volumes']['/backups'])]:
            if shutil.disk_usage(directory).free < size * 8 + 512 * 1024 * 1024:
                raise RuntimeError('INSUFFICIENT_MIGRATION_SPACE')
        self.record(paidServices={'source': source, 'flags': preserved_flags(current), 'verified': False})

    def prepare(self):
        self.assert_backup_paused()
        self.assert_other_writers_stopped()
        self.assert_source_tree()
        state = json.loads(self.journal.read_text())
        source = self.component_check(self.data, 17)
        compare_components(state['paidServices']['source'], source)
        owner = self.data.stat()
        self.stage.mkdir(mode=0o700)
        os.chown(self.stage, owner.st_uid, owner.st_gid)
        self.assert_mount_isolation(state['volumes'])
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                '--tmpfs', '/tmp:size=256m,mode=1777']
        for target, directory in state['volumes'].items():
            args += ['--mount', 'type=bind,source=' + directory + ',target=' + target +
                     (',readonly' if target.startswith('/secrets') else '')]
        args += ['--mount', 'type=bind,source=' + str(self.stage) + ',target=/prepared',
                 '--entrypoint', 'node', self.ops.image_id, 'scripts/prepare-paid-services-upgrade.cjs',
                 '--source', '/data', '--destination', '/prepared/data', '--backups', '/backups',
                 '--key', '/secrets/backup.key', '--offline']
        result = json.loads(self.ops.command(args, timeout=1830))
        self.validate_preparation(result, state, source)
        if (self.stage / 'data/.restore-in-progress').exists():
            raise RuntimeError('MIGRATION_COPY_INCOMPLETE')
        prepared = self.component_check(self.stage / 'data', 19)
        compare_components(source, prepared, exact=True)
        self.offline_store_check(self.stage / 'data', True, expected_schema=19, fence=True)
        self.assert_other_writers_stopped()
        self.record(prepared=True, paidServices={'source': source, 'prepared': prepared,
            'flags': state['paidServices']['flags'], 'verified': True, 'preservation': result['preservation']})

    def validate_preparation(self, result, state, source):
        expected = {'schema': 19, 'previousSchema': 17, 'sourceUnchanged': True,
            'sessionsRevoked': False, 'clientBindingsPreserved': True,
            'requiresStoppedSourceBeforeSwitch': True, 'readBudgetVersion': 1,
            'bookingLinksVersion': 1, 'paymentNetworkEnabled': False,
            'billingConfiguredByDefault': False, 'paidServicesEnabledByDefault': False,
            'cabinetSchemaUnchanged': True, 'scheduleModeUnchanged': True}
        if any(type(result.get(name)) is not type(value) or result[name] != value
               for name, value in expected.items()):
            raise RuntimeError('MIGRATION_COPY_NOT_CONFIRMED')
        if (result.get('readBudgetStoreId') != source['readBudgetStoreId'] or
                result.get('publicLinksFingerprint') != source['publicLinksFingerprint']):
            raise RuntimeError('PAID_SERVICES_COMPONENTS_CHANGED')
        proof = result.get('preservation', {})
        if (any(not re.fullmatch(r'[a-f0-9]{64}', proof.get(name, '')) for name in
                ['sourceSha256', 'originalTableSha256']) or
                any(type(proof.get(name)) is not int or proof[name] <= 0 for name in
                    ['originalTables', 'files'])):
            raise RuntimeError('MIGRATION_PRESERVATION_NOT_CONFIRMED')
        archives = [result.get('beforeArchive'), result.get('preparedArchive')]
        if any(not isinstance(archive, str) for archive in archives) or len(set(archives)) != 2:
            raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
        for archive in archives:
            if not re.fullmatch(r'/backups/cartoteca-v2-[a-zA-Z0-9_.-]+\.enc', archive):
                raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')
            file = Path(state['volumes']['/backups']) / Path(archive).name
            if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1 or file.stat().st_size == 0:
                raise RuntimeError('MIGRATION_ARCHIVES_NOT_CONFIRMED')

    def activate(self):
        state = json.loads(self.journal.read_text())
        current = self.ops.inspect()
        if (state.get('prepared') is not True or state.get('installed') is not True or
                state.get('committed') is True or current['Image'] != self.ops.image_id or not self.gated()):
            raise RuntimeError('PAID_SERVICES_GATE_NOT_CONFIRMED')
        # Both outer state and this journal are durable before any writer admission.
        check_active(self.ops, current)
        super().activate()

    def rollback_data(self):
        outer = self.ops.directory / 'state.json'
        if outer.exists() and json.loads(outer.read_text()).get('migrationCommitted'):
            raise RuntimeError('MIGRATION_COMMITTED_KEEP_CURRENT_DATA')
        super().rollback_data()

    def quarantine(self):
        if self.ops.inspect()['Image'] != self.ops.image_id:
            raise RuntimeError('PAID_SERVICES_IMAGE_CHANGED')
        super().quarantine()
