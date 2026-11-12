"""Closed host-side native backup commands. Never loads the application env_file."""
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
ACTIONS = {'run', 'preflight', 'status', 'check', 'stop'}


def plain_path(value, directory=False):
    if not isinstance(value, str) or '\0' in value:
        raise ValueError('CONFIGURATION')
    target = Path(value)
    if not target.is_absolute() or '..' in target.parts or any(p.is_symlink() for p in [target, *target.parents]):
        raise ValueError('CONFIGURATION')
    if not (target.is_dir() if directory else target.is_file()):
        raise ValueError('CONFIGURATION')
    return target


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError('CONFIGURATION')
        result[name] = value
    return result


def configuration(filename, require_secrets=True):
    file = plain_path(filename)
    if file.stat().st_size > 8192 or stat.S_IMODE(file.stat().st_mode) & 0o022:
        raise ValueError('CONFIGURATION')
    value = json.loads(file.read_text(encoding='utf-8'), object_pairs_hook=unique_object)
    if not isinstance(value, dict) or set(value) != {'root', 'project', 'image', 'secretDirectory'}:
        raise ValueError('CONFIGURATION')
    root = plain_path(value['root'], True)
    plain_path(str(root / 'compose.postgres.backup.yaml'))
    secrets = plain_path(value['secretDirectory'], True)
    if stat.S_IMODE(secrets.stat().st_mode) != 0o700:
        raise ValueError('CONFIGURATION')
    for name, minimum, maximum in ([('postgres_owner_password', 1, 4096), ('postgres_backup_key', 32, 32)] if require_secrets else []):
        secret = plain_path(str(secrets / name))
        if secret.stat().st_nlink != 1 or not minimum <= secret.stat().st_size <= maximum:
            raise ValueError('CONFIGURATION')
    if (not isinstance(value['project'], str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}', value['project']) or
            not isinstance(value['image'], str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', value['image'])):
        raise ValueError('CONFIGURATION')
    return value


def command(config, action, scheduled=False):
    if action not in ACTIONS or (scheduled and action != 'run'):
        raise ValueError('COMMAND')
    name = config['project'] + '-postgres-backup-' + action
    base = ['docker', 'compose', '--env-file', '/dev/null', '--project-directory', config['root'],
            '-p', config['project'] + '-backup', '-f', str(Path(config['root']) / 'compose.postgres.backup.yaml')]
    args = base + ['run', '--rm', '--no-deps', '--pull', 'never', '--name', name,
                   'backup', 'scripts/backup-agent.cjs', action]
    if scheduled:
        args.append('--scheduled')
    return args


def environment(config):
    # Compose never receives inherited provider/password/Docker routing settings.
    return {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
            'LANG': 'C.UTF-8', 'DOCKER_HOST': 'unix:///var/run/docker.sock', 'COMPOSE_DISABLE_ENV_FILE': '1',
            'CARTOTECA_POSTGRES_PROJECT': config['project'], 'CARTOTECA_POSTGRES_APP_IMAGE': config['image'],
            'CARTOTECA_POSTGRES_SECRET_DIR': config['secretDirectory']}


def execute(args, env, timeout):
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise TimeoutError('DEADLINE')
                for key, _ in selector.select(min(1, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk)
                        if len(output) > 65536:
                            raise ValueError('OUTPUT_LIMIT')
        return process.wait(timeout=max(0.1, deadline - time.monotonic())), bytes(output)
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def stop(config, run=execute):
    name = config['project'] + '-postgres-backup-run'
    code, raw = run(['docker', 'inspect', '--format', '{{json .Config.Labels}}\n{{.Image}}', name], environment(config), 10)
    if code:
        return {'backend': 'postgres', 'stopped': False}, 0
    labels, image = raw.decode().strip().splitlines()
    labels = json.loads(labels)
    if (labels.get('cartoteca.scope') != 'postgres-backup-v1' or
            labels.get('cartoteca.postgres-project') != config['project'] or image != config['image']):
        raise ValueError('FOREIGN_CONTAINER')
    code, _ = run(['docker', 'stop', '--time', '15', name], environment(config), 20)
    if code:
        raise ValueError('STOP_FAILED')
    return {'backend': 'postgres', 'stopped': True}, 0


def result(action, code, raw):
    lines = raw.decode('utf-8').strip().splitlines()
    if not lines:
        raise ValueError('RESULT')
    value = json.loads(lines[-1])
    if not isinstance(value, dict):
        raise ValueError('RESULT')
    if action == 'run':
        if code == 0 and value.get('state') == 'already_completed':
            return {'backend': 'postgres', 'state': 'already_completed', 'newBackup': False}, 0
        drill = value.get('drill', {})
        if (code or value.get('state') != 'local_only' or value.get('backend') != 'postgres' or
                value.get('verified') is not True or drill.get('backend') != 'postgres' or
                any(drill.get(name) is not True for name in ['restored', 'started', 'notificationsPaused'])):
            raise ValueError('BACKUP_FAILED')
        return {'backend': 'postgres', 'state': 'local_only', 'verified': True, 'restoreDrill': True,
                'independentExternalProtection': False}, 0
    if action == 'preflight':
        if code not in [0, 2] or value.get('exitCode') != code or type(value.get('ok')) is not bool:
            raise ValueError('PREFLIGHT_FAILED')
        keys = ['ok', 'code', 'exitCode', 'localAttemptReady', 'archiveVerified', 'independentProtectionVerified']
    elif action == 'check':
        if code not in [0, 1, 2] or value.get('exitCode') != code or value.get('severity') not in ['ok', 'warning', 'critical']:
            raise ValueError('CHECK_FAILED')
        keys = ['code', 'exitCode', 'severity', 'checkedAt', 'lastLocalAt', 'lastRemoteAt', 'lastDrillAt']
    else:
        if code not in [0, 2] or value.get('configured') is not True or value.get('health') not in ['stale', 'failed', 'protected', 'incomplete', 'unavailable']:
            raise ValueError('STATUS_FAILED')
        keys = ['configured', 'health', 'state', 'observedAt', 'lastLocalAt', 'lastRemoteAt', 'lastDrillAt', 'remoteConfigured']
    return {'backend': 'postgres', **{key: value[key] for key in keys if key in value}}, code


def main(argv, run=execute):
    if not argv or argv[0] not in ACTIONS:
        raise ValueError('COMMAND')
    action, flags = argv[0], list(argv[1:])
    scheduled = '--scheduled' in flags
    if scheduled:
        flags.remove('--scheduled')
    if len(flags) != 2 or flags[0] != '--config' or (scheduled and action != 'run'):
        raise ValueError('COMMAND')
    config = configuration(flags[1], require_secrets=action != 'stop')
    if action == 'stop':
        return stop(config, run)
    code, raw = run(command(config, action, scheduled), environment(config), 1810 if action == 'run' else 45)
    return result(action, code, raw)


if __name__ == '__main__':
    try:
        output, exit_code = main(sys.argv[1:])
    except Exception:
        output, exit_code = {'backend': 'postgres', 'code': 'POSTGRES_BACKUP_JOB_FAILED'}, 2
    print(json.dumps(output))
    sys.exit(exit_code)
