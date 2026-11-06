"""Keep old CI packages from being published beside incompatible native source."""
import importlib.util
import pathlib
import unittest
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


if __name__ == '__main__':
    unittest.main()
