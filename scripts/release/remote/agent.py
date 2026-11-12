"""Independent, journalled deployment worker. Invoked only by an explicit publish command."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True


def digest(file):
    value = hashlib.sha256()
    with open(file, 'rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(part)
    return value.hexdigest()


def atomic(file, value):
    temporary = file.with_name(file.name + '.next-' + uuid.uuid4().hex)
    with open(temporary, 'x', encoding='utf-8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    descriptor = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def assert_assistant_saving_version(config):
    if config.get('schema') == 19:
        from paid_services import assert_contract
        assert_contract(config)
        return
    if 'assistantSavingVersion' in config and (type(config['assistantSavingVersion']) is not int or
            config['assistantSavingVersion'] != 1 or config.get('publicationGate') is not True or
            config.get('migration') is not None or config.get('schema') != 17 or
            config.get('readBudgetVersion') != 1 or config.get('bookingLinksVersion') != 1):
        raise RuntimeError('INVALID_ASSISTANT_SAVING_VERSION')


def load_request(file, expected):
    if not re.fullmatch('[a-f0-9]{64}', expected):
        raise RuntimeError('INVALID_REQUEST_HASH')
    file = Path(file).absolute()
    if any(p.is_symlink() for p in [file, *file.parents]) or digest(file) != expected:
        raise RuntimeError('REQUEST_CHANGED')
    request = json.loads(file.read_text())
    config = request['config']
    for key in ['root', 'releaseRoot']:
        if not re.fullmatch(r'/opt/[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', config[key]):
            raise RuntimeError('INVALID_DIRECTORY')
        target = Path(config[key])
        if any(p.is_symlink() for p in [target, *target.parents]):
            raise RuntimeError('LINKED_DIRECTORY')
    root, releases = Path(config['root']), Path(config['releaseRoot'])
    if root == releases or root in releases.parents or releases in root.parents:
        raise RuntimeError('OVERLAPPING_DIRECTORIES')
    if request['version'] != 1 or not re.fullmatch(r'r-[a-f0-9]{12}-[a-f0-9]{12}', request['run']):
        raise RuntimeError('INVALID_RUN')
    if file.parent != releases / request['run'] or config['schema'] not in [11, 15, 16, 17, 18, 19]:
        raise RuntimeError('INVALID_TARGET')
    if config.get('migration') is not None and (config['migration'], config['schema']) not in [('staff-max-15-to-16', 16), ('staff-push-16-to-17', 17), ('structural-17-to-18', 18), ('read-budget-17', 17), ('booking-links-17', 17), ('paid-services-17-to-19', 19)]:
        raise RuntimeError('INVALID_MIGRATION')
    if 'readBudgetVersion' in config and (type(config['readBudgetVersion']) is not int or config['readBudgetVersion'] != 1 or config['schema'] not in [17, 19] or config.get('migration') not in [None, 'read-budget-17', 'booking-links-17', 'paid-services-17-to-19']):
        raise RuntimeError('INVALID_READ_BUDGET_VERSION')
    if config.get('migration') == 'read-budget-17' and config.get('readBudgetVersion') != 1:
        raise RuntimeError('READ_BUDGET_VERSION_REQUIRED')
    if 'bookingLinksVersion' in config and (type(config['bookingLinksVersion']) is not int or config['bookingLinksVersion'] != 1 or config['schema'] not in [17, 19] or config.get('readBudgetVersion') != 1 or config.get('migration') not in [None, 'booking-links-17', 'paid-services-17-to-19']):
        raise RuntimeError('INVALID_BOOKING_LINKS_VERSION')
    if config.get('migration') == 'booking-links-17' and config.get('bookingLinksVersion') != 1:
        raise RuntimeError('BOOKING_LINKS_VERSION_REQUIRED')
    if 'publicationGate' in config and (config['publicationGate'] is not True or config.get('migration') is not None or config['schema'] not in [17, 19] or config.get('readBudgetVersion') != 1 or config.get('bookingLinksVersion') != 1):
        raise RuntimeError('INVALID_PUBLICATION_GATE')
    assert_assistant_saving_version(config)
    if config.get('publicationGate') is True and 'publication_gate.py' not in request['files']:
        raise RuntimeError('MISSING_PUBLICATION_GATE_EXECUTOR')
    if config.get('migration') and 'migration.py' not in request['files']:
        raise RuntimeError('MISSING_MIGRATION_EXECUTOR')
    if config.get('readBudgetVersion') == 1 and 'read_budget.py' not in request['files']:
        raise RuntimeError('MISSING_READ_BUDGET_EXECUTOR')
    if config.get('bookingLinksVersion') == 1 and 'booking_links.py' not in request['files']:
        raise RuntimeError('MISSING_BOOKING_LINKS_EXECUTOR')
    if config['schema'] == 19 and 'paid_services.py' not in request['files']:
        raise RuntimeError('MISSING_PAID_SERVICES_EXECUTOR')
    for field in ['imageId']:
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', request[field]):
            raise RuntimeError('INVALID_IMAGE')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', config['expectedImage']):
        raise RuntimeError('INVALID_PREVIOUS_IMAGE')
    for name, expected_hash in request['files'].items():
        if name not in ['agent.py', 'operations.py', 'checks.py', 'migration.py', 'read_budget.py', 'booking_links.py', 'paid_services.py', 'publication_gate.py', 'delivery.py', 'probe.cjs', 'image-check.cjs']:
            raise RuntimeError('UNKNOWN_EXECUTOR_FILE')
        target = file.parent / name
        if target.is_symlink() or digest(target) != expected_hash:
            raise RuntimeError('EXECUTOR_CHANGED')
    return request, file.parent


def active(unit):
    if not unit:
        return False
    result = subprocess.run(['systemctl', 'show', unit, '-p', 'ActiveState', '--value'], capture_output=True, text=True, timeout=15)
    return result.stdout.strip() in ['active', 'activating', 'deactivating']


def read_state(directory):
    file = directory / 'state.json'
    state = json.loads(file.read_text()) if file.exists() else {'status': 'not_started', 'published': False}
    return {**state, 'active': active(state.get('unit'))}


@contextlib.contextmanager
def exclusive(file):
    descriptor = os.open(file, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def launch(request, directory, request_hash):
    with exclusive(directory / 'launch.lock'):
        for name in request['files']:
            (directory / name).chmod(0o644)
        state = read_state(directory)
        if state['active'] or state['status'] in ['completed', 'rolled_back', 'needs_attention']:
            return state
        if state['status'] not in ['not_started', 'failed_before_switch', 'published_backup_pending']:
            raise RuntimeError('INTERRUPTED_TRANSITION_REQUIRES_RECOVERY')
        unit = 'cartoteca-release-' + request['run'] + '-' + uuid.uuid4().hex[:8]
        previous_status = state['status']
        state.update(unit=unit, status='dispatching', resumeFrom=previous_status)
        atomic(directory / 'state.json', state)
        # Type=oneshot otherwise waits for the entire release while holding launch.lock.
        result = subprocess.run(['systemd-run', '--quiet', '--no-block', '--unit=' + unit, '--property=Type=oneshot', '--property=UMask=0077', '--property=TimeoutStartSec=2400', sys.executable, str(directory / 'agent.py'), 'run', str(directory / 'request.json'), request_hash], capture_output=True, timeout=20)
        if result.returncode:
            state['status'] = previous_status
            atomic(directory / 'state.json', state)
            raise RuntimeError('SERVER_EXECUTOR_NOT_STARTED')
        return read_state(directory)


def execute_run(request, directory):
    from operations import Operations
    from checks import preflight, public_checks
    with exclusive(Path(request['config']['releaseRoot']) / 'deployment.lock'):
        state = read_state(directory)
        ops = Operations(request, directory)
        state.update(active=True, startedAt=time.time(), attempt=state.get('attempt', 0) + 1)
        changed, healthy, timer_owned = False, False, False

        def save(status, **details):
            state.update(status=status, **details, updatedAt=time.time())
            atomic(directory / 'state.json', state)

        def step(name, operation):
            started = time.monotonic()
            save(state['status'], currentStage=name)
            outcome = 'failed'
            try:
                result = operation()
                outcome = 'passed'
                return result
            finally:
                with open(directory / 'timings.jsonl', 'a', encoding='utf-8') as stream:
                    stream.write(json.dumps({'attempt': state['attempt'], 'stage': name, 'status': outcome, 'durationMs': round((time.monotonic() - started) * 1000), 'finishedAt': time.time()}) + '\n')

        def stop_signal(*_):
            raise RuntimeError('EXECUTOR_INTERRUPTED')
        signal.signal(signal.SIGTERM, stop_signal)
        signal.signal(signal.SIGINT, stop_signal)
        try:
            if state.get('resumeFrom') == 'published_backup_pending':
                step('reconcile-published', lambda: public_checks(ops))
                healthy = True
                ops.pause_timer(); timer_owned = True
            else:
                save('preflight', published=False)
                step('preflight', lambda: preflight(ops))
                step('save-configuration', ops.save_configuration)
                ops.pause_timer(); timer_owned = True
                step('backup-before', ops.backup)
                # Last check is fresh and runs under the application-wide lock.
                step('recheck-previous', ops.assert_previous)
                if ops.migration:
                    save('migrating', published=False)
                    changed = True
                    step('migration-stop', ops.migration.stop)
                    step('migration-prepare', ops.migration.prepare)
                    step('migration-install', ops.migration.install)
                save('switching', published=False)
                changed = True
                step('switch', ops.switch)
                step('public-checks', lambda: public_checks(ops))
                if ops.migration:
                    # Journal this BEFORE restarting without the API/delivery gate.
                    save('activating', published=False, migrationCommitted=True)
                    step('migration-activate', ops.migration.activate)
                    step('public-checks-activated', lambda: public_checks(ops))
                elif getattr(ops, 'publication', None):
                    # A logical data feature also forbids old-image rollback once writers open.
                    save('activating', published=False, activationCommitted=True)
                    step('publication-activate', ops.publication.activate)
                    step('public-checks-activated', lambda: public_checks(ops))
                healthy = True
            save('published_backup_pending', published=True)
            step('backup-after', ops.backup)
            step('restore-backup-timer', ops.restore_timer); timer_owned = False
            save('completed', published=True, actualImage=ops.inspect()['Image'], currentStage=None)
            try:
                maintenance = step('storage-maintenance', ops.cleanup_storage)
                save('completed', maintenance=maintenance, maintenanceError=None, currentStage=None)
            except Exception:
                # Housekeeping cannot roll back a healthy published application.
                save('completed', maintenanceError='STORAGE_MAINTENANCE_FAILED', currentStage=None)
        except Exception as error:
            reason = str(error) if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', str(error)) else 'STAGE_FAILED'
            save(state['status'], failureStage=state.get('currentStage'), failureReason=reason)
            if state.get('activationCommitted') and not healthy:
                try:
                    step('publication-quarantine', ops.publication.quarantine)
                    save('needs_attention', published=False, error='ACTIVATION_FAILED_KEEP_CURRENT_DATA')
                except Exception:
                    save('needs_attention', published=False, error='ACTIVATION_FAILED_STOP_REQUIRES_ATTENTION')
            elif state.get('migrationCommitted') and not healthy:
                if request['config'].get('migration') in ['read-budget-17', 'booking-links-17', 'paid-services-17-to-19']:
                    try:
                        step('migration-quarantine', ops.migration.quarantine)
                        save('needs_attention', published=False, error='ACTIVATION_FAILED_KEEP_CURRENT_DATA')
                    except Exception:
                        save('needs_attention', published=False, error='ACTIVATION_FAILED_STOP_REQUIRES_ATTENTION')
                else:
                    save('needs_attention', published=False, error='ACTIVATION_FAILED_KEEP_SCHEMA16_DATA')
            elif changed and not healthy:
                try:
                    save('rolling_back', published=False)
                    step('rollback', ops.rollback)
                    save('rolled_back', published=False, actualImage=ops.inspect()['Image'])
                except Exception:
                    save('needs_attention', published=False, error='ROLLBACK_FAILED')
            elif healthy:
                save('published_backup_pending', published=True, error='FINISH_BACKUP_AND_TIMER')
            else:
                save('failed_before_switch', published=False, error='PREFLIGHT_OR_BACKUP_FAILED')
        finally:
            if timer_owned or ops.timer_touched:
                try:
                    step('restore-backup-timer', ops.restore_timer)
                except Exception:
                    save('needs_attention', error='BACKUP_TIMER_NOT_RESTORED')
            save(state['status'], active=False, finishedAt=time.time())
        return state


def run(request, directory):
    try:
        return execute_run(request, directory)
    except BlockingIOError:
        state = read_state(directory)
        state.update(status='failed_before_switch', active=False, published=False, error='ANOTHER_DEPLOYMENT_ACTIVE')
        atomic(directory / 'state.json', state)
        return state


def main():
    os.umask(0o077)
    mode, file, request_hash = sys.argv[1:]
    request, directory = load_request(file, request_hash)
    if mode == 'status':
        state = read_state(directory)
        try:
            from operations import Operations
            current = Operations(request, directory).inspect()
            state.update(observedImage=current['Image'], applicationRunning=current['State']['Running'])
        except Exception:
            state.update(observedImage=None, applicationRunning=None)
        return state
    if mode == 'launch':
        return launch(request, directory, request_hash)
    if mode == 'run':
        return run(request, directory)
    raise RuntimeError('UNKNOWN_OPERATION')


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception:
        # Configuration, credentials and customer information never enter transport output.
        print(json.dumps({'status': 'error', 'error': 'DEPLOYMENT_REFUSED_OR_INTERRUPTED'}))
        sys.exit(1)
