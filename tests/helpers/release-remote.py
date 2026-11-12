"""Synthetic state-machine tests. Every Docker/systemd/HTTP operation is replaced."""
import json
import hashlib
import io
import tarfile
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/release/remote'))
import agent
import operations
import checks
import read_budget
import migration
import booking_links
import publication_gate
import postgres


class WorkerTests(unittest.TestCase):
    def test_postgres_technical_backend_dispatch_never_opens_sqlite_and_requires_all_live_owners(self):
        config={'schema':19,'storageBackend':'postgres','postgresProfile':'production-v1','paymentNetworkEnabled':False}
        proof={'version':1,'backend':'postgres','profile':'production-v1','ready':True,'schema':19,
               'nativeSchema':True,'rls':True,'assetLineage':True,'preparedModes':True,'stores':3,
               'paymentNetworkEnabled':False,'assistantAppointmentSavingEnabled':False,
               'executors':{'version':1,'backend':'postgres','ready':True,'profileMatches':True,
                            'gateway':{'open':True},'children':{'web':True,'background':True},
                            'queries':{'configured':2,'ready':2,'closed':False}}}
        calls=[]
        current={'Config':{'Env':['CARTOTECA_STORAGE_BACKEND=postgres','CARTOTECA_POSTGRES_PROFILE=production-v1'],
                           'Cmd':['node','scripts/start-postgres-server.cjs']}}
        ops=SimpleNamespace(config={**config,'container':'synthetic-app'},inspect=lambda:current,
                            command=lambda args,**kw:(calls.append(args) or json.dumps(proof).encode()))
        checks.schema(ops)
        self.assertEqual(calls,[['docker','exec','synthetic-app','node','/app/scripts/postgres-readiness.cjs','--technical-output']])
        proof['executors']['children']['background']=False
        with self.assertRaisesRegex(RuntimeError,'POSTGRES_NOT_READY'):checks.schema(ops)
        with self.assertRaisesRegex(RuntimeError,'POSTGRES_RELEASE_SWITCH_NOT_APPROVED'):
            operations.Operations({'config':config},Path('/synthetic'))
        with self.assertRaisesRegex(RuntimeError,'POSTGRES_RELEASE_SWITCH_NOT_APPROVED'):checks.preflight(ops)

    def test_postgres_backup_validator_requires_native_verification_and_actual_restore_startup(self):
        proof={'state':'local_only','backend':'postgres','verified':True,
               'drill':{'backend':'postgres','restored':True,'started':True,'notificationsPaused':True}}
        self.assertEqual(postgres.backup_proof(proof),proof)
        for change in [{'verified':False},{'backend':'sqlite'},{'drill':{'restored':True}},
                       {'drill':{**proof['drill'],'started':False}}]:
            with self.assertRaisesRegex(RuntimeError,'POSTGRES_BACKUP_AND_DRILL_NOT_CONFIRMED'):
                postgres.backup_proof({**proof,**change})

    def test_exact_cached_image_avoids_repeated_load_without_accepting_a_tag(self):
        identity='sha256:'+'a'*64;calls=[]
        ops=SimpleNamespace(request={'imageId':identity},command=lambda args,**kw:(calls.append(args) or (identity+'\n').encode()))
        self.assertFalse(checks.load_image_if_missing(ops,Path('/synthetic/image.tar')))
        self.assertEqual(calls,[['docker','image','inspect',identity,'--format','{{.Id}}']])
        ops.request['imageId']='cartoteca:mutable'
        with self.assertRaisesRegex(RuntimeError,'INVALID_IMAGE_IDENTITY'):
            checks.load_image_if_missing(ops,Path('/synthetic/image.tar'))
        self.assertEqual(len(calls),1)

    def test_missing_image_loads_the_verified_archive_once(self):
        calls=[]
        def command(args,**kw):
            calls.append(args)
            if args[:3]==['docker','image','inspect']:raise RuntimeError('image absent')
            self.assertEqual(kw,{'timeout':300});return b''
        ops=SimpleNamespace(request={'imageId':'sha256:'+'a'*64},command=command)
        self.assertTrue(checks.load_image_if_missing(ops,Path('/synthetic/image.tar')))
        self.assertEqual(calls[-1],['docker','load','--input','/synthetic/image.tar'])
        self.assertEqual(len(calls),2)

    def test_cached_image_identity_mismatch_retains_original_load_before_strict_resolution(self):
        calls=[]
        ops=SimpleNamespace(request={'imageId':'sha256:'+'a'*64},command=lambda args,**kw:(calls.append(args) or ('sha256:'+'b'*64).encode()))
        self.assertTrue(checks.load_image_if_missing(ops,Path('/synthetic/image.tar')))
        self.assertEqual(calls[-1],['docker','load','--input','/synthetic/image.tar'])
        self.assertEqual(len(calls),2)

    def test_cached_image_never_bypasses_archive_hash_validation(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-preflight-hash-') as temporary:
            root=Path(temporary);directory=root/'release';directory.mkdir()
            (directory/'image.tar').write_bytes(b'synthetic-corrupt-archive')
            calls=[]
            ops=SimpleNamespace(root=root,directory=directory,migration=None,config={'schema':18},
                request={'imageId':'sha256:'+'a'*64,'imageBytes':25,'imageHash':'0'*64},
                assert_previous=lambda:{'Config':{'Env':[]}},command=lambda args,**kw:(calls.append(args) or b''))
            with patch.object(checks,'schema'),patch.object(read_budget,'check_release_mode'),patch.object(booking_links,'check_release_mode'):
                with self.assertRaisesRegex(RuntimeError,'ARCHIVE_CHANGED'):checks.preflight(ops)
            self.assertEqual(calls,[])

    def test_storage_cleanup_preserves_three_releases_and_all_container_images(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-release-storage-') as temporary:
            root = Path(temporary)
            app, releases = root / 'app', root / 'releases'
            app.mkdir(); releases.mkdir()
            current = releases / ('r-' + '6' * 12 + '-' + '6' * 12)
            current.mkdir()
            request = {'config': {'root': str(app), 'releaseRoot': str(releases),
                'container': 'synthetic', 'expectedImage': 'sha256:' + '5' * 64}}
            tags, directories, removed = {}, {}, []
            for index in range(1, 6):
                digit = str(index); name = 'r-' + digit * 12 + '-' + digit * 12
                directory = releases / name; directory.mkdir(); directories[index] = directory
                image = 'sha256:' + digit * 64; content = ('synthetic-' + digit).encode()
                (directory / 'image.tar').write_bytes(content)
                agent.atomic(directory / 'state.json', {'status': 'completed', 'published': True,
                    'actualImage': image, 'finishedAt': index})
                agent.atomic(directory / 'request.json', {'run': name, 'config': request['config'],
                    'imageHash': hashlib.sha256(content).hexdigest(), 'imageBytes': len(content)})
                tags['cartoteca:release-' + name] = image
            unknown = releases / 'manual'; unknown.mkdir(); (unknown / 'image.tar').write_text('manual')
            ops = operations.Operations(request, current)
            ops.inspect = lambda: {'Image': 'sha256:' + '6' * 64}
            def command(args, **_):
                if args == ['docker', 'ps', '-aq']: return ('a' * 12).encode()
                if args[:2] == ['docker', 'inspect']: return json.dumps([{'Image': 'sha256:' + '1' * 64}]).encode()
                if args[:3] == ['docker', 'image', 'ls']:
                    return '\n'.join(tag + ' ' + image for tag, image in tags.items()).encode()
                if args[:3] == ['docker', 'image', 'inspect']: return tags[args[3]].encode()
                if args[:3] == ['docker', 'image', 'rm']: removed.append(args[3]); return b''
                raise AssertionError(args)
            ops.command = command
            result = ops.cleanup_storage()
            self.assertEqual(result, {'removedArchives': 3, 'removedTags': 2})
            for index in [4, 5]: self.assertTrue((directories[index] / 'image.tar').exists())
            self.assertTrue((unknown / 'image.tar').exists())
            self.assertNotIn('cartoteca:release-' + directories[1].name, removed)
            self.assertEqual(len(removed), 2)

    def test_storage_cleanup_accepts_large_runtime_requests_without_touching_unowned_or_nonterminal_evidence(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-release-storage-large-') as temporary:
            root = Path(temporary)
            app, releases = root/'app', root/'releases'
            app.mkdir(); releases.mkdir()
            current = releases/('r-'+'6'*12+'-'+'6'*12); current.mkdir()
            config = {'root': str(app), 'releaseRoot': str(releases),
                      'container': 'synthetic', 'expectedImage': 'sha256:'+'5'*64}
            runtime = {'src/server/modules/synthetic/component-'+str(i).zfill(4)+'.cjs': 'a'*64
                       for i in range(869)}
            tags, directories, removed = {}, {}, []

            def seed(index, state_patch=None, request_patch=None):
                digit = format(index, 'x').zfill(12)
                name = 'r-'+digit+'-'+digit
                directory = releases/name; directory.mkdir()
                image = 'sha256:'+format(index, 'x').zfill(64)
                content = ('synthetic archive '+name).encode()
                (directory/'image.tar').write_bytes(content)
                state = {'status': 'completed', 'published': True,
                         'actualImage': image, 'finishedAt': index}
                request = {'version': 1, 'run': name, 'config': config, 'runtime': runtime,
                           'imageHash': hashlib.sha256(content).hexdigest(), 'imageBytes': len(content)}
                state.update(state_patch or {}); request.update(request_patch or {})
                (directory/'state.json').write_text(json.dumps(state), encoding='utf-8')
                (directory/'request.json').write_text(json.dumps(request), encoding='utf-8')
                tags['cartoteca:release-'+name] = image
                return directory

            for index in range(1, 6):
                directories[index] = seed(index)
                size = (directories[index]/'request.json').stat().st_size
                self.assertGreater(size, 65536)
                self.assertLess(size, 2*1024*1024)
            protected = [
                seed(10, {'status': 'rolled_back', 'published': False}),
                seed(11, {'status': 'needs_attention', 'published': False}),
                seed(12, {'status': 'failed_before_switch', 'published': False}),
                seed(13, {'published': False}),
                seed(14, request_patch={'config': {**config, 'root': str(root/'foreign-app')}}),
                seed(15, request_patch={'config': {**config, 'releaseRoot': str(root/'foreign-releases')}}),
                seed(16, request_patch={'run': 'r-'+'f'*12+'-'+'e'*12}),
                seed(17, {'padding': 'x'*65536}),
                seed(18, request_patch={'padding': 'x'*(2*1024*1024)}),
                seed(19),
            ]
            (protected[-1]/'request.json').write_text('{not valid JSON', encoding='utf-8')
            retained = {file: file.read_bytes() for directory in protected
                        for file in directory.iterdir()}
            ops = operations.Operations({'config': config}, current)
            ops.inspect = lambda: {'Image': 'sha256:'+'6'*64}

            def command(args, **_):
                if args == ['docker', 'ps', '-aq']: return ('a'*12).encode()
                if args[:2] == ['docker', 'inspect']:
                    return json.dumps([{'Image': 'sha256:'+format(1, 'x').zfill(64)}]).encode()
                if args[:3] == ['docker', 'image', 'ls']:
                    return '\n'.join(tag+' '+image for tag, image in tags.items()).encode()
                if args[:3] == ['docker', 'image', 'inspect']: return tags[args[3]].encode()
                if args[:3] == ['docker', 'image', 'rm']: removed.append(args[3]); return b''
                raise AssertionError('Unexpected external command: '+repr(args))

            ops.command = command
            result = ops.cleanup_storage()
            self.assertEqual(result, {'removedArchives': 3, 'removedTags': 2})
            for index in [1, 2, 3]: self.assertFalse((directories[index]/'image.tar').exists())
            for index in [4, 5]: self.assertTrue((directories[index]/'image.tar').exists())
            self.assertEqual({file: file.read_bytes() for file in retained}, retained)
            self.assertNotIn('cartoteca:release-'+directories[1].name, removed)
            self.assertEqual(removed, ['cartoteca:release-'+directories[i].name for i in [3, 2]])

    def scenario(self, failure=None, resume=False, migration=False, read_budget_mode=False, booking_links_mode=False, publication_gate=False):
        with tempfile.TemporaryDirectory(prefix='cartoteca-release-synthetic-') as temporary:
            root = Path(temporary)
            directory = root / 'run'
            directory.mkdir()
            events = []
            request = {'config': {'releaseRoot': str(root)}}
            if read_budget_mode:
                request['config']['migration'] = 'read-budget-17'
            if booking_links_mode:
                request['config']['migration'] = 'booking-links-17'
            if publication_gate:
                request['config']['publicationGate'] = True
            if resume:
                agent.atomic(directory / 'state.json', {'status': 'dispatching', 'resumeFrom': 'published_backup_pending',
                    **({'activationCommitted': True} if publication_gate else {})})

            class FakeOperations:
                def __init__(self, *_):
                    self.timer_touched = False
                    self.image = 'new' if resume else 'old'
                    self.backups = 1 if resume else 0
                    self.migration = FakeMigration(self) if migration else None
                    self.publication = FakePublication(self) if publication_gate else None
                    self.public_calls = 0
                def event(self, name):
                    events.append(name)
                    if name == failure or isinstance(failure, tuple) and name in failure:
                        raise RuntimeError('SYNTHETIC_FAILURE')
                def save_configuration(self): self.event('save')
                def pause_timer(self): self.event('pause'); self.timer_touched = True
                def restore_timer(self): self.event('timer'); self.timer_touched = False
                def assert_previous(self): self.event('previous')
                def backup(self):
                    self.backups += 1
                    self.event('backup-before' if self.backups == 1 else 'backup-after')
                def switch(self): self.image = 'new'; self.event('switch')
                def rollback(self): self.event('rollback'); self.image = 'old'
                def inspect(self): return {'Image': self.image}
                def cleanup_storage(self): self.event('storage-maintenance'); return {'removedArchives': 0, 'removedTags': 0}

            class FakeMigration:
                def __init__(self, ops): self.ops = ops
                def stop(self): self.ops.event('migration-stop')
                def prepare(self): self.ops.event('migration-prepare')
                def install(self): self.ops.event('migration-install')
                def activate(self): self.ops.event('migration-activate')
                def quarantine(self): self.ops.event('migration-quarantine')

            class FakePublication:
                def __init__(self, ops):
                    self.ops, self.enabled = ops, resume
                def gated(self): return not self.enabled
                def preflight(self): self.ops.event('publication-preflight')
                def activate(self):
                    # Must be persisted, not just set in the in-memory state.
                    durable = json.loads((directory / 'state.json').read_text())
                    assert durable['activationCommitted'] is True
                    self.ops.event('publication-activate')
                    self.enabled = True
                def quarantine(self):
                    self.ops.event('publication-quarantine')
                    self.enabled = False

            def preflight(ops): ops.event('preflight')
            def public(ops):
                ops.public_calls += 1
                if publication_gate:
                    expected_gate = not resume and ops.public_calls == 1
                    assert ops.publication.gated() == expected_gate
                    if ops.public_calls == 2 and failure == 'public-activated':
                        ops.event('public-activated')
                ops.event('public')
            with patch.object(operations, 'Operations', FakeOperations), patch.object(checks, 'preflight', preflight), patch.object(checks, 'public_checks', public), patch.object(agent, 'active', lambda *_: False):
                result = agent.run(request, directory)
            timings = [json.loads(line) for line in (directory / 'timings.jsonl').read_text().splitlines()]
            return result, events, timings

    def test_success(self):
        state, events, _ = self.scenario()
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(state['actualImage'], 'new')
        self.assertNotIn('rollback', events)
        self.assertEqual(events[-1], 'storage-maintenance')
        self.assertLess(events.index('timer'), events.index('storage-maintenance'))

    def test_maintenance_failure_does_not_repeat_backups_or_rollback_a_completed_release(self):
        state, events, _ = self.scenario('storage-maintenance')
        self.assertEqual(state['status'], 'completed')
        self.assertEqual(state['actualImage'], 'new')
        self.assertEqual(state['maintenanceError'], 'STORAGE_MAINTENANCE_FAILED')
        self.assertNotIn('rollback', events)
        self.assertEqual(events.count('backup-before'), 1)
        self.assertEqual(events.count('backup-after'), 1)

    def test_migration_checks_gate_before_activation(self):
        state, events, _ = self.scenario(migration=True)
        self.assertEqual(state['status'], 'completed')
        self.assertTrue(state['migrationCommitted'])
        self.assertLess(events.index('migration-stop'), events.index('migration-prepare'))
        self.assertLess(events.index('migration-prepare'), events.index('migration-install'))
        self.assertLess(events.index('public'), events.index('migration-activate'))
        self.assertEqual(events.count('public'), 2)

    def test_publication_gate_checks_before_durable_activation_without_migrating(self):
        state, events, timings = self.scenario(publication_gate=True)
        self.assertEqual(state['status'], 'completed')
        self.assertIs(state['activationCommitted'], True)
        self.assertNotIn('migration-stop', events)
        self.assertNotIn('migration-prepare', events)
        self.assertNotIn('migration-install', events)
        self.assertLess(events.index('public'), events.index('publication-activate'))
        self.assertEqual(events.count('public'), 2)
        self.assertEqual(next(row['status'] for row in timings if row['stage'] == 'publication-activate'), 'passed')
        self.assertEqual(next(row['status'] for row in timings if row['stage'] == 'public-checks-activated'), 'passed')

    def test_gated_phase_failure_returns_old_image_before_new_writes(self):
        state, events, _ = self.scenario('public', publication_gate=True)
        self.assertEqual(state['status'], 'rolled_back')
        self.assertEqual(state['actualImage'], 'old')
        self.assertNotIn('publication-activate', events)
        self.assertFalse(state.get('activationCommitted', False))
        self.assertNotIn('publication-quarantine', events)
        self.assertEqual(events.count('rollback'), 1)

    def test_publication_activation_failure_quarantines_without_old_image_or_data_rollback(self):
        for failure in ['publication-activate', 'public-activated']:
            with self.subTest(failure=failure):
                state, events, _ = self.scenario(failure, publication_gate=True)
                self.assertEqual(state['status'], 'needs_attention')
                self.assertEqual(state['error'], 'ACTIVATION_FAILED_KEEP_CURRENT_DATA')
                self.assertIs(state['activationCommitted'], True)
                self.assertIn('publication-quarantine', events)
                self.assertNotIn('rollback', events)

    def test_publication_failed_quarantine_does_not_fall_back_to_unsafe_old_image(self):
        state, events, _ = self.scenario(('publication-activate', 'publication-quarantine'), publication_gate=True)
        self.assertEqual(state['status'], 'needs_attention')
        self.assertEqual(state['error'], 'ACTIVATION_FAILED_STOP_REQUIRES_ATTENTION')
        self.assertNotIn('rollback', events)

    def test_publication_post_backup_failure_and_resume_do_not_reactivate_or_switch(self):
        state, events, _ = self.scenario('backup-after', publication_gate=True)
        self.assertEqual(state['status'], 'published_backup_pending')
        self.assertIs(state['activationCommitted'], True)
        self.assertNotIn('rollback', events)
        state, events, _ = self.scenario(resume=True, publication_gate=True)
        self.assertEqual(state['status'], 'completed')
        self.assertNotIn('switch', events)
        self.assertNotIn('publication-activate', events)
        self.assertNotIn('backup-before', events)

    def test_interrupted_committed_publication_is_not_blindly_restarted(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-publication-dead-') as temporary:
            directory = Path(temporary)
            agent.atomic(directory / 'state.json', {'status': 'activating', 'unit': 'synthetic-unit',
                'activationCommitted': True})
            with patch.object(agent, 'active', lambda *_: False), patch.object(agent.subprocess, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'REQUIRES_RECOVERY'):
                    agent.launch({'files': {}}, directory, 'synthetic')
            command.assert_not_called()

    def test_migration_prepare_failure_restarts_old_source(self):
        state, events, _ = self.scenario('migration-prepare', migration=True)
        self.assertEqual(state['status'], 'rolled_back')
        self.assertNotIn('migration-install', events)
        self.assertIn('rollback', events)

    def test_activation_failure_never_restores_stale_schema15(self):
        state, events, _ = self.scenario('migration-activate', migration=True)
        self.assertEqual(state['status'], 'needs_attention')
        self.assertTrue(state['migrationCommitted'])
        self.assertNotIn('rollback', events)
        self.assertEqual(state['error'], 'ACTIVATION_FAILED_KEEP_SCHEMA16_DATA')

    def test_preflight_failure_never_stops_old_application(self):
        state, events, _ = self.scenario('preflight')
        self.assertEqual(state['status'], 'failed_before_switch')
        self.assertEqual(events, ['preflight'])

    def test_read_budget_activation_failure_stops_writers_without_restoring_stale_data(self):
        state, events, _ = self.scenario('migration-activate', migration=True, read_budget_mode=True)
        self.assertEqual(state['status'], 'needs_attention')
        self.assertEqual(state['error'], 'ACTIVATION_FAILED_KEEP_CURRENT_DATA')
        self.assertIn('migration-quarantine', events)
        self.assertNotIn('rollback', events)
        self.assertTrue(state['migrationCommitted'])

    def test_read_budget_failed_quarantine_does_not_attempt_stale_rollback(self):
        state, events, _ = self.scenario(('migration-activate', 'migration-quarantine'), migration=True, read_budget_mode=True)
        self.assertEqual(state['status'], 'needs_attention')
        self.assertEqual(state['error'], 'ACTIVATION_FAILED_STOP_REQUIRES_ATTENTION')
        self.assertNotIn('rollback', events)

    def test_booking_links_activation_failure_quarantines_current_copy_without_rollback(self):
        state, events, _ = self.scenario('migration-activate', migration=True, booking_links_mode=True)
        self.assertEqual(state['status'], 'needs_attention')
        self.assertEqual(state['error'], 'ACTIVATION_FAILED_KEEP_CURRENT_DATA')
        self.assertIn('migration-quarantine', events)
        self.assertNotIn('rollback', events)
        self.assertTrue(state['migrationCommitted'])

    def test_booking_links_prepare_failure_returns_original_copy_before_activation(self):
        state, events, _ = self.scenario('migration-prepare', migration=True, booking_links_mode=True)
        self.assertEqual(state['status'], 'rolled_back')
        self.assertNotIn('migration-install', events)
        self.assertNotIn('migration-activate', events)
        self.assertIn('rollback', events)

    def test_backup_failure_never_switches_and_restores_timer(self):
        state, events, _ = self.scenario('backup-before')
        self.assertEqual(state['status'], 'failed_before_switch')
        self.assertNotIn('switch', events)
        self.assertIn('timer', events)

    def test_failed_new_application_returns_old_code(self):
        state, events, timings = self.scenario('public')
        self.assertEqual(state['status'], 'rolled_back')
        self.assertEqual(state['actualImage'], 'old')
        self.assertIn('rollback', events)
        self.assertEqual(next(row['status'] for row in timings if row['stage'] == 'public-checks'), 'failed')

    def test_post_backup_failure_keeps_healthy_new_application(self):
        state, events, _ = self.scenario('backup-after')
        self.assertEqual(state['status'], 'published_backup_pending')
        self.assertTrue(state['published'])
        self.assertNotIn('rollback', events)

    def test_rollback_failure_stops_automatic_attempts(self):
        state, events, _ = self.scenario(('public', 'rollback'))
        self.assertEqual(state['status'], 'needs_attention')
        self.assertEqual(events.count('rollback'), 1)

    def test_live_worker_is_not_dispatched_twice(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-release-active-') as temporary:
            directory = Path(temporary)
            agent.atomic(directory / 'state.json', {'status': 'switching', 'unit': 'synthetic-unit'})
            with patch.object(agent, 'active', lambda *_: True), patch.object(agent.subprocess, 'run') as command:
                state = agent.launch({'files': {}}, directory, 'synthetic')
            self.assertTrue(state['active'])
            command.assert_not_called()

    def test_dead_worker_in_transition_is_not_blindly_restarted(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-release-dead-') as temporary:
            directory = Path(temporary)
            agent.atomic(directory / 'state.json', {'status': 'switching', 'unit': 'synthetic-unit'})
            with patch.object(agent, 'active', lambda *_: False), patch.object(agent.subprocess, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'REQUIRES_RECOVERY'):
                    agent.launch({'files': {}}, directory, 'synthetic')
            command.assert_not_called()

    def test_resume_post_backup_does_not_repeat_switch(self):
        state, events, _ = self.scenario(resume=True)
        self.assertEqual(state['status'], 'completed')
        self.assertNotIn('switch', events)
        self.assertNotIn('backup-before', events)
        self.assertEqual(events, ['public', 'pause', 'backup-after', 'timer', 'storage-maintenance'])
        self.assertEqual(events.count('backup-after'), 1)
        self.assertEqual(events.count('storage-maintenance'), 1)

    def test_other_release_holds_global_lock(self):
        with tempfile.TemporaryDirectory(prefix='cartoteca-release-lock-') as temporary:
            file = Path(temporary) / 'lock'
            with agent.exclusive(file):
                with self.assertRaises(BlockingIOError):
                    with agent.exclusive(file):
                        self.fail('second owner acquired lock')


class ReadBudgetTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='cartoteca-read-budget-release-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        data = root / 'data'
        data.mkdir()
        class FakeOperations:
            def inspect(self): return {'Id': 'current', 'State': {'Running': True}, 'Config': {'Env': []}}
            def command(self, args, **_):
                if args == ['docker', 'ps', '-q']:
                    return b'current\nother'
                if args[:2] == ['docker', 'inspect']:
                    container = args[2]
                    return json.dumps([{'Id': container, 'Mounts': [{'Source': str(self.other if container == 'other' else data)}]}]).encode()
                raise AssertionError('Unexpected operation')
        ops = FakeOperations()
        ops.root, ops.directory, ops.other = root, root, root / 'unrelated'
        ops.request = {'run': 'synthetic'}
        ops.config = {'schema': 17, 'migration': 'read-budget-17', 'readBudgetVersion': 1, 'backupTimer': 'synthetic.timer'}
        transition = read_budget.ReadBudgetMigration(ops)
        return ops, transition

    def test_component_migration_keeps_schema_and_delivery_settings(self):
        _, transition = self.fixture()
        original = {'CARTOTECA_MAX_SCHEMA': '17', 'CARTOTECA_CABINET_SCHEMA': '1',
                    'CARTOTECA_PUSH_ENABLED': '0', 'CARTOTECA_SCHEDULED_NOTIFICATIONS': '0',
                    'UNCHANGED_PLACEHOLDER': '${LOCAL_ONLY}'}
        for gated in [True, False]:
            actual = transition.override_environment(original, gated)
            for name, value in original.items():
                self.assertEqual(actual[name], value)
            self.assertEqual({name: actual[name] for name in read_budget.FLAGS}, read_budget.FLAGS)
            self.assertEqual(actual.get('CARTOTECA_RELEASE_GATE'), '1' if gated else None)
        self.assertNotIn('CARTOTECA_SHARED_CABINET_WRITES', original)
        self.assertEqual(transition.previous_schema, 17)
        self.assertEqual(migration.StaffMaxMigration(transition.ops).previous_schema, 16)

    def test_overlapping_parent_child_and_equal_mounts_are_refused(self):
        ops, transition = self.fixture()
        for source in [transition.data, transition.data / 'platform', transition.data.parent,
                       transition.data / '../data', transition.retained, transition.stage / 'data']:
            ops.other = source
            with self.subTest(source=source), self.assertRaisesRegex(RuntimeError, 'ANOTHER_MIGRATION_WRITER_RUNNING'):
                transition.assert_other_writers_stopped(allow_current=True)
        ops.other = ops.root / 'data-neighbor'
        transition.assert_other_writers_stopped(allow_current=True)

    def test_prepare_requires_current_app_stopped(self):
        _, transition = self.fixture()
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_SOURCE_STILL_RUNNING'):
            transition.assert_other_writers_stopped()

    def test_host_mounts_cannot_hide_overlap_behind_distinct_container_paths(self):
        ops, transition = self.fixture()
        volumes = {'/data': str(transition.data), '/backups': str(ops.root / 'backups'),
                   '/secrets': str(ops.root / 'secrets')}
        transition.assert_mount_isolation(volumes)
        for target, source in [('/backups', transition.data / 'backups'),
                               ('/secrets', ops.root), ('/backups', transition.stage / 'archives')]:
            with self.subTest(target=target, source=source), self.assertRaisesRegex(RuntimeError, 'HOST_MOUNTS_OVERLAP'):
                transition.assert_mount_isolation({**volumes, target: str(source)})

    def test_backup_service_and_timer_must_both_be_idle(self):
        ops, transition = self.fixture()
        for busy in ['synthetic.timer', 'synthetic.service']:
            ops.command = lambda args, busy=busy: b'active' if args[2] == busy else b'inactive'
            with self.assertRaisesRegex(RuntimeError, 'MIGRATION_BACKUP_NOT_PAUSED'):
                transition.assert_backup_paused()
        ops.command = lambda _: b'inactive'
        transition.assert_backup_paused()

    def test_activated_store_requires_all_flags_before_database_check(self):
        ops, _ = self.fixture()
        for missing in read_budget.FLAGS:
            environment = [name + '=' + value for name, value in read_budget.FLAGS.items() if name != missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(RuntimeError, 'CONFIGURATION_MISMATCH'):
                read_budget.check_active(ops, {'Config': {'Env': environment}})

    def test_offline_verification_uses_readonly_sql_without_immutable_or_secrets(self):
        ops, transition = self.fixture()
        ops.image_id = 'synthetic-image'
        result = {'componentVersion': 1, 'mode': 'isolated', 'storeId': 'a' * 36}
        with patch.object(ops, 'command', return_value=json.dumps(result).encode()) as command:
            self.assertEqual(transition.offline_store_check(transition.data, True), result)
        args = command.call_args.args[0]
        mount = args[args.index('--mount') + 1]
        self.assertEqual(mount, 'type=bind,source=' + str(transition.data) + ',target=/data')
        self.assertIn('readOnly:true', args[-1])
        self.assertNotIn('immutable', args[-1])
        self.assertNotIn('--env', args)
        self.assertEqual(args[args.index('--network') + 1], 'none')

    def test_store_result_rejects_wrong_mode_identity_and_version(self):
        good = {'componentVersion': 1, 'mode': 'isolated', 'storeId': 'a' * 36}
        self.assertEqual(read_budget.validate_store_result(good, True), good)
        for changes in [{'mode': 'legacy'}, {'componentVersion': True}, {'componentVersion': 2}, {'storeId': None}]:
            with self.subTest(changes=changes), self.assertRaisesRegex(RuntimeError, 'STORE_NOT_CONFIRMED'):
                read_budget.validate_store_result({**good, **changes}, True)
        read_budget.validate_store_result({'componentVersion': None, 'mode': 'legacy', 'storeId': None}, False)

    def test_ordinary_release_cannot_silently_leave_enabled_mode_unpinned(self):
        ops, _ = self.fixture()
        ops.config.pop('migration')
        ops.config.pop('readBudgetVersion')
        current = {'Config': {'Env': [name + '=1' for name in read_budget.FLAGS]}}
        with self.assertRaisesRegex(RuntimeError, 'RELEASE_PIN_REQUIRED'):
            read_budget.check_release_mode(ops, current)
        ops.config['readBudgetVersion'] = 1
        with patch.object(read_budget, 'check_active') as active:
            read_budget.check_release_mode(ops, current)
            active.assert_called_once_with(ops, current)

    def test_existing_source_tree_rejects_hardlinked_data(self):
        _, transition = self.fixture()
        original = transition.data / 'synthetic.bin'
        original.write_bytes(b'synthetic')
        (transition.data / 'linked.bin').hardlink_to(original)
        with self.assertRaisesRegex(RuntimeError, 'LINKED_OR_SPECIAL'):
            transition.assert_source_tree()

    def test_committed_rollback_never_renames_current_data(self):
        _, transition = self.fixture()
        transition.journal.write_text(json.dumps({'committed': True}))
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_KEEP_CURRENT_DATA'):
            transition.rollback_data()
        self.assertTrue(transition.data.exists())


class BookingLinksTests(unittest.TestCase):
    def fixture(self):
        ops, _ = ReadBudgetTests.fixture(self)
        ops.config.update(migration='booking-links-17', bookingLinksVersion=1, container='synthetic-app')
        transition = booking_links.BookingLinksMigration(ops)
        ops.migration = transition
        return ops, transition

    def test_all_existing_environment_and_schema_flags_are_preserved(self):
        _, transition = self.fixture()
        original = {**read_budget.FLAGS, 'CARTOTECA_MAX_SCHEMA': '17',
                    'CARTOTECA_PUSH_ENABLED': '1', 'MAIL_TOKEN': '${UNCHANGED}'}
        self.assertEqual(transition.override_environment(original, False), original)
        self.assertEqual(transition.override_environment(original, True),
                         {**original, 'CARTOTECA_RELEASE_GATE': '1'})
        self.assertEqual(transition.previous_schema, 17)
        self.assertEqual(transition.stage.name, 'booking-links-synthetic')

    def test_existing_budget_can_be_checked_before_booking_links_journal_exists(self):
        ops, transition = self.fixture()
        self.assertFalse(transition.journal.exists())
        ops.command = lambda *_, **__: json.dumps({'componentVersion': 1, 'mode': 'isolated', 'storeId': 'a' * 36}).encode()
        current = {'Config': {'Env': [name + '=' + value for name, value in read_budget.FLAGS.items()]}}
        read_budget.check_active(ops, current)
        read_budget.check_release_mode(ops, current)
        self.assertFalse(transition.journal.exists())

    def test_component_proof_is_strict_and_carries_existing_budget_identity(self):
        good = {'bookingLinksVersion': 1, 'readBudgetStoreId': 'a' * 36}
        self.assertEqual(booking_links.validate_result(good, True), good)
        for changes in [{'bookingLinksVersion': None}, {'bookingLinksVersion': True},
                        {'bookingLinksVersion': 2}, {'readBudgetStoreId': None}]:
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                booking_links.validate_result({**good, **changes}, True)
        self.assertEqual(booking_links.validate_result({**good, 'bookingLinksVersion': None}, False)['bookingLinksVersion'], None)

    def test_live_component_requires_prepared_journal_and_same_budget_store(self):
        ops, transition = self.fixture()
        result = {'bookingLinksVersion': 1, 'readBudgetStoreId': 'a' * 36}
        ops.command = lambda *_, **__: json.dumps(result).encode()
        with patch.object(booking_links, 'check_budget'):
            for state in [{'storeId': 'a' * 36}, {'prepared': True, 'storeId': 'b' * 36}]:
                transition.journal.write_text(json.dumps(state))
                with self.assertRaisesRegex(RuntimeError, 'READ_BUDGET_CHANGED'):
                    booking_links.check_active(ops, {})
            transition.journal.write_text(json.dumps({'prepared': True, 'storeId': 'a' * 36}))
            booking_links.check_active(ops, {})

    def test_existing_links_cannot_be_released_without_pin(self):
        ops, _ = self.fixture()
        ops.config.pop('migration'); ops.config.pop('bookingLinksVersion')
        ops.command = lambda *_, **__: b'4'
        with self.assertRaisesRegex(RuntimeError, 'RELEASE_PIN_REQUIRED'):
            booking_links.check_release_mode(ops, {})
        ops.command = lambda *_, **__: b'0'
        booking_links.check_release_mode(ops, {})
        ops.config['bookingLinksVersion'] = 1
        with patch.object(booking_links, 'check_active') as active:
            booking_links.check_release_mode(ops, {})
            active.assert_called_once_with(ops, {})

    def test_offline_component_check_has_no_network_credentials_or_database_writes(self):
        ops, transition = self.fixture(); ops.image_id = 'synthetic-image'
        result = {'bookingLinksVersion': None, 'readBudgetStoreId': 'a' * 36}
        with patch.object(ops, 'command', return_value=json.dumps(result).encode()) as command:
            self.assertEqual(transition.component_check(transition.data, False), result)
        args = command.call_args.args[0]
        self.assertEqual(args[args.index('--network') + 1], 'none')
        self.assertIn('readOnly:true', args[-1]); self.assertNotIn('immutable', args[-1])
        self.assertNotIn('--env', args)
        self.assertFalse(any('/secrets' in value for value in args))

    def test_short_shell_is_version_checked_before_and_after_ungate(self):
        ops, _ = self.fixture()
        ops.image_id = 'synthetic-image'
        ops.config['origin'] = 'https://synthetic.invalid'
        (ops.directory / 'image-proof.json').write_text(json.dumps({'build': 'synthetic-build', 'publicAssets': {}}))
        ops.inspect = lambda: {'Image': 'synthetic-image', 'State': {'Running': True}, 'RestartCount': 0}
        headers = {'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'", 'X-Content-Type-Options': 'nosniff'}
        for gated in [True, False]:
            ops.migration = SimpleNamespace(gated=lambda: gated)
            for short_status, short_body in [(404, b'synthetic-build'), (200, b'old-build'), (200, b'synthetic-build')]:
                seen = []
                def http(url):
                    seen.append(url)
                    if url.startswith('http://'): return 308, {}, b''
                    if url.endswith('/b/aaaaaaaa'): return short_status, {}, short_body
                    if url.endswith('/app.js'): raise RuntimeError('AFTER_PAGE_CHECKS')
                    return 200, headers, b'synthetic-build'
                expected = 'AFTER_PAGE_CHECKS' if short_status == 200 and short_body == b'synthetic-build' else 'PUBLIC_PAGE_VERSION_MISMATCH'
                with self.subTest(gated=gated, status=short_status, body=short_body), patch.object(checks, 'http', http), self.assertRaisesRegex(RuntimeError, expected):
                    checks.public_checks(ops)
                self.assertIn('https://synthetic.invalid/b/aaaaaaaa', seen)


class PublicationGateTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='cartoteca-publication-gate-')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        original = {'CARTOTECA_MAX_SCHEMA': '17', 'CARTOTECA_CABINET_SCHEMA': '1',
            'CARTOTECA_PUSH_ENABLED': '1', 'CARTOTECA_SCHEDULED_NOTIFICATIONS': '0',
            **read_budget.FLAGS, 'LOCAL_ONLY_PLACEHOLDER': '${UNCHANGED}'}
        current = {'Image': 'synthetic-new', 'State': {'Running': True},
            'Config': {'Image': 'synthetic-old-tag', 'Env': ['CARTOTECA_RELEASE_GATE=1']}}
        calls = []
        def command(args, **_):
            calls.append(args)
            if args[:2] == ['docker', 'compose']:
                return json.dumps({'name': 'ignored', 'services': {'app': {
                    'image': 'synthetic-old-tag', 'environment': original}}}).encode()
            if args[:2] == ['docker', 'run']:
                return json.dumps({'publicationGate': True, 'personalCalendarVersion': 1}).encode()
            raise AssertionError('Unexpected operation')
        ops = SimpleNamespace(directory=directory, root=directory, image_id='synthetic-new',
            request={'run': 'synthetic'}, config={'schema': 17, 'readBudgetVersion': 1,
                'bookingLinksVersion': 1, 'publicationGate': True, 'expectedImage': 'synthetic-old'},
            command=command, assert_previous=lambda: current, inspect=lambda: current)
        return ops, publication_gate.PublicationGate(ops), original, current, calls

    def test_gate_environment_preserves_all_existing_schema_and_delivery_flags(self):
        _, gate, original, _, _ = self.fixture()
        self.assertEqual(gate.override_environment(original, False), original)
        self.assertEqual(gate.override_environment(original, True), {**original, 'CARTOTECA_RELEASE_GATE': '1'})
        self.assertNotIn('CARTOTECA_RELEASE_GATE', original)

    def test_preflight_capability_probe_never_mounts_data_or_secrets(self):
        ops, gate, original, _, calls = self.fixture()
        gate.preflight()
        probe = next(args for args in calls if args[:2] == ['docker', 'run'])
        self.assertIn('none', probe)
        for argument in ['--mount', '--volume', '--env']: self.assertNotIn(argument, probe)
        self.assertNotIn('/data', probe[-1])
        self.assertNotIn('/secrets', probe[-1])
        self.assertEqual(json.loads(gate.journal.read_text()), {
            'prepared': True, 'committed': False, 'personalCalendarVersion': 1})
        gated = json.loads((ops.directory/'gated-production.override.yaml').read_text())
        enabled = json.loads((ops.directory/'enabled-production.override.yaml').read_text())
        self.assertEqual(enabled['services']['app']['environment'], original)
        self.assertEqual(gated['services']['app']['environment'], {**original, 'CARTOTECA_RELEASE_GATE': '1'})
        self.assertEqual(enabled['services']['app']['image'], 'cartoteca:release-synthetic')

    def test_agent_commit_marker_blocks_preflight_before_any_docker_operation(self):
        ops, gate, _, _, calls = self.fixture()
        gate.record(prepared=True, committed=False)
        agent.atomic(ops.directory/'state.json', {'activationCommitted': True})
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_KEEP_CURRENT_DATA'):
            gate.preflight()
        self.assertEqual(calls, [])
        self.assertFalse((ops.directory/'gated-production.override.yaml').exists())

    def test_both_durable_commit_markers_block_direct_old_image_rollback(self):
        ops, gate, _, _, _ = self.fixture()
        gate.assert_rollback_safe()
        gate.record(prepared=True, committed=True)
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_KEEP_CURRENT_DATA'):
            gate.assert_rollback_safe()
        gate.record(committed=False)
        agent.atomic(ops.directory/'state.json', {'activationCommitted': True})
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_KEEP_CURRENT_DATA'):
            gate.assert_rollback_safe()

    def test_even_without_commit_marker_ungated_or_foreign_writer_blocks_rollback(self):
        _, gate, _, current, _ = self.fixture()
        current['Config']['Env'] = []
        with self.assertRaisesRegex(RuntimeError, 'WRITERS_MAY_BE_ACTIVE'):
            gate.assert_rollback_safe()
        current['Image'] = 'foreign'
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_CHANGED'):
            gate.assert_rollback_safe()

    def test_helper_commits_durably_before_enabling_configuration(self):
        ops, gate, _, current, _ = self.fixture()
        gate.record(prepared=True, committed=False)
        calls = []
        def replace_configs(**kwargs):
            self.assertIs(json.loads(gate.journal.read_text())['committed'], True)
            self.assertEqual(kwargs, {'phase': 'enabled'})
            calls.append('replace')
        def compose(*args):
            calls.append('compose')
            current['Config']['Env'] = []
        ops.replace_configs, ops.compose = replace_configs, compose
        ops.wait_ready = lambda image: calls.append('ready')
        gate.activate()
        self.assertEqual(calls, ['replace', 'compose', 'ready'])
        with self.assertRaisesRegex(RuntimeError, 'COMMITTED_KEEP_CURRENT_DATA'):
            gate.assert_rollback_safe()


class PortableImageTests(unittest.TestCase):
    def fixture(self, requested='config', target='manifest', architecture='amd64', tamper=False):
        temporary = tempfile.TemporaryDirectory(prefix='cartoteca-image-identity-')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        config = json.dumps({'os': 'linux', 'architecture': architecture}).encode()
        config_id = 'sha256:' + hashlib.sha256(config).hexdigest()
        manifest = json.dumps({'config': {'digest': config_id}, 'layers': []}).encode()
        manifest_id = 'sha256:' + hashlib.sha256(manifest).hexdigest()
        identities = {'config': config_id, 'manifest': manifest_id, 'unknown': 'sha256:' + '0' * 64}
        archive = directory / 'image.tar'
        with tarfile.open(archive, 'w:gz') as tar:
            files = {'index.json': json.dumps({'manifests': [{'digest': manifest_id}]}).encode(),
                     'blobs/sha256/' + manifest_id.split(':')[1]: manifest,
                     'blobs/sha256/' + config_id.split(':')[1]: b'changed' if tamper else config}
            for name, content in files.items():
                member = tarfile.TarInfo(name); member.size = len(content)
                tar.addfile(member, io.BytesIO(content))
        class FakeOperations:
            def command(self, args):
                if args[3] == identities[target]:
                    return identities[target].encode()
                raise RuntimeError('COMMAND_FAILED')
        ops = FakeOperations()
        ops.directory = directory
        ops.root = directory
        ops.request = {'imageId': identities[requested], 'imageHash': agent.digest(archive)}
        return ops, archive, identities[target]

    def test_config_identity_resolves_to_verified_containerd_manifest(self):
        ops, archive, expected = self.fixture()
        self.assertEqual(checks.resolve_image(ops, archive), expected)
        self.assertEqual(checks.candidate_image(ops), expected)

    def test_cache_probe_retains_both_archive_proven_identity_conversions(self):
        for requested,target in [('config','manifest'),('manifest','config')]:
            with self.subTest(requested=requested,target=target):
                ops,archive,expected=self.fixture(requested=requested,target=target)
                original=ops.command;loads=[]
                def command(args,**kwargs):
                    if args[:2]==['docker','load']:loads.append(args);return b''
                    if args[3]==ops.request['imageId']:return expected.encode()
                    return original(args)
                ops.command=command
                self.assertTrue(checks.load_image_if_missing(ops,archive))
                self.assertEqual(checks.resolve_image(ops,archive),expected)
                self.assertEqual(checks.candidate_image(ops),expected)
                self.assertEqual(len(loads),1)

    def test_cache_fallback_cannot_qualify_an_unrelated_archive_identity(self):
        ops,archive,_=self.fixture(requested='unknown')
        original=ops.command;loads=[]
        def command(args,**kwargs):
            if args[:2]==['docker','load']:loads.append(args);return b''
            return original(args)
        ops.command=command
        self.assertTrue(checks.load_image_if_missing(ops,archive))
        with self.assertRaisesRegex(RuntimeError,'ARCHIVE_IMAGE_MISMATCH'):checks.resolve_image(ops,archive)
        self.assertEqual(len(loads),1)

    def test_manifest_identity_resolves_to_verified_classic_config(self):
        ops, archive, expected = self.fixture(requested='manifest', target='config')
        self.assertEqual(checks.resolve_image(ops, archive), expected)

    def test_matching_identity_needs_no_conversion(self):
        ops, archive, expected = self.fixture(requested='config', target='config')
        self.assertEqual(checks.resolve_image(ops, archive), expected)

    def test_unrelated_identity_is_rejected(self):
        ops, archive, _ = self.fixture(requested='unknown')
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_IMAGE_MISMATCH'):
            checks.resolve_image(ops, archive)

    def test_changed_blob_is_rejected(self):
        ops, archive, _ = self.fixture(tamper=True)
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_BLOB_CHANGED'):
            checks.resolve_image(ops, archive)

    def test_wrong_platform_is_rejected(self):
        ops, archive, _ = self.fixture(architecture='arm64')
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_IMAGE_MISMATCH'):
            checks.resolve_image(ops, archive)

    def test_saved_identity_cannot_be_used_for_another_archive(self):
        ops, archive, _ = self.fixture()
        checks.resolve_image(ops, archive)
        ops.request['imageHash'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'IMAGE_IDENTITY_CHANGED'):
            checks.candidate_image(ops)

    def test_max_probe_uses_current_namespace_without_bot_credentials(self):
        ops, archive, expected = self.fixture(requested='config', target='config')
        ops.config = {'container': 'synthetic-current-app', 'schema': 15}
        ops.request.update(imageBytes=archive.stat().st_size, runtime={})
        ops.migration = None
        current = {'Config': {'Env': ['CARTOTECA_MAX_ENABLED=1', 'CARTOTECA_MAX_SCHEMA=15']}}
        ops.assert_previous = lambda: current
        ops.compose = lambda *args, **kwargs: b''
        commands = []
        def command(args, **kwargs):
            commands.append(args)
            if args[:2] == ['docker', 'exec']:
                return b'0' if 'booking_public_links' in args[-1] else b'15'
            if args[:2] == ['docker', 'image']: return expected.encode()
            if '/tmp/probe.cjs' in args: return b'{"build":"synthetic","publicAssets":{}}'
            return b''
        ops.command = command
        checks.preflight(ops)
        probe = next(args for args in commands if '-e' in args and args[:2] == ['docker', 'run'])
        self.assertEqual(probe[probe.index('--network') + 1], 'container:synthetic-current-app')
        self.assertNotIn('--env', probe)
        self.assertNotIn('--mount', probe)
        self.assertIn('r.status!==401', probe[-1])


class AssistantSavingTests(unittest.TestCase):
    def test_remote_request_guard_requires_exact_version_and_all_safe_pins(self):
        safe = {'assistantSavingVersion': 1, 'publicationGate': True, 'schema': 17,
                'readBudgetVersion': 1, 'bookingLinksVersion': 1}
        agent.assert_assistant_saving_version({})
        agent.assert_assistant_saving_version(safe)
        invalid = [{'assistantSavingVersion': value} for value in [0, 2, True, False, '1', None]]
        invalid += [{'publicationGate': value} for value in [None, False, 1, 'true']]
        invalid += [{'schema': 18}, {'migration': 'booking-links-17'},
                    {'readBudgetVersion': None}, {'bookingLinksVersion': None}]
        for patch in invalid:
            with self.subTest(patch=patch), self.assertRaisesRegex(RuntimeError, 'INVALID_ASSISTANT_SAVING_VERSION'):
                agent.assert_assistant_saving_version({**safe, **patch})

    def current(self, gated=False):
        env = ['NODE_ENV=production', 'CARTOTECA_ASSISTANT_APPOINTMENT_SAVING=1']
        if gated: env.append('CARTOTECA_RELEASE_GATE=1')
        return {'Config': {'Cmd': ['node', 'multi-server.cjs'],
                'Entrypoint': ['docker-entrypoint.sh'], 'Env': env}}

    def test_explicit_optin_survives_gate_then_activation_without_touching_other_flags(self):
        original = {'KEEP': 'synthetic', 'CARTOTECA_PUSH_ENABLED': '1'}
        gate = publication_gate.PublicationGate(SimpleNamespace(
            config={'assistantSavingVersion': 1}, directory=Path('/synthetic')))
        self.assertEqual(gate.override_environment(original, True), {**original,
            'CARTOTECA_ASSISTANT_APPOINTMENT_SAVING': '1', 'CARTOTECA_RELEASE_GATE': '1'})
        self.assertEqual(gate.override_environment(original, False), {**original,
            'CARTOTECA_ASSISTANT_APPOINTMENT_SAVING': '1'})
        self.assertEqual(original, {'KEEP': 'synthetic', 'CARTOTECA_PUSH_ENABLED': '1'})
        gate.ops.config = {}
        self.assertEqual(gate.override_environment(original, False), original)
        existing = {**original, 'CARTOTECA_ASSISTANT_APPOINTMENT_SAVING': '1'}
        self.assertEqual(gate.override_environment(existing, False), existing)

    def test_old_preflight_accepts_previous_flagoff_but_same_known_single_process(self):
        old = self.current(); old['Config']['Env'] = ['NODE_ENV=production']
        self.assertEqual(checks.assistant_process(old, False, require_saving=False), 'combined')
        with self.assertRaisesRegex(RuntimeError, 'ASSISTANT_SINGLE_PROCESS_REQUIRED'):
            checks.assistant_process(old, False)

    def test_gated_and_active_admission_read_no_provider_or_clinical_state(self):
        for gated in [True, False]:
            proof = {'assistantSavingVersion': 1, 'assistantSavingEnabled': not gated,
                     'assistantProcessRole': 'combined', 'assistantSingleProcess': True}
            calls = []
            ops = SimpleNamespace(config={'assistantSavingVersion': 1, 'container': 'synthetic'},
                command=lambda args: (calls.append(args) or json.dumps(proof).encode()))
            self.assertEqual(checks.check_assistant_saving(ops, self.current(gated), gated), proof)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:5], ['docker', 'exec', 'synthetic', 'node', '-e'])
            self.assertNotIn('fetch(', calls[0][-1]); self.assertNotIn('platform.sqlite', calls[0][-1])
            ops.config = {}
            self.assertEqual(checks.check_assistant_saving(ops, {}, gated), {})
            self.assertEqual(len(calls), 1)

    def test_unknown_topologies_and_changed_admission_fail_before_runtime_probe(self):
        for name, value in [('NODE_ENV', 'development'), ('CARTOTECA_PROCESS_ROLE', 'background'),
                            ('WEB_CONCURRENCY', '2'), ('CARTOTECA_ASSISTANT_APPOINTMENT_SAVING', '0'),
                            ('CARTOTECA_RELEASE_GATE', '1')]:
            current = self.current()
            current['Config']['Env'] = [item for item in current['Config']['Env']
                                      if not item.startswith(name + '=')] + [name + '=' + value]
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, 'ASSISTANT_SINGLE_PROCESS_REQUIRED'):
                checks.assistant_process(current, False)
        for field, value in [('Cmd', ['node', 'scripts/start-workers.cjs']),
                             ('Cmd', ['sh', '-c', 'node multi-server.cjs']),
                             ('Entrypoint', ['custom-wrapper'])]:
            current = self.current(); current['Config'][field] = value
            with self.assertRaisesRegex(RuntimeError, 'ASSISTANT_SINGLE_PROCESS_REQUIRED'):
                checks.assistant_process(current, False)

    def publication_fixture(self, document_patch=None, ids=b'synthetic-id\n'):
        temporary = tempfile.TemporaryDirectory(prefix='cartoteca-assistant-publication-')
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        original = {'KEEP': 'synthetic', 'CARTOTECA_PUSH_ENABLED': '1'}
        app = {'image': 'synthetic-old-tag', 'environment': original}
        if document_patch: app.update(document_patch)
        current = self.current(); current['Id'] = 'synthetic-id'
        current['Config']['Image'] = 'synthetic-old-tag'
        current['Config']['Env'] = ['NODE_ENV=production']
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if args[:2] == ['docker', 'compose']:
                return json.dumps({'services': {'app': app}}).encode()
            if args[:2] == ['docker', 'ps']: return ids
            if args[:2] == ['docker', 'run']:
                return b'{"publicationGate":true,"personalCalendarVersion":1}'
            raise AssertionError('Unexpected real operation')
        ops = SimpleNamespace(directory=directory, root=directory, image_id='synthetic-new',
            request={'run': 'synthetic-run'},
            config={'schema': 17, 'readBudgetVersion': 1, 'bookingLinksVersion': 1,
                    'publicationGate': True, 'assistantSavingVersion': 1, 'project': 'synthetic'},
            assert_previous=lambda: current, command=command)
        return ops, publication_gate.PublicationGate(ops), original, calls

    def test_preflight_pins_one_previous_app_and_generates_both_admitted_phases(self):
        ops, gate, original, calls = self.publication_fixture()
        # Portable fake: durability is covered by existing Linux worker tests.
        with patch.object(agent, 'atomic', lambda file, value: file.write_text(json.dumps(value))):
            gate.preflight()
        for phase, gated in [('gated', True), ('enabled', False)]:
            env = json.loads((ops.directory / (phase + '-production.override.yaml')).read_text())['services']['app']['environment']
            expected = {**original, 'CARTOTECA_ASSISTANT_APPOINTMENT_SAVING': '1'}
            if gated: expected['CARTOTECA_RELEASE_GATE'] = '1'
            self.assertEqual(env, expected)
        self.assertEqual(len([args for args in calls if args[:2] == ['docker', 'ps']]), 1)

    def test_preflight_refuses_custom_or_multiple_apps_before_capability_run(self):
        cases = [({'command': ['node', 'scripts/start-workers.cjs']}, b'synthetic-id\n'),
                 ({'entrypoint': ['custom-wrapper']}, b'synthetic-id\n'),
                 ({'scale': 2}, b'synthetic-id\n'), ({'deploy': {'replicas': 2}}, b'synthetic-id\n'),
                 ({}, b'synthetic-id\nsecond-app\n'), ({}, b'unrelated-container\n')]
        for document, ids in cases:
            ops, gate, original, calls = self.publication_fixture(document, ids)
            with self.subTest(document=document, ids=ids), self.assertRaisesRegex(RuntimeError, 'ASSISTANT_SINGLE_PROCESS_REQUIRED'):
                gate.preflight()
            self.assertFalse(any(args[:2] == ['docker', 'run'] for args in calls))
            self.assertFalse((ops.directory / 'gated-production.override.yaml').exists())

    def test_incomplete_runtime_proof_cannot_qualify_admission(self):
        ops = SimpleNamespace(config={'assistantSavingVersion': 1, 'container': 'synthetic'},
            command=lambda args: b'{"assistantSavingVersion":1}')
        with self.assertRaisesRegex(RuntimeError, 'ASSISTANT_ADMISSION_NOT_CONFIRMED'):
            checks.check_assistant_saving(ops, self.current(), False)
        for changes in [{'assistantSavingVersion': True}, {'assistantSavingEnabled': 1},
                        {'assistantSingleProcess': 1}]:
            proof = {'assistantSavingVersion': 1, 'assistantSavingEnabled': True,
                     'assistantProcessRole': 'combined', 'assistantSingleProcess': True, **changes}
            ops.command = lambda args, value=proof: json.dumps(value).encode()
            with self.subTest(changes=changes), self.assertRaisesRegex(RuntimeError, 'ASSISTANT_ADMISSION_NOT_CONFIRMED'):
                checks.check_assistant_saving(ops, self.current(), False)


if __name__ == '__main__':
    unittest.main()
