"""Ordinary gated publication on synthetic schema17/component1 data only."""
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location('gate_links', Path(__file__).with_name('release-stand-booking-links.py'))
links = importlib.util.module_from_spec(spec); spec.loader.exec_module(links)

POST_COMMIT = r'''
if(process.env.STAND_PUBLICATION==='1'){
 const database=require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase('/data/platform',{
   notificationSchema:17,sharedCabinetWrites:true,isolatedReadBudgets:true});
 try{database.transaction(()=>{
   const owner=database.db.prepare("SELECT account_id,organization_id FROM memberships WHERE role='owner' LIMIT 1").get();
   const row=database.db.prepare('SELECT value FROM organizations WHERE id=?').get(owner.organization_id);
   const profile=database.open(row.value),previous=profile.personalEvents||{version:1,revision:0,events:[]};
   profile.personalEvents={version:1,revision:previous.revision+1,events:[...previous.events,{
     id:'22222222-2222-4222-8222-222222222222',staffId:owner.account_id,date:'2090-01-02',
     time:'10:00',duration:30,notes:'Synthetic post-commit personal reservation'}]};
   database.db.prepare('UPDATE organizations SET value=? WHERE id=?').run(database.seal(profile),owner.organization_id);
 });}finally{database.closeWriter();database.db.close();}
}
'''

OBSERVE = r'''
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto'),fs=require('node:fs');
const d=new DatabaseSync('/data/platform/platform.sqlite',{readOnly:true});
try{
 const row=d.prepare('SELECT value FROM organizations ORDER BY id LIMIT 1').get(),value=Buffer.from(row.value);
 const decipher=crypto.createDecipheriv('aes-256-gcm',fs.readFileSync('/data/platform/platform.key'),value.subarray(0,12));
 decipher.setAuthTag(value.subarray(12,28));
 const profile=JSON.parse(Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8'));
 console.log(JSON.stringify({schema:d.prepare('PRAGMA user_version').get().user_version,
   personal:profile.personalEvents||{version:1,revision:0,events:[]},integrity:d.prepare('PRAGMA integrity_check').get().integrity_check}));
}finally{d.close();}
'''

BUSINESS_SETUP = r'''
const p=require('/app/platform-store.cjs').createPlatformStore('/data/platform',{
 notificationSchema:17,sharedCabinetWrites:true,isolatedReadBudgets:true});let storage;
try{
 const token='stand-synthetic-session',actor=p.session(token);
 if(!actor)throw Error('Synthetic session unavailable');
 const directory=p.organization(actor.organizationId).legacyData?'/data':'/data/tenants/'+actor.organizationId;
 storage=require('/app/storage.cjs').createStorage(directory,{sharedCabinetWrites:true});
 const state=storage.read();if(state.patients.length)throw Error('Synthetic business fixture must be empty');
 storage.write({...state,services:[{id:'stand-service',name:'Synthetic stand service',duration:'30',price:100}],patients:[]});
 const workspace=p.workspaceSettings(actor.organizationId);
 p.saveWorkspace(actor.organizationId,actor.accountId,{...workspace,
   rooms:workspace.rooms.map(room=>({...room,preventOverlap:false})),
   staffRules:[{staffId:actor.accountId,preventOverlap:false}]},()=>storage.read());
 const date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
 const schedule=p.workSchedules.view(token,actor.accountId,date,date);
 p.workSchedules.save(token,{staffId:actor.accountId,dates:[date],status:'working',
   intervals:[['09:00','12:00']],revision:schedule.revision,expectedTimeZone:'Europe/Moscow'},storage);
 const settings=p.onlineBooking.view(token);
 p.onlineBooking.save(token,{revision:settings.revision,mode:'any',minimumLeadMinutes:0,
   reservationMinutes:30,staff:{},services:{}},new Set(['stand-service']));
 const publication=p.bookingPublication.view(token);
 if(!p.bookingPublication.save(token,{revision:publication.revision,enabled:true}).enabled)
   throw Error('Synthetic publication not enabled');
 console.log(JSON.stringify({organizationId:actor.organizationId,staffId:actor.accountId,date}));
}finally{storage?.close();p.close();}
'''

