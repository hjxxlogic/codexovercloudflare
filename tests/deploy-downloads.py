"""Keep old CI packages from being published beside incompatible native source."""
import importlib.util
import pathlib
import unittest
import tempfile
import json
import sys
from contextlib import ExitStack
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('downloads', pathlib.Path(__file__).resolve().parents[1] / 'scripts/deploy-downloads.py')
downloads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloads)


class NativeInputsTests(unittest.TestCase):
    def test_allows_cloud_and_operator_tool_changes(self):
        with patch.object(downloads.subprocess, 'check_output', return_value='apps/relay/src/migration.ts\ndocs/USER_GUIDE.md\nscripts/deploy-agent.py\n'):
            downloads.check_native_inputs('ci', 'live')

    def test_refuses_runtime_or_toolchain_changes(self):
        for name in ['native/src/agent.cpp', 'CMakeLists.txt', 'config/cloudflare-service-token.json',
                     'scripts/build-access.py', 'Dockerfile.musl', 'vcpkg.json']:
            with self.subTest(name=name), patch.object(downloads.subprocess, 'check_output', return_value=name + '\n'):
                with self.assertRaisesRegex(RuntimeError, 'native inputs differ'):
                    downloads.check_native_inputs('ci', 'live')


class LocalPublicationTests(unittest.TestCase):
    def test_local_preparation_skips_actions_and_preserves_live_assets(self):
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            root = pathlib.Path(temporary)
            original = root / 'prior'
            (original / 'worker').mkdir(parents=True)
            (original / 'site').mkdir()
            (original / 'worker/index.js').write_text('original worker')
            (original / 'site/index.html').write_text('original web')
            prior = {'applied': True, 'verification': {'publicAssetBytesMatch': True},
                     'target': 'https://r.xlogic.cc', 'sourceIdentity': {'commit': 'old'}}
            (original / 'deployment.json').write_text(json.dumps(prior))
            (original / 'deploy.json').write_text(json.dumps({
                'routes': [{'pattern': 'r.xlogic.cc', 'custom_domain': True}], 'assets': {}}))
            identity = {'version': '0.6.16', 'commit': 'new', 'sourceDigest': 'digest',
                        'protocol': 1, 'dirty': False}
            def command(args, **kwargs):
                if args[:2] == ['git', 'status']: return b''
                if args[:2] == ['git', 'rev-parse']: return 'new'
                return json.dumps(identity)
            stack.enter_context(patch.object(downloads, 'ROOT', root))
            stack.enter_context(patch.object(sys, 'argv', ['deploy-downloads.py',
                '--deployment', str(original / 'deployment.json'), '--local-build-dir', str(root / 'build')]))
            stack.enter_context(patch.object(downloads.subprocess, 'check_output', side_effect=command))
            api = stack.enter_context(patch.object(downloads.agent, 'api'))
            stack.enter_context(patch.object(downloads.cloud, 'validate_storage_config'))
            stack.enter_context(patch.object(downloads.cloud, 'verify_existing_worker', return_value={'index.js': 'hash'}))
            preserve = stack.enter_context(patch.object(downloads.cloud, 'preserve_downloads', return_value={'version': 'old'}))
            package = stack.enter_context(patch.object(downloads.cloud, 'publish_local_native', return_value={}))
            downloads.main()
            api.assert_not_called()
            preserve.assert_called_once()
            package.assert_called_once()
            output = root / '.local/deploy-downloads/local-new'
            self.assertEqual((output / 'worker/index.js').read_text(), 'original worker')
            self.assertEqual((output / 'site/index.html').read_text(), 'original web')
            evidence = json.loads((output / 'deployment.json').read_text())
            self.assertFalse(evidence['ciVerified'])
            self.assertFalse(evidence['nativeCiVerified'])
            self.assertIsNone(evidence['run'])
            self.assertFalse(evidence['applied'])
            self.assertEqual(evidence['nativeIdentity']['commit'], 'new')
            identity['dirty'] = True
            with self.assertRaisesRegex(RuntimeError, 'clean source'):
                downloads.main()


if __name__ == '__main__':
    unittest.main()
