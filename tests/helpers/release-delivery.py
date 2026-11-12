"""Offline receiver contract tests; synthetic archives and no SSH/network access."""
import hashlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('delivery', pathlib.Path(__file__).resolve().parents[2] / 'scripts/release/remote/delivery.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class Response(io.BytesIO):
    def geturl(self):
        return 'https://synthetic.blob.core.windows.net/test'


class Receiver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='release-delivery-')
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name).resolve()
        self.image = b'SYNTHETIC_IMAGE'
        self.request = {'sourceHash': 'synthetic', 'imageBytes': len(self.image),
                        'imageHash': hashlib.sha256(self.image).hexdigest(), 'files': {}}
        data = json.dumps(self.request).encode()
        (self.root / 'request.json').write_bytes(data)
        self.request_hash = hashlib.sha256(data).hexdigest()
        self.payload = {'url': 'https://synthetic.blob.core.windows.net/test', 'sourceHash': 'synthetic',
                        'entry': 'image-100/image.tar'}
        self.zip_data = self.archive([('image-100/image.tar', self.image)])

    def archive(self, entries):
        buffer = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(buffer, 'w') as archive:
                for name, data in entries:
                    archive.writestr(name, data)
        data = buffer.getvalue()
        self.payload.update(zipBytes=len(data), zipHash=hashlib.sha256(data).hexdigest())
        return data

    def run_receive(self, data=None):
        source = self.zip_data if data is None else data
        with patch.object(delivery.urllib.request, 'build_opener') as opener, patch.object(delivery, 'sync_directory'):
            opener.return_value.open.return_value = Response(source)
            return delivery.receive(self.root, self.request_hash, self.payload)

    def clean(self):
        self.assertFalse(list(self.root.glob('*.part')))

    def test_success_only_extracts_image_and_retries_idempotently(self):
        self.zip_data = self.archive([('image-100/image.tar', self.image), ('../escape', b'BAD')])
        self.assertEqual(self.run_receive()['status'], 'passed')
        self.assertEqual((self.root / 'image.tar').read_bytes(), self.image)
        self.assertEqual(self.run_receive()['status'], 'passed')
        self.clean()

    def test_corrupt_zip_is_rejected_and_cleaned(self):
        with self.assertRaises(ValueError):
            self.run_receive(self.zip_data[:-1] + b'X')
        self.clean()
        self.assertFalse((self.root / 'image.tar').exists())

    def test_oversized_zip_is_rejected(self):
        self.payload['zipBytes'] = 1
        with self.assertRaises(ValueError):
            self.run_receive()
        self.clean()

    def test_wrong_image_hash_is_rejected(self):
        self.zip_data = self.archive([('image-100/image.tar', b'X' * len(self.image))])
        with self.assertRaises(ValueError):
            self.run_receive()
        self.clean()

    def test_duplicate_or_absent_image_entry_is_rejected(self):
        for entries in [[('other', self.image)], [('image-100/image.tar', self.image)] * 2]:
            self.zip_data = self.archive(entries)
            with self.assertRaises(AssertionError):
                self.run_receive()
            self.clean()

    def test_request_source_and_existing_server_state_are_checked(self):
        self.request_hash = '0' * 64
        with self.assertRaises(AssertionError):
            self.run_receive()
        self.request_hash = hashlib.sha256((self.root / 'request.json').read_bytes()).hexdigest()
        self.payload['sourceHash'] = 'other'
        with self.assertRaises(AssertionError):
            self.run_receive()
        self.payload['sourceHash'] = 'synthetic'
        (self.root / 'state.json').write_text('{}')
        with self.assertRaises(AssertionError):
            self.run_receive()

    def test_expired_download_is_unavailable_without_an_image(self):
        with patch.object(delivery.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = urllib.error.URLError('synthetic')
            self.assertEqual(delivery.receive(self.root, self.request_hash, self.payload)['status'], 'unavailable')
        self.clean()

    def test_http_reason_is_safe_and_distinct_from_timeout(self):
        cases = [
            (urllib.error.HTTPError('https://synthetic/?sig=PRIVATE', 403, 'PRIVATE', None, None),
             'http', 403),
            (TimeoutError('PRIVATE'), 'timeout', None),
            (urllib.error.URLError(TimeoutError('PRIVATE')), 'timeout', None),
            (urllib.error.URLError('PRIVATE'), 'network', None),
        ]
        for error, reason, status in cases:
            with patch.object(delivery.urllib.request, 'build_opener') as opener:
                opener.return_value.open.side_effect = error
                result = delivery.receive(self.root, self.request_hash, self.payload)
            self.assertEqual(result['reason'], reason)
            self.assertEqual(result.get('httpStatus'), status)
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertIsInstance(result['durationMs'], int)
            self.clean()

    def test_unsafe_redirect_is_rejected(self):
        for url in ['http://synthetic.blob.core.windows.net/x', 'https://attacker.invalid/x',
                    'https://user:pass@synthetic.blob.core.windows.net/x']:
            self.assertFalse(delivery.valid_url(url))
            with self.assertRaises(ValueError):
                delivery.Redirects().redirect_request(None, None, 302, 'redirect', {}, url)


if __name__ == '__main__':
    unittest.main()