BUSINESS_API = r'''
(async()=>{
 const assert=require('node:assert/strict'),input=JSON.parse(require('fs').readFileSync(0,'utf8'));
 const call=(path,method='GET',body)=>new Promise((resolve,reject)=>{
   const request=require('node:http').request('http://127.0.0.1:4173'+path,{method,headers:{
     Host:'127.0.0.1',Origin:'https://127.0.0.1','X-Cartoteca-Request':'1','Content-Type':'application/json',
     Cookie:'cartoteca_v2_session=stand-synthetic-session',
     'X-Cartoteca-Account-Id':input.staffId,'X-Cartoteca-Organization-Id':input.organizationId}},response=>{
       const chunks=[];let bytes=0;
       response.on('data',chunk=>{
         bytes+=chunk.length;
         if(bytes>1024*1024)request.destroy(Error('Synthetic response exceeded limit'));
         else chunks.push(chunk);
       });
       response.on('error',reject);
       response.on('end',()=>{
         try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}
         catch(error){reject(error);}
       });
     });
   request.setTimeout(15000,()=>request.destroy(Error('Synthetic API request timeout')));
   request.on('error',reject);
   request.end(body===undefined?undefined:JSON.stringify(body));
 });
 const before=await call('/api/cabinet');assert.equal(before.status,200,'cabinet-before');
 const event={id:'33333333-3333-4333-8333-333333333333',staffId:input.staffId,date:input.date,
   time:'10:00',duration:30,notes:'Synthetic real API reservation'};
 const created=await call('/api/calendar/personal-event','POST',{revision:before.data.personalRevision,event});
 assert.equal(created.status,200,'personal-create');
 const current=await call('/api/cabinet');assert.equal(current.status,200,'cabinet-current');
 assert.ok(current.data.personalEvents.some(item=>item.id===event.id));
 const payload={revision:current.data.revision,services:current.data.services,patients:[{
   id:'stand-patient-blocked',name:'Synthetic blocked patient',createdBy:input.staffId,visits:[],
   appointments:[{id:'stand-appointment-blocked',date:input.date,time:'10:00',duration:30,
     staffId:input.staffId,roomId:'main',service:'Synthetic stand service'}]}]};
 assert.equal((await call('/api/cabinet','PUT',payload)).status,409);
 const publicResult=await call('/api/public-booking/availability?organization='+input.organizationId,'POST',{
   date:input.date,serviceIds:['stand-service'],staffId:input.staffId});
 assert.equal(publicResult.status,200,'public-preview: '+publicResult.data.error);
 assert.ok(publicResult.data.slots.some(slot=>slot.time==='09:30'));
 assert.ok(publicResult.data.slots.some(slot=>slot.time==='10:30'));
 assert.ok(!publicResult.data.slots.some(slot=>['09:45','10:00','10:15'].includes(slot.time)));
 const final=await call('/api/cabinet');assert.equal(final.data.patients.length,0);
 console.log(JSON.stringify({personalCreated:true,manualOverlapBlocked:true,publicOverlapBlocked:true,
   neighboringTimeAvailable:true,noPatientOrAppointmentCreated:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
'''


def prepare_baseline(command, stand):
    """One offline synthetic fixture setup; not part of the ordinary release."""
    links.prepare_baseline(command, stand)
    stand.reset(17, key_file=True, production=True, read_budget_enabled=True)
    stand.compose('stop', '-t', '10', 'app')
    stage = stand.root/('gate-baseline-'+os.urandom(6).hex())
    stage.mkdir(mode=0o700); os.chown(stage, 1000, 1000)
    result = json.loads(command('docker', 'run', '--rm', '--network', 'none',
        '--mount', 'type=bind,source='+str(stand.root/'data')+',target=/data',
        '--mount', 'type=bind,source='+str(stage)+',target=/prepared',
        '--mount', 'type=bind,source='+str(stand.root/'backups')+',target=/backups',
        '--mount', 'type=bind,source='+str(stand.root/'keys/backup.key')+',target=/secrets/backup.key,readonly',
        '--entrypoint', 'node', stand.new, 'scripts/prepare-booking-public-links.cjs',
        '--source', '/data', '--destination', '/prepared/data', '--backups', '/backups',
        '--key', '/secrets/backup.key', '--offline', timeout=300))
    assert result['sourceUnchanged'] and (stage/'data').is_dir()
    data = stand.root/'data'
    assert data.is_dir() and not data.is_symlink() and data.parent == stand.root
    data.rename(stand.root/('fixture-retained-'+os.urandom(6).hex()))
    (stage/'data').rename(data)


def observe(command, stand, *, offline=False):
    if not offline:
        return json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', OBSERVE))
    data = stand.root/'data'
    assert data.parent == stand.root and not data.is_symlink()
    return json.loads(command('docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--mount',
        'type=bind,source='+str(data)+',target=/data', '--entrypoint', 'node', stand.new, '-e', OBSERVE))


def seed(command, stand):
    return dict(links=links.seed(command, stand, ordinary=True), personal=observe(command, stand))


