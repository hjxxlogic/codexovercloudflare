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
    def test_uncommitted_mode_requires_local_build(self):
        with patch('sys.argv', ['deploy-cloud.py', '--allow-uncommitted']):
            with self.assertRaises(SystemExit) as error:
                cloud.main()
            self.assertEqual(error.exception.code, 2)

    def test_r2_target_isolates_routes_bindings_and_access(self):
        import re
        config = json.loads(re.sub(r',(\s*[}\]])', r'\1', (ROOT / 'wrangler.jsonc').read_text()))
        original = json.loads(json.dumps(config))
        result = cloud.deployment_target(config, 'r2', 'a' * 64)
        self.assertEqual(config, original)
        self.assertEqual(result['name'], 'codex-over-cloudflare-r2')
        self.assertEqual(result['routes'], [{'pattern': 'r2.xlogic.cc', 'custom_domain': True}])
        self.assertEqual(result['vars']['ACCESS_AUD'], 'a' * 64)
        self.assertFalse(result['workers_dev'])
        self.assertEqual(result['durable_objects'], original['durable_objects'])
        self.assertEqual(cloud.deployment_target(config, 'production'), original)
        result = cloud.deployment_target(config, 'r2', without_access=True)
        self.assertEqual(result['vars']['ACCESS_ENABLED'], 'false')
        self.assertNotIn('ACCESS_AUD', result['vars'])
        for args in [('production', 'a' * 64, False), ('production', None, True),
                     ('r2', None, False), ('r2', 'a' * 64, True), ('r2', 'bad', False)]:
            with self.assertRaises(RuntimeError):
                cloud.deployment_target(config, *args)
        config['durable_objects']['bindings'][0]['script_name'] = original['name']
        with self.assertRaisesRegex(RuntimeError, 'Worker-local'):
            cloud.deployment_target(config, 'r2', 'a' * 64)

    def test_initialization_cannot_skip_platforms_or_modify_production(self):
        for args in [[], ['--publish-downloads'], ['--target', 'r2', '--r2-without-access'],
                     ['--target', 'r2', '--r2-without-access', '--publish-downloads', '--skip-native-platform', 'linux-musl']]:
            with patch('sys.argv', ['deploy-cloud.py', '--initialize-downloads', *args]):
                with self.assertRaises(SystemExit):
                    cloud.main()

    def test_production_config_uses_only_durable_objects(self):
        import re
        config = json.loads(re.sub(r',(\s*[}\]])', r'\1', (ROOT / 'wrangler.jsonc').read_text()))
        self.assertNotIn('STATE_BACKEND', config['vars'])
        cloud.validate_storage_config(config)
        self.assertEqual(config.get('d1_databases', []), [])
        self.assertEqual(config['triggers']['crons'], [])

    def test_local_mode_cannot_publish_native_or_claim_a_ci_run(self):
        for options in (['--run-id', '1'], ['--cloud-only-after-windows-failure'],
                        ['--publish-downloads'], ['--notify-release']):
            with patch('sys.argv', ['deploy-cloud.py', '--local-build', *options]):
                with self.assertRaises(SystemExit) as error:
                    cloud.main()
                self.assertEqual(error.exception.code, 2)

    def test_cloud_only_exception_keeps_other_checks_and_identity_required(self):
        run = {'head_sha': COMMIT, 'path': '.github/workflows/checks.yml',
               'event': 'push', 'status': 'completed', 'conclusion': 'failure'}
        jobs = [{'name': name, 'conclusion': 'failure' if name == 'windows-x64' else 'success'}
                for name in cloud.agent.REQUIRED_JOBS]
        def verify(candidate_run, candidate_jobs):
            with patch.object(cloud.agent, 'api', side_effect=[candidate_run, {'jobs': candidate_jobs}]):
                return cloud.completed_cloud_run('owner/repo', COMMIT, 1)
        self.assertEqual(verify(run, jobs), (run, jobs))
        for field, value in [('head_sha', 'b' * 40), ('path', 'other.yml'),
                             ('event', 'pull_request'), ('status', 'in_progress'),
                             ('conclusion', 'cancelled')]:
            with self.assertRaises(RuntimeError):
                verify({**run, field: value}, jobs)
        for name in cloud.agent.REQUIRED_JOBS:
            changed = [{**job, 'conclusion': 'skipped'} if job['name'] == name else job for job in jobs]
            with self.assertRaises(RuntimeError):
                verify(run, changed)
        with self.assertRaises(RuntimeError):
            verify(run, [job for job in jobs if job['name'] != 'windows-x64'])
        for forbidden in ('--publish-downloads', '--notify-release'):
            with patch('sys.argv', ['deploy-cloud.py', '--cloud-only-after-windows-failure', '--run-id', '1', forbidden]):
                with self.assertRaises(SystemExit) as error:
                    cloud.main()
                self.assertEqual(error.exception.code, 2)

    def test_release_notification_authenticates_and_checks_identity(self):
        manifest = {'version': '0.5.15', 'commit': COMMIT}
        with tempfile.TemporaryDirectory() as directory:
            secret = pathlib.Path(directory) / 'owner'
            secret.write_text('synthetic-owner-secret-' * 3)
            secret.chmod(0o600)
            with patch.object(cloud, 'release_post', side_effect=[{'token': 'test-token'}, manifest]) as post:
                self.assertEqual(cloud.notify_release('https://relay.test', manifest, secret), manifest)
                self.assertEqual(post.call_args_list[0].args[1], '/api/v1/auth/login')
                self.assertEqual(post.call_args_list[1].args, (
                    'https://relay.test', '/api/v1/admin/releases', manifest, 'test-token'))
            with patch.object(cloud, 'release_post', side_effect=[{'token': 'test-token'}, {**manifest, 'commit': 'b' * 40}]):
                with self.assertRaisesRegex(RuntimeError, 'identity mismatch'):
                    cloud.notify_release('https://relay.test', manifest, secret)

    def test_release_credentials_reject_redirects_and_nonprivate_secret(self):
        self.assertIsNone(cloud.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.test'))
        if cloud.os.name != 'nt':
            with tempfile.TemporaryDirectory() as directory:
                secret = pathlib.Path(directory) / 'owner'
                secret.write_text('synthetic-owner-secret-' * 3)
                secret.chmod(0o644)
                with patch.object(cloud, 'release_post') as post:
                    with self.assertRaisesRegex(RuntimeError, 'private'):
                        cloud.notify_release('https://relay.test', {}, secret)
                    post.assert_not_called()

    def test_reject_removed_storage_configuration(self):
        config = {'durable_objects': {'bindings': [
            {'name': 'REGISTRY', 'class_name': 'RegistryDO'},
            {'name': 'HOSTS', 'class_name': 'HostRelayDO'},
        ]}}
        cloud.validate_storage_config(config)
        for extra in ({'vars': {'STATE_BACKEND': 'do'}},
                      {'d1_databases': [{'binding': 'STATE_DB'}]},
                      {'durable_objects': {'bindings': []}}):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                cloud.validate_storage_config({**config, **extra})

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

    def test_explicit_musl_deferral_preserves_verified_previous_download(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            site = root / 'site'
            target = site / 'downloads'
            target.mkdir(parents=True)
            old_name = 'coc-0.5.13-linux-x86_64-musl.tar.gz'
            old_bytes = b'previous verified static musl package'
            (target / old_name).write_bytes(old_bytes)
            (target / 'index.json').write_text(json.dumps({
                'version': '0.5.13', 'commit': 'b' * 40, 'files': [old_name]}))
            (target / 'SHA256SUMS').write_text(hashlib.sha256(old_bytes).hexdigest() + '  ' + old_name + '\n')
            bundles, identity = self.native_bundles(root)
            del bundles['linux-musl']
            with self.assertRaises(RuntimeError):
                cloud.publish_downloads(bundles, identity, site)
            (target / old_name).write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                cloud.publish_downloads(bundles, identity, site, skip_musl=True)
            (target / old_name).write_bytes(old_bytes)
            result = cloud.publish_downloads(bundles, identity, site, skip_musl=True)
            self.assertEqual(result['deferredPlatforms']['linux-musl']['version'], '0.5.13')
            self.assertIn(old_name, result['files'])
            self.assertNotIn('coc-0.5.14-linux-x86_64-musl.tar.gz', result['files'])
            self.assertEqual((target / old_name).read_bytes(), old_bytes)
            self.assertIn('暂缓发布', (target / 'index.html').read_text())
            self.assertIn(hashlib.sha256(old_bytes).hexdigest(), (target / 'SHA256SUMS').read_text())
            self.assertEqual(cloud.publish_downloads(bundles, identity, site, skip_musl=True), result)

    def test_musl_deferral_requires_explicit_partial_publication_without_notification(self):
        for options in ([], ['--publish-downloads', '--notify-release']):
            with patch('sys.argv', ['deploy-cloud.py', '--skip-native-platform', 'linux-musl', *options]):
                with self.assertRaises(SystemExit) as error:
                    cloud.main()
                self.assertEqual(error.exception.code, 2)

    def test_oversized_native_archive_is_rejected_before_writing_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            site = root / 'site'
            site.mkdir()
            bundles, identity = self.native_bundles(root)
            path, _ = bundles['linux-musl']
            with zipfile.ZipFile(path) as archive:
                contents = {name: archive.read(name) for name in archive.namelist()}
            package = 'coc-0.5.14-linux-x86_64-musl.tar.gz'
            contents[package] = b'x' * (25 * 1024 * 1024 + 1)
            files = json.loads(contents['index.json'])['files']
            contents['SHA256SUMS'] = ''.join(
                hashlib.sha256(contents[name]).hexdigest() + '  ' + name + '\n'
                for name in files).encode()
            with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
                for name, data in contents.items():
                    archive.writestr(name, data)
            bundles['linux-musl'] = (path, 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest())
            with self.assertRaisesRegex(RuntimeError, '25 MiB'):
                cloud.publish_downloads(bundles, identity, site)
            self.assertFalse((site / 'downloads' / package).exists())


if __name__ == '__main__':
    unittest.main()
