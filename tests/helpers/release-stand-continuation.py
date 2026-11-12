"""Explicit last-three continuation, same frozen image; never a full stand retry."""
import ast
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
IDENTITY = {'candidate': 'interface-20261014-08',
    'sourceHash': 'b9725a1567efd44b2e5143ce7aadf0eab1e30b80f021a83647d73f094e0902e1',
    'imageId': 'sha256:7bf4fc9a6ef9411846e0e3b932f81dd989339dda646f5243b192c840432214f2'}
CONTROLLER = 'bae789dc11a84851ae3ff6991e79d32d811ca1eb202da03ce296b34a8b08cf54'
RUNTIME = '47594c9fdfe398498f7de24a5090901ab870d1358cc8ad2bddfec6b54a8d5312'
BEFORE = '1e75323809cb283abbf65ab6a028381ec7de10d975825665853c610c5b39a73b'
AFTER = '109be3b6a7278379d33f6352bb0fa9bed83106722482acdc68e82e9dac3601c9'
ORIGINAL = '5692d26751094d39c6938dcea2d023979182fe849e7bebc01fa834990d50e9c8'


def sha(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ordinary(path, directory=False):
    path = Path(path)
    info = path.lstat()
    assert not stat.S_ISLNK(info.st_mode) and path.resolve() == path
    assert stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    return path


def repaired_program(original, repaired):
    assert sha(original) == BEFORE and sha(repaired) == AFTER
    programs = []
    trees = [ast.parse(p.read_text()) for p in (original, repaired)]
    for tree in trees:
        assignments = [node for node in tree.body if isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'BUSINESS_API' for t in node.targets)]
        assert len(assignments) == 1
        node = assignments[0]
        programs.append(ast.literal_eval(node.value))
        node.value = ast.Constant(value='RECORDED_BUSINESS_API_OVERLAY')
    assert ast.dump(trees[0], include_attributes=False) == ast.dump(trees[1], include_attributes=False)
    assert programs[0].split(' const before=', 1)[1] == programs[1].split(' const before=', 1)[1]
    return programs[1]


