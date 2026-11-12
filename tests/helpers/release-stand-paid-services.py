"""Real candidate-image, platform-only schema17→19 deployment scenarios on the disposable stand."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import time
import urllib.request

OBSERVE = r"""
const {DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');
const inventory=require('/app/src/server/infrastructure/backup/organization-inventory.cjs');
const d=new DatabaseSync('/data/platform/platform.sqlite',{readOnly:true});
try{
 const tables=['accounts','organizations','memberships','platform_sessions','invitations','booking_public_links'];
 const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
 const records=Object.fromEntries(tables.map(name=>[name,digest(d.prepare('SELECT * FROM '+name+' ORDER BY 1').all())]));
 const registration=require('/app/src/server/infrastructure/booking-read-budget-store.cjs').assertMode(d,'/data/platform',true);
 const component=require('/app/src/server/infrastructure/booking-public-links-schema.cjs').validate(d);
 const version=d.prepare('PRAGMA user_version').get().user_version;
 if(version===19)require('/app/src/server/modules/billing/prepared-schema.cjs').validatePaidSchema(d);
 console.log(JSON.stringify({schema:version,records,registration,component,
   marker:d.prepare('SELECT value FROM stand_marker ORDER BY value').all(),
   files:inventory.dataInventory('/data').filter(row=>row.name!=='platform/platform.sqlite'),
   integrity:d.prepare('PRAGMA integrity_check').get().integrity_check}));
}finally{d.close();}
"""
MARKER = "const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite');d.exec(\"CREATE TABLE IF NOT EXISTS stand_marker(value TEXT);INSERT INTO stand_marker SELECT 'synthetic-persistent-value' WHERE NOT EXISTS(SELECT 1 FROM stand_marker)\");d.close()"


def current(command, stand, offline=False):
    args = ['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges:true','--mount',
            'type=bind,source='+str(stand.root/'data')+',target=/data','--entrypoint','node',stand.new]
    if offline: return json.loads(command(*args,'-e',OBSERVE))
    return json.loads(command('docker','exec','cartoteca-ci-stand-app','node','-e',OBSERVE))


def normal_entrypoint(command, stand, schema, ordinary=False):
    stand.compose('stop','-t','10','app')
    base = json.loads((stand.root/'compose.yaml').read_text())
    base['services']['app']['command'] = ['node','multi-server.cjs']
    (stand.root/'compose.yaml').write_text(json.dumps(base))
    override = json.loads((stand.root/'production.override.yaml').read_text())
    app = override['services']['app']
    if not ordinary: app['image'] = 'cartoteca-ci:previous'
    app['environment'] = dict(app.get('environment',{}), CARTOTECA_MAX_SCHEMA=str(schema),
        CARTOTECA_SHARED_CABINET_WRITES='1', CARTOTECA_ISOLATED_READ_BUDGETS='1',
        CARTOTECA_READ_BUDGET_VERSION='1', CARTOTECA_PUSH_ENABLED='1',
        CARTOTECA_ASSISTANT_APPOINTMENT_SAVING='1', CARTOTECA_PAYMENT_NETWORK_ENABLED='0',
        APP_ORIGIN='https://127.0.0.1')
    (stand.root/'production.override.yaml').write_text(json.dumps(override))
    stand.compose('up','-d','--force-recreate','app')
    for _ in range(100):
        try:
            if urllib.request.urlopen('https://127.0.0.1/login.html',timeout=5).status==200: return stand.observed()['Image']
        except Exception: pass
        time.sleep(.25)
    raise RuntimeError('Paid stand baseline failed to start')


def inject(directory, failure):
    # Faults affect only the disposable copied worker after its real image/DDL checks.
    if failure == 'migration':
        with (directory/'operations.py').open('a') as stream:
            stream.write(r"""
_paid_command = Operations.command
def _paid_occupied(self,args,**kwargs):
 if 'scripts/prepare-paid-services-upgrade.cjs' in args:
  destination=self.migration.stage/'data';destination.mkdir(mode=0o700);os.chown(destination,1000,1000)
 return _paid_command(self,args,**kwargs)
Operations.command=_paid_occupied
""")
    if failure == 'startup':
        with (directory/'operations.py').open('a') as stream:
            stream.write(r"""
_paid_ready = Operations.wait_ready
def _paid_gated_failure(self,*args,**kwargs):
 result=_paid_ready(self,*args,**kwargs)
 if self.config.get('migration')=='paid-services-17-to-19' and self.migration.gated():
  raise RuntimeError('SYNTHETIC_GATED_READINESS_FAILURE')
 return result
Operations.wait_ready=_paid_gated_failure
""")
    if failure == 'activation':
        with (directory/'paid_services.py').open('a') as stream:
            stream.write(r"""
_paid_activate=PaidServicesMigration.activate
def _paid_committed_failure(self):
 _paid_activate(self)
 code="const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite');d.exec(\"INSERT INTO stand_marker VALUES('synthetic-post-commit-value')\");d.close()"
 self.ops.command(['docker','exec',self.ops.config['container'],'node','-e',code])
 raise RuntimeError('SYNTHETIC_POST_COMMIT_FAILURE')
PaidServicesMigration.activate=_paid_committed_failure
""")


def scenario(fixture, stand, name, failure=None, ordinary=False):
    command, digest = fixture.command, fixture.digest
    print('STAND_SCENARIO '+name,flush=True)
    started=time.monotonic()
    if not ordinary:
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command,stand)
        stand.reset(17,key_file=True,production=True,read_budget_enabled=True)
        fixture.booking_links.seed(command,stand,ordinary=True)
        command('docker','exec','cartoteca-ci-stand-app','node','-e',MARKER)
    previous_image=normal_entrypoint(command,stand,19 if ordinary else 17,ordinary=ordinary)
    if not ordinary: assert previous_image==stand.old, 'Fresh paid stand baseline image changed'
    before=current(command,stand)
    run='r-'+os.urandom(6).hex()+'-'+os.urandom(6).hex()
    directory=stand.releases/run;directory.mkdir()
    names=['agent.py','operations.py','checks.py','migration.py','paid_services.py','read_budget.py',
           'booking_links.py','publication_gate.py','probe.cjs','image-check.cjs']
    sources=[stand.source/'scripts/release'/('image-check.cjs' if name=='image-check.cjs' else 'remote/'+name) for name in names]
    command('scp',*stand.ssh_args,'-P','22222',*[str(file) for file in sources],str(stand.archive),
            'root@127.0.0.1:'+str(directory)+'/',timeout=300)
    inject(directory,failure)
    runtime=json.loads(command('node','-e',"const f=require('./scripts/release/files.cjs');console.log(JSON.stringify(require('./scripts/release/deployment-plan.cjs').runtimeFiles({source:'.',data:{files:f.manifest('.')}})))",timeout=30))
    config=dict(root=str(stand.root),releaseRoot=str(stand.releases),container='cartoteca-ci-stand-app',
        project='cartoteca-ci-stand',backupTimer=stand.timer,origin='https://127.0.0.1',schema=19,
        expectedImage=previous_image,readBudgetVersion=1,bookingLinksVersion=1,assistantSavingVersion=1,paymentNetworkEnabled=False)
    config.update(dict(publicationGate=True) if ordinary else dict(migration='paid-services-17-to-19'))
    request=dict(version=1,run=run,files={name:digest(directory/name) for name in names},imageId=stand.new,
        imageHash=stand.image_hash,imageBytes=stand.archive.stat().st_size,runtime=runtime,config=config)
    file=directory/'request.json';file.write_text(json.dumps(request));request_hash=digest(file)
    args=['python3',str(directory/'agent.py'),'launch',str(file),request_hash]
    ssh=['ssh',*stand.ssh_args,'-p','22222','root@127.0.0.1']
    client=subprocess.Popen(ssh+[shlex.join(args)+'; sleep 60'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    killed=False
    try:
        deadline=time.monotonic()+400
        while time.monotonic()<deadline:
            state_file=directory/'state.json'
            if client.poll() is not None and not state_file.exists():
                raise RuntimeError('Paid stand launch failed')
            if state_file.exists():
                state=json.loads(state_file.read_text())
                active=command('systemctl','show',state['unit'],'-p','ActiveState','--value') in ['active','activating','deactivating']
                if active and not killed:
                    if not failure: assert json.loads(command(*ssh,shlex.join(args)))['unit']==state['unit']
                    client.terminate();client.wait(timeout=10);killed=True
                if state['status'] in ['completed','rolled_back','failed_before_switch','needs_attention','published_backup_pending'] and not active: break
            time.sleep(.15)
        else: raise RuntimeError('Paid stand deployment timed out')
        expected='needs_attention' if failure=='activation' else 'rolled_back' if failure else 'completed'
        assert state['status']==expected,(name,state)
        observed=stand.observed()
        after=current(command,stand,offline=failure=='activation')
        assert after['integrity']=='ok' and after['schema']==(17 if failure in ['startup','migration'] else 19)
        for key in ['records','registration','component','files']:
            assert after[key]==before[key], 'Paid stand lost preserved '+key
        assert all(row in after['marker'] for row in before['marker'])
        if failure=='activation':
            assert state['migrationCommitted'] and not observed['State']['Running']
            assert {'value':'synthetic-post-commit-value'} in after['marker']
        elif not failure:
            assert observed['State']['Running'] and observed['Image']==stand.new
            public=json.loads((directory/'public-checks.json').read_text())
            assert public['paidServices']['paymentNetworkEnabled'] is False
            assert json.loads((directory/'public-checks-gated.json').read_text())['gated']
            backup=json.loads((stand.root/'status/status.json').read_text())
            assert backup['lastDrillAt'] and backup['lastLocalAt']
            assert killed
        else: assert observed['State']['Running'] and observed['Image']==stand.old
        env=dict(value.split('=',1) for value in observed['Config']['Env'] if '=' in value)
        assert env.get('CARTOTECA_PAYMENT_NETWORK_ENABLED')=='0'
        assert env.get('CARTOTECA_CABINET_SCHEMA','0')=='0'
        assert env.get('CARTOTECA_SCHEDULED_NOTIFICATIONS','0')=='0'
        timings=[json.loads(row) for row in (directory/'timings.jsonl').read_text().splitlines()]
        result=dict(scenario=name,passed=True,schema=after['schema'],status=state['status'],disconnected=killed,
            durationMs=round((time.monotonic()-started)*1000),stages=timings,paidServices=dict(
                sourceSchema=before['schema'],paymentNetworkEnabled=False,platformOnly=True,componentsPreserved=True))
        stand.results.append(result);print(json.dumps(result),flush=True)
    except Exception:
        if (directory/'state.json').exists(): print('PAID_STAND_STATE '+(directory/'state.json').read_text(),flush=True)
        raise
    finally:
        if client.poll() is None: client.terminate();client.wait(timeout=10)
