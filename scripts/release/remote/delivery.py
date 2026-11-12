"""Download a private signed artifact; stdin and diagnostics never expose the URL."""
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import zipfile
from urllib.parse import urlsplit


def valid_url(value):
    url = urlsplit(value)
    return (url.scheme == 'https' and url.hostname is not None and
            url.hostname.endswith('.blob.core.windows.net') and
            not url.username and not url.password and not url.port and not url.fragment)


class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not valid_url(newurl):
            raise ValueError('Unsafe artifact redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def copy_verified(source, destination, expected_bytes, expected_hash):
    size, digest = 0, hashlib.sha256()
    with destination.open('xb') as target:
        while True:
            chunk = source.read(1048576)
            if not chunk:
                break
            size += len(chunk)
            if size > expected_bytes:
                raise ValueError('Oversized delivery')
            digest.update(chunk)
            target.write(chunk)
        target.flush()
        os.fsync(target.fileno())
    if size != expected_bytes or digest.hexdigest() != expected_hash:
        raise ValueError('Delivery digest differs')


def sync_directory(root):
    fd = os.open(root, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def receive(root, request_hash, payload):
    started = time.monotonic()
    assert root.is_dir() and not any(p.is_symlink() for p in [root, *root.parents])
    assert not (root / 'state.json').exists()
    assert not (root / 'request.json').is_symlink()
    request_bytes = (root / 'request.json').read_bytes()
    assert hashlib.sha256(request_bytes).hexdigest() == request_hash
    request = json.loads(request_bytes)
    assert request['sourceHash'] == payload['sourceHash'] and valid_url(payload['url'])
    for name, expected in request['files'].items():
        file = root / name
        assert file.parent == root and file.is_file() and not file.is_symlink()
        assert hashlib.sha256(file.read_bytes()).hexdigest() == expected
    # Exclusive unique temporary files make retries safe without deleting someone else's files.
    suffix = str(os.getpid()) + '-' + str(time.time_ns())
    archive, output = root / ('delivery-' + suffix + '.zip.part'), root / ('image-' + suffix + '.part')
    try:
        try:
            with urllib.request.build_opener(Redirects()).open(payload['url'], timeout=60) as remote:
                assert valid_url(remote.geturl())
                copy_verified(remote, archive, payload['zipBytes'], payload['zipHash'])
        except urllib.error.HTTPError as error:
            return {'status': 'unavailable', 'reason': 'http', 'httpStatus': error.code,
                    'durationMs': round((time.monotonic() - started) * 1000)}
        except (urllib.error.URLError, TimeoutError) as error:
            reason = 'timeout' if isinstance(error, TimeoutError) or isinstance(
                getattr(error, 'reason', None), TimeoutError) else 'network'
            return {'status': 'unavailable', 'reason': reason,
                    'durationMs': round((time.monotonic() - started) * 1000)}
        with zipfile.ZipFile(archive) as zip_file:
            entries = [entry for entry in zip_file.infolist() if entry.filename == payload['entry']]
            assert len(entries) == 1 and entries[0].file_size == request['imageBytes']
            with zip_file.open(entries[0]) as source:
                copy_verified(source, output, request['imageBytes'], request['imageHash'])
        assert not (root / 'state.json').exists()
        os.replace(output, root / 'image.tar')
        sync_directory(root)
        return {'status': 'passed', 'method': 'GitHub-Azure-direct',
                'imageBytes': request['imageBytes'], 'imageHash': request['imageHash'],
                'zipBytes': payload['zipBytes'], 'zipHash': payload['zipHash'],
                'durationMs': round((time.monotonic() - started) * 1000)}
    finally:
        for file in [archive, output]:
            if file.exists():
                file.unlink()


if __name__ == '__main__':
    try:
        result = receive(pathlib.Path(sys.argv[1]), sys.argv[2], json.load(sys.stdin))
        print(json.dumps(result))
    except Exception:
        # urllib exceptions can include the signed URL. Keep diagnostics intentionally bounded.
        print(json.dumps({'status': 'failed', 'reason': 'delivery_verification'}))
        sys.exit(1)
