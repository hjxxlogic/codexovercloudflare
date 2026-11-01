"""Run authentic old native updaters against isolated local release bytes.

Never points an updater at a user's installed executable or production relay.
The legacy platform selector names this host-only fixture ubuntu20.04; it does
not certify this local build on that distribution. --e2e starts the installed
programs with the existing real local relay/browser acceptance suite.
"""
import argparse
import hashlib
import io
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
# A staged copy may override the repository root before it is checked in.
ROOT = pathlib.Path(os.environ.get('COC_TEST_ROOT', ROOT)).resolve()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--old-agent', type=pathlib.Path, required=True)
parser.add_argument('--old-client', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
parser.add_argument('--e2e', action='store_true')
args = parser.parse_args()
workspace = args.output.resolve()
workspace.mkdir(mode=0o700, parents=True, exist_ok=False)


def run(command, *, ok=True, timeout=45, **kwargs):
    result = subprocess.run([str(x) for x in command], capture_output=True,
                            text=True, timeout=timeout, **kwargs)
    assert (result.returncode == 0) == ok, (command, result.stdout, result.stderr)
    return result


def identity(binary):
    return json.loads(run([binary, '--version']).stdout)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


programs = {'coc-agent': ROOT / 'build/coc-agent', 'coc-client': ROOT / 'build/coc-client'}
release = identity(programs['coc-agent'])
assert release['dirty'] is False, 'Build a clean committed candidate before authentic old update tests'
assert release == identity(programs['coc-client']), 'Agent/client build identities differ'
assert release['protocol'] == 1, 'Legacy release protocol must remain 1'
old = {'coc-agent': args.old_agent.resolve(), 'coc-client': args.old_client.resolve()}
evidence = {'candidate': release, 'hostOnly': True, 'platformSelector': 'ubuntu20.04',
            'old': {}, 'cases': [], 'e2e': False}
for name, binary in old.items():
    version = identity(binary)
    assert tuple(map(int, version['version'].split('.'))) < tuple(map(int, release['version'].split('.')))
    assert version['dirty'] is False and version['protocol'] == 1
    evidence['old'][name] = {'build': version, 'sha256': sha(binary)}

package = 'coc-' + release['version'] + '-linux-x86_64-ubuntu20.04'
filename = package + '.tar.gz'
encoded = io.BytesIO()
with tarfile.open(fileobj=encoded, mode='w:gz') as archive:
    for name, binary in programs.items():
        archive.add(binary, arcname=package + '/' + name)
archive_bytes = encoded.getvalue()
archive_sha = hashlib.sha256(archive_bytes).hexdigest()
assert len(archive_bytes) <= 32 * 1024 * 1024
(workspace / filename).write_bytes(archive_bytes)
evidence['archive'] = {'file': filename, 'sha256': archive_sha, 'bytes': len(archive_bytes)}
mode = 'good'
requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        requests.append(self.path)
        if self.path.startswith('/downloads/'):
            assert not self.headers.get('Authorization'), 'Credential leaked into public download'
        if mode == 'network' and self.path == '/downloads/index.json':
            self.send_error(503)
            return
        manifest = dict(release, files=[] if mode == 'platform' else [filename])
        if mode == 'identity':
            manifest['commit'] = '0' * 40
        if mode == 'protocol':
            manifest['protocol'] = 99
        if self.path == '/downloads/index.json':
            body = json.dumps(manifest).encode()
        elif self.path == '/downloads/SHA256SUMS':
            body = (('0' * 64 if mode == 'checksum' else archive_sha) + '  ' + filename + '\n').encode()
        elif self.path == '/downloads/' + filename:
            body = archive_bytes
        elif self.path.startswith('/api/'):
            body = b'{"pending":[]}'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Content-Type', 'application/json')
        self.send_header('X-CoC-Delivery', '2')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
relay = f'http://127.0.0.1:{server.server_port}'
installed = {}


def setup(name, scenario):
    folder = workspace / name / scenario
    folder.mkdir(mode=0o700, parents=True)
    binary = folder / name
    shutil.copy2(old[name], binary)
    config = folder / 'config.json'
    state = folder / 'state'
    state.mkdir(mode=0o700)
    # Deliberately dummy, local-only credentials; byte equality checks preservation.
    settings = {'autoUpdate': {'enabled': False, 'platform': 'ubuntu20.04'}}
    if name == 'coc-agent':
        project = folder / 'project'
        project.mkdir()
        settings.update({'relayUrl': relay, 'hostId': 'legacy-upgrade-local',
                         'token': 'isolated-not-a-production-credential',
                         'dataDir': str(state), 'codexPath': shutil.which('node'),
                         'codexArgs': [str(ROOT / 'tests/fixtures/fake-codex.mjs')],
                         'projects': [{'id': 'project', 'name': 'Original Project', 'path': str(project)}]})
    else:
        settings.update({'version': 2, 'selected': relay + '~legacy-upgrade-local',
                         'entries': [{'relay': relay, 'hostId': 'legacy-upgrade-local',
                                      'token': 'isolated-client-credential', 'name': 'Original identity'}]})
    config.write_text(json.dumps(settings, indent=2) + '\n')
    config.chmod(0o600)
    (state / 'identity-proof.json').write_text('{"preserve":"original local state"}\n')
    return binary, config, state


def initialize_agent(binary, config, state):
    log = binary.parent / 'startup.log'
    endpoint = state / 'project-control.json'
    original_endpoint = endpoint.read_bytes() if endpoint.exists() else None
    with log.open('w') as output:
        child = subprocess.Popen([str(binary), 'run', '--config', str(config)],
                                 stdout=output, stderr=output)
        try:
            deadline = time.monotonic() + 10
            while not (state / 'agent.db').exists() or not endpoint.exists() or endpoint.read_bytes() == original_endpoint:
                assert child.poll() is None, log.read_text()
                assert time.monotonic() < deadline, log.read_text()
                time.sleep(0.05)
            # Opening the committed DB verifies initialization, not a guessed delay.
            with sqlite3.connect(state / 'agent.db') as database:
                database.execute('SELECT COUNT(*) FROM sessions').fetchone()
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=10)


