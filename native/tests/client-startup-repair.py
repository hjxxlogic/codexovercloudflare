"""Client startup boundaries using fake Codex and a loopback relay; no model calls."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


# Reuse the native crypto interoperability fixture; no shared-library or Node dependency.
class SecureFixture:
    def __init__(self, peer):
        self.process = subprocess.Popen([sys.argv[2], '--interop'], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True)
        self.public = json.loads(self.process.stdout.readline())['key']
        self.binding = b'coc-channel-1:interop'
        self.header = self.call({'key': peer})['header']

    def call(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()
        result = json.loads(self.process.stdout.readline())
        assert not result.get('failed'), result
        return result

    def accept(self, header):
        assert self.call({'header': header})['ready']

    def seal(self, value):
        return self.call({'plain': '1' + json.dumps(value)})['cipher']

    def open(self, value):
        plain = self.call({'cipher': value})['plain']
        assert plain[0] == '1'
        return json.loads(plain[1:])

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()

def read_exact(stream, size):
    result = b''
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise EOFError()
        result += part
    return result


def send_frame(stream, value):
    body = json.dumps(value).encode()
    header = bytes([0x81, len(body)]) if len(body) < 126 else b'\x81\x7e' + struct.pack('!H', len(body))
    stream.write(header + body)
    stream.flush()


def read_frame(stream):
    first, length = read_exact(stream, 2)
    masked = length & 128
    length &= 127
    if length == 126:
        length = struct.unpack('!H', read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', read_exact(stream, 8))[0]
    mask = read_exact(stream, 4) if masked else None
    body = read_exact(stream, length)
    if mask:
        body = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
    return first & 15, body


def fake_codex():
    args = sys.argv[2:]
    mode = os.environ['FAKE_CODEX_MODE']
    if args == ['--version']:
        if mode == 'version-fail':
            return 17
        print('codex-cli 0.164.0')
        return 0
    if args[0] == 'exec':
        with open(os.environ['REPAIR_CAPTURE'], 'a') as output:
            output.write(json.dumps(args) + '\n')
        return 0
    if mode == 'normal-exit':
        return 0
    if mode in ('connected-fail', 'handshake-fail'):
        url = urlsplit(args[args.index('--remote') + 1])
        with socket.create_connection((url.hostname, url.port), timeout=5) as connection:
            connection.sendall((f'GET / HTTP/1.1\r\nHost: {url.netloc}\r\nUpgrade: websocket\r\n'
                                'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
                                f'Authorization: Bearer {os.environ["COC_REMOTE_TICKET"]}\r\n\r\n').encode())
            response = connection.makefile('rb')
            assert b'101' in response.readline()
            while response.readline() != b'\r\n':
                pass
            if mode == 'connected-fail':
                body = json.dumps({'method': 'initialized'}).encode()
                mask = b'abcd'
                encoded = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
                connection.sendall(bytes([0x81, 128 | len(body)]) + mask + encoded)
            time.sleep(0.2)
    return 127 if mode == 'exec-fail' else 17


if len(sys.argv) > 1 and sys.argv[1] == '--fake-codex':
    sys.exit(fake_codex())

client = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix='coc-client-repair-') as temporary:
    root = Path(temporary)
    capture = root / 'repairs.jsonl'
    fake = root / 'codex'
    fake.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' +
                    shlex.quote(str(Path(__file__).resolve())) + ' --fake-codex "$@"\n')
    fake.chmod(0o700)
    mode = 'ok'
    errors = []
    requests = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *args):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-CoC-Demand', '1')
            self.send_header('X-CoC-Delivery', '2')
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            requests.append(self.path)
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
            if mode == 'http-fail':
                self.reply(403, {'error': {'code': 'FORBIDDEN', 'message': 'test refusal'}})
            else:
                self.reply(200, {'mode': 'cli', 'ticket': 'private-test-ticket', 'delivery': 2})

        def do_GET(self):
            requests.append(self.path)
            cipher = None
            try:
                key = self.headers['Sec-WebSocket-Key']
                accept = base64.b64encode(hashlib.sha1(
                    (key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                self.send_response(101)
                self.send_header('Upgrade', 'websocket')
                self.send_header('Connection', 'Upgrade')
                self.send_header('Sec-WebSocket-Accept', accept)
                self.end_headers()
                self.connection.settimeout(5)
                control = {'controlEpoch': 1, 'connectionGeneration': 1,
                           'controlId': 'control', 'owner': 'owner'}
                send_frame(self.wfile, {'type': 'channel-welcome', 'version': 1})
                cipher = None
                logical = None
                def send(value):
                    send_frame(self.wfile, {'type': 'channel-data', 'data': cipher.seal(value)})
                while True:
                    opcode, body = read_frame(self.rfile)
                    if opcode == 8:
                        return
                    if opcode != 1:
                        continue
                    frame = json.loads(body)
                    kind = frame['type']
                    if kind == 'channel-register':
                        send_frame(self.wfile, {'type': 'channel-registered'})
                    elif kind == 'channel-connect':
                        cipher = SecureFixture(frame['key'])
                        send_frame(self.wfile, {'type': 'channel-key',
                                   'data': cipher.public,
                                   'binding': cipher.binding.decode()})
                    elif kind == 'channel-header':
                        cipher.accept(frame['data'])
                        send_frame(self.wfile, {'type': 'channel-header', 'data': cipher.header})
                    elif kind == 'channel-data':
                        packet = cipher.open(frame['data'])
                        if packet['type'] == 'request':
                            requests.append(packet['path'])
                            if mode == 'http-fail':
                                send({'type': 'response', 'id': packet['id'], 'error': {
                                    'code': 'FORBIDDEN', 'message': 'test refusal', 'status': 403}})
                            else:
                                send({'type': 'response', 'id': packet['id'], 'data': {
                                    'mode': 'cli', 'ticket': 'private-test-ticket', 'delivery': 2}})
                        elif packet['type'] == 'open':
                            logical = packet['id']
                            send({'type': 'opened', 'id': logical, 'frame': {
                                'type': 'delivery-ready', 'delivery': 2, 'instance': 'journal',
                                'controller': 'controller', 'control': control}})
                        elif packet['type'] == 'stream' and packet['frame']['type'] == 'delivery-open':
                            for lane in ['normal', 'priority']:
                                exchange = packet['frame']['exchangeId']
                                send({'type': 'stream', 'id': logical, 'frame': {
                                    'type': 'delivery-window', 'lane': lane, 'exchangeId': exchange,
                                    'controlReady': dict(control, exchangeId=exchange, instance='journal'),
                                    'window': {'stream': lane, 'instance': 'journal', 'streamSerial': 1,
                                               'creditGeneration': 'generation', 'received': 0,
                                               'receivedBytes': 0, 'credit': 4, 'byteCredit': 262144}}})
            except (EOFError, ConnectionError, TimeoutError):
                pass
            except Exception as error:
                errors.append(repr(error))
                import traceback
                traceback.print_exc()
            finally:
                if cipher:
                    cipher.close()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    relay = f'http://127.0.0.1:{server.server_port}'
    config = root / 'credentials.json'
    config.write_text(json.dumps({'version': 2, 'autoUpdate': False,
                                 'selected': relay + '~host',
                                 'entries': [{'relay': relay, 'hostId': 'host', 'token': 'private-token'}]}))
    env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'], REPAIR_CAPTURE=str(capture))
    env.pop('COC_NO_STARTUP_REPAIR', None)

    def check(name, fake_mode, expected, command='attach', extra=(), disabled=False):
        before = len(capture.read_text().splitlines()) if capture.exists() else 0
        requests_before = len(requests)
        selected = dict(env, FAKE_CODEX_MODE=fake_mode)
        if disabled:
            selected['COC_NO_STARTUP_REPAIR'] = '1'
        result = subprocess.run([client, command, 'host~session', '--config', str(config),
                                 '--offline', 'true', '--cache-dir', str(root / name), *extra],
                                env=selected, capture_output=True, timeout=12)
        after = len(capture.read_text().splitlines()) if capture.exists() else 0
        if fake_mode == 'version-fail':
            assert len(requests) == requests_before, (name, requests[requests_before:])
        assert after - before == expected, (name, result.stderr.decode(), after - before)
        assert result.returncode == (0 if fake_mode == 'normal-exit' else 1), (name, result.stderr)
        if expected:
            prompt = json.loads(capture.read_text().splitlines()[-1])[-1]
            assert 'private-token' not in prompt and 'private-test-ticket' not in prompt
        print(name, 'passed')

    try:
        check('version', 'version-fail', 1)
        check('version-disabled', 'version-fail', 0, disabled=True)
        check('connect-version', 'version-fail', 1, 'connect', ('--project', 'project'))
        mode = 'http-fail'
        check('attach-refused', 'early-fail', 1)
        mode = 'ok'
        check('early-exit', 'early-fail', 1)
        check('exec-exit', 'exec-fail', 1)
        check('normal-exit', 'normal-exit', 0)
        blocked = root / 'blocked-cache'
        blocked.write_text('not a directory')
        check('storage', 'early-fail', 1, extra=('--cache-dir', str(blocked)))
        check('before-initialized', 'handshake-fail', 1)
        check('runtime-exit', 'connected-fail', 0)
        check('usage', 'early-fail', 0, 'connect')
        assert not errors, errors
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
