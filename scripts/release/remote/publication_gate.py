"""Gated ordinary publication: no schema changes, copies, or data rollback."""
import json


CAPABILITY_CODE = r'''
const assert=require('node:assert/strict');
const personal=require('/app/src/shared/personal-calendar.cjs');
const routes=require('/app/src/server/modules/calendar/routes.cjs').routes;
const gate=require('/app/src/server/application/release-gate.cjs').gatedRelease;
const event={id:'00000000-0000-4000-8000-000000000001',date:'2090-01-01',
 time:'23:55',duration:5,staffId:'synthetic-owner',notes:'Synthetic'};
assert.deepEqual(personal.personalCollection(undefined),{version:1,revision:0,events:[]});
assert.deepEqual(personal.personalCollection({version:1,revision:1,events:[event]}).events,[event]);
assert.ok(routes.some(r=>r.path==='/api/calendar/personal-event'&&r.method==='POST'));
assert.ok(routes.some(r=>r.path==='/api/calendar/personal-event'&&r.method==='DELETE'));
const gated=gate({releaseGate:true,maxEnabled:true,pushEnabled:true,telegramAutostart:true});
for(const name of ['maxEnabled','pushEnabled','pushAutostart','telegramAutostart',
 'supportAutostart','maxAutostart','adminEmailAutostart','bookingPublicationAutostart'])
 assert.equal(gated[name],false);
assert.equal(gated.sendMail,null);
console.log(JSON.stringify({publicationGate:true,personalCalendarVersion:1}));
'''