try:
    for name in programs:
        for scenario in ('network', 'platform', 'checksum', 'identity', 'protocol', 'install', 'good'):
            mode = scenario
            binary, config, state = setup(name, scenario)
            if name == 'coc-agent' and scenario == 'good':
                initialize_agent(binary, config, state)
                archived = {'id': 'legacy-upgrade-local~archive', 'state': 'closed', 'mode': 'web',
                            'projectId': 'project', 'running': False, 'threadId': 'original-thread'}
                event = {'seq': 1, 'type': 'user', 'data': {'text': 'preserved authentic old history'}, 'time': 1, 'revision': 1}
                with sqlite3.connect(state / 'agent.db') as database:
                    database.execute('INSERT INTO sessions(id,value) VALUES(?,?)', (archived['id'], json.dumps(archived)))
                    database.execute('INSERT INTO events(seq,session,value,time) VALUES(1,?,?,1)', (archived['id'], json.dumps(event)))
                    database.execute('INSERT INTO history(seq,session,value,revision) VALUES(1,?,?,1)', (archived['id'], json.dumps(event)))
            before_binary = sha(binary)
            before_config = config.read_bytes()
            before_state = {str(p.relative_to(state)): p.read_bytes()
                            for p in state.rglob('*') if p.is_file()}
            if scenario == 'install':
                pathlib.Path(str(binary) + '.previous').mkdir()
            requests.clear()
            result = run([binary, 'update', '--config', config, '--relay', relay], ok=scenario == 'good')
            (binary.parent / 'update.stdout').write_text(result.stdout)
            (binary.parent / 'update.stderr').write_text(result.stderr)
            assert config.read_bytes() == before_config, 'Updater changed credentials/configuration'
            assert {str(p.relative_to(state)): p.read_bytes()
                    for p in state.rglob('*') if p.is_file()} == before_state, 'Updater changed original data'
            assert not list(binary.parent.glob('.coc-update-*')), 'Staging directory leaked'
            if scenario == 'good':
                assert identity(binary) == release, 'Installed actual candidate failed to start'
                assert sha(pathlib.Path(str(binary) + '.previous')) == before_binary
                assert sha(binary) == sha(programs[name])
                installed[name] = str(binary)
                if name == 'coc-agent':
                    initialize_agent(binary, config, state)
                    assert config.read_bytes() == before_config
                    assert (state / 'identity-proof.json').read_bytes() == before_state['identity-proof.json']
                    with sqlite3.connect(state / 'agent.db') as database:
                        saved = json.loads(database.execute('SELECT value FROM history WHERE seq=1').fetchone()[0])
                        assert saved['data']['text'] == 'preserved authentic old history'
                        assert database.execute('SELECT COUNT(*) FROM transport2_commands').fetchone()[0] == 0, 'Old work imported into new commands'
                        assert database.execute('PRAGMA quick_check').fetchone()[0] == 'ok'

            else:
                assert sha(binary) == before_binary, 'Failed upgrade replaced the old executable'
                assert identity(binary) == evidence['old'][name]['build']
            evidence['cases'].append({'program': name, 'scenario': scenario, 'pass': True,
                                      'downloads': list(requests)})
            print('PASS:', name, scenario, flush=True)
    # This suite starts both newly installed real programs, a real local Worker,
    # deterministic Codex and Chromium; it performs delivery:2 business writes.
    if args.e2e:
        environment = dict(os.environ, COC_AGENT_BINARY=installed['coc-agent'],
                           COC_CLI_BINARY=installed['coc-client'])
        with (workspace / 'installed-e2e.log').open('w') as output:
            result = subprocess.run(['npm', 'run', 'test:e2e'], cwd=ROOT, env=environment,
                                    stdout=output, stderr=subprocess.STDOUT, timeout=420)
        assert result.returncode == 0, 'Installed binary E2E failed; see installed-e2e.log'
        evidence['e2e'] = True
        print('PASS: installed Agent/client delivery:2 business handshake and full local E2E', flush=True)
finally:
    server.shutdown()
    server.server_close()
    for name, binary in old.items():
        assert sha(binary) == evidence['old'][name]['sha256'], 'Authentic original fixture was modified'
    (workspace / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
