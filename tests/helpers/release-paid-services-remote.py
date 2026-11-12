"""Targeted synthetic paid-services deployment tests; all operational effects replaced."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('paid_release_fakes',HERE/'release-paid-services-fakes.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class PaidServicesRemoteTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='cartoteca-paid-release-synthetic-')
        self.addCleanup(temporary.cleanup);self.root=Path(temporary.name)
        self.atomic=patch.object(f.agent,'atomic',f.atomic);self.atomic.start();self.addCleanup(self.atomic.stop)

    def fixture(self,ordinary=False): return f.transition(self.root,ordinary)

    def guards(self,value):
        for name in ['assert_backup_paused','assert_other_writers_stopped']:
            mocked=patch.object(value,name);mocked.start();self.addCleanup(mocked.stop)

    def test_contract_accepts_only_exact_pinned_full_transition_or_ordinary19(self):
        for ordinary in [False,True]:
            safe=f.config(ordinary);f.paid.assert_contract(safe);f.agent.assert_assistant_saving_version(safe)
            for name in ['readBudgetVersion','bookingLinksVersion','assistantSavingVersion']:
                for wrong in [None,0,2,True,'1']:
                    with self.subTest(name=name,wrong=wrong),self.assertRaises(RuntimeError):
                        f.paid.assert_contract({**safe,name:wrong})
            for wrong in [None,True,0,'false']:
                with self.subTest(payment=wrong),self.assertRaises(RuntimeError):
                    f.paid.assert_contract({**safe,'paymentNetworkEnabled':wrong})
        for fields in [{'publicationGate':False},{'publicationGate':True},{'migration':'structural-17-to-18'}]:
            with self.assertRaises(RuntimeError):f.paid.assert_contract({**f.config(),**fields})
        f.agent.assert_assistant_saving_version(dict(schema=17,assistantSavingVersion=1,
            readBudgetVersion=1,bookingLinksVersion=1,publicationGate=True))

    def test_operations_selects_dedicated_platform_only_migration(self):
        ops=f.operations.Operations(dict(config={**f.config(),'root':str(self.root)},run='synthetic'),self.root)
        self.assertIsInstance(ops.migration,f.paid.PaidServicesMigration)
        self.assertEqual(ops.migration.previous_schema,17)
        self.assertEqual(ops.migration.schema,19)
        self.assertEqual(ops.migration.stage,self.root/'paid-services-synthetic')

    def test_override_changes_only_three_explicit_flags(self):
        _,value=self.fixture()
        original={'CARTOTECA_CABINET_SCHEMA':'0','CARTOTECA_SCHEDULED_NOTIFICATIONS':'0',
            'CARTOTECA_PUSH_ENABLED':'1','CARTOTECA_MAX_SCHEMA':'17',
            'CARTOTECA_ASSISTANT_APPOINTMENT_SAVING':'1','KEEP':'${LOCAL_ONLY}'}
        for gated in [True,False]:
            result=value.override_environment(original,gated)
            for name in original:
                if name!='CARTOTECA_MAX_SCHEMA':self.assertEqual(result[name],original[name])
            self.assertEqual(result['CARTOTECA_MAX_SCHEMA'],'19')
            self.assertEqual(result['CARTOTECA_PAYMENT_NETWORK_ENABLED'],'0')
            self.assertEqual(result['CARTOTECA_RELEASE_GATE'],'1' if gated else '0')
        self.assertNotIn('CARTOTECA_RELEASE_GATE',original)

    def test_schema_checks_are_explicit17_before_and19_after_without_ddl(self):
        for schema in [17,19]:
            for code in [f.paid.state_code(schema),f.read_budget.store_check_code(True,True,schema),
                         f.booking_links.component_code(True,schema)]:
                self.assertIn('='+str(schema)+';',code)
                self.assertNotIn('CREATE TABLE',code);self.assertNotIn('INSERT INTO',code)
                result=subprocess.run([shutil.which('node') or 'node','--check'],input=code,text=True,capture_output=True)
                self.assertEqual(result.returncode,0,result.stderr)
        for wrong in [True,18,'19',None]:
            with self.assertRaises(RuntimeError):f.paid.state_code(wrong)

    def test_live_proof_checks_durable_components_and_original_cabinet_schemas(self):
        ops,value=self.fixture()
        proof=f.paid.check_active(ops,ops.inspect())
        self.assertEqual(proof,dict(paymentNetworkEnabled=False,platformOnly=True,
            componentsPreserved=True,cabinetSchemaUnchanged=True,scheduleModeUnchanged=True))
        ops.live['cabinets']['b'*64]=2
        with self.assertRaisesRegex(RuntimeError,'COMPONENTS_CHANGED'):f.paid.check_active(ops,ops.inspect())

    def test_gated_checks_reject_reassigned_mapping_but_admitted_new_cabinets_are_valid(self):
        ops,value=self.fixture();ops.live['publicLinksFingerprint']='c'*64
        with self.assertRaisesRegex(RuntimeError,'COMPONENTS_CHANGED'):f.paid.check_active(ops,ops.inspect())
        ops.current['Config']['Env']=[v for v in ops.current['Config']['Env'] if not v.startswith('CARTOTECA_RELEASE_GATE=')]
        ops.live['cabinets']['d'*64]=1
        self.assertTrue(f.paid.check_active(ops,ops.inspect())['componentsPreserved'])

    def test_payment_network_and_changed_scheduler_fail_before_proof_claim(self):
        ops,value=self.fixture()
        ops.current['Config']['Env'].append('CARTOTECA_PAYMENT_NETWORK_ENABLED=1')
        with self.assertRaisesRegex(RuntimeError,'CONFIGURATION_MISMATCH'):f.paid.check_active(ops,ops.inspect())
        self.assertFalse(ops.calls)
        ops.current['Config']['Env'].pop();ops.current['Config']['Env'].append('CARTOTECA_SCHEDULED_NOTIFICATIONS=1')
        with self.assertRaisesRegex(RuntimeError,'PRESERVATION_NOT_CONFIRMED'):f.paid.check_active(ops,ops.inspect())

    def test_unverified_journal_never_generates_paid_services_public_success(self):
        ops,value=self.fixture();state=json.loads(value.journal.read_text())
        state['paidServices']['verified']=False;f.atomic(value.journal,state)
        with self.assertRaisesRegex(RuntimeError,'PRESERVATION_NOT_CONFIRMED'):f.paid.check_active(ops,ops.inspect())

    def test_preparation_receipt_requires_two_real_synthetic_archives_and_all_preservation_fields(self):
        _,value=self.fixture();archives=self.root/'archives';archives.mkdir()
        result=f.prepared_result();state={'volumes':{'/backups':str(archives)}}
        for name in ['beforeArchive','preparedArchive']:(archives/Path(result[name]).name).write_bytes(b'synthetic-archive')
        value.validate_preparation(result,state,f.proof())
        for name in ['sourceUnchanged','sessionsRevoked','clientBindingsPreserved','cabinetSchemaUnchanged',
                     'scheduleModeUnchanged','paymentNetworkEnabled','previousSchema']:
            bad=copy.deepcopy(result);bad[name]=None
            with self.subTest(name=name),self.assertRaises(RuntimeError):value.validate_preparation(bad,state,f.proof())
        bad=copy.deepcopy(result);bad['preservation']['files']=0
        with self.assertRaises(RuntimeError):value.validate_preparation(bad,state,f.proof())
        bad=copy.deepcopy(result);bad['preparedArchive']=bad['beforeArchive']
        with self.assertRaises(RuntimeError):value.validate_preparation(bad,state,f.proof())
        bad=copy.deepcopy(result);bad['readBudgetStoreId']='00000000-0000-4000-8000-000000000000'
        with self.assertRaises(RuntimeError):value.validate_preparation(bad,state,f.proof())

    def test_activation_records_durable_commit_before_enabling_writers(self):
        ops,value=self.fixture();self.guards(value)
        f.atomic(ops.directory/'state.json',{'migrationCommitted':True})
        value.activate()
        self.assertTrue(json.loads(value.journal.read_text())['committed'])
        self.assertFalse(value.gated())
        self.assertTrue(ops.current['State']['Running'])

    def test_uninstalled_or_wrong_image_cannot_activate(self):
        ops,value=self.fixture();state=json.loads(value.journal.read_text());state['installed']=False
        f.atomic(value.journal,state)
        with self.assertRaisesRegex(RuntimeError,'GATE_NOT_CONFIRMED'):value.activate()
        state['installed']=True;f.atomic(value.journal,state);ops.current['Image']='sha256:'+'1'*64
        with self.assertRaisesRegex(RuntimeError,'GATE_NOT_CONFIRMED'):value.activate()
        self.assertFalse(ops.calls)

    def test_rollback_before_commit_retains_failed19_and_returns_original17(self):
        ops,value=self.fixture();self.guards(value)
        value.stage.mkdir();value.retained.mkdir();(value.retained/'original').write_text('synthetic17')
        (value.data/'latest').write_text('synthetic19-gated')
        with patch.object(f.migration,'sync_directory'):
            value.rollback_data()
        self.assertEqual((value.data/'original').read_text(),'synthetic17')
        self.assertEqual((value.stage/'failed-data/latest').read_text(),'synthetic19-gated')

    def test_outer_or_inner_durable_commit_blocks_all_data_rollback(self):
        ops,value=self.fixture();self.guards(value)
        for outer in [True,False]:
            f.atomic(ops.directory/'state.json',{'migrationCommitted':outer})
            state=json.loads(value.journal.read_text());state['committed']=not outer;f.atomic(value.journal,state)
            with self.assertRaisesRegex(RuntimeError,'COMMITTED_KEEP_CURRENT_DATA'):value.rollback_data()
        self.assertFalse(ops.calls)

    def test_quarantine_keeps_latest_current_data_and_refuses_foreign_image(self):
        ops,value=self.fixture();(value.data/'latest').write_text('synthetic-post-commit')
        value.quarantine();self.assertFalse(ops.current['State']['Running'])
        self.assertEqual((value.data/'latest').read_text(),'synthetic-post-commit')
        ops.current['Image']='sha256:'+'1'*64
        with self.assertRaisesRegex(RuntimeError,'IMAGE_CHANGED'):value.quarantine()

    def test_ordinary19_uses_existing_data_proof_without_migration(self):
        ops,gate=self.fixture(ordinary=True)
        ops.current['Config']['Env']=[v for v in ops.current['Config']['Env'] if not v.startswith('CARTOTECA_RELEASE_GATE=')]
        f.paid.prepare_publication(gate,ops.inspect())
        self.assertTrue(f.paid.check_active(ops,ops.inspect())['platformOnly'])
        enabled=gate.override_environment({'KEEP':'same'},False)
        self.assertEqual(enabled['CARTOTECA_RELEASE_GATE'],'0')
        self.assertEqual(enabled['CARTOTECA_PAYMENT_NETWORK_ENABLED'],'0')
        self.assertIsNone(ops.migration)

    def test_executor_rolls_back_only_before_durable_paid_admission(self):
        for index,failure in enumerate(['prepare','public-gated','activate','public-active']):
            directory=self.root/str(index);directory.mkdir()
            state,events=f.scenario(directory,failure)
            if failure in ['prepare','public-gated']:
                self.assertEqual(state['status'],'rolled_back');self.assertIn('rollback',events)
                self.assertNotIn('quarantine',events)
            else:
                self.assertEqual(state['status'],'needs_attention');self.assertIn('quarantine',events)
                self.assertNotIn('rollback',events)
                self.assertTrue(state['migrationCommitted'])
                self.assertEqual(state['error'],'ACTIVATION_FAILED_KEEP_CURRENT_DATA')
            self.assertIn('timer',events)

    def test_executor_full_success_orders_backups_checks_and_committed_activation(self):
        state,events=f.scenario(self.root)
        self.assertEqual(state['status'],'completed')
        self.assertLess(events.index('backup-before'),events.index('stop'))
        self.assertLess(events.index('public-gated'),events.index('activate'))
        self.assertLess(events.index('public-active'),events.index('backup-after'))
        self.assertTrue(state['migrationCommitted'])

    def test_failed_quarantine_and_post_backup_never_revert_admitted_data(self):
        state,events=f.scenario(self.root,('activate','quarantine'))
        self.assertEqual(state['error'],'ACTIVATION_FAILED_STOP_REQUIRES_ATTENTION')
        self.assertNotIn('rollback',events)
        directory=self.root/'backup-case';directory.mkdir()
        state,events=f.scenario(directory,'backup-after')
        self.assertEqual(state['status'],'published_backup_pending')
        self.assertTrue(state['published']);self.assertNotIn('rollback',events)


prepared_spec=importlib.util.spec_from_file_location('paid_release_preparation',HERE/'release-paid-services-preparation.py')
prepared=importlib.util.module_from_spec(prepared_spec);prepared_spec.loader.exec_module(prepared)
PreparationTests=prepared.PreparationTests

if __name__=='__main__':unittest.main(verbosity=2)