def inject_gated_http_check(directory):
    """Extend only the copied synthetic worker, with one real blocked POST."""
    with (directory/'checks.py').open('a', encoding='utf-8') as stream:
        stream.write('''
_stand_original_public_checks = public_checks
def public_checks(ops):
    result = _stand_original_public_checks(ops)
    if ops.config.get('publicationGate') and ops.publication.gated():
        import urllib.request, urllib.error
        from agent import atomic
        req = urllib.request.Request(ops.config['origin']+'/api/calendar/personal-event',
            data=b'{}', method='POST', headers={'Origin':ops.config['origin'],
                'Content-Type':'application/json','X-Cartoteca-Request':'1',
                'Cookie':'cartoteca_v2_session=stand-synthetic-session'})
        try:
            status = urllib.request.urlopen(req, timeout=15).status
        except urllib.error.HTTPError as error:
            status = error.code
        if status != 503: raise RuntimeError('STAND_PERSONAL_GATE_OPEN')
        atomic(ops.directory/'personal-gated-http.json', {'personalWriteBlocked':True,'status':status})
    return result
''')


def verify_business_api(command):
    input_value = json.loads(command('docker', 'exec', 'cartoteca-ci-stand-app', 'node', '-e', BUSINESS_SETUP))
    result = json.loads(command('docker', 'exec', '-i', 'cartoteca-ci-stand-app', 'node', '-e', BUSINESS_API,
        stdin=json.dumps(input_value).encode(), timeout=90))
    assert result == dict(personalCreated=True, manualOverlapBlocked=True, publicOverlapBlocked=True,
        neighboringTimeAvailable=True, noPatientOrAppointmentCreated=True)
    return result


def assert_personal(before, after, latest=False):
    assert after['schema'] == before['schema'] == 17 and after['integrity'] == 'ok'
    if not latest:
        assert after == before, 'Ordinary code switch changed personal reservations'
        return
    assert after['personal']['version'] == 1
    assert after['personal']['revision'] == before['personal']['revision']+1
    assert len(after['personal']['events']) == len(before['personal']['events'])+1
    assert after['personal']['events'][:-1] == before['personal']['events']
    event = after['personal']['events'][-1]
    assert event['id'] == '22222222-2222-4222-8222-222222222222'
    assert event['duration'] == 30 and event['time'] == '10:00'


def verify(command, stand, directory, run, before, failure, current):
    latest = failure == 'activation'
    after = observe(command, stand, offline=latest)
    assert_personal(before['personal'], after, latest)
    links_after = links.observe(command, stand, offline=latest)
    links.assert_state(before['links']['links'], links_after, True, latest=latest)
    expected_budget = before['links']['budget']
    if latest:
        expected_budget = {**expected_budget, 'counters': [{**row, 'failures': row['failures']+1}
            if row['key'] == 'booking-budget:read-address:stand-synthetic' else row
            for row in expected_budget['counters']]}
    budget_after = links.budget.observe(command, stand, offline=latest)
    links.budget.assert_state(expected_budget, budget_after, True)
    assert budget_after['registration'] == before['links']['budget']['registration']
    env = dict(item.split('=', 1) for item in current['Config']['Env'] if '=' in item)
    assert all(env.get(key) == value for key, value in links.budget.FLAGS.items())
    assert env.get('CARTOTECA_MAX_SCHEMA') == '17'
    assert not (stand.root/('data-before-'+run)).exists(), 'Ordinary release cloned/restored working data'
    assert not (directory/'migration-state.json').exists(), 'Unexpected SQL/component migration'
    state = json.loads((directory/'state.json').read_text())
    if failure != 'startup':
        record = json.loads((directory/'publication-state.json').read_text())
        assert state['activationCommitted'] is True and record['committed'] is True
        gated = json.loads((directory/'public-checks-gated.json').read_text())
        assert gated['passed'] and gated['gated']
        assert gated['readBudgetVersion'] == gated['bookingLinksVersion'] == 1
        assert json.loads((directory/'personal-gated-http.json').read_text()) == {
            'personalWriteBlocked': True, 'status': 503}
    if latest:
        assert not current['State']['Running'], 'Activation failure left a writer running'
        assert current['Image'] != stand.old, 'Unsafe old image resumed after activation commitment'
    elif not failure:
        public = json.loads((directory/'public-checks.json').read_text())
        assert public['passed'] and public['gated'] is False
        assert public['readBudgetVersion'] == public['bookingLinksVersion'] == 1
        assert env.get('CARTOTECA_RELEASE_GATE') != '1'
    else:
        assert state.get('activationCommitted') is not True
        assert current['Image'] == stand.old
    return dict(schema=17, readBudgetVersion=1, bookingLinksVersion=1,
        personalReservationsPreserved=True, noSqlMigration=True, noDataRollback=True,
        retainedLatestData=latest, gatedBeforeActivation=failure != 'startup')
