"""Offline CLI and publication preparation with in-memory executor responses only."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('paid_preparation_fakes',HERE/'release-paid-services-fakes.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix='cartoteca-paid-preparation-synthetic-')
        self.addCleanup(temporary.cleanup);self.root=Path(temporary.name)
        atomic=patch.object(f.agent,'atomic',f.atomic);atomic.start();self.addCleanup(atomic.stop)

    def prepare(self,wrong_cabinet=False,incomplete=False):
        ops,value=f.transition(self.root);archives=self.root/'archives';archives.mkdir()
        result=f.prepared_result();state=json.loads(value.journal.read_text())
        state.update(prepared=False,volumes={'/data':str(value.data),'/backups':str(archives),'/secrets':str(self.root/'secrets')})
        state['paidServices']['verified']=False;f.atomic(value.journal,state)
        prepared=f.proof(19)
        if wrong_cabinet:prepared['cabinets']['b'*64]=2
        def command(args,**kw):
            self.assertEqual(args[args.index('--network')+1],'none')
            self.assertIn('--read-only',args);self.assertNotIn('--env',args)
            self.assertIn('type=bind,source='+str(self.root/'secrets')+',target=/secrets,readonly',args)
            self.assertEqual(args[-10:],[
                'scripts/prepare-paid-services-upgrade.cjs','--source','/data','--destination',
                '/prepared/data','--backups','/backups','--key','/secrets/backup.key','--offline'])
            self.assertEqual(kw,{'timeout':1830})
            (value.stage/'data').mkdir()
            if incomplete:(value.stage/'data/.restore-in-progress').write_text('synthetic')
            for name in ['beforeArchive','preparedArchive']:(archives/Path(result[name]).name).write_bytes(b'synthetic')
            return json.dumps(result).encode()
        ops.command=command
        with patch.object(value,'assert_backup_paused'),patch.object(value,'assert_other_writers_stopped'), \
             patch.object(value,'assert_source_tree'),patch.object(value,'assert_mount_isolation'), \
             patch.object(f.paid.os,'chown',create=True), \
             patch.object(value,'component_check',side_effect=[f.proof(17),prepared]) as component, \
             patch.object(value,'offline_store_check',return_value={'storeId':f.proof()['readBudgetStoreId']}) as budget:
            if wrong_cabinet or incomplete:
                with self.assertRaises(RuntimeError):value.prepare()
                self.assertFalse(json.loads(value.journal.read_text())['paidServices']['verified'])
            else:
                value.prepare()
                self.assertEqual(component.call_args_list[0].args,(value.data,17))
                self.assertEqual(component.call_args_list[1].args,(value.stage/'data',19))
                budget.assert_called_once_with(value.stage/'data',True,expected_schema=19,fence=True)
                saved=json.loads(value.journal.read_text())
                self.assertTrue(saved['prepared']);self.assertTrue(saved['paidServices']['verified'])

    def test_prepare_uses_full_offline_helper_and_checks_original_and_prepared_components(self):self.prepare()
    def test_cabinet_schema_changed_copy_never_passes_prepared_gate(self):self.prepare(wrong_cabinet=True)
    def test_incomplete_copy_never_passes_prepared_gate(self):self.prepare(incomplete=True)

    def test_component_release_checks_target17_before_and19_when_live(self):
        ops,_=f.transition(self.root)
        for module in [f.read_budget,f.booking_links]:
            with patch.object(module,'check_active') as active:
                module.check_release_mode(ops,ops.inspect())
                self.assertEqual(active.call_args.kwargs,{'expected_schema':17})
        for value in [True,'1',None]:
            bad=f.proof();bad['bookingLinksVersion']=value
            with self.assertRaises(RuntimeError):f.paid.validate_proof(bad,17)

    def test_ordinary19_preflight_keeps_existing_flags_and_generates_only_gates(self):
        ops,gate=f.transition(self.root,True)
        ops.config['project']='synthetic-project';ops.current['Config']['Image']='synthetic:previous'
        ops.current['Config']['Env']=[v for v in ops.current['Config']['Env'] if not v.startswith('CARTOTECA_RELEASE_GATE=')]+['CARTOTECA_RELEASE_GATE=0']
        ops.assert_previous=ops.inspect
        original={'CARTOTECA_RELEASE_GATE':'0','CARTOTECA_MAX_SCHEMA':'19',
            'CARTOTECA_CABINET_SCHEMA':'0','CARTOTECA_SCHEDULED_NOTIFICATIONS':'0',
            'CARTOTECA_PAYMENT_NETWORK_ENABLED':'0','UNCHANGED':'${SOURCE_ONLY}'}
        document={'services':{'app':{'image':'synthetic:previous','environment':original}}}
        def command(args,**kw):
            if args[:2]==['docker','compose']:return json.dumps(document).encode()
            if args[:3]==['docker','ps','-q']:return b'synthetic-id'
            if args[:2]==['docker','exec']:return json.dumps(f.proof(19)).encode()
            if args[:2]==['docker','run']:
                self.assertEqual(args[args.index('--network')+1],'none')
                self.assertNotIn('--mount',args);self.assertNotIn('--env',args)
                return b'{"publicationGate":true,"personalCalendarVersion":1}'
            raise AssertionError(args)
        ops.command=command;gate.preflight()
        for name,flag in [('gated','1'),('enabled','0')]:
            actual=json.loads((ops.directory/(name+'-production.override.yaml')).read_text())['services']['app']['environment']
            self.assertEqual(actual['CARTOTECA_RELEASE_GATE'],flag)
            for key in ['CARTOTECA_CABINET_SCHEMA','CARTOTECA_SCHEDULED_NOTIFICATIONS','UNCHANGED']:
                self.assertEqual(actual[key],original[key])
        self.assertTrue(json.loads(gate.journal.read_text())['paidServices']['verified'])
