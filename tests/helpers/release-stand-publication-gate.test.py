"""Pure fixture checks; no Docker, SSH, listeners or real data."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE/filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


helper = load('publication_gate_stand', 'release-stand-publication-gate.py')
budget_tests = load('gate_budget_tests', 'release-stand-read-budget.test.py')
links_tests = load('gate_links_tests', 'release-stand-booking-links.test.py')


class StandPublicationGateTests(unittest.TestCase):
    setUp = budget_tests.StandReadBudgetTests.setUp
    js = budget_tests.StandReadBudgetTests.js
    prepare_budget = budget_tests.StandReadBudgetTests.prepare
    prepare = links_tests.StandBookingLinksTests.prepare

    def seed(self):
        links_tests.StandBookingLinksTests.seed(self)
        prepared = self.base/'links-prepared'
        self.prepare(prepared)
        self.data = prepared
        return json.loads(self.js(helper.OBSERVE).stdout)

    def test_exact_four_real_gate_cases_keep_all_previous_cases(self):
        tree = ast.parse((HERE/'release-stand.py').read_text(encoding='utf-8'))
        names = [n.args[1].value for n in ast.walk(tree) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name) and n.func.id == 'scenario']
        self.assertEqual(len(names), 37)
        self.assertEqual(len(set(names)), 37)
        self.assertEqual({name for name in names if name.startswith('publication-gate-')}, {
            'publication-gate-after-disconnect', 'publication-gate-without-migration',
            'publication-gate-startup-failure-returns-current',
            'publication-gate-activation-failure-keeps-current-data'})
        for name in ['release-stand-publication-gate.py', 'release-stand.py', 'release-stand-fixture.py']:
            ast.parse((HERE/name).read_text(encoding='utf-8'))

    def test_main_isolates_both_fault_baselines_after_business_api_without_erasing_previous_data(self):
        # Execute the actual orchestration with synthetic boundaries, never Docker/SSH.
        stand_main = load('publication_gate_main_isolation', 'release-stand.py')
        candidate = self.base/'candidate'
        source = candidate/'source'
        source.mkdir(parents=True)
        (candidate/'candidate.json').write_text(json.dumps({'id': 'synthetic', 'sourceHash': 'a'*64}))
        report = self.base/'orchestration-report.json'
        baseline = dict(schema=17, incomplete=False, integrity='ok', budgetIntegrity='ok',
            componentVersion=1, registration=dict(mode='isolated', version=1), legacyCounters=[],
            login=dict(key='stand-synthetic-login', failures=2),
            persistent=dict(sessions=dict(count=1, sha256='synthetic-sessions'),
                            notifications=dict(count=1, sha256='synthetic-notifications')),
            counters=[dict(key='booking-budget:read-address:stand-synthetic', failures=239),
                      dict(key='booking-budget:site-read:stand-synthetic', failures=19999)])
        events = []

        class Stand:
            def __init__(self):
                self.generation = 0
                self.prepared = None
                self.budget = None
                self.retained = []
                self.results = []
                self.closed = False

            def fresh_data(self):
                self.retained.append(copy.deepcopy(self.budget))
                self.generation += 1
                self.budget = None
                self.prepared = None

            def close(self):
                self.closed = True

        stand = Stand()

        def prepare_baseline(_command, current):
            current.budget = copy.deepcopy(baseline)
            current.prepared = current.generation
            events.append(('prepared', current.generation))

        def scenario(current, name, **options):
            if name == 'publication-gate-after-disconnect':
                self.assertEqual(current.prepared, current.generation)
                events.append((name, current.generation))
            elif name == 'publication-gate-without-migration':
                self.assertEqual(events[-1], ('publication-gate-after-disconnect', current.generation))
                current.budget['counters'].extend([
                    dict(key='booking-budget:read-address:real-http-synthetic', failures=1),
                    dict(key='booking-budget:site-read:real-http-synthetic', failures=1)])
                # Existing strict rollback assertions must still reject a polluted baseline.
                with self.assertRaises(AssertionError):
                    helper.links.budget.assert_state(current.budget, copy.deepcopy(current.budget), True)
                events.append((name, current.generation))
            elif name in ('publication-gate-startup-failure-returns-current',
                          'publication-gate-activation-failure-keeps-current-data'):
                previous_case = next(item for item in reversed(events) if item[0] != 'prepared')
                self.assertGreater(current.generation, previous_case[1], 'Fault reused prior API/fault data')
                self.assertEqual(events[-1], ('prepared', current.generation), 'Fault baseline was not prepared')
                self.assertEqual(current.prepared, current.generation)
                helper.links.budget.assert_state(baseline, current.budget, True)
                self.assertTrue(options['publication_gate'])
                self.assertEqual(options['failure'], 'startup' if 'startup' in name else 'activation')
                events.append((name, current.generation))
            current.results.append(dict(scenario=name, passed=True))

        image_id = 'sha256:'+'c'*64

        def inspect_image(*args):
            self.assertEqual(args, ('docker', 'image', 'inspect', 'synthetic-image', '--format', '{{.Id}}'))
            return image_id

        def paid_scenario(module, current, name, **options):
            self.assertIs(module, stand_main.fixture)
            self.assertIs(current, stand)
            return scenario(current, name, **options)

        with patch.object(stand_main.fixture, 'Fixture', return_value=stand), \
             patch.object(stand_main.fixture.publication_gate, 'prepare_baseline', side_effect=prepare_baseline), \
             patch.object(stand_main, 'command', side_effect=inspect_image) as inspect, \
             patch.object(stand_main, 'scenario', side_effect=scenario), \
             patch.object(stand_main.fixture.paid_services, 'scenario', side_effect=paid_scenario) as paid, \
             patch.object(stand_main.sys, 'argv', ['synthetic-stand', str(source), 'synthetic-image', str(report)]):
            stand_main.main()
        inspect.assert_called_once_with('docker', 'image', 'inspect', 'synthetic-image', '--format', '{{.Id}}')
        self.assertEqual([(call.args[2], call.kwargs) for call in paid.call_args_list], [
            ('paid-services-17-to-19-after-disconnect', {}),
            ('schema-19-without-migration', {'ordinary': True}),
            ('paid-services-preparation-failure-keeps-schema17', {'failure': 'migration'}),
            ('paid-services-gated-startup-failure-returns-schema17', {'failure': 'startup'}),
            ('paid-services-activation-failure-keeps-new-data', {'failure': 'activation'}),
        ])
        self.assertTrue(stand.closed)
        result = json.loads(report.read_text())
        self.assertTrue(result['passed'])
        self.assertEqual(result['imageId'], image_id)
        self.assertEqual(len(stand.results), 42)
        self.assertTrue(any(snapshot and len(snapshot['counters']) == 4 for snapshot in stand.retained),
                        'The business API fixture was erased instead of retained')

    def test_post_commit_encrypted_reservation_survives_without_schema_or_budget_change(self):
        before = self.seed()
        budget_before = json.loads(self.js(helper.links.budget.OBSERVE).stdout)
        self.js(helper.POST_COMMIT, flags={'STAND_PUBLICATION': '1'})
        after = json.loads(self.js(helper.OBSERVE).stdout)
        helper.assert_personal(before, after, latest=True)
        helper.links.budget.assert_state(budget_before,
            json.loads(self.js(helper.links.budget.OBSERVE).stdout), True)
        changed = copy.deepcopy(after); changed['personal']['events'] = []
        with self.assertRaises(AssertionError):
            helper.assert_personal(before, changed, latest=True)
        with self.assertRaises(AssertionError):
            helper.assert_personal(after, before)
        self.assertEqual(before['schema'], after['schema'])

    def test_activation_fault_changes_only_explicit_disposable_fixture(self):
        before = self.seed()
        self.js(helper.POST_COMMIT)
        helper.assert_personal(before, json.loads(self.js(helper.OBSERVE).stdout))

    def test_all_candidate_business_api_programs_are_valid_without_execution(self):
        for code in [helper.POST_COMMIT, helper.OBSERVE, helper.BUSINESS_SETUP, helper.BUSINESS_API]:
            result = subprocess.run([shutil.which('node') or 'node', '--check'], input=code,
                capture_output=True, text=True, encoding='utf-8', timeout=15, env=self.env)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_active_synthetic_api_reserves_personal_time_for_manual_and_public_booking(self):
        self.seed()
        metadata = json.loads(self.js(helper.BUSINESS_SETUP).stdout)
        api = helper.BUSINESS_API.replace("JSON.parse(require('fs').readFileSync(0,'utf8'))", json.dumps(metadata))
        api = api.replace("'http://127.0.0.1:4173'", "('http://127.0.0.1:'+server.address().port)")
        api = api.rstrip().rstrip(';')+'.finally(()=>server.close());'
        code = """
