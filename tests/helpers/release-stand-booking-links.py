"""Public booking link assertions for the disposable schema17/read-budget1 stand."""
import importlib.util
import json
import os
from pathlib import Path


spec = importlib.util.spec_from_file_location('links_budget', Path(__file__).with_name('release-stand-read-budget.py'))
budget = importlib.util.module_from_spec(spec); spec.loader.exec_module(budget)

OBSERVE = r'''
const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs');
const d=new DatabaseSync('/data/platform/platform.sqlite',{readOnly:true});
try{
 const component=require('/app/src/server/infrastructure/booking-public-links-schema.cjs').validate(d);
 console.log(JSON.stringify({schema:d.prepare('PRAGMA user_version').get().user_version,
   component,links:component?d.prepare('SELECT * FROM booking_public_links ORDER BY code').all():[],
   integrity:d.prepare('PRAGMA integrity_check').get().integrity_check,
   incomplete:fs.existsSync('/data/.restore-in-progress')}));
}finally{d.close();}
'''

ALLOCATE = r'''
const database=require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase('/data/platform',{
 notificationSchema:17,sharedCabinetWrites:true,isolatedReadBudgets:true});
try{
 const owner=database.db.prepare("SELECT account_id,organization_id FROM memberships WHERE role='owner' LIMIT 1").get();
 const links=require('/app/src/server/modules/booking/short-links.cjs').createBookingShortLinks(database);
 if(!links.available)throw Error('Expected prepared public links');
 links.ensure(owner.organization_id,[owner.account_id]);
 const organization=links.path(owner.organization_id),staff=links.path(owner.organization_id,owner.account_id);
 if(!/^\/b\/[a-z0-9]{8}$/.test(organization)||!/^\/b\/[a-z0-9]{8}$/.test(staff)||organization===staff)
   throw Error('Short target addresses not allocated');
 console.log(JSON.stringify({organization,staff}));
}finally{database.closeWriter();database.db.close();}
'''

# Deliberate latest-data change in a fixture runtime which then refuses to start.
# A rollback must not discard this newly allocated target. This synthetic staff
# UUID need not resolve publicly, but is a valid durable registry identity.
POST_COMMIT = r'''
const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite');
try{if(d.prepare("SELECT 1 FROM sqlite_schema WHERE name='booking_public_links'").get()){
 const org=d.prepare('SELECT id FROM organizations ORDER BY id LIMIT 1').get().id;
 d.prepare('INSERT INTO booking_public_links(code,organization_id,staff_id,created_at) VALUES(?,?,?,?)')
  .run('zzzzzzzz',org,'11111111-1111-4111-8111-111111111111',Date.now());
}}finally{d.close();}
'''


def prepare_baseline(command, stand):
    """Real offline budget preparation on synthetic data before the links test."""
    stand.reset(17, key_file=True, production=True)
    stand.compose('stop', '-t', '10', 'app')
    stage = stand.root/('links-baseline-'+os.urandom(6).hex())
    stage.mkdir(mode=0o700); os.chown(stage, 1000, 1000)
    result = json.loads(command('docker', 'run', '--rm', '--network', 'none',
        '--mount', 'type=bind,source='+str(stand.root/'data')+',target=/data',
        '--mount', 'type=bind,source='+str(stage)+',target=/prepared',
        '--mount', 'type=bind,source='+str(stand.root/'backups')+',target=/backups',
        '--mount', 'type=bind,source='+str(stand.root/'keys/backup.key')+',target=/secrets/backup.key,readonly',
        '--entrypoint', 'node', stand.new, 'scripts/prepare-booking-read-budget.cjs',
        '--source', '/data', '--destination', '/prepared/data', '--backups', '/backups',
        '--key', '/secrets/backup.key', '--offline', timeout=300))
    assert result['sourceUnchanged'] and (stage/'data').is_dir()
    assert not (stage/'data/.restore-in-progress').exists()
    data = stand.root/'data'
    assert data.is_dir() and not data.is_symlink() and data.parent == stand.root
    data.rename(stand.root/('fixture-retained-'+os.urandom(6).hex()))
    (stage/'data').rename(data)


