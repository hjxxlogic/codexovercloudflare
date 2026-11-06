"""Offline safeguards for reusing executable Worker modules during web-only updates."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cloud_web_deploy', ROOT / 'scripts/deploy-cloud.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class WebOnlyDeployment(unittest.TestCase):
    def test_preserved_source_must_match_the_explicit_target(self):
        for target, origin, worker in [('production', 'https://r.xlogic.cc', 'codex-over-cloudflare'),
                                       ('r2', 'https://r2.xlogic.cc', 'codex-over-cloudflare-r2')]:
            source = {'applied': True, 'verification': {'publicAssetBytesMatch': True},
                      'target': origin, 'worker': worker}
            deploy.validate_web_source(source, target)
            for changed in [{'applied': False}, {'verification': {}}, {'worker': 'other'}, {'target': 'https://other.test'}]:
                with self.assertRaisesRegex(RuntimeError, 'verified'):
                    deploy.validate_web_source({**source, **changed}, target)
            with self.assertRaisesRegex(RuntimeError, 'verified'):
                deploy.validate_web_source(source, 'r2' if target == 'production' else 'production')

    def verify(self, modules):
        parts = []
        for name, body in modules.items():
            parts.append(b'--test\r\nContent-Disposition: form-data; name="' + name.encode() +
                         b'"\r\nContent-Type: application/javascript\r\n\r\n' + body + b'\r\n')
        response = io.BytesIO(b''.join(parts) + b'--test--\r\n')
        response.headers = {'Content-Type': 'multipart/form-data; boundary=test'}
        with tempfile.TemporaryDirectory() as directory:
            worker = Path(directory)
            (worker / 'index.js').write_bytes(b'original code')
            (worker / 'index.js.map').write_bytes(b'local debug map')
            with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'test-only'}), \
                    patch.object(deploy.urllib.request, 'urlopen', return_value=response):
                return deploy.verify_existing_worker({'account_id': 'test', 'name': 'test'}, worker)

    def test_exact_runtime_code_and_normalized_debug_map(self):
        self.assertEqual(self.verify({'index.js': b'original code', 'index.js.map': b'normalized map'}),
                         {'index.js': hashlib.sha256(b'original code').hexdigest()})

    def test_rejects_changed_live_code(self):
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            self.verify({'index.js': b'another live version'})

    def test_rejects_unknown_runtime_module(self):
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            self.verify({'index.js': b'original code', 'extra.wasm': b'extra runtime'})

    def test_requires_runtime_entry(self):
        with self.assertRaisesRegex(RuntimeError, 'entry point'):
            self.verify({'index.js.map': b'debug map'})

    def test_rejects_worker_and_native_mutation_options_before_reading_artifacts(self):
        for option in ('--replace-vars', '--publish-downloads', '--notify-release', '--initialize-downloads'):
            result = subprocess.run(['python3', str(ROOT / 'scripts/deploy-cloud.py'), '--local-build',
                                     '--target', 'r2', '--web-only-from', '/nonexistent/artifact.json', option],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('forbids Worker/config/native changes', result.stderr)


if __name__ == '__main__':
    unittest.main()
