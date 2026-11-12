"""Technical PostgreSQL probes only. This module never authorizes a cutover."""
import json


def enabled(config):
    backend = config.get('storageBackend', 'sqlite')
    if backend not in ['sqlite', 'postgres']:
        raise RuntimeError('INVALID_STORAGE_BACKEND')
    if backend == 'sqlite':
        if 'postgresProfile' in config:
            raise RuntimeError('INVALID_POSTGRES_PROFILE')
        return False
    if (config.get('postgresProfile') != 'production-v1' or
            config.get('paymentNetworkEnabled') is not False or
            any(name in config for name in ['migration', 'publicationGate', 'assistantSavingVersion'])):
        raise RuntimeError('INVALID_POSTGRES_PROFILE')
    return True


def validate_readiness(proof, expected):
    executors = proof.get('executors', {})
    queries = executors.get('queries', {})
    if (type(expected) is not int or proof.get('version') != 1 or
            proof.get('backend') != 'postgres' or proof.get('profile') != 'production-v1' or
            proof.get('schema') != expected or
            any(proof.get(name) is not True for name in
                ['ready', 'nativeSchema', 'rls', 'assetLineage', 'preparedModes']) or
            type(proof.get('stores')) is not int or not 2 <= proof['stores'] <= 100000 or
            proof.get('paymentNetworkEnabled') is not False or
            proof.get('assistantAppointmentSavingEnabled') is not False or
            executors.get('version') != 1 or executors.get('backend') != 'postgres' or
            executors.get('ready') is not True or executors.get('profileMatches') is not True or
            executors.get('gateway', {}).get('open') is not True or
            any(executors.get('children', {}).get(name) is not True for name in ['web', 'background']) or
            type(queries.get('configured')) is not int or not 1 <= queries['configured'] <= 16 or
            type(queries.get('ready')) is not int or queries['ready'] != queries['configured'] or
            queries.get('closed') is not False):
        raise RuntimeError('POSTGRES_NOT_READY')
    return proof


def readiness(ops, expected=None):
    if not enabled(ops.config):
        raise RuntimeError('POSTGRES_PROFILE_REQUIRED')
    current = ops.inspect()
    environment = dict(item.split('=', 1) for item in current['Config'].get('Env', []) if '=' in item)
    if (environment.get('CARTOTECA_STORAGE_BACKEND') != 'postgres' or
            environment.get('CARTOTECA_POSTGRES_PROFILE') != 'production-v1' or
            current['Config'].get('Cmd') not in
            [['node', 'scripts/start-postgres-server.cjs'], ['node', '/app/scripts/start-postgres-server.cjs']]):
        raise RuntimeError('POSTGRES_EXECUTOR_MISMATCH')
    raw = ops.command(['docker', 'exec', ops.config['container'], 'node',
                       '/app/scripts/postgres-readiness.cjs', '--technical-output'], timeout=45)
    if len(raw) > 8192:
        raise RuntimeError('POSTGRES_PROBE_INVALID')
    proof = validate_readiness(json.loads(raw), ops.config['schema'] if expected is None else expected)
    for name in ['readBudgetVersion', 'bookingLinksVersion']:
        if ops.config.get(name) == 1 and proof.get(name) != 1:
            raise RuntimeError('POSTGRES_COMPONENT_MISMATCH')
    return proof


def backup_proof(value):
    drill = value.get('drill', {})
    if (value.get('state') not in ['protected', 'local_only'] or
            value.get('backend') != 'postgres' or value.get('verified') is not True or
            drill.get('backend') != 'postgres' or
            any(drill.get(name) is not True for name in ['restored', 'started', 'notificationsPaused'])):
        raise RuntimeError('POSTGRES_BACKUP_AND_DRILL_NOT_CONFIRMED')
    return {'state': value['state'], 'backend': 'postgres', 'verified': True,
            'drill': {'backend': 'postgres', 'restored': True, 'started': True, 'notificationsPaused': True}}


def reject_automatic_switch(config):
    if enabled(config):
        raise RuntimeError('POSTGRES_RELEASE_SWITCH_NOT_APPROVED')
