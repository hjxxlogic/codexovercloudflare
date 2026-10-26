"""Real Codex shared-server approval contract with a local deterministic Responses peer.

No user credentials or real model calls. Only the accepted probe executes a harmless echo. The native client
explicitly rejects and accepts mocked escalations, then closes only its own connection.
"""
import http.server
import json
import os
import pathlib
import queue
import shutil
import subprocess
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
BINARY = pathlib.Path(os.environ.get('COC_TEST_BINARY', ROOT / 'build/coc-tests')).resolve()


class Responses(http.server.BaseHTTPRequestHandler):
    calls = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        Responses.calls += 1
        if Responses.calls == 1:
            item = {'type': 'function_call', 'id': 'fc1', 'call_id': 'call1',
                    'name': 'exec_command', 'arguments': json.dumps({
                        'cmd': 'echo coc-approval-probe',
                        'sandbox_permissions': 'require_escalated',
                        'justification': 'Isolated remote approval contract'})}
        else:
            item = {'type': 'message', 'id': 'msg2', 'role': 'assistant', 'content': [
                {'type': 'output_text', 'text': 'Decision observed', 'annotations': []}]}
        events = [
            {'type': 'response.created', 'response': {'id': 'local-response'}},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': {'id': 'local-response',
                'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for event in events:
            self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()


class Owner:
    def __init__(self, env, cwd, socket):
        self.process = subprocess.Popen([
            shutil.which('node'), str(ROOT / 'tests/fixtures/codex-socket-client.mjs'), socket],
            cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True)
        self.messages = queue.Queue()
        self.sequence = 0
        self.notifications = []

        def read():
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
        self.call('initialize', {'clientInfo': {'name': 'coc-approval-contract', 'version': '0.5.8'},
            'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized'})

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()

    def call(self, method, params):
        self.sequence += 1
        self.send({'id': self.sequence, 'method': method, 'params': params})
        while True:
            value = self.messages.get(timeout=15)
            if value.get('id') == self.sequence and 'method' not in value:
                assert 'error' not in value, value
                return value['result']
            self.notifications.append(value)

    def await_method(self, method, turn_id=None):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            value = self.messages.get(timeout=15)
            self.notifications.append(value)
            params = value.get('params', {})
            matches = turn_id is None or params.get('turnId', params.get('turn', {}).get('id')) == turn_id
            if value.get('method') == method and matches:
                return value
        raise AssertionError('No ' + method)

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=5)


with tempfile.TemporaryDirectory(prefix='coc-approval-contract-') as directory:
    root = pathlib.Path(directory)
    home, work, socket = root / 'home', root / 'work', root / 'server.sock'
    home.mkdir()
    work.mkdir()
    provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Responses)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    (home / 'config.toml').write_text(
        'model="probe"\nmodel_provider="probe"\n[model_providers.probe]\nname="probe"\n'
        f'base_url="http://127.0.0.1:{provider.server_port}/v1"\nwire_api="responses"\n')
    env = dict(os.environ, CODEX_HOME=str(home))
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'):
        env.pop(key, None)
    daemon = subprocess.Popen(['codex', 'app-server', '--listen', 'unix://' + str(socket)],
        cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    owner = None
    try:
        deadline = time.monotonic() + 10
        while not socket.exists():
            assert time.monotonic() < deadline and daemon.poll() is None
            time.sleep(0.05)
        owner = Owner(env, str(work), str(socket))
        thread = owner.call('thread/start', {'cwd': str(work), 'sandbox': 'read-only',
            'approvalPolicy': 'on-request', 'ephemeral': False, 'historyMode': 'paginated'})['thread']['id']
        for allow in (False, True):
            Responses.calls = 0
            start = len(owner.notifications)
            turn = owner.call('turn/start', {'threadId': thread, 'input': [
                {'type': 'text', 'text': 'local approval transport probe', 'text_elements': []}]})['turn']['id']
            approval = owner.await_method('item/commandExecution/requestApproval', turn)
            assert approval['params']['threadId'] == thread
            command = [str(BINARY), '--external-approval', 'unix://' + str(socket), thread, str(work)]
            if allow:
                command.append('--allow')
            result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=25)
            assert result.returncode == 0, (result.stdout, result.stderr)
            print(result.stdout.strip())
            resolved = owner.await_method('serverRequest/resolved')
            assert resolved['params']['requestId'] == approval['id']
            owner.await_method('turn/completed', turn)
            assert daemon.poll() is None and owner.process.poll() is None
            output = ''.join(v.get('params', {}).get('delta', '') for v in owner.notifications[start:]
                if v.get('method') == 'item/commandExecution/outputDelta')
            completed = [v.get('params', {}).get('item', {}) for v in owner.notifications[start:]
                if v.get('method') == 'item/completed']
            output += ''.join(item.get('aggregatedOutput', '') or '' for item in completed
                if item.get('type') == 'commandExecution')
            assert ('coc-approval-probe' in output) == allow, (allow, output, completed)
            print('PASS: genuine Codex remote', 'accept executes harmless echo' if allow else 'reject prevents execution',
                  'and original owner remains connected')
        owner.call('thread/read', {'threadId': thread, 'includeTurns': False})
    finally:
        if owner:
            owner.close()
        daemon.terminate()
        try:
            daemon.wait(timeout=3)
        except subprocess.TimeoutExpired:
            daemon.kill()
            daemon.wait()
        provider.shutdown()
