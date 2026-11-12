"""Synthetic read-budget activation assertions for the real disposable release stand."""
import json


FLAGS = {'CARTOTECA_SHARED_CABINET_WRITES': '1',
         'CARTOTECA_ISOLATED_READ_BUDGETS': '1', 'CARTOTECA_READ_BUDGET_VERSION': '1'}
SERVER_START = r'''
const production=process.env.STAND_PRODUCTION==='1';
if(production){
  const check=new(require('node:sqlite').DatabaseSync)(p+'/platform.sqlite',{readOnly:true});
  const populated=Boolean(check.prepare('SELECT 1 FROM accounts LIMIT 1').get());check.close();
  if(!populated){
    const account=require('/app/platform-store.cjs').createPlatformStore(p,{notificationSchema:schema});
    try{account.importLegacyOwner({email:'owner@release-stand.invalid',displayName:'Synthetic owner',
      organizationName:'Synthetic stand',salt:'a'.repeat(32),passwordHash:'b'.repeat(128)});}finally{account.close();}
  }
}
const options={dataDir:'/data',notificationSchema:schema,releaseGate:process.env.CARTOTECA_RELEASE_GATE==='1',
  production,origin:'https://127.0.0.1',sendMail:null,telegramBot:null,supportBot:null,
  telegramAutostart:false,supportAutostart:false,maxAutostart:false,
  adminEmailAutostart:false,bookingPublicationAutostart:false,...(production?{pushAutostart:false}:{})};
const resolved=require('/app/src/server/config.cjs').configuration(options);
const server=require('/app/multi-server.cjs').createMultiServer(options);
if(production)require('fs').writeFileSync('/tmp/stand-runtime-proof.json',JSON.stringify({
  production:resolved.production,schema,releaseGate:resolved.releaseGate,
  sharedCabinetWrites:resolved.sharedCabinetWrites,isolatedReadBudgets:resolved.isolatedReadBudgets,
  readBudgetVersion:resolved.readBudgetVersion}));
server.listen(4173,'0.0.0.0');
'''

SEED = r'''
const {DatabaseSync}=require('node:sqlite'),path=require('node:path');
const store=require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
const d=new DatabaseSync('/data/platform/platform.sqlite');
let budget;
try{
  const record=store.registration(d);
  const target=record?.mode==='isolated'?(budget=new DatabaseSync('/data/platform/'+store.filename)):d;
  const now=Date.now(),put=target.prepare('INSERT OR REPLACE INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)');
  put.run('booking-budget:read-address:stand-synthetic',239,now,now+3600000);
  put.run('booking-budget:site-read:stand-synthetic',19999,now,now+3600000);
  d.prepare('INSERT OR REPLACE INTO login_limits(key,failures,window_started,blocked_until) VALUES(?,?,?,?)')
    .run('stand-synthetic-login',2,now,now+3600000);
}finally{budget?.close();d.close();}
'''

PERSISTENT_STATE = r'''
const database=require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase('/data/platform',{
  notificationSchema:17,sharedCabinetWrites:process.env.CARTOTECA_SHARED_CABINET_WRITES==='1',
  isolatedReadBudgets:process.env.CARTOTECA_ISOLATED_READ_BUDGETS==='1'});
try{
  const {db}=database,now=Date.now();
  const owner=db.prepare("SELECT account_id,organization_id FROM memberships WHERE role='owner' LIMIT 1").get();
  if(!owner)throw Error('Synthetic production owner was not initialized');
  database.transaction(()=>{
    db.prepare('INSERT OR REPLACE INTO platform_sessions(token_hash,id,account_id,organization_id,value,expires_at) VALUES(?,?,?,?,?,?)')
      .run(database.tokenHash('stand-synthetic-session'),'stand-synthetic-session-id',owner.account_id,
        owner.organization_id,database.seal({createdAt:now,userAgent:'Synthetic stand'}),now+86400000);
    require('/app/src/server/modules/notifications/notification-store.cjs').createNotificationStore(database)
      .enqueue({org:owner.organization_id,patient:'stand-patient',appointment:'stand-appointment',
        stamp:'stand-stamp',recipient:'stand-recipient',channel:'telegram',expiresAt:now+86400000},now+3600000);
  });
}finally{database.closeWriter();database.db.close();}
'''

# A valid legacy component is readable by backup and the old OFF runtime. Only
# the newly restored copy fails when its migration inserts the active counters.
# This does not damage the original registration or bypass the real CLI/backup.
PREPARATION_FAILURE = r'''
const {DatabaseSync}=require('node:sqlite'),{randomUUID}=require('node:crypto');
const store=require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
const d=new DatabaseSync('/data/platform/platform.sqlite');
let b;
try{
  if(store.registration(d))throw Error('Synthetic failure setup requires fresh legacy data');
  b=new DatabaseSync('/data/platform/'+store.filename);
  b.exec(store.schema);d.exec(store.registrationTable);
  const id=randomUUID();b.prepare('INSERT INTO budget_meta VALUES(1,?,NULL)').run(id);
  d.prepare("INSERT INTO booking_read_budget_store VALUES(1,1,?,'legacy')").run(id);
  b.exec("CREATE TRIGGER stand_preparation_failure BEFORE INSERT ON login_limits BEGIN SELECT RAISE(ABORT,'synthetic preparation failure'); END");
  store.assertMode(d,'/data/platform',false);
}finally{b?.close();d.close();}
'''

