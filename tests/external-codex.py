"""Real Codex 0.164.0 cross-process read/queue contract, isolated from credentials/models."""
import json
import os
import pathlib
import queue
import subprocess
import tempfile
import threading
import time


class Peer:
    def __init__(self, env, cwd):
        self.process = subprocess.Popen(
            ['codex', 'app-server', '--listen', 'stdio://'], cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.messages = queue.Queue()
        self.sequence = 0

        def read():
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        threading.Thread(target=read, daemon=True).start()
        self.call('initialize', {'clientInfo': {'name': 'coc-external-test', 'version': '0.5.8'},
                                 'capabilities': {'experimentalApi': True}})
        self.process.stdin.write('{"method":"initialized"}\n')
        self.process.stdin.flush()

    def call(self, method, params, error=False):
        self.sequence += 1
        key = self.sequence
        self.process.stdin.write(json.dumps({'id': key, 'method': method, 'params': params}) + '\n')
        self.process.stdin.flush()
        while True:
            message = self.messages.get(timeout=20)
            if message.get('id') == key and 'method' not in message:
                if error:
                    return message
                assert 'error' not in message, message
                return message['result']

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=10)


with tempfile.TemporaryDirectory(prefix='coc-external-contract-') as directory:
    root = pathlib.Path(directory)
    home, work = root / 'home', root / 'work'
    home.mkdir()
    work.mkdir()
    # No user auth/config is inherited; the only configured provider is a closed loopback port.
    (home / 'config.toml').write_text(
        'model="probe"\nmodel_provider="probe"\n[model_providers.probe]\n'
        'name="probe"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\n')
    env = dict(os.environ, CODEX_HOME=str(home))
    for name in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'):
        env.pop(name, None)
    for mode in ('paginated', 'legacy'):
        peers = []
        try:
            owner = Peer(env, str(work))
            peers.append(owner)
            thread = owner.call('thread/start', {'cwd': str(work), 'sandbox': 'read-only',
                'approvalPolicy': 'on-request', 'ephemeral': False, 'historyMode': mode})['thread']['id']
            owner.call('thread/inject_items', {'threadId': thread, 'items': [
                {'type': 'message', 'role': 'user', 'content': [
                    {'type': 'input_text', 'text': 'persist isolated test thread'}]}]})
            # Initialize the paginated store before another process can race its first migration.
            if mode == 'paginated':
                owner.call('thread/items/list', {'threadId': thread, 'limit': 1})
            reader = Peer(env, str(work))
            peers.append(reader)
            owner.call('turn/start', {'threadId': thread, 'input': [
                {'type': 'text', 'text': 'local transport probe', 'text_elements': []}]})
            deadline = time.monotonic() + 10
            while True:
                result = reader.call('thread/read', {'threadId': thread, 'includeTurns': False}, error=True)
                if 'result' in result:
                    break
                assert time.monotonic() < deadline, result
                time.sleep(0.05)
            assert result['result']['thread']['cwd'] == str(work)
            failed = reader.call('thread/resume', {'threadId': thread, 'excludeTurns': True}, error=True)
            assert 'already has an active writer' in failed['error']['message'], failed
            method = 'thread/turns/list' if mode == 'legacy' else 'thread/items/list'
            params = {'threadId': thread, 'sortDirection': 'desc', 'limit': 1}
            if mode == 'legacy':
                params['itemsView'] = 'full'
            while True:
                page = reader.call(method, params)
                if page['data']:
                    break
                assert time.monotonic() < deadline, page
                time.sleep(0.05)
            assert page['backwardsCursor'], page
            forward = reader.call(method, dict(params, sortDirection='asc', cursor=page['backwardsCursor']))
            identity = lambda entry: entry.get('item', entry)['id']
            assert list(map(identity, forward['data'])) == list(map(identity, page['data'])), (page, forward)
            queued = reader.call('thread/queue/add', {'threadId': thread, 'clientUserMessageId': 'queue-' + mode,
                'input': [{'type': 'text', 'text': 'queued from independent reader', 'text_elements': []}]})
            pending = reader.call('thread/queue/list', {'threadId': thread, 'limit': 100})
            assert queued['queuedSubmission'] in pending['data'], pending
            assert owner.process.poll() is None
            print('PASS: real Codex', mode, 'writer lock, read-only reverse cursor and independent queue')
        finally:
            for peer in peers:
                peer.close()
