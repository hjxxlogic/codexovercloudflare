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
    def test_authenticated_metadata_uses_gh_without_public_fallback(self):
        with patch.object(deploy.shutil, 'which', return_value='/tools/gh'), \
                patch.object(deploy.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)), \
                patch.object(deploy.subprocess, 'check_output', return_value=b'{"id":42}') as request, \
                patch.object(deploy, 'curl') as public:
            self.assertEqual(deploy.api('owner/repo', 'runs/42'), {'id': 42})
            self.assertEqual(request.call_args.args[0], [
                '/tools/gh', 'api', '--hostname', 'github.com', 'repos/owner/repo/actions/runs/42'])
            public.assert_not_called()
            request.side_effect = deploy.subprocess.CalledProcessError(1, ['gh', 'api'])
            with self.assertRaises(deploy.subprocess.CalledProcessError):
                deploy.api('owner/repo', 'runs/42')
            public.assert_not_called()

    def test_metadata_without_gh_login_keeps_public_api(self):
        for executable in (None, '/tools/gh'):
            with patch.object(deploy.shutil, 'which', return_value=executable), \
                    patch.object(deploy.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)), \
                    patch.object(deploy, 'curl', return_value=b'{"id":42}') as public:
                self.assertEqual(deploy.api('owner/repo', 'runs/42'), {'id': 42})
                public.assert_called_once_with('https://api.github.com/repos/owner/repo/actions/runs/42')

    def test_text_response_retries_discard_partial_stdout(self):
        for headers in (None, b'X-Test-Access: synthetic\n'):
            failed = types.SimpleNamespace(returncode=28, stdout=b'partial response', stderr=b'timeout')
            success = types.SimpleNamespace(returncode=0, stdout=b'complete\n200 application/json' if headers else b'complete', stderr=b'')
            with self.subTest(headers=bool(headers)), patch.object(deploy._access, 'request_headers', return_value=headers), \
                    patch.object(deploy.subprocess, 'run', side_effect=[failed, success]) as run, \
                    patch.object(deploy.time, 'sleep'):
                self.assertEqual(deploy.curl('https://example.invalid/metadata'), b'complete')
                self.assertEqual(run.call_count, 2)
                args = run.call_args.args[0]
                self.assertEqual(args[args.index('--retry') + 1], '0')
                self.assertEqual(args[args.index('--max-time') + 1], '60')
                self.assertIn('--compressed', args)

    def test_push_rejects_dirty_source_or_another_repository(self):
        for replies in [[' M native/src/agent.cpp'],
                        ['', COMMIT, 'master', 'git@github.com:someone/else.git']]:
            with patch.object(deploy.subprocess, 'check_output', side_effect=replies), \
                    patch.object(deploy.subprocess, 'run') as push:
                with self.assertRaises(RuntimeError):
                    deploy.push_source('hjxxlogic/codexovercloudflare', COMMIT)
                push.assert_not_called()

    def test_local_build_rejects_dirty_or_wrong_source_before_compilation(self):
        for build in [{**BUILD, 'dirty': True}, {**BUILD, 'commit': 'c' * 40}]:
            with patch.object(deploy.subprocess, 'check_output', return_value=json.dumps(build)), \
                    patch.object(deploy.subprocess, 'run') as compile:
                with self.assertRaisesRegex(RuntimeError, 'clean HEAD'):
                    deploy.prepare_local_build(COMMIT, pathlib.Path('/unused'))
                compile.assert_not_called()

    def test_local_build_identity_is_checked_after_compilation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'build').mkdir()
            (root / 'build/coc-agent').write_bytes(b'local-executable')
            for after in [BUILD, {**BUILD, 'sourceDigest': 'd' * 64}]:
                with patch.object(deploy, 'ROOT', root), \
                        patch.object(deploy.subprocess, 'check_output', side_effect=[json.dumps(BUILD), json.dumps(BUILD), json.dumps(after)]), \
                        patch.object(deploy.subprocess, 'run') as compile:
                    if after != BUILD:
                        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                            deploy.prepare_local_build(COMMIT, root / 'output')
                    else:
                        metadata, binary = deploy.prepare_local_build(COMMIT, root / 'output')
                        self.assertEqual(metadata, BUILD)
                        self.assertEqual(binary.read_bytes(), b'local-executable')
                    self.assertEqual(compile.call_count, 3)

    def test_uncommitted_local_build_keeps_dirty_identity_and_detects_changes(self):
        dirty = {**BUILD, 'dirty': True}
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'build').mkdir()
            (root / 'build/coc-agent').write_bytes(b'uncommitted-executable')
            for after in [dirty, {**dirty, 'sourceDigest': 'd' * 64}]:
                with patch.object(deploy, 'ROOT', root), \
                        patch.object(deploy.subprocess, 'check_output', side_effect=[json.dumps(dirty), json.dumps(dirty), json.dumps(after)]), \
                        patch.object(deploy.subprocess, 'run'):
                    if after != dirty:
                        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                            deploy.prepare_local_build(COMMIT, root / 'output', True)
                    else:
                        metadata, binary = deploy.prepare_local_build(COMMIT, root / 'output', True)
                        self.assertTrue(metadata['dirty'])
                        self.assertEqual(binary.read_bytes(), b'uncommitted-executable')

    def test_local_target_reuses_helper_without_ssh(self):
        args = types.SimpleNamespace(local=True, binary='/tmp/coc-agent', service='test.service',
                                     commit=COMMIT, verify_seconds=120, allow_restart_active=False)
        with patch.object(deploy.subprocess, 'run', return_value=types.SimpleNamespace(
                stdout='{"idle":true}', stderr='', returncode=0)) as run:
            self.assertEqual(deploy.remote(None, 'status', args), {'idle': True})
            invocation = run.call_args.args[0]
            self.assertEqual(invocation[1], str(ROOT / 'scripts/deploy-agent-remote.py'))
            self.assertEqual(invocation[2], 'status')
            self.assertNotIn('input', run.call_args.kwargs)
            self.assertNotIn('--allow-restart-active', invocation)

    def test_local_staging_never_overwrites_existing_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary) / 'source'
            target = pathlib.Path(temporary) / 'candidate'
            source.write_bytes(b'verified-ci-binary')
            deploy.stage_candidate(types.SimpleNamespace(local=True), source, str(target))
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            with self.assertRaises(FileExistsError):
                deploy.stage_candidate(types.SimpleNamespace(local=True), source, str(target))
            self.assertEqual(target.read_bytes(), source.read_bytes())

    def test_named_push_remote_still_verifies_repository(self):
        with patch.object(deploy.subprocess, 'check_output', side_effect=[
                '', COMMIT, 'master', 'git@github.com:hjxxlogic/codexovercloudflare.git']) as git, \
                patch.object(deploy.subprocess, 'run') as push:
            deploy.push_source('hjxxlogic/codexovercloudflare', COMMIT, 'github')
            self.assertEqual(git.call_args.args[0], ['git', 'remote', 'get-url', '--push', 'github'])
            self.assertEqual(push.call_args.args[0], ['git', 'push', 'github', 'HEAD:refs/heads/master'])

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
                args = run.call_args.args[0]
                self.assertEqual(args[args.index('--retry') + 1], '0')
                self.assertIn('--speed-time', args)
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

    def test_explicit_uncommitted_candidate_still_requires_matching_source(self):
        args = types.SimpleNamespace(commit=COMMIT, source_digest=DIGEST, allow_uncommitted=True)
        remote.identity({**BUILD, 'dirty': True}, args)
        for field, value in [('sourceDigest', '0' * 64), ('commit', 'c' * 40), ('target', 'windows-x86_64')]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                remote.identity({**BUILD, 'dirty': True, field: value}, args)

    def test_uncommitted_mode_requires_local_build(self):
        with patch('sys.argv', ['deploy-agent.py', '--local', '--allow-uncommitted', '--binary', '/tmp/agent']):
            with self.assertRaises(SystemExit) as error:
                deploy.main()
            self.assertEqual(error.exception.code, 2)

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
