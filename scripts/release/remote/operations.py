import json
import os
from pathlib import Path
import subprocess
import time
import uuid


class Operations:
    def __init__(self, request, directory):
        if request['config'].get('storageBackend', 'sqlite') != 'sqlite':
            from postgres import reject_automatic_switch
            reject_automatic_switch(request['config'])
        self.request, self.directory = request, directory
        self.config = request['config']
        self.root = Path(self.config['root'])
        self.previous_file = directory / 'previous.json'
        self.timer_touched = False
        self.migration = None
        self.publication = None
        if self.config.get('publicationGate') is True:
            from publication_gate import PublicationGate
            self.publication = PublicationGate(self)
        if self.config.get('migration'):
            if self.config['migration'] == 'read-budget-17':
                from read_budget import ReadBudgetMigration
                self.migration = ReadBudgetMigration(self)
            elif self.config['migration'] == 'booking-links-17':
                from booking_links import BookingLinksMigration
                self.migration = BookingLinksMigration(self)
            elif self.config['migration'] == 'paid-services-17-to-19':
                from paid_services import PaidServicesMigration
                self.migration = PaidServicesMigration(self)
            else:
                from migration import StaffMaxMigration
                self.migration = StaffMaxMigration(self)

    def command(self, args, timeout=60, stdin=None):
        result = subprocess.run(args, input=stdin, capture_output=True, timeout=timeout,
                                env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8'})
        if result.returncode:
            raise RuntimeError('COMMAND_FAILED')
        return result.stdout

    @property
    def image_id(self):
        from checks import candidate_image
        return candidate_image(self)

    def inspect(self):
        return json.loads(self.command(['docker', 'inspect', self.config['container']]))[0]

    def compose(self, *args, backup=False, timeout=90):
        base = ['docker', 'compose', '--project-directory', str(self.root)]
        if backup:
            base += ['-f', str(self.root / 'compose.backup.yaml')]
        else:
            base += ['-p', self.config['project'], '-f', str(self.root / 'compose.yaml'), '-f', str(self.root / 'production.override.yaml')]
        return self.command(base + list(args), timeout=timeout)

    def assert_previous(self):
        current = self.inspect()
        if current['Image'] != self.config['expectedImage'] or not current['State']['Running']:
            raise RuntimeError('PREVIOUS_VERSION_CHANGED')
        return current

    def pause_timer(self):
        timer = self.config['backupTimer']
        if self.command(['systemctl', 'is-active', timer]).strip() != b'active':
            raise RuntimeError('BACKUP_TIMER_NOT_ACTIVE')
        self.command(['systemctl', 'stop', timer])
        self.timer_touched = True
        try:
            service = timer.removesuffix('.timer') + '.service'
            state = self.command(['systemctl', 'show', service, '-p', 'ActiveState', '--value']).strip()
            if state not in [b'inactive', b'failed']:
                raise RuntimeError('BACKUP_ALREADY_RUNNING')
        except Exception:
            self.restore_timer()
            raise

    def restore_timer(self):
        self.command(['systemctl', 'start', self.config['backupTimer']])
        if self.command(['systemctl', 'is-active', self.config['backupTimer']]).strip() != b'active':
            raise RuntimeError('BACKUP_TIMER_NOT_ACTIVE')
        self.timer_touched = False

    def backup(self):
        output = self.compose('run', '--rm', '--no-deps', 'backup', 'node', 'scripts/backup-agent.cjs', 'run', backup=True, timeout=1830)
        rows = [json.loads(line) for line in output.decode().splitlines() if line.startswith('{')]
        if not rows or rows[-1].get('state') not in ['protected', 'local_only']:
            raise RuntimeError('BACKUP_AND_DRILL_NOT_CONFIRMED')
        if self.config.get('storageBackend', 'sqlite') != 'sqlite':
            from postgres import enabled, backup_proof
            if not enabled(self.config):
                raise RuntimeError('INVALID_STORAGE_BACKEND')
            from agent import atomic
            proof = backup_proof(rows[-1])
            state = json.loads((self.directory / 'state.json').read_text())
            stage = state.get('currentStage')
            if stage not in ['backup-before', 'backup-after']:
                raise RuntimeError('POSTGRES_BACKUP_STAGE_INVALID')
            atomic(self.directory / (stage + '-postgres.json'), proof)
            return proof
        return {'state': rows[-1]['state']}

    def cleanup_storage(self):
        from agent import atomic, digest
        import re
        releases = Path(self.config['releaseRoot'])
        if any(p.is_symlink() for p in [releases, *releases.parents]):
            raise RuntimeError('LINKED_RELEASE_DIRECTORY')
        completed = []
        for directory in releases.iterdir():
            if not re.fullmatch(r'r-[a-f0-9]{12}-[a-f0-9]{12}', directory.name) or directory.is_symlink() or not directory.is_dir():
                continue
            state_file, request_file = directory / 'state.json', directory / 'request.json'
            # Requests carry the canonical runtime manifest (already >64 KiB).
            # Keep the small state bound; cap request metadata separately at the
            # release transport's 2 MiB metadata envelope, never read unbounded input.
            metadata = [(state_file, 65536), (request_file, 2 * 1024 * 1024)]
            if not all(file.is_file() and not file.is_symlink() and file.stat().st_size <= limit for file, limit in metadata):
                continue
            try:
                state, request = json.loads(state_file.read_text()), json.loads(request_file.read_text())
            except (ValueError, OSError):
                continue
            if state.get('status') != 'completed' or state.get('published') is not True or request.get('run') != directory.name:
                continue
            config = request.get('config', {})
            if config.get('root') != self.config['root'] or config.get('releaseRoot') != self.config['releaseRoot']:
                continue
            image, stamp = state.get('actualImage', ''), state.get('finishedAt', state.get('updatedAt'))
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', image) or type(stamp) not in [int, float]:
                continue
            completed.append((stamp, directory, state, request))
        completed.sort(key=lambda row: row[0], reverse=True)
        # The current run is retained independently, including before finishedAt
        # is written. Incomplete/foreign releases are never cleanup candidates.
        older = [row for row in completed if row[1] != self.directory][2:]
        used = {self.inspect()['Image'], self.config['expectedImage']}
        container_ids = self.command(['docker', 'ps', '-aq']).decode().split()
        if container_ids:
            if any(not re.fullmatch(r'[a-f0-9]{12,64}', identity) for identity in container_ids):
                raise RuntimeError('INVALID_CONTAINER_ID')
            used.update(row['Image'] for row in json.loads(self.command(['docker', 'inspect', *container_ids])))
        tags = {}
        for line in self.command(['docker', 'image', 'ls', '--no-trunc', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}']).decode().splitlines():
            parts = line.split()
            if len(parts) == 2:
                tags[parts[0]] = parts[1]
        record = {'format': 1, 'plannedRuns': [row[1].name for row in older], 'removedArchives': [], 'removedTags': []}
        evidence = self.directory / 'storage-maintenance.json'
        atomic(evidence, record)
        for _, directory, state, request in older:
            if any(p.is_symlink() for p in [directory, *directory.parents]) or directory.parent != releases:
                raise RuntimeError('LINKED_RELEASE_DIRECTORY')
            archive = directory / 'image.tar'
            if archive.exists():
                before = archive.lstat()
                if archive.is_symlink() or not archive.is_file() or not re.fullmatch(r'[a-f0-9]{64}', request.get('imageHash', '')):
                    raise RuntimeError('INVALID_OLD_IMAGE_ARCHIVE')
                if before.st_size != request.get('imageBytes') or digest(archive) != request['imageHash']:
                    raise RuntimeError('OLD_IMAGE_ARCHIVE_CHANGED')
                after = archive.lstat()
                if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise RuntimeError('OLD_IMAGE_ARCHIVE_CHANGED')
                archive.unlink()
                descriptor = os.open(directory, os.O_RDONLY)
                try: os.fsync(descriptor)
                finally: os.close(descriptor)
                record['removedArchives'].append(directory.name)
                atomic(evidence, record)
            tag = 'cartoteca:release-' + directory.name
            if tags.get(tag) == state['actualImage'] and state['actualImage'] not in used:
                actual = self.command(['docker', 'image', 'inspect', tag, '--format', '{{.Id}}']).decode().strip()
                if actual != state['actualImage']:
                    raise RuntimeError('OLD_IMAGE_TAG_CHANGED')
                # Remove only this managed tag, without force or volume pruning.
                self.command(['docker', 'image', 'rm', tag])
                record['removedTags'].append(tag)
                atomic(evidence, record)
        return {'removedArchives': len(record['removedArchives']), 'removedTags': len(record['removedTags'])}

    def save_configuration(self):
        from agent import atomic
        current = self.assert_previous()
        old_name = current['Config']['Image']
        build = self.command(['docker', 'exec', self.config['container'], 'node', '-e', 'const fs=require("fs"),layout="/app/src/shared/web-assets.cjs",modern=fs.existsSync(layout);if(!modern&&fs.existsSync("/app/dist/public"))throw Error("UNRECOGNIZED_PUBLIC_LAYOUT");const root=modern?require(layout).publicAssetRoot("/app"):"/app";require("/app/src/server/http/client-release.cjs").clientRelease(root).then(console.log)']).decode().strip()
        if len(build) != 16 or any(c not in '0123456789abcdef' for c in build):
            raise RuntimeError('PREVIOUS_BUILD_UNKNOWN')
        if self.command(['docker', 'image', 'inspect', old_name, '--format', '{{.Id}}']).decode().strip() != current['Image']:
            raise RuntimeError('PREVIOUS_TAG_CHANGED')
        for name in ['production.override.yaml', 'compose.backup.yaml']:
            source = self.root / name
            if source.is_symlink() or not source.is_file():
                raise RuntimeError('INVALID_COMPOSE_FILE')
            content = source.read_bytes()
            if content.count(old_name.encode()) != 1:
                raise RuntimeError('COMPOSE_IMAGE_NOT_UNAMBIGUOUS')
            saved = self.directory / ('before-' + name)
            if saved.exists():
                if saved.read_bytes() != content:
                    raise RuntimeError('CONFIGURATION_CHANGED')
            else:
                with open(saved, 'xb') as stream:
                    stream.write(content); stream.flush(); os.fsync(stream.fileno())
        atomic(self.previous_file, {'imageId': current['Image'], 'imageName': old_name, 'build': build})

    def configuration_bytes(self, name, phase='gated'):
        saved = (self.directory / ('before-' + name)).read_bytes()
        if (self.migration or self.publication) and name == 'production.override.yaml':
            return (self.directory / (phase + '-production.override.yaml')).read_bytes()
        old = json.loads(self.previous_file.read_text())
        return saved.replace(old['imageName'].encode(), ('cartoteca:release-' + self.request['run']).encode())

    def replace_configs(self, restore=False, phase='gated'):
        old = json.loads(self.previous_file.read_text())
        new_name = 'cartoteca:release-' + self.request['run']
        for name in ['production.override.yaml', 'compose.backup.yaml']:
            target = self.root / name
            saved = (self.directory / ('before-' + name)).read_bytes()
            newer = self.configuration_bytes(name, phase)
            valid = [saved, newer]
            if (self.migration or self.publication) and name == 'production.override.yaml':
                valid += [self.configuration_bytes(name, 'gated'), self.configuration_bytes(name, 'enabled')]
            if target.read_bytes() not in valid:
                raise RuntimeError('COMPOSE_CHANGED_EXTERNALLY')
            temporary = target.with_name(target.name + '.next-' + uuid.uuid4().hex)
            with open(temporary, 'xb') as stream:
                stream.write(saved if restore else newer); stream.flush(); os.fsync(stream.fileno())
            os.chmod(temporary, target.stat().st_mode & 0o777)
            os.replace(temporary, target)
            descriptor = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        self.compose('config', '--quiet')
        self.compose('config', '--quiet', backup=True)

    def wait_ready(self, expected, build=None):
        from checks import http
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            current = self.inspect()
            if current['Image'] != expected or current['RestartCount'] or current['State'].get('OOMKilled'):
                raise RuntimeError('APPLICATION_CRASHED')
            if not current['State']['Running']:
                raise RuntimeError('APPLICATION_STOPPED')
            try:
                status, _, body = http(self.config['origin'] + '/login.html')
                if status == 200 and (build is None or build.encode() in body):
                    return
            except Exception:
                pass
            time.sleep(1)
        raise RuntimeError('APPLICATION_NOT_READY')

    def switch(self):
        self.command(['docker', 'tag', self.image_id, 'cartoteca:release-' + self.request['run']])
        self.compose('stop', '-t', '45', 'app')
        self.replace_configs()
        self.compose('up', '-d', '--no-build', '--no-deps', 'app')
        self.wait_ready(self.image_id, json.loads((self.directory / 'image-proof.json').read_text())['build'])

    def rollback(self):
        if self.publication:
            self.publication.assert_rollback_safe()
        previous = json.loads(self.previous_file.read_text())
        # Restore the saved name only if it still resolves to the saved immutable image.
        if self.command(['docker', 'image', 'inspect', previous['imageName'], '--format', '{{.Id}}']).decode().strip() != previous['imageId']:
            raise RuntimeError('ROLLBACK_IMAGE_CHANGED')
        if self.migration:
            self.migration.rollback_data()
        self.replace_configs(restore=True)
        self.compose('up', '-d', '--no-build', '--no-deps', 'app')
        self.wait_ready(previous['imageId'], previous['build'])
        from checks import schema, http
        schema(self, expected=self.migration.previous_schema if self.migration else self.config['schema'])
        if http(self.config['origin'] + '/api/cabinet')[0] != 401:
            raise RuntimeError('ROLLBACK_ACCESS_CHECK_FAILED')
