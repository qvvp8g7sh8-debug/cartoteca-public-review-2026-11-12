import hashlib
import json
from pathlib import Path
import shutil
import re
import tarfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def candidate_image(ops):
    file = ops.directory / 'image-target.json'
    if not file.exists():
        return ops.request['imageId']
    if file.is_symlink():
        raise RuntimeError('LINKED_IMAGE_IDENTITY')
    proof = json.loads(file.read_text())
    if proof['imageHash'] != ops.request['imageHash'] or proof['requestedId'] != ops.request['imageId'] or not re.fullmatch(r'sha256:[a-f0-9]{64}', proof['targetId']):
        raise RuntimeError('IMAGE_IDENTITY_CHANGED')
    return proof['targetId']


def resolve_image(ops, archive):
    from agent import atomic
    requested = ops.request['imageId']
    try:
        actual = ops.command(['docker', 'image', 'inspect', requested, '--format', '{{.Id}}']).decode().strip()
        if actual != requested:
            raise RuntimeError('LOADED_IMAGE_MISMATCH')
    except RuntimeError:
        # Classic and containerd image stores identify the same OCI content differently.
        # The archive SHA256 has already been verified. No tags or unverified load output are used.
        with tarfile.open(archive) as tar:
            index = json.load(tar.extractfile('index.json'))
            if len(index['manifests']) != 1:
                raise RuntimeError('AMBIGUOUS_IMAGE_ARCHIVE')
            manifest_id = index['manifests'][0]['digest']
            def blob(identity):
                if not re.fullmatch(r'sha256:[a-f0-9]{64}', identity):
                    raise RuntimeError('INVALID_ARCHIVE_IDENTITY')
                content = tar.extractfile('blobs/sha256/' + identity.split(':')[1]).read()
                if 'sha256:' + hashlib.sha256(content).hexdigest() != identity:
                    raise RuntimeError('ARCHIVE_BLOB_CHANGED')
                return json.loads(content)
            manifest = blob(manifest_id)
            config_id = manifest['config']['digest']
            config = blob(config_id)
            if requested not in [manifest_id, config_id] or config['os'] != 'linux' or config['architecture'] != 'amd64':
                raise RuntimeError('ARCHIVE_IMAGE_MISMATCH')
            target = config_id if requested == manifest_id else manifest_id
            actual = ops.command(['docker', 'image', 'inspect', target, '--format', '{{.Id}}']).decode().strip()
            if actual != target:
                raise RuntimeError('LOADED_IMAGE_MISMATCH')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', actual):
        raise RuntimeError('INVALID_LOADED_IMAGE_IDENTITY')
    atomic(ops.directory / 'image-target.json', {'requestedId': requested, 'targetId': actual, 'imageHash': ops.request['imageHash']})
    return actual


