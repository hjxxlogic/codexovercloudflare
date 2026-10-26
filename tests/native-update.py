"""Exercise actual native self-updates using a loopback release server and ELF fixtures."""
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
CLI = pathlib.Path(os.environ.get('COC_CLI_BINARY', ROOT / 'build/coc-client')).resolve()
AGENT = pathlib.Path(os.environ.get('COC_AGENT_BINARY', ROOT / 'build/coc-agent')).resolve()
BUILD = json.loads(subprocess.check_output([CLI, '--version']))
RELEASE = dict(BUILD, version='.'.join(BUILD['version'].split('.')[:2] +
                                    [str(int(BUILD['version'].split('.')[2]) + 1)]),
               commit='a' * 40, sourceDigest='b' * 64, dirty=False)
MUSL = '--musl' in sys.argv
PLATFORM = 'musl' if MUSL else 'ubuntu20.04'
NAME = f"coc-{RELEASE['version']}-linux-x86_64-{PLATFORM}"
FILENAME = NAME + '.tar.gz'
MODE = 'good'
REQUESTS = []
ENTERED = threading.Event()
UNBLOCK = threading.Event()
ARCHIVES = {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        REQUESTS.append(self.path)
        if self.path.startswith('/downloads/'):
            assert not self.headers.get('Authorization'), 'Release download leaked credentials'
        if MODE == 'wait' and self.path == '/downloads/index.json':
            ENTERED.set()
            UNBLOCK.wait(10)
        if self.path == '/downloads/index.json':
            manifest = dict(RELEASE, files=[FILENAME], protocol=99 if MODE == 'protocol' else BUILD['protocol'])
            if MODE == 'downgrade':
                manifest['version'] = '0.0.1'
            body = json.dumps(manifest).encode()
        elif self.path == '/downloads/SHA256SUMS':
            archive = ARCHIVES['identity' if MODE == 'identity' else 'good']
            checksum = '0' * 64 if MODE == 'checksum' else hashlib.sha256(archive).hexdigest()
            body = f'{checksum}  {FILENAME}\n'.encode()
        elif self.path == '/downloads/' + FILENAME:
            body = ARCHIVES['identity' if MODE == 'identity' else 'good']
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run(args, ok=True):
    result = subprocess.run([str(a) for a in args], text=True, capture_output=True, timeout=20)
    assert (result.returncode == 0) == ok, (args, result.stdout, result.stderr)
    return result


with tempfile.TemporaryDirectory(prefix='coc-update-test-') as temporary:
    workspace = pathlib.Path(temporary)
    marker = workspace / 'restarted'
    for kind in ('good', 'identity'):
        metadata = dict(RELEASE)
        if kind == 'identity':
            metadata['commit'] = 'c' * 40
        source = ('#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){'
                  'if(argc==2 && strcmp(argv[1],"--version")==0){puts(' +
                  json.dumps(json.dumps(metadata)) + ');return 0;}FILE *f=fopen(' +
                  json.dumps(str(marker)) + ',"w");if(f){fputs("restarted",f);fclose(f);}return 0;}')
        candidate = workspace / ('fixture-' + kind)
        subprocess.run(['cc', *(['-static'] if MUSL else []), '-x', 'c', '-', '-o', str(candidate)], input=source.encode(), check=True)
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as archive:
            for program in ('coc-agent', 'coc-client'):
                archive.add(candidate, arcname=NAME + '/' + program)
            # Even a verified archive must not extract unrelated paths or traversal entries.
            bad = tarfile.TarInfo('../../must-not-be-created')
            bad.size = 4
            archive.addfile(bad, io.BytesIO(b'evil'))
        ARCHIVES[kind] = output.getvalue()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    relay = f'http://127.0.0.1:{server.server_port}'

    def installation(name, agent=False, disabled=False):
        folder = workspace / name
        folder.mkdir(mode=0o700)
        binary = folder / ('coc-agent' if agent else 'coc-client')
        shutil.copy2(AGENT if agent else CLI, binary)
        config = folder / 'config.json'
        config.write_text(json.dumps({'version': 2, 'entries': [], 'selected': '',
                                      'autoUpdate': False if disabled else ({} if MUSL else {'platform': PLATFORM})}))
        return binary, config

    try:
        binary, config = installation('success')
        original = binary.read_bytes()
        run([binary, 'update', '--config', config, '--relay', relay])
        assert json.loads(run([binary, '--version']).stdout) == RELEASE
        assert pathlib.Path(str(binary) + '.previous').read_bytes() == original
        assert binary.stat().st_mode & 0o777 == 0o755
        assert not list(binary.parent.glob('.coc-update-*')), 'Staging directory leaked'
        assert not (workspace / 'must-not-be-created').exists()
        print('PASS: matching platform, SHA256, native identity, atomic install, previous executable, safe extraction')

        binary, config = installation('agent-manual', agent=True)
        original = binary.read_bytes()
        run([binary, 'update', '--config', config, '--relay', relay])
        assert json.loads(run([binary, '--version']).stdout) == RELEASE
        assert pathlib.Path(str(binary) + '.previous').read_bytes() == original
        print('PASS: explicit Agent update installs the Agent member without requiring login or Codex')

        for mode in ('checksum', 'identity', 'protocol'):
            MODE = mode
            binary, config = installation(mode)
            before = binary.read_bytes()
            result = run([binary, 'update', '--config', config, '--relay', relay], ok=False)
            assert 'UPDATE_FAILED' in result.stderr
            assert binary.read_bytes() == before
            assert not pathlib.Path(str(binary) + '.previous').exists()
            assert not list(binary.parent.glob('.coc-update-*'))
        print('PASS: corrupt archive, mismatched candidate and incompatible protocol preserve installed binary')

        MODE = 'downgrade'
        binary, config = installation('downgrade')
        REQUESTS.clear()
        run([binary, 'update', '--config', config, '--relay', relay])
        assert REQUESTS == ['/downloads/index.json'], REQUESTS
        assert not pathlib.Path(str(binary) + '.previous').exists()
        print('PASS: older release never downloads or replaces binary')

        MODE = 'good'
        binary, config = installation('disabled', disabled=True)
        REQUESTS.clear()
        run([binary, 'hosts', '--config', config, '--relay', relay])
        assert not REQUESTS
        assert not pathlib.Path(str(binary) + '.update-state.json').exists()
        print('PASS: autoUpdate false makes no download requests or update state')

        MODE = 'wait'
        binary, config = installation('concurrent')
        first = subprocess.Popen([str(binary), 'update', '--config', str(config), '--relay', relay],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            assert ENTERED.wait(5)
            result = run([binary, 'update', '--config', config, '--relay', relay], ok=False)
            assert 'CONFIG_BUSY' in result.stderr
        finally:
            UNBLOCK.set()
            out, err = first.communicate(timeout=20)
        assert first.returncode == 0, (out, err)
        print('PASS: concurrent update excluded by executable lock')

        if '--automatic' in sys.argv:
            assert BUILD.get('dirty') is False, 'Automatic integration requires a clean release build'
            MODE = 'good'
            binary, config = installation('automatic')
            run([binary, 'hosts', '--config', config, '--relay', relay])
            assert json.loads(run([binary, '--version']).stdout) == RELEASE
            print('PASS: default CLI command completion installs newer release')

            binary, config = installation('agent', agent=True)
            project = workspace / 'project'
            project.mkdir()
            data = {'relayUrl': relay, 'hostId': 'test-update', 'token': 'x' * 32,
                    'dataDir': str(workspace / 'agent-state'), 'codexPath': str(shutil.which('node')),
                    'codexArgs': [str(ROOT / 'tests/fixtures/fake-codex.mjs')],
                    'projects': [{'id': 'project', 'name': 'project', 'path': str(project)}],
                    'autoUpdate': {'platform': PLATFORM}}
            config.write_text(json.dumps(data))
            log = (workspace / 'agent.log').open('w+')
            agent = subprocess.Popen([str(binary), 'run', '--config', str(config)],
                                     stdout=subprocess.DEVNULL, stderr=log)
            try:
                agent.wait(timeout=45)
                assert agent.returncode == 0 and marker.read_text() == 'restarted'
                assert json.loads(run([binary, '--version']).stdout) == RELEASE
            except Exception:
                log.flush()
                log.seek(0)
                print(log.read(), file=sys.stderr)
                print('Agent download paths:', REQUESTS, file=sys.stderr)
                raise
            finally:
                if agent.poll() is None:
                    agent.terminate()
                    agent.wait(timeout=10)
                log.close()
            print('PASS: idle Agent prepares update in background, closes stores and reexecutes new release')

            if '--busy' in sys.argv:
                helper = subprocess.Popen([shutil.which('node'), str(ROOT / 'tests/fixtures/update-relay.mjs'), relay],
                                          stdout=subprocess.PIPE, text=True)
                active_agent = None
                try:
                    active_relay = f"http://127.0.0.1:{json.loads(helper.stdout.readline())['port']}"
                    binary, config = installation('busy-agent', agent=True)
                    data['relayUrl'] = active_relay
                    data['dataDir'] = str(workspace / 'busy-agent-state')
                    config.write_text(json.dumps(data))
                    marker.unlink(missing_ok=True)
                    log = (workspace / 'busy-agent.log').open('w+')
                    active_agent = subprocess.Popen([str(binary), 'run', '--config', str(config)],
                                                    stdout=subprocess.DEVNULL, stderr=log)
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        with urllib.request.urlopen(active_relay + '/state', timeout=2) as response:
                            state = json.load(response)
                        if state.get('created'):
                            break
                        time.sleep(0.1)
                    assert state.get('created'), state
                    # Pass the first 30s install opportunity with a live Codex runtime.
                    time.sleep(31)
                    assert active_agent.poll() is None, 'Active Agent was interrupted by update'
                    assert json.loads(run([binary, '--version']).stdout) == json.loads(run([AGENT, '--version']).stdout)
                    assert list(binary.parent.glob('.coc-update-*/candidate')), 'Update was not prepared'
                    assert not pathlib.Path(str(binary) + '.previous').exists()
                    urllib.request.urlopen(urllib.request.Request(active_relay + '/stop', data=b'{}'), timeout=2).close()
                    active_agent.wait(timeout=40)
                    assert active_agent.returncode == 0 and marker.read_text() == 'restarted'
                    assert json.loads(run([binary, '--version']).stdout) == RELEASE
                    print('PASS: prepared Agent update waits for running session to end before atomic install and restart')
                finally:
                    if active_agent is not None and active_agent.poll() is None:
                        active_agent.terminate()
                        active_agent.wait(timeout=10)
                    helper.terminate()
                    helper.wait(timeout=10)
                    if active_agent is not None:
                        log.close()
    finally:
        server.shutdown()
        server.server_close()
