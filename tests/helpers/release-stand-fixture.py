"""Disposable CI or explicitly marked, expiring test VM; never a production host."""
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
import stat
from pathlib import Path
import subprocess
import time


budget_spec = importlib.util.spec_from_file_location('stand_read_budget', Path(__file__).with_name('release-stand-read-budget.py'))
read_budget = importlib.util.module_from_spec(budget_spec); budget_spec.loader.exec_module(read_budget)
links_spec = importlib.util.spec_from_file_location('stand_booking_links', Path(__file__).with_name('release-stand-booking-links.py'))
booking_links = importlib.util.module_from_spec(links_spec); links_spec.loader.exec_module(booking_links)
gate_spec = importlib.util.spec_from_file_location('stand_publication_gate', Path(__file__).with_name('release-stand-publication-gate.py'))
publication_gate = importlib.util.module_from_spec(gate_spec); gate_spec.loader.exec_module(publication_gate)
paid_spec = importlib.util.spec_from_file_location('stand_paid_services', Path(__file__).with_name('release-stand-paid-services.py'))
paid_services = importlib.util.module_from_spec(paid_spec); paid_spec.loader.exec_module(paid_services)


def command(*args, timeout=120, stdin=None, include_stderr=False):
    result = subprocess.run(args, input=stdin, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Stand command failed: ' + args[0] + '\n' + result.stderr.decode()[-3000:])
    return (result.stdout + (result.stderr if include_stderr else b'')).decode().strip()


def digest(file):
    with open(file, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_lab_marker(marker, machine_id, now, uid, mode, is_link, source):
    """Pure checks also exercised on synthetic metadata, without touching the host."""
    if uid != 0 or mode & 0o077 or is_link:
        raise RuntimeError('Test marker must be private, root-owned and not a link')
    if (not isinstance(marker, dict) or marker.get('version') != 1
            or marker.get('purpose') != 'cartoteca-synthetic-checks'
            or marker.get('disposable') is not True
            or marker.get('machineId') != machine_id):
        raise RuntimeError('Marker does not authorize this dedicated test machine')
    expires = datetime.fromisoformat(marker.get('expiresAt', '').replace('Z', '+00:00'))
    if expires.tzinfo is None or not now < expires <= now + timedelta(days=8):
        raise RuntimeError('Test authorization expired or exceeds the short test lease')
    if not Path(source).resolve().is_relative_to(Path('/opt/cartoteca-checks/.release/candidates')):
        raise RuntimeError('Stand source must be an immutable test candidate')
    return True


def assert_disposable_environment(source):
    if os.geteuid() != 0:
        raise RuntimeError('Disposable stand requires root')
    if os.environ.get('GITHUB_ACTIONS') == 'true':
        return
    if os.environ.get('CARTOTECA_TEST_LAB') != 'approved':
        raise RuntimeError('Use CI or an explicitly approved, expiring test VM')
    marker_path = Path('/etc/cartoteca-test-lab.json')
    info = os.stat(marker_path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError('Test marker must be a regular file')
    validate_lab_marker(json.loads(marker_path.read_text()), Path('/etc/machine-id').read_text().strip(),
                        datetime.now(timezone.utc), info.st_uid, info.st_mode,
                        stat.S_ISLNK(info.st_mode), source)


class Fixture:
    def __init__(self, source, image):
        assert_disposable_environment(source)
        os.umask(0o022)
        self.source, self.image = Path(source).resolve(), image
        self.base = Path('/opt/cartoteca-ci-stand')
        self.base.mkdir()  # Never reuse or delete an existing installation.
        self.base.chmod(0o755)
        self.root = self.base / 'app'
        self.releases = self.base / 'releases'
        self.root.mkdir(); self.releases.mkdir()
        self.results = []
        self.timer = 'cartoteca-ci-stand-backup.timer'
        self.units = []
        self.setup()

    def write(self, name, text):
        file = self.base / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)
        return file

    def setup(self):
        for name in ['data', 'backups', 'keys', 'state', 'work', 'status']:
            folder = self.root / name
            folder.mkdir(); os.chown(folder, 1000, 1000)
        key = self.root / 'keys/backup.key'
        key.write_bytes(os.urandom(32)); key.chmod(0o600); os.chown(key, 1000, 1000)
        self.write('start.cjs', '''if(process.env.STAND_START_FAILURE) process.exit(42);
if(process.env.STAND_ACTIVATE_FAILURE && process.env.CARTOTECA_RELEASE_GATE!=='1'){
const d=new(require('node:sqlite').DatabaseSync)('/data/platform/platform.sqlite');d.exec("INSERT INTO stand_marker VALUES ('synthetic-post-commit-value')");d.close();
if(process.env.STAND_PRODUCTION==='1'){const b=new(require('node:sqlite').DatabaseSync)('/data/platform/booking-read-budget.sqlite');b.exec("UPDATE login_limits SET failures=failures+1 WHERE key='booking-budget:read-address:stand-synthetic'");b.close();}
{''' + booking_links.POST_COMMIT + '''}
{''' + publication_gate.POST_COMMIT + '''}
process.exit(43);}
const p='/data/platform';if(!require('fs').existsSync(p+'/platform.sqlite'))require('/app/platform-store.cjs').createPlatformStore(p).close();
const db=new(require('node:sqlite').DatabaseSync)(p+'/platform.sqlite',{readOnly:true});const version=db.prepare('PRAGMA user_version').get().user_version;db.close();
if(Number(process.env.CARTOTECA_MAX_SCHEMA||process.env.STAND_SCHEMA)>=15&&version===11){
const d=require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase(p);
for(const [n,f]of [['012-max-connections','migrateMaxConnections'],['013-notification-queue','migrateNotificationQueue'],['014-notification-channels','migrateNotificationChannels'],['015-max-inbox','migrateMaxInbox']])require('/app/src/server/migrations/'+n+'.cjs')[f](d,p);d.db.close();}
const schema=Number(process.env.CARTOTECA_MAX_SCHEMA||process.env.STAND_SCHEMA);
for(const [v,n,f]of [[16,'016-staff-max','migrateStaffMax'],[17,'017-staff-push','migrateStaffPush']]){
const check=new(require('node:sqlite').DatabaseSync)(p+'/platform.sqlite',{readOnly:true});const current=check.prepare('PRAGMA user_version').get().user_version;check.close();
if(schema>=v&&current===v-1){const d=require('/app/src/server/infrastructure/platform-database.cjs').createPlatformDatabase(p,{notificationSchema:current});require('/app/src/server/migrations/'+n+'.cjs')[f](d,p);d.db.close();}}
''' + read_budget.SERVER_START)
        self.write('old.Dockerfile', 'FROM ' + self.image + '\nUSER root\nRUN printf "\\n/* previous stand version */\\n" >> /app/style.css\nUSER node\n')
        self.write('broken.Dockerfile', 'FROM ' + self.image + '\nENV STAND_START_FAILURE=1\n')
        self.write('activation.Dockerfile', 'FROM ' + self.image + '\nENV STAND_ACTIVATE_FAILURE=1\n')
        for tag, name in [('cartoteca-ci:previous', 'old'), ('cartoteca-ci:broken', 'broken'), ('cartoteca-ci:activation', 'activation')]:
            command('docker', 'build', '-t', tag, '-f', str(self.base / (name + '.Dockerfile')), str(self.base), timeout=300)
        self.old = command('docker', 'image', 'inspect', 'cartoteca-ci:previous', '--format', '{{.Id}}')
        self.new = command('docker', 'image', 'inspect', self.image, '--format', '{{.Id}}')
        self.broken = command('docker', 'image', 'inspect', 'cartoteca-ci:broken', '--format', '{{.Id}}')
        self.activation = command('docker', 'image', 'inspect', 'cartoteca-ci:activation', '--format', '{{.Id}}')
        self.archive = self.base / 'image.tar'
        command('docker', 'save', '-o', str(self.archive), self.image, 'cartoteca-ci:broken', 'cartoteca-ci:activation', timeout=300)
        self.image_hash = digest(self.archive)
        mounts = {name: '/'+target for name, target in [('data','data'),('backups','backups'),('keys','secrets'),('state','backup-state'),('work','backup-work'),('status','backup-status')]}
        backup = {'name':'cartoteca-ci-backup','services':{'backup':{
            'image':'cartoteca-ci:previous', 'network_mode':'none',
            'environment':{'CARTOTECA_DATA_DIR':'/data','BACKUP_DIR':'/backups','BACKUP_KEY_FILE':'/secrets/backup.key','BACKUP_STATE_DIR':'/backup-state','BACKUP_WORK_DIR':'/backup-work','BACKUP_STATUS_FILE':'/backup-status/status.json'},
            'volumes':[str(self.root/name)+':'+target for name,target in mounts.items()]}}}
        self.write('app/compose.backup.yaml', json.dumps(backup))
        self.backup_original = (self.root / 'compose.backup.yaml').read_bytes()
        for suffix, content in [('service','[Service]\nType=oneshot\nExecStart=/bin/true\n'),('timer','[Timer]\nOnActiveSec=1d\n')]:
            Path('/etc/systemd/system/cartoteca-ci-stand-backup.'+suffix).write_text(content)
        command('systemctl','daemon-reload'); command('systemctl','start',self.timer)
        # A temporary self-signed CA is trusted only on this disposable VM.
        command('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Cartoteca CI stand','-addext','subjectAltName=IP:127.0.0.1','-keyout',str(self.base/'tls.key'),'-out',str(self.base/'tls.crt'))
        command('cp',str(self.base/'tls.crt'),'/usr/local/share/ca-certificates/cartoteca-ci-stand.crt')
        command('update-ca-certificates')
        caddy = self.write('Caddyfile', '{\n admin off\n auto_https disable_redirects\n}\nhttps://127.0.0.1 {\n tls '+str(self.base/'tls.crt')+' '+str(self.base/'tls.key')+'\n reverse_proxy 127.0.0.1:4173\n}\nhttp://127.0.0.1 {\n redir https://127.0.0.1{uri} 308\n}\n')
        caddy_units = subprocess.run(['systemctl','list-unit-files','caddy.service','--no-legend'],capture_output=True,text=True,timeout=15)
        if 'caddy.service' in caddy_units.stdout:
            command('systemctl','stop','caddy')
        command('systemd-run','--unit=cartoteca-ci-stand-caddy','/usr/bin/caddy','run','--config',str(caddy),'--adapter','caddyfile')
        self.units.append('cartoteca-ci-stand-caddy')
        for name in ['ssh-host', 'ssh-client']:
            command('ssh-keygen','-q','-t','ed25519','-N','','-f',str(self.base/name))
            (self.base/name).chmod(0o600)
        # GitHub /opt is group-writable; keep authorized_keys under root-owned /run.
        ssh_access = Path('/run/cartoteca-ci-stand-ssh')
        ssh_access.mkdir(mode=0o700)
        authorized = ssh_access/'authorized_keys'
        authorized.write_text((self.base/'ssh-client.pub').read_text()); authorized.chmod(0o600)
        public = (self.base/'ssh-host.pub').read_text().split()
        self.write('known_hosts','[127.0.0.1]:22222 '+public[0]+' '+public[1]+'\n')
        sshd = self.write('sshd.conf','Port 22222\nListenAddress 127.0.0.1\nPidFile '+str(self.base/'sshd.pid')+'\nHostKey '+str(self.base/'ssh-host')+'\nAuthorizedKeysFile '+str(authorized)+'\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nUsePAM no\nStrictModes yes\nSubsystem sftp internal-sftp\n')
        Path('/run/sshd').mkdir(exist_ok=True)
        command('/usr/sbin/sshd','-t','-f',str(sshd))
        command('systemd-run','--unit=cartoteca-ci-stand-sshd','/usr/sbin/sshd','-D','-e','-f',str(sshd))
        self.units.append('cartoteca-ci-stand-sshd')
        self.ssh_args = ['-i',str(self.base/'ssh-client'),'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(self.base/'known_hosts')]
        deadline = time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                command('ssh',*self.ssh_args,'-p','22222','root@127.0.0.1','true',timeout=5)
                return
            except Exception:
                time.sleep(.3)
        print(command('journalctl','-u','cartoteca-ci-stand-sshd','--no-pager','-n','20'),flush=True)
        raise RuntimeError('Stand SSH not ready')

    def fresh_data(self):
        self.compose('stop', '-t', '10', 'app')
        data = self.root / 'data'
        assert data.is_dir() and not data.is_symlink() and self.base == Path('/opt/cartoteca-ci-stand')
        data.rename(self.root / ('fixture-retained-' + os.urandom(6).hex()))
        data.mkdir(mode=0o700); os.chown(data, 1000, 1000)

    def reset(self, schema, key_file=False, production=False, read_budget_enabled=False, publication_gate=False):
        app = {'image':'cartoteca-ci:previous'}
        if schema == 18:
            app['environment'] = {'CARTOTECA_MAX_SCHEMA':'18','CARTOTECA_CABINET_SCHEMA':'2','CARTOTECA_SCHEDULED_NOTIFICATIONS':'1','CARTOTECA_PUSH_ENABLED':'1'}
        if read_budget_enabled:
            assert schema == 17 and production
            app['environment'] = dict(read_budget.FLAGS, CARTOTECA_MAX_SCHEMA='17')
        if publication_gate:
            assert schema == 17 and production and read_budget_enabled
            app['environment']['STAND_PUBLICATION'] = '1'
        self.write('app/production.override.yaml', json.dumps({'services':{'app':app}}))
        self.write('app/compose.yaml',json.dumps({'services':{'app':{'init':True,'container_name':'cartoteca-ci-stand-app','ports':['127.0.0.1:4173:4173'],'network_mode':'bridge','environment':{'STAND_SCHEMA':str(schema),'STAND_PRODUCTION':'1' if production else '0'},'volumes':[str(self.root/'data')+':/data',str(self.base/'start.cjs')+':/stand/start.cjs:ro'],'command':['node','/stand/start.cjs']}}}))
        (self.root/'compose.backup.yaml').write_bytes(self.backup_original)
        if key_file:
            backup=json.loads(self.backup_original)
            volumes=backup['services']['backup']['volumes']
            volumes[volumes.index(str(self.root/'keys')+':/secrets')]=str(self.root/'keys/backup.key')+':/secrets/backup.key:ro'
            (self.root/'compose.backup.yaml').write_text(json.dumps(backup))
        self.compose('up','-d','--force-recreate','app')
        deadline = time.monotonic()+30
        last_error = None
        while time.monotonic()<deadline:
            try:
                import urllib.request
                if urllib.request.urlopen('https://127.0.0.1/login.html').status==200:
                    return
            except Exception as error:
                last_error = repr(error)
                time.sleep(.3)
        # Only this fixture's synthetic services; never inspect host credentials or env.
        print('STAND_HTTP_ERROR', last_error, flush=True)
        print('STAND_APP_LOG', command('docker','logs','cartoteca-ci-stand-app',include_stderr=True)[-4000:], flush=True)
        print('STAND_PROXY_LOG', command('journalctl','-u','cartoteca-ci-stand-caddy','--no-pager','-n','20')[-6000:], flush=True)
        raise RuntimeError('Stand app not ready')

    def compose(self, *args):
        return command('docker','compose','--project-directory',str(self.root),'-p','cartoteca-ci-stand','-f',str(self.root/'compose.yaml'),'-f',str(self.root/'production.override.yaml'),*args)

    def observed(self):
        return json.loads(command('docker','inspect','cartoteca-ci-stand-app'))[0]

    def close(self):
        for directory in self.releases.iterdir():
            state = directory/'state.json'
            if directory.is_dir() and state.exists():
                unit = json.loads(state.read_text()).get('unit')
                if unit:
                    subprocess.run(['systemctl','stop',unit],capture_output=True)
        for unit in self.units+[self.timer]:
            subprocess.run(['systemctl','stop',unit],capture_output=True)
        self.compose('down')