def main():
    source, original, repaired, destination = map(lambda p: Path(p).resolve(), sys.argv[1:])
    ordinary(source, True); ordinary(original); ordinary(repaired)
    assert source == Path('/opt/cartoteca-checks/.release/candidates/interface-20261014-08/source')
    assert destination == Path('/opt/cartoteca-checks/interface-20261014-08/.release/candidates/interface-20261014-08/stand-continuation')
    assert not destination.exists() and not destination.is_symlink()
    assert sha(original) == ORIGINAL
    previous = json.loads(original.read_text())
    assert previous['candidate'] == IDENTITY['candidate'] and previous['sourceHash'] == IDENTITY['sourceHash']
    assert previous['passed'] is False and len(previous['scenarios']) == 34
    assert all(row['passed'] is True for row in previous['scenarios'])
    metadata = json.loads((source.parent/'candidate.json').read_text())
    assert metadata['id'] == IDENTITY['candidate'] and metadata['sourceHash'] == IDENTITY['sourceHash']
    assert {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()} == set(metadata['files'])
    for name, info in metadata['files'].items():
        file = source/name
        assert not file.is_symlink() and sha(file) == info['sha256']
    os.chdir(source)
    code = "const f=require('./scripts/release/files.cjs'),s=require('./scripts/release/state.cjs');const c=s.readCandidate('/opt/cartoteca-checks', 'interface-20261014-08');console.log(JSON.stringify({controller:f.controllerHash(c.data.files),runtime:f.objectHash(require('./scripts/release/deployment-plan.cjs').runtimeFiles(c))}));"
    fingerprints = json.loads(subprocess.check_output(['node', '-e', code], timeout=30))
    assert fingerprints == {'controller': CONTROLLER, 'runtime': RUNTIME}
    spec = importlib.util.spec_from_file_location('frozen_stand', source/'tests/helpers/release-stand.py')
    frozen = importlib.util.module_from_spec(spec); spec.loader.exec_module(frozen)
    fixture, command = frozen.fixture, frozen.command
    fixture.assert_disposable_environment(source)
    assert not Path('/opt/cartoteca-v2').exists()
    assert not command('docker', 'ps', '-aq')
    program = repaired_program(source/'tests/helpers/release-stand-publication-gate.py', repaired)
    fixture.publication_gate.BUSINESS_API = program
    stand = object.__new__(fixture.Fixture)
    stand.source, stand.image = source, 'cartoteca-ci:interface14'
    stand.base = ordinary('/opt/cartoteca-ci-stand', True)
    stand.root = ordinary(stand.base/'app', True)
    stand.releases = ordinary(stand.base/'releases', True)
    stand.results, stand.units = [], []
    stand.timer = 'cartoteca-ci-stand-backup.timer'
    for name in ['data', 'backups', 'keys', 'state', 'work', 'status']:
        ordinary(stand.root/name, True)
    for name in ['start.cjs', 'Caddyfile', 'sshd.conf', 'known_hosts', 'ssh-client', 'ssh-host', 'tls.crt', 'tls.key']:
        ordinary(stand.base/name)
    key = ordinary(stand.root/'keys/backup.key')
    assert key.stat().st_mode & 0o077 == 0
    access = ordinary('/run/cartoteca-ci-stand-ssh', True)
    assert access.stat().st_uid == 0 and stat.S_IMODE(access.stat().st_mode) == 0o700
    authorized = ordinary(access/'authorized_keys')
    assert authorized.stat().st_uid == 0 and stat.S_IMODE(authorized.stat().st_mode) == 0o600
    stand.archive = ordinary(stand.base/'image.tar')
    stand.image_hash = sha(stand.archive)
    for field, tag in [('old', 'previous'), ('new', 'interface14'), ('broken', 'broken'), ('activation', 'activation')]:
        value = command('docker', 'image', 'inspect', 'cartoteca-ci:'+tag, '--format', '{{.Id}}')
        assert re.fullmatch(r'sha256:[a-f0-9]{64}', value)
        setattr(stand, field, value)
    assert stand.new == IDENTITY['imageId']
    base_layers = json.loads(command('docker', 'image', 'inspect', stand.new))[0]['RootFS']['Layers']
    for image in [stand.old, stand.broken, stand.activation]:
        assert json.loads(command('docker', 'image', 'inspect', image))[0]['RootFS']['Layers'][:len(base_layers)] == base_layers
    retained_backup = ordinary(stand.root/'compose.backup.yaml').read_bytes()
    baseline_backup = json.loads(retained_backup)
    backup = baseline_backup['services']['backup']
    assert str(stand.root/'keys')+':/secrets' in backup['volumes']
    # A retained successful switch left the backup on the new managed tag.
    # Restore only the fixture's expected baseline image in memory, as setup did.
    retained_image = backup['image']
    assert retained_image == 'cartoteca-ci:previous' or re.fullmatch(r'cartoteca:release-r-[a-f0-9]{12}-[a-f0-9]{12}', retained_image)
    assert command('docker', 'image', 'inspect', retained_image, '--format', '{{.Id}}') == (stand.old if retained_image == 'cartoteca-ci:previous' else stand.new)
    backup['image'] = 'cartoteca-ci:previous'
    stand.backup_original = json.dumps(baseline_backup).encode()
    stand.ssh_args = ['-i', str(stand.base/'ssh-client'), '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile='+str(stand.base/'known_hosts')]
    setup = ast.parse((source/'tests/helpers/release-stand-fixture.py').read_text())
    expression = next(node.args[1] for node in ast.walk(setup) if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute) and node.func.attr == 'write'
        and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == 'start.cjs')
    assert all(isinstance(n, (ast.Constant, ast.BinOp, ast.Add, ast.Attribute, ast.Name, ast.Load)) for n in ast.walk(expression))
    expected_start = eval(compile(ast.Expression(expression), '<frozen-start>', 'eval'),
        {'__builtins__': {}, 'publication_gate': fixture.publication_gate,
         'booking_links': fixture.booking_links, 'read_budget': fixture.read_budget})
    assert (stand.base/'start.cjs').read_text() == expected_start
    for unit in ['cartoteca-ci-stand-caddy', 'cartoteca-ci-stand-sshd', stand.timer]:
        status = subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True)
        assert status.stdout.strip() != 'active'
    with (stand.releases/'deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        fcntl.flock(lock, fcntl.LOCK_UN)
    destination.mkdir(mode=0o755)
    proof = {'version': 1, **IDENTITY, 'originalReportSha256': ORIGINAL,
        'runtime': {'beforeSha256': RUNTIME, 'afterSha256': RUNTIME},
        'controller': {'beforeSha256': CONTROLLER, 'afterSha256': CONTROLLER},
        'helperOverlay': {'path': 'tests/helpers/release-stand-publication-gate.py',
            'beforeSha256': BEFORE, 'afterSha256': AFTER, 'astOnlyBusinessApi': True, 'changes': ['BUSINESS_API']},
        'passed': False, 'scenarios': [], 'gateFaults': {}}
    prior_proof = ordinary(destination.with_name('stand-continuation-cases01')/'supplement.json')
    saved = json.loads(prior_proof.read_text())
    assert saved['passed'] is False and len(saved['scenarios']) == 1
    assert all(saved[k] == proof[k] for k in ['candidate', 'sourceHash', 'imageId',
        'originalReportSha256', 'runtime', 'controller', 'helperOverlay'])
    first = saved['scenarios'][0]
    assert first['scenario'] == 'publication-gate-without-migration' and first['passed'] is True
    assert first['personalCalendarApi'] == dict(personalCreated=True, manualOverlapBlocked=True,
        publicOverlapBlocked=True, neighboringTimeAvailable=True, noPatientOrAppointmentCreated=True)
    stand.results.append(first)
    receipt = {'version': 1, 'identity': IDENTITY, 'originalReportSha256': ORIGINAL,
        'originalScenarioNames': [s['scenario'] for s in previous['scenarios']]+[
            'publication-gate-without-migration', 'publication-gate-startup-failure-returns-current',
            'publication-gate-activation-failure-keeps-current-data'],
        **{k: proof[k] for k in ['runtime', 'controller', 'helperOverlay']}}
    setup_proof = {'retainedBackupSha256': hashlib.sha256(retained_backup).hexdigest(),
        'baselineBackupSha256': hashlib.sha256(stand.backup_original).hexdigest(),
        'retainedImage': retained_image, 'baselineImage': 'cartoteca-ci:previous',
        'onlyBackupImageRestored': True, 'priorSupplementSha256': sha(prior_proof),
        'reusedSuccessfulScenarios': [first['scenario']],
        'freshSyntheticBaselinePerFaultCase': True}
    (destination/'setup-proof.json').write_text(json.dumps(setup_proof, indent=2))
    adapter = {'requestSha256': sha(__file__), 'proofSha256': sha(destination/'setup-proof.json')}
    proof['adapter'] = receipt['adapter'] = adapter
    try:
        command('systemctl', 'start', stand.timer)
        for unit, args in [('cartoteca-ci-stand-caddy', ['/usr/bin/caddy', 'run', '--config', str(stand.base/'Caddyfile'), '--adapter', 'caddyfile']),
                           ('cartoteca-ci-stand-sshd', ['/usr/sbin/sshd', '-D', '-e', '-f', str(stand.base/'sshd.conf')])]:
            command('systemd-run', '--unit='+unit, *args)
            stand.units.append(unit)
        deadline = time.monotonic()+15
        while True:
            ready = subprocess.run(['ssh', *stand.ssh_args, '-p', '22222',
                'root@127.0.0.1', 'true'], capture_output=True, timeout=5)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Retained stand SSH did not become ready')
            time.sleep(0.3)
        # Retain previous synthetic data by the frozen recoverable rename; never delete it.
        stand.fresh_data()
        fixture.publication_gate.prepare_baseline(command, stand)
        for name, failure in [('publication-gate-startup-failure-returns-current', 'startup'),
            ('publication-gate-activation-failure-keeps-current-data', 'activation')]:
            # Real API case added legitimate read-budget rows; fault assertions
            # need the same isolated two-counter baseline, not polluted history.
            stand.fresh_data()
            fixture.publication_gate.prepare_baseline(command, stand)
            prior_dirs = set(stand.releases.glob('*/state.json'))
            frozen.scenario(stand, name, schema=17, failure=failure, publication_gate=True)
            result = stand.results[-1]
            if failure:
                stages = {s['stage']: s['status'] for s in result['stages']}
                new_states = set(stand.releases.glob('*/state.json'))-prior_dirs
                assert len(new_states) == 1
                state_file = new_states.pop()
                state = json.loads(state_file.read_text())
                observed = stand.observed()
                if failure == 'startup':
                    proof['gateFaults']['startup'] = {'activationCommitted': state.get('activationCommitted') is True,
                        'rollbackPassed': stages.get('rollback') == 'passed'}
                else:
                    latest_dir = state_file.parent
                    publication = json.loads((latest_dir/'publication-state.json').read_text())
                    proof['gateFaults']['activation'] = {'activationCommitted': state.get('activationCommitted') is True,
                        'publicationCommitted': publication.get('committed') is True,
                        'quarantinePassed': stages.get('publication-quarantine') == 'passed',
                        'applicationRunning': observed['State']['Running'], 'oldImageRestored': observed['Image'] == stand.old,
                        'currentDataRetained': publication.get('currentDataRetained') is True}
        proof['passed'] = len(stand.results) == 3
    finally:
        proof['scenarios'] = stand.results
        (destination/'supplement.json').write_text(json.dumps(proof, indent=2))
        receipt['supplementSha256'] = sha(destination/'supplement.json')
        (destination/'receipt.json').write_text(json.dumps(receipt, indent=2))
        assert sha(original) == ORIGINAL
        stand.close()
    print(json.dumps({'passed': proof['passed'], 'scenarios': len(stand.results), 'imageId': stand.new}))


if __name__ == '__main__':
    main()