class PublicationGate:
    def __init__(self, ops):
        self.ops = ops
        self.journal = ops.directory / 'publication-state.json'

    def record(self, **changes):
        from agent import atomic
        state = json.loads(self.journal.read_text()) if self.journal.exists() else {}
        state.update(changes)
        atomic(self.journal, state)
        return state

    def override_environment(self, environment, gated):
        result = dict(environment)
        if self.ops.config.get('assistantSavingVersion') == 1:
            result['CARTOTECA_ASSISTANT_APPOINTMENT_SAVING'] = '1'
        if self.ops.config.get('schema') == 19:
            result['CARTOTECA_PAYMENT_NETWORK_ENABLED'] = '0'
            result['CARTOTECA_RELEASE_GATE'] = '1' if gated else '0'
        elif gated:
            result['CARTOTECA_RELEASE_GATE'] = '1'
        return result

    def preflight(self):
        from agent import atomic
        config = self.ops.config
        if (config.get('publicationGate') is not True or config.get('migration') is not None or
                config.get('schema') not in [17, 19] or config.get('readBudgetVersion') != 1 or
                config.get('bookingLinksVersion') != 1):
            raise RuntimeError('INVALID_PUBLICATION_GATE')
        if config.get('schema') == 19:
            from paid_services import assert_contract
            assert_contract(config)
        state_file = self.ops.directory / 'state.json'
        if ((self.journal.exists() and json.loads(self.journal.read_text()).get('committed')) or
                (state_file.exists() and json.loads(state_file.read_text()).get('activationCommitted'))):
            raise RuntimeError('PUBLICATION_COMMITTED_KEEP_CURRENT_DATA')
        current = self.ops.assert_previous()
        document = json.loads(self.ops.command([
            'docker', 'compose', '--project-directory', str(self.ops.root),
            '-f', str(self.ops.root / 'production.override.yaml'), 'config',
            '--format', 'json', '--no-env-resolution', '--no-interpolate',
            '--no-normalize', '--no-path-resolution', '--no-consistency']))
        document.pop('name', None)
        app = document.get('services', {}).get('app', {})
        environment = app.get('environment', {})
        if (app.get('image') != current['Config']['Image'] or
                not isinstance(environment, dict) or
                ('CARTOTECA_RELEASE_GATE' in environment and not
                 (config.get('schema') == 19 and environment['CARTOTECA_RELEASE_GATE'] == '0'))):
            raise RuntimeError('PUBLICATION_OVERRIDE_NOT_SUPPORTED')
        if config.get('assistantSavingVersion') == 1:
            from checks import assistant_process
            # Old code need not support autosave yet, but one known HTTP owner
            # must be the only app replica before the explicit admission.
            assistant_process(current, gated=False, require_saving=config.get('schema') == 19)
            for name, allowed in [('command', [None, ['node', 'multi-server.cjs']]),
                                  ('entrypoint', [None, ['docker-entrypoint.sh']])]:
                if app.get(name) not in allowed:
                    raise RuntimeError('ASSISTANT_SINGLE_PROCESS_REQUIRED')
            if app.get('scale', 1) != 1 or app.get('deploy', {}).get('replicas', 1) != 1:
                raise RuntimeError('ASSISTANT_SINGLE_PROCESS_REQUIRED')
            ids = self.ops.command(['docker', 'ps', '-q',
                '--filter', 'label=com.docker.compose.project=' + config['project'],
                '--filter', 'label=com.docker.compose.service=app']).decode().split()
            if len(ids) != 1 or not current.get('Id', '').startswith(ids[0]):
                raise RuntimeError('ASSISTANT_SINGLE_PROCESS_REQUIRED')
        if config.get('schema') == 19:
            from paid_services import prepare_publication
            prepare_publication(self, current)
        args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--memory=900m', '--cpus=2',
                '--entrypoint', 'node', self.ops.image_id, '-e', CAPABILITY_CODE]
        proof = json.loads(self.ops.command(args, timeout=90))
        if (proof.get('publicationGate') is not True or
                type(proof.get('personalCalendarVersion')) is not int or
                proof['personalCalendarVersion'] != 1):
            raise RuntimeError('PUBLICATION_CAPABILITY_NOT_CONFIRMED')
        atomic(self.ops.directory / 'publication-capabilities.json', proof)
        app['image'] = 'cartoteca:release-' + self.ops.request['run']
        for gated, phase in [(True, 'gated'), (False, 'enabled')]:
            app['environment'] = self.override_environment(environment, gated)
            atomic(self.ops.directory / (phase + '-production.override.yaml'), document)
        self.record(prepared=True, committed=False, personalCalendarVersion=1)

    def gated(self):
        return 'CARTOTECA_RELEASE_GATE=1' in self.ops.inspect()['Config'].get('Env', [])

    def activate(self):
        state = json.loads(self.journal.read_text())
        if (state.get('prepared') is not True or state.get('committed') is True or
                self.ops.inspect()['Image'] != self.ops.image_id or not self.gated()):
            raise RuntimeError('PUBLICATION_GATE_NOT_CONFIRMED')
        # This is durable before removing the API/background-writer gate.
        self.record(committed=True)
        self.ops.replace_configs(phase='enabled')
        self.ops.compose('up', '-d', '--no-build', '--no-deps', 'app')
        self.ops.wait_ready(self.ops.image_id)
        if self.gated():
            raise RuntimeError('PUBLICATION_GATE_STILL_ACTIVE')

    def assert_rollback_safe(self):
        state = self.ops.directory / 'state.json'
        if ((self.journal.exists() and json.loads(self.journal.read_text()).get('committed')) or
                (state.exists() and json.loads(state.read_text()).get('activationCommitted'))):
            raise RuntimeError('PUBLICATION_COMMITTED_KEEP_CURRENT_DATA')
        current = self.ops.inspect()
        if current['Image'] not in [self.ops.image_id, self.ops.config['expectedImage']]:
            raise RuntimeError('PUBLICATION_IMAGE_CHANGED')
        if current['Image'] == self.ops.image_id and current['State']['Running'] and not self.gated():
            raise RuntimeError('PUBLICATION_WRITERS_MAY_BE_ACTIVE')

    def quarantine(self):
        if self.ops.inspect()['Image'] != self.ops.image_id:
            raise RuntimeError('PUBLICATION_IMAGE_CHANGED')
        self.ops.compose('stop', '-t', '45', 'app')
        if self.ops.inspect()['State']['Running']:
            raise RuntimeError('PUBLICATION_SOURCE_STILL_RUNNING')
        self.record(activationFailed=True, currentDataRetained=True)
