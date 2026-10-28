"""Artifact integrity and extraction boundary checks; executed by GitHub Actions."""
import hashlib
import importlib.util
import json
import pathlib
import stat
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cloud', ROOT / 'scripts/deploy-cloud.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
COMMIT = 'a' * 40


class CloudArtifactTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