def http(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(url, timeout=10) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as response:
        return response.code, response.headers, response.read()


def schema(ops, expected=None):
    if ops.config.get('storageBackend', 'sqlite') != 'sqlite':
        from postgres import readiness
        readiness(ops, expected)
        return
    code = 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/data/platform/platform.sqlite",{readOnly:true});const v=d.prepare("PRAGMA user_version").get().user_version;if(d.prepare("PRAGMA integrity_check").get().integrity_check!=="ok"||d.prepare("PRAGMA foreign_key_check").all().length)process.exit(1);d.close();console.log(v)'
    result = ops.command(['docker', 'exec', ops.config['container'], 'node', '-e', code])
    if result.decode().strip() != str(ops.config['schema'] if expected is None else expected):
        raise RuntimeError('SCHEMA_MISMATCH')


def load_image_if_missing(ops, archive):
    requested = ops.request['imageId']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', requested):
        raise RuntimeError('INVALID_IMAGE_IDENTITY')
    try:
        present = ops.command(['docker', 'image', 'inspect', requested, '--format', '{{.Id}}']).decode().strip()
    except RuntimeError:
        present = None
    if present == requested:
        return False
    # Classic/containerd identities can differ. Keep the existing load + archive-
    # proven resolve path for every absence or mismatch; this probe never qualifies an image.
    ops.command(['docker', 'load', '--input', str(archive)], timeout=300)
    return True


def assistant_process(current, gated, require_saving=True):
    """Only the reviewed single node HTTP entrypoint may own transient dialogues."""
    config = current.get('Config', {})
    environment = dict(item.split('=', 1) for item in config.get('Env', []) if '=' in item)
    command = config.get('Cmd')
    role = environment.get('CARTOTECA_PROCESS_ROLE', 'combined')
    if (environment.get('NODE_ENV') != 'production' or role not in ['web', 'combined'] or
            command not in [['node', 'multi-server.cjs'], ['node', '/app/multi-server.cjs']] or
            config.get('Entrypoint') not in [None, [], ['docker-entrypoint.sh']] or
            environment.get('WEB_CONCURRENCY', '1') != '1' or
            (environment.get('CARTOTECA_RELEASE_GATE') == '1') != gated or
            (require_saving and environment.get('CARTOTECA_ASSISTANT_APPOINTMENT_SAVING') != '1')):
        raise RuntimeError('ASSISTANT_SINGLE_PROCESS_REQUIRED')
    return role


def check_assistant_saving(ops, current, gated):
    if ops.config.get('assistantSavingVersion') != 1:
        return {}
    role = assistant_process(current, gated)
    code = r'''const assert=require('node:assert/strict');
const c=require('/app/src/server/config.cjs').configuration();
assert.equal(c.production,true);assert.equal(c.assistantAppointmentSavingEnabled,true);
assert.ok(['web','combined'].includes(c.processRole));
const enabled=process.env.CARTOTECA_RELEASE_GATE!=='1';
assert.equal(typeof require('/app/src/server/infrastructure/assistant-executor-authority.cjs').acquireAssistantExecutorAuthority,'function');
console.log(JSON.stringify({assistantSavingVersion:1,assistantSavingEnabled:enabled,
 assistantProcessRole:c.processRole,assistantSingleProcess:true}));'''
    expected = {'assistantSavingVersion': 1, 'assistantSavingEnabled': not gated,
                'assistantProcessRole': role, 'assistantSingleProcess': True}
    proof = json.loads(ops.command(['docker', 'exec', ops.config['container'], 'node', '-e', code]))
    if (proof != expected or type(proof.get('assistantSavingVersion')) is not int or
            type(proof.get('assistantSavingEnabled')) is not bool or
            type(proof.get('assistantSingleProcess')) is not bool):
        raise RuntimeError('ASSISTANT_ADMISSION_NOT_CONFIRMED')
    return proof


def preflight(ops):
    if ops.config.get('storageBackend', 'sqlite') != 'sqlite':
        from postgres import reject_automatic_switch
        reject_automatic_switch(ops.config)
    from agent import digest, atomic
    request, directory = ops.request, ops.directory
    current = ops.assert_previous()
    from read_budget import check_release_mode
    check_release_mode(ops, current)
    from booking_links import check_release_mode as check_booking_links_mode
    check_booking_links_mode(ops, current)
    previous_schema = ops.migration.previous_schema if ops.migration else ops.config['schema']
    schema(ops, expected=previous_schema)
    if (ops.root / 'data').is_symlink():
        raise RuntimeError('LINKED_DATA_DIRECTORY')
    if shutil.disk_usage(directory).free < request['imageBytes'] * 2 + 256 * 1024 * 1024:
        raise RuntimeError('INSUFFICIENT_RELEASE_SPACE')
    archive = directory / 'image.tar'
    if archive.is_symlink() or archive.stat().st_size != request['imageBytes'] or digest(archive) != request['imageHash']:
        raise RuntimeError('ARCHIVE_CHANGED')
    load_image_if_missing(ops, archive)
    image_id = resolve_image(ops, archive)
    # Only synthetic data and no credentials are mounted in preparation containers.
    args = ['docker', 'run', '--rm', '--network', 'none', '--memory=900m', '--cpus=2', '--tmpfs', '/tmp:size=256m,mode=1777']
    ops.command(args + ['--mount', 'type=bind,source=' + str(directory / 'image-check.cjs') + ',target=/tmp/image-check.cjs,readonly', '--entrypoint', 'node', image_id, '/tmp/image-check.cjs'], timeout=90)
    proof_request = directory / 'probe-input.json'
    atomic(proof_request, {'schema': ops.config['schema'], 'runtime': request['runtime']})
    proof_request.chmod(0o644)
    proof = ops.command(args + ['--mount', 'type=bind,source=' + str(directory / 'probe.cjs') + ',target=/tmp/probe.cjs,readonly', '--mount', 'type=bind,source=' + str(proof_request) + ',target=/tmp/probe-input.json,readonly', '--entrypoint', 'node', image_id, '/tmp/probe.cjs'], timeout=90)
    atomic(directory / 'image-proof.json', json.loads(proof))
    environment = dict(item.split('=', 1) for item in current['Config'].get('Env', []) if '=' in item)
    if environment.get('CARTOTECA_RELEASE_GATE') == '1':
        raise RuntimeError('PREVIOUS_RELEASE_GATE_ACTIVE')
    if environment.get('CARTOTECA_MAX_ENABLED') == '1':
        if previous_schema not in [15, 16, 17, 18, 19] or environment.get('CARTOTECA_MAX_SCHEMA', '15') != str(previous_schema):
            raise RuntimeError('MAX_SCHEMA_CONFIGURATION_MISMATCH')
        # Same egress network as the current app, but no bot credentials or background workers.
        code = 'fetch("https://platform-api2.max.ru/me",{signal:AbortSignal.timeout(15000)}).then(r=>{if(r.status!==401)process.exit(1)}).catch(()=>process.exit(1))'
        ops.command(['docker', 'run', '--rm', '--network', 'container:' + ops.config['container'], '--entrypoint', 'node', image_id, '-e', code], timeout=30)
    ops.compose('config', '--quiet')
    ops.compose('config', '--quiet', backup=True)
    if ops.migration:
        ops.migration.preflight()
    elif getattr(ops, 'publication', None):
        ops.publication.preflight()


def public_checks(ops):
    from agent import atomic
    current = ops.inspect()
    if current['Image'] != ops.image_id or not current['State']['Running'] or current['RestartCount'] or current['State'].get('OOMKilled'):
        raise RuntimeError('RUNNING_IMAGE_UNHEALTHY')
    origin = ops.config['origin']
    proof = json.loads((ops.directory / 'image-proof.json').read_text())
    checked = 0
    transition = ops.migration or getattr(ops, 'publication', None)
    gated = bool(transition and transition.gated())
    status, headers, body = http(origin + '/login.html')
    if status != 200 or proof['build'].encode() not in body or 'no-store' not in headers.get('Cache-Control', '') or not headers.get('Content-Security-Policy') or headers.get('X-Content-Type-Options') != 'nosniff':
        raise RuntimeError('PUBLIC_VERSION_OR_HEADERS_FAILED')
    checked += 5
    parsed = urlsplit(origin)
    if http('http://' + parsed.netloc + '/')[0] != 308:
        raise RuntimeError('HTTPS_REDIRECT_FAILED')
    checked += 1
    for name, expected in proof['publicAssets'].items():
        status, _, body = http(origin + '/' + name)
        if status != 200 or hashlib.sha256(body).hexdigest() != expected:
            raise RuntimeError('PUBLIC_RESOURCE_MISMATCH')
        checked += 1
    pages = ['admin.html', 'privacy.html', 'consent.html', 'booking.html']
    if ops.config.get('bookingLinksVersion') == 1:
        pages.append('b/aaaaaaaa')
    for name in pages:
        status, _, body = http(origin + '/' + name)
        if status != 200 or proof['build'].encode() not in body:
            raise RuntimeError('PUBLIC_PAGE_VERSION_MISMATCH')
        checked += 1
    for name in ['/app.js', '/app-settings.js', '/app-assistant.js', '/assistant-capture-worklet.js', '/security.js', '/api/cabinet', '/api/notifications/service-visibility']:
        expected_status = 503 if gated and name.startswith('/api/') else 401
        if http(origin + name)[0] != expected_status:
            raise RuntimeError('ANONYMOUS_ACCESS_FAILED')
        checked += 1
    for name in ['/.env.local', '/data/platform/platform.sqlite', '/src/server/config.cjs']:
        if http(origin + name)[0] != 404:
            raise RuntimeError('PRIVATE_PATH_EXPOSED')
        checked += 1
    schema(ops)
    read_budget_proof = check_assistant_saving(ops, current, gated)
    if ops.config.get('readBudgetVersion') == 1:
        from read_budget import check_active
        check_active(ops, current)
        read_budget_proof['readBudgetVersion'] = 1
    if ops.config.get('bookingLinksVersion') == 1:
        from booking_links import check_active as check_booking_links
        check_booking_links(ops, current)
        read_budget_proof['bookingLinksVersion'] = 1
    if ops.config['schema'] == 19:
        from paid_services import check_active as check_paid_services
        read_budget_proof['paidServices'] = check_paid_services(ops, current)
    if ops.config['schema'] == 18:
        environment = dict(item.split('=', 1) for item in current['Config'].get('Env', []) if '=' in item)
        if environment.get('CARTOTECA_CABINET_SCHEMA') != '2' or environment.get('CARTOTECA_SCHEDULED_NOTIFICATIONS') != ('0' if gated else '1'):
            raise RuntimeError('STRUCTURAL_CONFIGURATION_MISMATCH')
        code = 'const {DatabaseSync}=require("node:sqlite"),p="/data",s=require("/app/src/server/infrastructure/backup/snapshot.cjs");const d=new DatabaseSync(p+"/platform/platform.sqlite",{readOnly:true});try{for(const r of s.cabinetPaths(p,d).cabinets){const c=new DatabaseSync(p+"/"+r+"/cabinet.sqlite",{readOnly:true});try{if(c.prepare("PRAGMA user_version").get().user_version!==2||c.prepare("PRAGMA integrity_check").get().integrity_check!=="ok"||c.prepare("PRAGMA foreign_key_check").all().length)process.exit(1)}finally{c.close()}}}finally{d.close()}'
        ops.command(['docker', 'exec', ops.config['container'], 'node', '-e', code])
    # Check full runtime contents in the active image, not only its publicly served resources.
    code = 'const fs=require("fs"),c=require("crypto"),m=JSON.parse(fs.readFileSync(0,"utf8"));for(const [n,h]of Object.entries(m)){if(c.createHash("sha256").update(fs.readFileSync("/app/"+n)).digest("hex")!==h)process.exit(1)}'
    ops.command(['docker', 'exec', '-i', ops.config['container'], 'node', '-e', code], stdin=json.dumps(ops.request['runtime']).encode())
    previous = json.loads(ops.previous_file.read_text())
    for name in ['production.override.yaml', 'compose.backup.yaml']:
        before = (ops.directory / ('before-' + name)).read_bytes()
        phase = 'gated' if gated else 'enabled'
        if (ops.root / name).read_bytes() != ops.configuration_bytes(name, phase):
            raise RuntimeError('UNEXPECTED_CONFIGURATION_CHANGE')
    atomic(ops.directory / ('public-checks-gated.json' if gated else 'public-checks.json'), {'passed': True, 'gated': gated, 'checks': checked + 4, 'actualImage': current['Image'], 'build': proof['build'], **read_budget_proof})
