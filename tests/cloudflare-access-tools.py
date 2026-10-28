"""Verify release-tool origin boundaries and redirect rejection without network access."""
import importlib.util
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deploy_access_test', ROOT / 'scripts/deploy-agent.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class AccessTools(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.file = pathlib.Path(self.directory.name) / 'access.json'
        self.file.write_text(json.dumps({'origins': ['https://relay.example.test'], 'clientId': 'test-client', 'clientSecret': 'test-secret'}))
        self.file.chmod(0o600)
        self.environment = patch.dict(os.environ, {'COC_ACCESS_CONFIG': str(self.file)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_origin_scope(self):
        self.assertIsNotNone(deploy._access.request_headers('https://relay.example.test:443/downloads/index.json'))
        for target in ['https://github.com/api', 'https://relay.example.test:444/', 'http://relay.example.test/', 'https://other.example.test/']:
            self.assertIsNone(deploy._access.request_headers(target))

    def test_headers_use_stdin_and_redirects_are_disabled(self):
        response = types.SimpleNamespace(returncode=0, stdout=b'{}\n200 application/json', stderr=b'')
        with patch.object(deploy.subprocess, 'run', return_value=response) as run:
            self.assertEqual(deploy.curl('https://relay.example.test/api/v1/healthz'), b'{}')
        args = run.call_args.args[0]
        self.assertNotIn('--location', args)
        self.assertNotIn('test-secret', str(args))
        self.assertIn(b'CF-Access-Client-Secret: test-secret', run.call_args.kwargs['input'])

    def test_redirect_and_html_are_not_downloads(self):
        for output in [b'login\n302 text/html', b'login\n200 text/html']:
            with patch.object(deploy.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=output, stderr=b'')):
                with self.assertRaises(RuntimeError):
                    deploy.curl('https://relay.example.test/downloads/index.json')

    def test_reject_header_injection(self):
        self.file.write_text(json.dumps({'origins': ['https://relay.example.test'], 'clientId': 'test', 'clientSecret': 'test\r\nInjected: yes'}))
        with self.assertRaises(ValueError):
            deploy._access.request_headers('https://relay.example.test/')


if __name__ == '__main__':
    unittest.main()
