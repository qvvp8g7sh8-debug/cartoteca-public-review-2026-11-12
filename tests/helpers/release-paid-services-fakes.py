"""Temporary synthetic executor objects; no Docker, systemd, HTTP or provider calls."""
import contextlib
import copy
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/release/remote'))
if sys.platform == 'win32':
    # The production module is Linux-only. Every lock operation is replaced below.
    sys.modules.setdefault('fcntl', SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None))
import agent
import operations
import migration
import paid_services as paid
import publication_gate
import read_budget
import booking_links


def atomic(file, value):
    temporary = file.with_name(file.name + '.synthetic-next')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    temporary.replace(file)


def config(ordinary=False):
    result = dict(schema=19, readBudgetVersion=1, bookingLinksVersion=1,
                  assistantSavingVersion=1, paymentNetworkEnabled=False,
                  container='synthetic-app', backupTimer='synthetic.timer')
    result.update(publicationGate=True) if ordinary else result.update(migration=paid.MIGRATION)
    return result


def proof(schema=17):
    return dict(schema=schema, readBudgetVersion=1, bookingLinksVersion=1,
                readBudgetStoreId='12345678-1234-4234-8234-123456789012',
                publicLinksFingerprint='a'*64, cabinets={'b'*64: 1})


def prepared_result():
    return dict(schema=19, previousSchema=17, sourceUnchanged=True, sessionsRevoked=False,
        clientBindingsPreserved=True, requiresStoppedSourceBeforeSwitch=True,
        readBudgetVersion=1, bookingLinksVersion=1, readBudgetStoreId=proof()['readBudgetStoreId'],
        publicLinksFingerprint=proof()['publicLinksFingerprint'], paymentNetworkEnabled=False,
        billingConfiguredByDefault=False, paidServicesEnabledByDefault=False,
        cabinetSchemaUnchanged=True, scheduleModeUnchanged=True,
        preservation=dict(sourceSha256='c'*64, originalTableSha256='d'*64, originalTables=20, files=7),
        beforeArchive='/backups/cartoteca-v2-before.enc', preparedArchive='/backups/cartoteca-v2-prepared.enc')


class FakeOperations:
    def __init__(self, root, ordinary=False):
        self.root, self.directory = root/'app', root/'run'
        self.root.mkdir(); self.directory.mkdir(); (self.root/'data').mkdir()
        self.config = config(ordinary)
        self.request = dict(run='synthetic', config=self.config)
        self.image_id = 'sha256:'+'f'*64
        self.current = dict(Id='synthetic-id', Image=self.image_id, State=dict(Running=True),
            Config=dict(Env=['NODE_ENV=production','CARTOTECA_ASSISTANT_APPOINTMENT_SAVING=1',
                'CARTOTECA_SHARED_CABINET_WRITES=1','CARTOTECA_ISOLATED_READ_BUDGETS=1',
                'CARTOTECA_READ_BUDGET_VERSION=1','CARTOTECA_MAX_SCHEMA=19',
                'CARTOTECA_PAYMENT_NETWORK_ENABLED=0','CARTOTECA_RELEASE_GATE=1'],
                Cmd=['node','multi-server.cjs'], Entrypoint=['docker-entrypoint.sh']))
        self.live = proof(19); self.calls=[]
        self.migration = None; self.publication = None

    def inspect(self): return copy.deepcopy(self.current)
    def command(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ['docker', 'exec'] and 'node' in args:
            return json.dumps(self.live).encode()
        raise AssertionError('Unexpected executor command')
    def compose(self, *args):
        self.calls.append((list(args), {}))
        if args[0]=='stop': self.current['State']['Running']=False
        elif args[0]=='up': self.current['State']['Running']=True
        else: raise AssertionError(args)
    def replace_configs(self, phase):
        assert phase=='enabled'
        state=json.loads(self.migration.journal.read_text())
        assert state['committed'] is True
        self.current['Config']['Env']=[v for v in self.current['Config']['Env'] if not v.startswith('CARTOTECA_RELEASE_GATE=')]+['CARTOTECA_RELEASE_GATE=0']
    def wait_ready(self, image): assert image==self.image_id


def transition(root, ordinary=False):
    ops=FakeOperations(root, ordinary)
    value=publication_gate.PublicationGate(ops) if ordinary else paid.PaidServicesMigration(ops)
    if ordinary: ops.publication=value
    else: ops.migration=value
    value.record(prepared=True, installed=True, committed=False, paidServices={
        'source':proof(19 if ordinary else 17), 'prepared':proof(19),
        'flags':paid.preserved_flags(ops.current), 'verified':True})
    return ops,value


def scenario(directory, failure=None, ordinary=False):
    events=[]; request={'config':dict(config(ordinary), releaseRoot=str(directory))}
    def event(name):
        events.append(name)
        if name==failure or isinstance(failure,tuple) and name in failure:
            raise RuntimeError('SYNTHETIC_FAILURE')
    class Transition:
        def __init__(self,ops): self.ops=ops
        def stop(self): event('stop')
        def prepare(self): event('prepare')
        def install(self): event('install')
        def activate(self):
            outer=json.loads((directory/'state.json').read_text())
            assert outer['activationCommitted' if ordinary else 'migrationCommitted'] is True
            self.ops.image='new'; event('activate')
        def quarantine(self): event('quarantine')
    class Ops:
        def __init__(self,*_):
            self.image='old';self.timer_touched=False;self.backups=0;self.public_calls=0
            self.migration=None if ordinary else Transition(self)
            self.publication=Transition(self) if ordinary else None
        def save_configuration(self): event('save')
        def pause_timer(self): self.timer_touched=True;event('pause')
        def restore_timer(self): self.timer_touched=False;event('timer')
        def backup(self): self.backups+=1;event('backup-before' if self.backups==1 else 'backup-after')
        def assert_previous(self): event('previous')
        def switch(self): self.image='new';event('switch')
        def rollback(self): event('rollback');self.image='old'
        def inspect(self): return {'Image':self.image}
        def cleanup_storage(self): event('cleanup');return {}
    def public(ops): ops.public_calls+=1;event('public-gated' if ops.public_calls==1 else 'public-active')
    import checks
    with patch.object(agent,'exclusive',lambda *_:contextlib.nullcontext()), \
         patch.object(agent,'active',lambda *_:False), patch.object(operations,'Operations',Ops), \
         patch.object(checks,'preflight',lambda *_:event('preflight')), patch.object(checks,'public_checks',public):
        state=agent.execute_run(request,directory)
    return state,events