OBSERVE = r'''
const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),crypto=require('node:crypto');
const store=require('/app/src/server/infrastructure/booking-read-budget-store.cjs');
const d=new DatabaseSync('/data/platform/platform.sqlite',{readOnly:true});let b;
try{
  const registration=store.registration(d),isolated=registration?.mode==='isolated';
  store.assertMode(d,'/data/platform',isolated);
  if(registration)b=new DatabaseSync('/data/platform/'+store.filename,{readOnly:true});
  const query='SELECT key,failures,window_started,blocked_until FROM login_limits WHERE '+store.readWhere+' ORDER BY key';
  const fingerprint=(table)=>{const rows=d.prepare('SELECT * FROM '+table+' ORDER BY 1').all();
    return {count:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')};};
  const result={schema:d.prepare('PRAGMA user_version').get().user_version,registration,
    componentVersion:b?b.prepare('PRAGMA user_version').get().user_version:null,
    counters:(isolated?b:d).prepare(query).all(),legacyCounters:d.prepare(query).all(),
    login:d.prepare("SELECT key,failures,window_started,blocked_until FROM login_limits WHERE key='stand-synthetic-login'").get(),
    incomplete:fs.existsSync('/data/.restore-in-progress'),
    integrity:d.prepare('PRAGMA integrity_check').get().integrity_check,
    budgetIntegrity:b?b.prepare('PRAGMA integrity_check').get().integrity_check:null,
    persistent:{sessions:fingerprint('platform_sessions'),notifications:fingerprint('notification_channel_jobs')}};
  console.log(JSON.stringify(result));
}finally{b?.close();d.close();}
'''


def seed(command, preparation_failure=False):
    command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', SEED)
    command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', PERSISTENT_STATE)
    if preparation_failure:
        command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', PREPARATION_FAILURE)
    return json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', OBSERVE))


def observe(command, stand, *, offline=False, directory=None):
    if not offline:
        return json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', OBSERVE))
    directory = directory or stand.root/'data'
    assert directory.parent == stand.root and not directory.is_symlink()
    return json.loads(command('docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount',
        # SQLite may create WAL/SHM sidecars for a stopped WAL database. SQL
        # connections in OBSERVE stay readOnly; no immutable live-WAL shortcut.
        'type=bind,source='+str(directory)+',target=/data',
        '--entrypoint', 'node', stand.new, '-e', OBSERVE))


def assert_state(before, after, enabled):
    assert after['schema'] == 17 and after['incomplete'] is False
    assert after['integrity'] == 'ok' and after['budgetIntegrity'] in (None, 'ok')
    assert len(before['counters']) == 2 and after['counters'] == before['counters']
    assert after['login'] == before['login'], 'Non-booking authentication counter changed'
    assert all(row['count'] > 0 for row in before['persistent'].values())
    assert after['persistent'] == before['persistent'], 'Session/notification state changed'
    if enabled:
        assert after['registration']['mode'] == 'isolated'
        assert after['registration']['version'] == after['componentVersion'] == 1
        assert after['legacyCounters'] == [], 'Independent legacy budget remained active'
    else:
        assert after == before, 'Failed activation changed the original counter/store state'


def verify(command, stand, directory, run, before, failure, migration, current):
    enabled = failure in (None, 'activation')
    after = observe(command, stand, offline=failure == 'activation')
    expected = before
    if failure == 'activation':
        expected = {**before, 'counters': [{**row, 'failures': row['failures']+1}
            if row['key'] == 'booking-budget:read-address:stand-synthetic' else row
            for row in before['counters']]}
    assert_state(expected, after, enabled)
    env = dict(item.split('=', 1) for item in current['Config']['Env'] if '=' in item)
    assert env.get('STAND_PRODUCTION') == '1'
    if enabled:
        assert all(env.get(key) == value for key, value in FLAGS.items())
        if before['registration'] and not migration:
            assert after['registration'] == before['registration'], 'Ordinary release changed store identity'
    else:
        assert all(env.get(key, '0') == '0' for key in FLAGS)
    if failure != 'activation':
        proof = json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e',
            "console.log(require('fs').readFileSync('/tmp/stand-runtime-proof.json','utf8'))"))
        assert proof == dict(production=True, schema=17, releaseGate=False,
            sharedCabinetWrites=enabled, isolatedReadBudgets=enabled, readBudgetVersion=1 if enabled else 0)
    if migration and failure in (None, 'activation'):
        gated = json.loads((directory/'public-checks-gated.json').read_text())
        assert gated['passed'] and gated['gated'] and gated['readBudgetVersion'] == 1
    if not failure:
        public = json.loads((directory/'public-checks.json').read_text())
        assert public['passed'] and public['readBudgetVersion'] == 1
    if failure == 'migration':
        partial = stand.root/('read-budget-'+run)/'data/.restore-in-progress'
        assert partial.read_text() == 'booking-read-budget-preparation-v1'
    if failure == 'activation':
        assert not current['State']['Running'], 'Failed active runtime must be stopped, not rolled back'
        retained = stand.root/('data-before-'+run)
        assert retained.is_dir()
        assert_state(before, observe(command, stand, offline=True, directory=retained), False)
    return dict(production=True, activeCountersPreserved=True, loginCounterPreserved=True,
        sessionNotificationStatePreserved=True,
        schema=17, readBudgetVersion=1 if enabled else 0, isolated=enabled,
        incompleteCopyBlocked=failure == 'migration', retainedLatestData=failure == 'activation')
