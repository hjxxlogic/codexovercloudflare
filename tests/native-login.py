"""Exercise real native login against a local fault-injecting relay; no model calls."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class LoginRecovery(unittest.TestCase):
    def run_login(self, scenario, binary='coc-agent'):
        polls = []
        stopped = threading.Event()
        expires = int(time.time() * 1000) + (300 if scenario == 'expired' else 60000)
        grant = {'state': 'approved', 'hostId': 'login-host',
                 'token': 'local-test-token-for-login-only',
                 'role': 'agent' if binary == 'coc-agent' else 'cli',
                 'name': 'local-test'}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                body = json.dumps([{'id': grant['hostId'], 'name': grant['name']}]).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-CoC-Demand', '1')
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                status = 200
                if self.path == '/api/v1/auth/device/start':
                    result = {'id': 'login-request', 'pollSecret': 'local-poll-secret',
                              'code': 'TESTCODE', 'url': '/#authorize=login-request',
                              'expires': expires}
                elif self.path == '/api/v1/auth/device/poll':
                    polls.append(data)
                    if (scenario == 'recovery' and len(polls) == 2) or scenario == 'expired':
                        # Simulate a response that never arrives, bounded by the client deadline.
                        stopped.wait(40)
                        return
                    if scenario == 'recovery' and len(polls) in (1, 3):
                        # Poll 3 represents an approved grant committed before response loss.
                        self.connection.shutdown(socket.SHUT_RDWR)
                        self.connection.close()
                        return
                    if scenario == 'rejected':
                        result = {'state': 'rejected'}
                    elif scenario == 'unauthorized':
                        status, result = 401, {'error': {'code': 'UNAUTHORIZED', 'message': 'revoked'}}
                    else:
                        result = grant
                else:
                    status, result = 404, {}
                body = json.dumps(result).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-CoC-Demand', '1')
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='coc-login-') as tmp:
                config = Path(tmp) / 'credential.json'
                if scenario == 'custom':
                    config.write_text(json.dumps({
                        'dataDir': str(Path(tmp) / 'custom-data'),
                        'projects': [{'id': 'test', 'name': 'Test', 'path': tmp}],
                        'sandbox': 'read-only', 'codexPath': 'custom-codex',
                        'wakeUrl': 'http://127.0.0.1:9',
                        'accessEmails': ['User@EXAMPLE.com'],
                        'externalSessions': {'allowQueue': True},
                        'autoUpdate': {'enabled': False, 'intervalHours': 24},
                    }))
                executable = os.environ.get('COC_AGENT_BINARY' if binary == 'coc-agent'
                                            else 'COC_CLI_BINARY', 'build/' + binary)
                args = [str(Path(executable).resolve()), 'login', '--relay',
                        'http://127.0.0.1:' + str(server.server_port), '--config', str(config)]
                if binary == 'coc-agent' and scenario != 'empty':
                    args += ['--project', tmp]
                if scenario == 'defaults':
                    args += ['--name', '办公室电脑', '--proxy', 'http://127.0.0.1:1']
                result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8', timeout=60)
                if scenario in ('recovery', 'defaults', 'custom', 'empty'):
                    self.assertEqual(result.returncode, 0, result.stderr)
                    saved = json.loads(config.read_text(encoding='utf-8'))
                    credential = saved if binary == 'coc-agent' else saved['entries'][0]
                    self.assertEqual(credential['token'], grant['token'])
                    self.assertEqual(saved['displayName'], '办公室电脑' if scenario == 'defaults' else socket.gethostname())
                    self.assertEqual(saved['proxy'], 'http://127.0.0.1:1' if scenario == 'defaults' else '')
                    self.assertEqual(len(polls), 4 if scenario == 'recovery' else 1)
                    if scenario == 'recovery':
                        self.assertIn('HTTP_TIMEOUT', result.stderr)
                        self.assertIn('HTTP_NETWORK', result.stderr)
                    if binary == 'coc-agent':
                        if scenario == 'empty':
                            self.assertEqual(saved['projects'], [])
                        self.assertEqual(set(saved), {
                            'relayUrl', 'hostId', 'token', 'wakeUrl', 'codexPath', 'codexArgs',
                            'sandbox', 'externalSessions', 'dataDir', 'projects', 'autoUpdate',
                            'displayName', 'proxy', 'accessEmails',
                        })
                        self.assertEqual(saved['externalSessions'], {
                            'allowQueue': scenario == 'custom', 'allowApprovals': False,
                            'approvalEndpoint': '', 'approvalTokenFile': '',
                        })
                        self.assertEqual(saved['accessEmails'], ['User@example.com'] if scenario == 'custom' else [])
                        self.assertEqual(saved['autoUpdate'], {
                            'enabled': scenario != 'custom' and os.name != 'nt',
                            'intervalHours': 24 if scenario == 'custom' else 1, 'platform': '',
                        })
                        if scenario == 'custom':
                            self.assertEqual(saved['sandbox'], 'read-only')
                            self.assertEqual(saved['codexPath'], 'custom-codex')
                            self.assertEqual(saved['wakeUrl'], 'http://127.0.0.1:9')
                else:
                    self.assertNotEqual(result.returncode, 0)
                    code = {'rejected': 'LOGIN_REJECTED', 'unauthorized': 'UNAUTHORIZED',
                            'expired': 'LOGIN_EXPIRED'}[scenario]
                    self.assertIn(code, result.stderr)
                    self.assertFalse(config.exists())
                    self.assertEqual(len(polls), 1)
                self.assertTrue(all(p == polls[0] for p in polls))
                self.assertNotIn(grant['token'], result.stdout + result.stderr)
                self.assertNotIn('local-poll-secret', result.stdout + result.stderr)
        finally:
            stopped.set()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_access_emails_preserves_credentials_and_only_saves_after_success(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                requests.append((self.path, self.headers.get('Authorization'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                body = b'{}' if len(requests) < 3 else b'{"error":{"code":"UNAVAILABLE","message":"retry"}}'
                self.send_response(200 if len(requests) < 3 else 503)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='coc-emails-') as tmp:
                path = Path(tmp) / 'agent.json'
                original = {'relayUrl': 'http://127.0.0.1:' + str(server.server_port), 'token': 'test-agent-credential', 'projects': ['preserved']}
                path.write_text(json.dumps(original))
                executable = Path(os.environ.get('COC_AGENT_BINARY', 'build/coc-agent')).resolve()
                def run(*emails):
                    return subprocess.run([str(executable), 'access-emails', *emails, '--config', str(path)], capture_output=True, text=True, timeout=10)
                self.assertEqual(run('User@EXAMPLE.com', 'User@example.com').returncode, 0)
                self.assertEqual(json.loads(path.read_text()), {**original, 'accessEmails': ['User@example.com']})
                self.assertEqual(requests[0], ('/api/v1/agent/access-emails', 'Bearer ' + original['token'], {'emails': ['User@example.com']}))
                self.assertEqual(run().returncode, 0)
                self.assertEqual(json.loads(path.read_text())['accessEmails'], [])
                self.assertNotEqual(run('next@example.com').returncode, 0)
                self.assertEqual(json.loads(path.read_text())['accessEmails'], [])
                self.assertNotEqual(run('invalid').returncode, 0)
                self.assertEqual(len(requests), 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_instance_settings_before_login(self):
        for binary in ('coc-agent', 'coc-client'):
            with self.subTest(binary=binary), tempfile.TemporaryDirectory(prefix='coc-settings-') as tmp:
                path = Path(tmp) / 'settings.json'
                executable = Path(os.environ.get('COC_AGENT_BINARY' if binary == 'coc-agent'
                                                 else 'COC_CLI_BINARY', 'build/' + binary)).resolve()
                def run(*args):
                    return subprocess.run([str(executable), *args, '--config', str(path)],
                                          capture_output=True, text=True, encoding='utf-8', timeout=5)
                self.assertEqual(run('name', ' 我的笔记本 ').returncode, 0)
                self.assertEqual(run('proxy', 'socks5://user:p%40ss@127.0.0.1:1080').returncode, 0)
                saved = json.loads(path.read_text(encoding='utf-8'))
                self.assertEqual(saved['displayName'], '我的笔记本')
                self.assertEqual(saved['proxy'], 'socks5://user:p%40ss@127.0.0.1:1080')
                invalid = run('proxy', 'http://proxy:0')
                self.assertNotEqual(invalid.returncode, 0)
                self.assertEqual(json.loads(path.read_text(encoding='utf-8')), saved)
                self.assertEqual(run('proxy', '').returncode, 0)
                self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['proxy'], '')
                if os.name != 'nt':
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_agent_login_without_project(self):
        self.run_login('empty')

    def test_agent_recovers_transport_failures(self):
        self.run_login('recovery')

    def test_cli_recovers_transport_failures(self):
        self.run_login('recovery', 'coc-client')

    def test_terminal_errors_and_expiry(self):
        for scenario in ('rejected', 'unauthorized', 'expired'):
            with self.subTest(scenario=scenario):
                self.run_login(scenario)

    def test_generated_defaults_and_custom_configuration(self):
        for scenario in ('defaults', 'custom'):
            with self.subTest(scenario=scenario):
                self.run_login(scenario)


if __name__ == '__main__':
    unittest.main()
