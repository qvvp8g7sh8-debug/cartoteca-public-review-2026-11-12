"""Run explicitly on a disposable Linux VM; never discovered by npm test."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('release-stand-fixture.py'))
fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
command, digest = fixture.command, fixture.digest


def scenario(stand, name, schema=11, failure=None, migration=False, key_file=None, read_budget=False, booking_links=False, publication_gate=False):
    started = time.monotonic()
    print('STAND_SCENARIO '+name,flush=True)
    read_budget = read_budget or migration == 'read-budget'
    booking_links = booking_links or migration == 'booking-links'
    target_schema = schema if read_budget or booking_links or not migration else schema+1
    if booking_links and migration:
        fixture.booking_links.prepare_baseline(command, stand)
    stand.reset(schema, key_file=bool(migration) if key_file is None else key_file,
        production=read_budget or booking_links or publication_gate,
        read_budget_enabled=publication_gate or booking_links or read_budget and not migration,
        publication_gate=publication_gate)
    budget_before = fixture.read_budget.seed(command, failure == 'migration') if read_budget else None
    links_before = fixture.booking_links.seed(command, stand, ordinary=not migration) if booking_links else None
    gate_before = fixture.publication_gate.seed(command, stand) if publication_gate else None
    old = stand.observed()
    marker = "const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite');d.exec(\"CREATE TABLE IF NOT EXISTS stand_marker(value TEXT); INSERT INTO stand_marker SELECT 'synthetic-persistent-value' WHERE NOT EXISTS(SELECT 1 FROM stand_marker)\");console.log(JSON.stringify(d.prepare('SELECT value FROM stand_marker').all()));d.close()"
    command('docker','exec','cartoteca-ci-stand-app','node','-e',marker)
    read_marker = "const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite',{readOnly:true});console.log(JSON.stringify([d.prepare('SELECT value FROM stand_marker').all(),d.prepare('PRAGMA user_version').get()]));d.close()"
    before = command('docker','exec','cartoteca-ci-stand-app','node','-e',read_marker)
    run = 'r-' + os.urandom(6).hex() + '-' + os.urandom(6).hex()
    directory = stand.releases/run
    directory.mkdir()
    names = ['agent.py','operations.py','checks.py','migration.py','read_budget.py','booking_links.py','publication_gate.py','probe.cjs','image-check.cjs']
    sources = [stand.source/'scripts/release'/('image-check.cjs' if n=='image-check.cjs' else 'remote/'+n) for n in names]
    # Real SCP into a real SSH server, with a pinned host key and a VM-only key.
    command('scp',*stand.ssh_args,'-P','22222',*[str(p) for p in sources],str(stand.archive),'root@127.0.0.1:'+str(directory)+'/',timeout=300)
    if publication_gate:
        fixture.publication_gate.inject_gated_http_check(directory)
    if booking_links and failure == 'migration':
        fixture.booking_links.inject_preparation_failure(directory)
    image = stand.activation if failure=='activation' else stand.broken if failure=='startup' else stand.new
    runtime = json.loads(command('node','-e',"const f=require('./scripts/release/files.cjs');console.log(JSON.stringify(require('./scripts/release/deployment-plan.cjs').runtimeFiles({source:'.',data:{files:f.manifest('.')}})))",timeout=30))
    request = {'version':1,'run':run,'files':{n:digest(directory/n) for n in names},'imageId':image,'imageHash':stand.image_hash,'imageBytes':stand.archive.stat().st_size,'runtime':runtime,'config':{'root':str(stand.root),'releaseRoot':str(stand.releases),'container':'cartoteca-ci-stand-app','project':'cartoteca-ci-stand','backupTimer':stand.timer,'origin':'https://127.0.0.1','schema':schema,'expectedImage':stand.old}}
    if migration:
        request['config'].update(schema=target_schema, migration='booking-links-17' if booking_links else 'read-budget-17' if read_budget else 'structural-17-to-18' if migration=='structural' else 'staff-push-16-to-17' if migration=='push' else 'staff-max-15-to-16')
    if read_budget or booking_links or publication_gate:
        request['config']['readBudgetVersion'] = 1
    if booking_links or publication_gate:
        request['config']['bookingLinksVersion'] = 1
    if publication_gate:
        request['config']['publicationGate'] = True
    if failure=='migration' and not read_budget and not booking_links:
        collision = 'notification_schedule' if migration=='structural' else 'staff_push_jobs' if migration=='push' else 'staff_max_stops'
        command('docker','exec','cartoteca-ci-stand-app','node','-e',"const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite');d.exec('CREATE TABLE "+collision+"(bad TEXT)');d.close()")
    if failure=='archive':
        request['imageHash']='0'*64
    if failure=='backup':
        (stand.root/'keys/backup.key').rename(stand.root/'keys/backup.saved')
    lock = None
    if failure=='lock':
        lock = open(stand.releases/'deployment.lock','a')
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    file = directory/'request.json'; file.write_text(json.dumps(request))
    request_hash = digest(file)
    args = ['python3',str(directory/'agent.py'),'launch',str(file),request_hash]
    ssh = ['ssh',*stand.ssh_args,'-p','22222','root@127.0.0.1']
    # Keep the client connected, then terminate it after the independent worker started.
    client = subprocess.Popen(ssh+[shlex.join(args)+'; sleep 60'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+300
        killed=False
        while time.monotonic()<deadline:
            state_file=directory/'state.json'
            if client.poll() is not None and not state_file.exists():
                raise RuntimeError('Stand launch failed: '+client.communicate()[1].decode()[-2000:])
            if state_file.exists():
                state=json.loads(state_file.read_text())
                active=command('systemctl','show',state['unit'],'-p','ActiveState','--value') in ['active','activating','deactivating']
                if active and not killed:
                    if not failure:
                        repeated=json.loads(command(*ssh,shlex.join(args)))
                        assert repeated['unit']==state['unit'], 'Duplicate executor started'
                    client.terminate(); client.wait(timeout=10); killed=True
                if state['status'] in ['completed','rolled_back','failed_before_switch','needs_attention','published_backup_pending'] and not active:
                    break
            time.sleep(.15)
        else:
            raise RuntimeError('Stand worker timeout: '+name)
        expected='needs_attention' if failure=='activation' else 'rolled_back' if failure in ['startup','migration'] else 'failed_before_switch' if failure else 'completed'
        assert state['status']==expected, (name,state)
        current=stand.observed()
        if failure=='activation':
            after=json.loads(command('docker','run','--rm','--network','none','--mount','type=bind,source='+str(stand.root/'data')+',target=/data','--entrypoint','node',stand.new,'-e',read_marker))
            assert after[1]['user_version']==target_schema and {'value':'synthetic-post-commit-value'} in after[0]
            assert state['activationCommitted' if publication_gate else 'migrationCommitted']
        else:
            assert current['State']['Running']
            assert current['Image']==(stand.old if failure else stand.new)
            after=json.loads(command('docker','exec','cartoteca-ci-stand-app','node','-e',read_marker))
            expected_data=json.loads(before)
            if migration and not failure:
                expected_data[1]['user_version']=target_schema
            assert after==expected_data
        if failure in ['archive','backup','lock']:
            assert current['Id']==old['Id'], 'Pre-switch refusal replaced the old container'
        assert command('systemctl','is-active',stand.timer)=='active'
        if migration:
            record=json.loads((directory/'migration-state.json').read_text())
            if not failure:
                assert record['committed']
                assert json.loads((directory/'public-checks-gated.json').read_text())['gated']
                assert not json.loads((directory/'public-checks.json').read_text())['gated']
            if failure=='activation':
                assert record['committed'] and (stand.root/('data-before-'+run)).is_dir()
        if not failure:
            assert killed, 'Disconnect scenario was not exercised'
            public=json.loads((directory/'public-checks.json').read_text())
            assert public['passed'] and public['actualImage']==stand.new
            backup=json.loads((stand.root/'status/status.json').read_text())
            assert backup['lastDrillAt'] and backup['lastLocalAt']
        timings=[json.loads(row) for row in (directory/'timings.jsonl').read_text().splitlines()] if (directory/'timings.jsonl').exists() else []
        result={'scenario':name,'passed':True,'schema':schema,'status':state['status'],'disconnected':killed,'durationMs':round((time.monotonic()-started)*1000),'stages':timings}
        if read_budget:
            result['readBudget'] = fixture.read_budget.verify(command, stand, directory, run,
                budget_before, failure, migration, current)
        if booking_links:
            result['bookingLinks'] = fixture.booking_links.verify(command, stand, directory, run,
                links_before, failure, migration, current)
        if publication_gate:
            result['publicationGate'] = fixture.publication_gate.verify(command, stand, directory, run,
                gate_before, failure, current)
            if name == 'publication-gate-without-migration':
                result['personalCalendarApi'] = fixture.publication_gate.verify_business_api(command)
        stand.results.append(result)
        print(json.dumps(result),flush=True)
    except Exception:
        if (directory/'state.json').exists():
            state=json.loads((directory/'state.json').read_text())
            print('STAND_STATE '+json.dumps(state),flush=True)
            if state.get('unit'):
                print(command('journalctl','-u',state['unit'],'--no-pager','-n','30'),flush=True)
        raise
    finally:
        if client.poll() is None:
            client.terminate(); client.wait(timeout=10)
        if lock:
            lock.close()
        saved=stand.root/'keys/backup.saved'
        if saved.exists():
            saved.rename(stand.root/'keys/backup.key')


def main():
    source, image, report = sys.argv[1:]
    candidate=json.loads((Path(source).resolve().parent/'candidate.json').read_text())
    identity={'sourceHash':candidate['sourceHash'],'candidate':candidate['id'],'imageId':command('docker','image','inspect',image,'--format','{{.Id}}')}
    Path(report).write_text(json.dumps({**identity,'passed':False,'scenarios':[],'stage':'setup'}))
    stand=fixture.Fixture(source,image)
    try:
        scenario(stand,'success-after-disconnect-and-duplicate-launch')
        scenario(stand,'damaged-archive',failure='archive')
        scenario(stand,'backup-failed-before-switch',failure='backup')
        scenario(stand,'concurrent-release-lock',failure='lock')
        scenario(stand,'startup-failure-rolls-back',failure='startup')
        scenario(stand,'schema-15-without-migration',schema=15)
        scenario(stand,'staff-max-15-to-16-after-disconnect',schema=15,migration=True)
        scenario(stand,'schema-16-without-migration',schema=16)
        stand.fresh_data()
        scenario(stand,'staff-max-preparation-failure-keeps-schema15',schema=15,failure='migration',migration=True)
        stand.fresh_data()
        scenario(stand,'staff-max-gated-startup-failure-returns-schema15',schema=15,failure='startup',migration=True)
        stand.fresh_data()
        scenario(stand,'staff-max-activation-failure-keeps-new-data',schema=15,failure='activation',migration=True)
        stand.fresh_data()
        scenario(stand,'staff-max-directory-key-15-to-16',schema=15,migration=True,key_file=False)
        stand.fresh_data()
        scenario(stand,'staff-push-16-to-17-after-disconnect',schema=16,migration='push')
        scenario(stand,'schema-17-without-migration',schema=17)
        stand.fresh_data()
        scenario(stand,'staff-push-preparation-failure-keeps-schema16',schema=16,failure='migration',migration='push')
        stand.fresh_data()
        scenario(stand,'staff-push-gated-startup-failure-returns-schema16',schema=16,failure='startup',migration='push')
        stand.fresh_data()
        scenario(stand,'staff-push-activation-failure-keeps-new-data',schema=16,failure='activation',migration='push')
        stand.fresh_data()
        scenario(stand,'staff-push-directory-key-16-to-17',schema=16,migration='push',key_file=False)
        stand.fresh_data()
        scenario(stand,'structural-17-to-18-after-disconnect',schema=17,migration='structural')
        scenario(stand,'schema-18-without-migration',schema=18)
        stand.fresh_data()
        scenario(stand,'structural-preparation-failure-keeps-schema17',schema=17,failure='migration',migration='structural')
        stand.fresh_data()
        scenario(stand,'structural-gated-startup-failure-returns-schema17',schema=17,failure='startup',migration='structural')
        stand.fresh_data()
        scenario(stand,'structural-activation-failure-keeps-new-data',schema=17,failure='activation',migration='structural')
        stand.fresh_data()
        scenario(stand,'read-budget-17-after-disconnect',schema=17,migration='read-budget')
        scenario(stand,'read-budget-17-without-migration',schema=17,read_budget=True)
        stand.fresh_data()
        scenario(stand,'read-budget-preparation-failure-keeps-schema17',schema=17,failure='migration',migration='read-budget')
        stand.fresh_data()
        scenario(stand,'read-budget-gated-startup-failure-returns-schema17',schema=17,failure='startup',migration='read-budget')
        stand.fresh_data()
        scenario(stand,'read-budget-activation-failure-keeps-new-data',schema=17,failure='activation',migration='read-budget')
        stand.fresh_data()
        scenario(stand,'booking-links-17-after-disconnect',schema=17,migration='booking-links')
        scenario(stand,'booking-links-17-without-migration',schema=17,booking_links=True)
        stand.fresh_data()
        scenario(stand,'booking-links-preparation-failure-keeps-schema17',schema=17,failure='migration',migration='booking-links')
        stand.fresh_data()
        scenario(stand,'booking-links-gated-startup-failure-returns-schema17',schema=17,failure='startup',migration='booking-links')
        stand.fresh_data()
        scenario(stand,'booking-links-activation-failure-keeps-new-data',schema=17,failure='activation',migration='booking-links')
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        scenario(stand,'publication-gate-after-disconnect',schema=17,publication_gate=True)
        scenario(stand,'publication-gate-without-migration',schema=17,publication_gate=True)
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        scenario(stand,'publication-gate-startup-failure-returns-current',schema=17,failure='startup',publication_gate=True)
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        scenario(stand,'publication-gate-activation-failure-keeps-current-data',schema=17,failure='activation',publication_gate=True)
        fixture.paid_services.scenario(fixture,stand,'paid-services-17-to-19-after-disconnect')
        fixture.paid_services.scenario(fixture,stand,'schema-19-without-migration',ordinary=True)
        fixture.paid_services.scenario(fixture,stand,'paid-services-preparation-failure-keeps-schema17',failure='migration')
        fixture.paid_services.scenario(fixture,stand,'paid-services-gated-startup-failure-returns-schema17',failure='startup')
        fixture.paid_services.scenario(fixture,stand,'paid-services-activation-failure-keeps-new-data',failure='activation')
    finally:
        Path(report).write_text(json.dumps({**identity,'passed':len(stand.results)==42,'scenarios':stand.results},indent=2))
        stand.close()


if __name__=='__main__':
    main()