def inject_preparation_failure(directory):
    """Fault only in the copied disposable worker, never in product code/image.

    Occupy the copy destination after migration-stop and stage creation. Then
    invoke the real unchanged CLI: it must refuse rather than overwrite data.
    """
    file = directory/'operations.py'
    with file.open('a', encoding='utf-8') as stream:
        stream.write('''
_stand_original_command = Operations.command
def _stand_occupied_copy(self, args, **kwargs):
    if self.config.get('migration') == 'booking-links-17' and 'scripts/prepare-booking-public-links.cjs' in args:
        copy = self.migration.stage / 'data'
        copy.mkdir(mode=0o700)
        (copy / '.restore-in-progress').write_text('booking-public-links-preparation-v1')
        os.chown(copy, 1000, 1000)
        os.chown(copy / '.restore-in-progress', 1000, 1000)
    return _stand_original_command(self, args, **kwargs)
Operations.command = _stand_occupied_copy
''')


def observe(command, stand, *, offline=False, directory=None):
    if not offline:
        return json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', OBSERVE))
    directory = directory or stand.root/'data'
    assert directory.parent == stand.root and not directory.is_symlink()
    return json.loads(command('docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount',
        'type=bind,source='+str(directory)+',target=/data', '--entrypoint', 'node', stand.new, '-e', OBSERVE))


def seed(command, stand, ordinary=False):
    previous_budget = budget.seed(command)
    if ordinary:
        command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', ALLOCATE)
    return dict(budget=previous_budget, links=observe(command, stand))


def assert_state(before, after, enabled, latest=False):
    assert after['schema'] == before['schema'] == 17
    assert after['integrity'] == 'ok' and after['incomplete'] is False
    if not enabled:
        assert after == before, 'Failed preparation changed source registry'
        return
    assert after['component'] == {'version': 1}
    for row in before['links']:
        assert row in after['links'], 'Existing public address was lost or reassigned'
    if latest:
        assert any(row['code'] == 'zzzzzzzz' for row in after['links']), 'Latest public address was discarded'


def verify(command, stand, directory, run, before, failure, migration, current):
    enabled = failure in (None, 'activation')
    after = observe(command, stand, offline=failure == 'activation')
    assert_state(before['links'], after, enabled, latest=failure == 'activation')
    expected_budget = before['budget']
    if failure == 'activation':
        expected_budget = {**expected_budget, 'counters': [{**row, 'failures': row['failures']+1}
            if row['key'] == 'booking-budget:read-address:stand-synthetic' else row
            for row in expected_budget['counters']]}
    budget_after = budget.observe(command, stand, offline=failure == 'activation')
    budget.assert_state(expected_budget, budget_after, True)
    assert budget_after['registration'] == before['budget']['registration']
    env = dict(item.split('=', 1) for item in current['Config']['Env'] if '=' in item)
    assert env.get('STAND_PRODUCTION') == '1'
    assert all(env.get(key) == value for key, value in budget.FLAGS.items())
    if migration and enabled:
        gated = json.loads((directory/'public-checks-gated.json').read_text())
        assert gated['passed'] and gated['gated'] and gated['bookingLinksVersion'] == 1
    if not failure:
        public = json.loads((directory/'public-checks.json').read_text())
        assert public['passed'] and public['bookingLinksVersion'] == 1 and public['readBudgetVersion'] == 1
        paths = json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', ALLOCATE))
        assert paths == json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', ALLOCATE))
        if not migration:
            assert observe(command, stand)['links'] == before['links']['links']
    if failure == 'migration':
        marker = stand.root/('booking-links-'+run)/'data/.restore-in-progress'
        assert marker.read_text() == 'booking-public-links-preparation-v1'
    if failure == 'activation':
        assert not current['State']['Running']
        retained = stand.root/('data-before-'+run)
        assert_state(before['links'], observe(command, stand, offline=True, directory=retained), False)
        budget.assert_state(before['budget'], budget.observe(command, stand, offline=True, directory=retained), True)
    return dict(schema=17, bookingLinksVersion=1 if enabled else 0, readBudgetVersion=1,
        mappingsPreserved=True, sessionNotificationStatePreserved=True, activeCountersPreserved=True,
        preparationFault='occupied-copy-destination' if failure == 'migration' else None,
        incompleteCopyBlocked=failure == 'migration', retainedLatestData=failure == 'activation')
