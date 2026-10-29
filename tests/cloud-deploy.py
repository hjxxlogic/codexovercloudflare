"""Artifact integrity and extraction boundary checks; executed by GitHub Actions."""
import hashlib
import gzip
import importlib.util
import json
import pathlib
import stat
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cloud', ROOT / 'scripts/deploy-cloud.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
COMMIT = 'a' * 40


class CloudArtifactTests(unittest.TestCase):
    def test_d1_configuration_requires_verified_schema_and_real_database(self):
        with tempfile.TemporaryDirectory() as directory:
            worker = pathlib.Path(directory)
            config = {'vars': {'ACCESS_ENABLED': 'true'}}
            cloud.configure_state_db(config, worker, None)
            self.assertNotIn('d1_databases', config)
            for invalid in ('../bad', '00000000-0000-0000-0000-000000000001'):
                with self.assertRaises(RuntimeError):
                    cloud.configure_state_db(config, worker, invalid)
            database_id = '12345678-1234-1234-1234-123456789abc'
            with self.assertRaises(RuntimeError):
                cloud.configure_state_db(config, worker, database_id)
            (worker / 'state-migrations').mkdir()
            (worker / 'state-migrations/0001_relay_state.sql').write_text('CREATE TABLE test(id);')
            cloud.configure_state_db(config, worker, database_id)
            self.assertEqual(config['vars'], {'ACCESS_ENABLED': 'true', 'STATE_BACKEND': 'd1'})
            self.assertEqual(config['d1_databases'][0]['database_id'], database_id)
            self.assertEqual(config['triggers']['crons'], ['17 * * * *'])

    def artifact(self, root, extra=None, commit=COMMIT, dirty=False):
        path = root / 'artifact.zip'
        with zipfile.ZipFile(path, 'w') as bundle:
            bundle.writestr('deploy-source.json', json.dumps({
                'commit': commit, 'dirty': dirty, 'protocol': 1}))
            bundle.writestr('index.js', 'export default {}')
            if extra:
                bundle.writestr(*extra)
        return path, 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()

    def test_valid_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path, digest = self.artifact(root)
            cloud.unpack(path, digest, COMMIT, root / 'out')
            self.assertTrue((root / 'out/index.js').is_file())

    def test_reject_tampering_and_wrong_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for commit, dirty in [('b' * 40, False), (COMMIT, True)]:
                path, digest = self.artifact(root, commit=commit, dirty=dirty)
                with self.assertRaises(RuntimeError):
                    cloud.unpack(path, digest, COMMIT, root / 'out')
            path, digest = self.artifact(root)
            with self.assertRaises(RuntimeError):
                cloud.unpack(path, 'sha256:' + '0' * 64, COMMIT, root / 'out')

    def test_reject_traversal_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            link = zipfile.ZipInfo('link')
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            for extra in [('../escape', 'bad'), ('/escape', 'bad'), ('dir\\escape', 'bad'), (link, '/tmp')]:
                path, digest = self.artifact(root, extra)
                with self.assertRaises(RuntimeError):
                    cloud.unpack(path, digest, COMMIT, root / 'out')
            self.assertFalse((root / 'escape').exists())


    def test_preserve_uses_canonical_download_page_without_credential_redirect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            site, cache = root / 'site', root / 'cache'
            site.mkdir()
            cache.mkdir()
            replies = {'https://relay.test/downloads/index.json': b'{"files": []}',
                       'https://relay.test/downloads/SHA256SUMS': b'',
                       'https://relay.test/downloads/': b'<html>downloads</html>'}
            with patch.object(cloud.agent, 'curl', side_effect=lambda url: replies[url]):
                cloud.preserve_downloads('https://relay.test', site, cache)
            self.assertEqual((site / 'downloads/index.html').read_bytes(), replies['https://relay.test/downloads/'])

    def native_bundles(self, root, bad_source=False):
        identity = {'version': '0.5.14', 'commit': COMMIT, 'sourceDigest': 'c' * 64, 'protocol': 1}
        bundles = {}
        source = 'codex-over-cloudflare-0.5.14-source.tar.gz'
        for platform in ('linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'):
            package = ('coc-0.5.14-windows-x64.zip' if platform == 'windows-x64'
                       else 'coc-0.5.14-linux-x86_64-' + platform[len('linux-'):] + '.tar.gz')
            content = {package: platform.encode(), source: gzip.compress(b'same source archive', mtime=len(bundles) + 1)}
            manifest = {**identity, 'files': list(content)}
            if bad_source and platform == 'linux-musl':
                manifest['commit'] = 'b' * 40
            path = root / (platform + '.zip')
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('index.json', json.dumps(manifest))
                archive.writestr('SHA256SUMS', ''.join(hashlib.sha256(value).hexdigest() + '  ' + name + '\n' for name, value in content.items()))
                for name, value in content.items():
                    archive.writestr(name, value)
            bundles[platform] = (path, 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest())
        return bundles, identity

    def test_publish_native_downloads_preserves_old_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            site = root / 'site'
            (site / 'downloads').mkdir(parents=True)
            (site / 'downloads/previous.tar.gz').write_bytes(b'previous')
            bundles, identity = self.native_bundles(root)
            manifest = cloud.publish_downloads(bundles, identity, site)
            self.assertEqual(len(manifest['files']), 5)
            with zipfile.ZipFile(bundles['linux-ubuntu20.04'][0]) as archive:
                self.assertEqual((site / 'downloads/codex-over-cloudflare-0.5.14-source.tar.gz').read_bytes(), archive.read('codex-over-cloudflare-0.5.14-source.tar.gz'))
            self.assertEqual((site / 'downloads/previous.tar.gz').read_bytes(), b'previous')
            self.assertEqual(json.loads((site / 'downloads/index.json').read_text())['commit'], COMMIT)

    def test_native_publication_rejects_missing_platform_digest_and_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            site = root / 'site'
            site.mkdir()
            bundles, identity = self.native_bundles(root)
            with self.assertRaises(RuntimeError):
                cloud.publish_downloads({k:v for k,v in bundles.items() if k != 'windows-x64'}, identity, site)
            path, digest = bundles['linux-musl']
            bundles['linux-musl'] = (path, 'sha256:' + '0' * 64)
            with self.assertRaises(RuntimeError):
                cloud.publish_downloads(bundles, identity, site)
            bundles, identity = self.native_bundles(root, bad_source=True)
            with self.assertRaises(RuntimeError):
                cloud.publish_downloads(bundles, identity, site)
            self.assertFalse((site / 'downloads').exists())


if __name__ == '__main__':
    unittest.main()
