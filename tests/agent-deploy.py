"""Deployment trust-boundary and rollback regression; no network, SSH, or service changes."""
import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import tarfile
import tempfile
import types
import unittest
import zipfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load('deploy-agent')
remote = load('deploy-agent-remote')
COMMIT = 'a' * 40
DIGEST = 'b' * 64
BUILD = {'commit': COMMIT, 'sourceDigest': DIGEST, 'dirty': False,
         'protocol': 1, 'target': 'linux-x86_64'}


class DeploymentTests(unittest.TestCase):
    def test_interrupted_download_retries_without_new_curl_options(self):
        failed = types.SimpleNamespace(returncode=56, stdout=b'', stderr=b'reset')
        success = types.SimpleNamespace(returncode=0, stdout=b'', stderr=b'')
        with tempfile.TemporaryDirectory() as temp:
            partial = pathlib.Path(temp) / 'artifact.part'
            partial.write_bytes(b'partial')
            with patch.object(deploy.subprocess, 'run', side_effect=[failed, success]) as run, \
                    patch.object(deploy.time, 'sleep'):
                deploy.curl('https://example.invalid/artifact', partial)
                self.assertEqual(run.call_count, 2)
                self.assertIn('--continue-at', run.call_args.args[0])
                self.assertNotIn('--retry-all-errors', run.call_args.args[0])
            self.assertEqual(partial.read_bytes(), b'partial')

    def test_run_must_be_successful_exact_source_and_workflow(self):
        run = {'head_sha': COMMIT, 'path': '.github/workflows/checks.yml', 'event': 'push',
               'status': 'completed', 'conclusion': 'success', 'html_url': 'test'}
        self.assertTrue(deploy.check_run(run, COMMIT))
        for field, value in [('head_sha', 'c' * 40), ('path', 'other.yml'),
                             ('event', 'pull_request'), ('conclusion', 'failure')]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                deploy.check_run({**run, field: value}, COMMIT)
        jobs = [{'name': name, 'conclusion': 'success'} for name in deploy.REQUIRED_JOBS]
        deploy.check_jobs(jobs)
        with self.assertRaises(RuntimeError):
            deploy.check_jobs(jobs[:-1])
        with self.assertRaises(RuntimeError):
            deploy.check_jobs([{**job, 'conclusion': 'skipped'} for job in jobs])

    def package(self, directory, member='release/coc-agent', kind=tarfile.REGTYPE):
        package = io.BytesIO()
        with tarfile.open(fileobj=package, mode='w:gz') as tar:
            entry = tarfile.TarInfo(member)
            entry.type = kind
            entry.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
            entry.size = 3 if kind == tarfile.REGTYPE else 0
            tar.addfile(entry, io.BytesIO(b'ELF') if entry.size else None)
        name = 'coc-0.5.13-linux-x86_64-musl.tar.gz'
        archive = directory / 'artifact.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('index.json', json.dumps({'version': '0.5.13', 'commit': COMMIT,
                                                      'protocol': 1, 'files': [name]}))
            bundle.writestr('SHA256SUMS', hashlib.sha256(package.getvalue()).hexdigest() + '  ' + name)
            bundle.writestr(name, package.getvalue())
        return archive, 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest()

    def test_artifact_digest_source_and_archive_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = pathlib.Path(temp)
            archive, digest = self.package(directory)
            _, binary = deploy.unpack_artifact(archive, digest, COMMIT, directory)
            self.assertEqual(binary.read_bytes(), b'ELF')
            with self.assertRaises(RuntimeError):
                deploy.unpack_artifact(archive, 'sha256:' + '0' * 64, COMMIT, directory)
            with self.assertRaises(RuntimeError):
                deploy.unpack_artifact(archive, digest, 'c' * 40, directory)
            for member, kind in [('../coc-agent', tarfile.REGTYPE),
                                 ('release/coc-agent', tarfile.SYMTYPE)]:
                archive, digest = self.package(directory, member, kind)
                with self.assertRaises(RuntimeError):
                    deploy.unpack_artifact(archive, digest, COMMIT, directory)

    def test_candidate_identity_cannot_be_dirty_or_wrong_source(self):
        args = types.SimpleNamespace(commit=COMMIT, source_digest=DIGEST)
        remote.identity(BUILD, args)
        for field, value in [('dirty', True), ('sourceDigest', '0' * 64),
                             ('commit', 'c' * 40), ('target', 'windows-x86_64')]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                remote.identity({**BUILD, field: value}, args)

    def test_missing_or_stale_metrics_never_mean_idle(self):
        keys = ['runtimes', 'archiveReaders', 'approvals', 'queuedCommands', 'fileRequests',
                'fileQueueBytes', 'bufferedEvents', 'storageIngressBytes', 'relayEgressBytes']
        metrics = {'event': 'agent_metrics', 'time': 100000, **dict.fromkeys(keys, 0)}
        for data, idle in [(None, False), (metrics, True),
                           ({**metrics, 'time': 0}, False), ({**metrics, 'runtimes': 1}, False)]:
            logs = json.dumps(data) if data else ''
            with patch.object(remote, 'execute', side_effect=['42', 'active', json.dumps(BUILD), logs]), \
                    patch.object(remote.os, 'readlink', return_value='/tmp/coc-agent (deleted)'), \
                    patch.object(remote.time, 'time', return_value=100):
                self.assertEqual(remote.status(pathlib.Path('/tmp/coc-agent'), 'test.service')['idle'], idle)

    def install_fixture(self, directory):
        binary, candidate = directory / 'coc-agent', directory / 'candidate'
        binary.write_bytes(b'old-running-executable')
        candidate.write_bytes(b'new-ci-executable')
        return types.SimpleNamespace(binary=str(binary), candidate=str(candidate),
                                     sha256=hashlib.sha256(candidate.read_bytes()).hexdigest(),
                                     commit=COMMIT, source_digest=DIGEST, service='test.service',
                                     verify_seconds=1, allow_restart_active=False)

    def test_busy_agent_is_never_stopped(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.install_fixture(pathlib.Path(temp))
            with patch.object(remote, 'execute', return_value=json.dumps(BUILD)), \
                    patch.object(remote, 'status', return_value={'idle': False}), \
                    patch.object(remote, 'service') as service:
                with self.assertRaisesRegex(RuntimeError, 'became busy'):
                    remote.install(args)
                service.assert_not_called()
            self.assertEqual(pathlib.Path(args.binary).read_bytes(), b'old-running-executable')

    def test_failed_start_restores_previous_running_binary(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.install_fixture(pathlib.Path(temp))
            original_copy = shutil.copy2

            def copy(source, target):
                return original_copy(args.binary if str(source).startswith('/proc/') else source, target)

            starts = 0

            def service(action, name):
                nonlocal starts
                if action == 'start':
                    starts += 1
                    if starts == 1:
                        raise RuntimeError('simulated new service startup failure')

            with patch.object(remote, 'execute', return_value=json.dumps(BUILD)), \
                    patch.object(remote, 'status', return_value={'idle': True, 'pid': 42}), \
                    patch.object(remote.shutil, 'copy2', side_effect=copy), \
                    patch.object(remote, 'service', side_effect=service):
                with self.assertRaisesRegex(RuntimeError, 'startup failure'):
                    remote.install(args)
            self.assertEqual(starts, 2)
            self.assertEqual(pathlib.Path(args.binary).read_bytes(), b'old-running-executable')
            self.assertEqual(len(list(pathlib.Path(temp).glob('coc-agent.backup-*'))), 1)


if __name__ == '__main__':
    unittest.main()