const server=require('/app/multi-server.cjs').createMultiServer({dataDir:'/data',notificationSchema:17,
 sharedCabinetWrites:true,isolatedReadBudgets:true,production:false,origin:'https://127.0.0.1',
 telegramAutostart:false,supportAutostart:false,maxAutostart:false,adminEmailAutostart:false,
 bookingPublicationAutostart:false,pushAutostart:false});
server.listen(0,'127.0.0.1',()=>{""" + api + '});'
        result = json.loads(self.js(code).stdout)
        self.assertTrue(result['personalCreated'])
        self.assertTrue(result['manualOverlapBlocked'])
        self.assertTrue(result['publicOverlapBlocked'])
        self.assertTrue(result['noPatientOrAppointmentCreated'])

    def test_direct_transport_preserves_public_proxy_host_origin_and_csrf_headers(self):
        # Run the actual native HTTP transport without sockets or copied transport logic.
        call = helper.BUSINESS_API.split(' const call=', 1)[1].split('\n const before=', 1)[0].rstrip().rstrip(';')
        code = """
const assert=require('node:assert/strict');
const {secureRequest}=require('/app/src/server/http/security.cjs');
const http=require('node:http'),{EventEmitter}=require('node:events');
const seen=[],headers={},input={staffId:'synthetic-owner',organizationId:'synthetic-organization'};let mode='success';
http.request=(url,options,receive)=>{
 assert.ok(url.startsWith('http://127.0.0.1:4173/api/'));
 assert.deepEqual(options.headers,{Host:'127.0.0.1',Origin:'https://127.0.0.1',
   'X-Cartoteca-Request':'1','Content-Type':'application/json',
   Cookie:'cartoteca_v2_session=stand-synthetic-session',
   'X-Cartoteca-Account-Id':input.staffId,'X-Cartoteca-Organization-Id':input.organizationId});
 const req={method:options.method,url:new URL(url).pathname,socket:{localPort:4173},headers:{
   host:options.headers.Host,origin:options.headers.Origin,'x-cartoteca-request':options.headers['X-Cartoteca-Request']}};
 const res={setHeader:(key,value)=>headers[key]=value};
 assert.equal(secureRequest(req,res,'https://127.0.0.1'),'https://127.0.0.1');
 assert.throws(()=>secureRequest({...req,headers:{...req.headers,host:'127.0.0.1:4173'}},res,'https://127.0.0.1'),
   error=>error.status===403);
 if(options.method==='POST'){
   assert.throws(()=>secureRequest({...req,headers:{...req.headers,origin:'http://127.0.0.1:4173'}},res,'https://127.0.0.1'),
     error=>error.status===403);
   assert.throws(()=>secureRequest({...req,headers:{...req.headers,'x-cartoteca-request':'0'}},res,'https://127.0.0.1'),
     error=>error.status===403);
 }
 const request=new EventEmitter();let timeout;
 request.setTimeout=(milliseconds,callback)=>{
   assert.equal(milliseconds,15000);timeout=callback;return request;
 };
 request.destroy=error=>{request.emit('error',error);return request;};
 request.end=body=>{
   seen.push({method:options.method,body});
   queueMicrotask(()=>{
     if(mode==='timeout'){timeout();return;}
     const response=new EventEmitter();response.statusCode=200;receive(response);
     if(mode==='large'){response.emit('data',Buffer.alloc(1024*1024+1));return;}
     response.emit('data',Buffer.from('{"synthetic":true}'));response.emit('end');
   });
 };
 return request;
};
const call=""" + call + """
;
(async()=>{
 await call('/api/cabinet');
 await call('/api/calendar/personal-event','POST',{revision:0});
 assert.equal(seen[0].method,'GET');assert.equal(seen[0].body,undefined);
 assert.equal(seen[1].method,'POST');assert.deepEqual(JSON.parse(seen[1].body),{revision:0});
 assert.equal(headers['Cache-Control'],'no-store');
 mode='large';await assert.rejects(call('/api/large'),/exceeded limit/);
 mode='timeout';await assert.rejects(call('/api/timeout'),/request timeout/);
 console.log(JSON.stringify({proxyHost:true,csrfPreserved:true,wrongHostRejected:true,
   boundedBody:true,boundedTimeout:true}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
"""
        result = json.loads(self.js(code).stdout)
        self.assertEqual(result, dict(proxyHost=True, csrfPreserved=True, wrongHostRejected=True,
            boundedBody=True, boundedTimeout=True))

    def test_copied_worker_gated_check_is_bounded_and_does_not_change_product(self):
        worker = self.base/'worker'; worker.mkdir()
        file = worker/'checks.py'
        file.write_text('def public_checks(ops): return None\n')
        helper.inject_gated_http_check(worker)
        copied = file.read_text()
        ast.parse(copied)
        self.assertIn("status != 503", copied)
        self.assertIn('timeout=15', copied)
        self.assertIn('/api/calendar/personal-event', copied)
        self.assertIn("ops.publication.gated()", copied)

    def test_offline_observer_has_readonly_sql_and_no_network(self):
        class Stand:
            root = self.base
            new = 'synthetic-immutable-image'
        calls = []
        def command(*args): calls.append(args); return '{}'
        helper.observe(command, Stand(), offline=True)
        self.assertIn('--read-only', calls[0])
        self.assertIn('none', calls[0])
        self.assertIn('readOnly:true', helper.OBSERVE)
        self.assertNotIn('immutable', helper.OBSERVE)
        self.assertNotIn('--env', calls[0])
        self.assertNotIn('--volume', calls[0])


if __name__ == '__main__':
    unittest.main()
