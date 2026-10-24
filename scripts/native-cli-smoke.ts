// Tests real native TUI initialization through the same guarded stdio bridge.
// Default is initialization only; --task explicitly runs a real model turn.
import WebSocket, { WebSocketServer } from 'ws';
import { localRelay } from './local-relay.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexProcess, guardCli, redact } from '../apps/agent/src/codex.ts';
import type { Rpc } from '../packages/protocol/src/index.ts';
const dir = mkdtempSync(join(tmpdir(), 'coc-native-'));
const relay = process.argv.includes('--relay')
  ? await localRelay(dir)
  : undefined;
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise<void>((r) => wss.once('listening', r));
const runTask = process.argv.includes('--task');
let turnCompleted = false;
const methods = new Set<string>(),
  rejected = new Set<string>(),
  responses = new Set<string>();
let codex: CodexProcess | undefined, threadId: string | undefined;
const requests = new Map<string, string>();
wss.on('connection', (ws, req) => {
  if (req.headers.authorization !== 'Bearer local-smoke-only') {
    ws.close();
    return;
  }
  if (relay) {
    const upstream = new WebSocket(relay.endpoint, {
      headers: { Authorization: 'Bearer ' + relay.ticket },
    });
    const queue: string[] = [];
    upstream.on('open', () => {
      for (const m of queue) upstream.send(m);
      queue.length = 0;
    });
    ws.on('message', (raw) => {
      const text = raw.toString(),
        m: Rpc = JSON.parse(text);
      if (m.method) methods.add(m.method);
      if (m.method && m.id !== undefined) requests.set(String(m.id), m.method);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else queue.push(text);
    });
    upstream.on('message', (raw) => {
      const m: Rpc = JSON.parse(raw.toString());
      if (!m.method && m.id !== undefined) {
        const method = requests.get(String(m.id));
        if (method && !m.error) responses.add(method);
        if (method && m.error) rejected.add(method);
      }
      if (
        m.method === 'turn/completed' &&
        m.params?.turn?.status === 'completed'
      ) {
        turnCompleted = true;
        writeFileSync(join(dir, 'turn-completed'), 'ok');
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(raw.toString());
    });
    upstream.on('error', () => ws.close());
    upstream.on('close', () => ws.close());
    ws.on('close', () => upstream.close());
    return;
  }
  codex = new CodexProcess(
    'codex',
    [],
    dir,
    'read-only',
    (m: Rpc) => {
      if (
        m.method === 'turn/completed' &&
        m.params?.turn?.status === 'completed'
      ) {
        turnCompleted = true;
        writeFileSync(join(dir, 'turn-completed'), 'ok');
      }
      if (!m.method && m.id !== undefined) {
        const method = requests.get(String(m.id));
        if (method && !m.error) responses.add(method);
        if (method === 'thread/start') threadId = m.result?.thread?.id;
      }
      ws.send(JSON.stringify(redact(m)));
    },
    () => ws.close(),
  );
  ws.on('message', (raw) => {
    const m: Rpc = JSON.parse(raw.toString());
    if (m.method) methods.add(m.method);
    if (['thread/list', 'thread/loaded/list'].includes(m.method || '')) {
      responses.add(m.method!);
      ws.send(
        JSON.stringify({
          id: m.id,
          result:
            m.method === 'thread/list'
              ? { data: [], nextCursor: null }
              : { data: threadId ? [threadId] : [] },
        }),
      );
      return;
    }
    try {
      const guarded = guardCli(m, dir, 'read-only', threadId);
      if (m.id !== undefined && m.method) requests.set(String(m.id), m.method);
      codex!.send(guarded);
    } catch (e) {
      console.log(
        'Bridge rejection:',
        m.method,
        (e as Error).message,
        'fields:',
        Object.keys(m.params || {}).join(','),
        'config keys:',
        Object.keys(m.params?.config || {}).join(','),
      );
      if (m.method) rejected.add(m.method);
      if (m.id !== undefined)
        ws.send(
          JSON.stringify({
            id: m.id,
            error: { code: -32001, message: 'Unsupported remote action' },
          }),
        );
    }
  });
  ws.on('close', () => codex?.close());
});
const port = (wss.address() as any).port;
const py = spawn(
  'python3',
  [
    '-c',
    `
import os,pty,select,subprocess,time,sys,fcntl,termios,struct
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
env=os.environ.copy();env['TERM']='xterm-256color';env['COC_SMOKE_TICKET']='local-smoke-only'
p=subprocess.Popen(['codex','--remote',sys.argv[1],'--remote-auth-token-env','COC_SMOKE_TICKET','--no-alt-screen','--sandbox','read-only','--ask-for-approval','on-request'],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=sys.argv[2],start_new_session=True)
os.close(slave)
task=sys.argv[3]=='task'
sent=False
submitted=False
start=time.time()
end=start+(90 if task else 15)
while time.time()<end and p.poll() is None:
 if task and os.path.exists(os.path.join(sys.argv[2],'turn-completed')):break
 if task and not sent and time.time()-start>5:
  os.write(master,b'Reply with exactly coc-native-ok. Do not execute commands, read files, or modify anything.');sent=True
 if sent and not submitted and time.time()-start>7:
  os.write(master,b'\\r');submitted=True
 r,_,_=select.select([master],[],[],0.2)
 if r:
  try:
   data=os.read(master,65536)
   if b'\\x1b[6n' in data: os.write(master,b'\\x1b[1;1R')
   if b'trust' in data.lower(): os.write(master,b'\\r')
  except OSError:break
p.terminate()
try:p.wait(timeout=3)
except subprocess.TimeoutExpired:p.kill();p.wait()
os.close(master)
`,
    'ws://127.0.0.1:' + port,
    dir,
    runTask ? 'task' : 'init',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
let stderr = '';
py.stderr.on('data', (d) => (stderr += d));
try {
  await new Promise<void>((r, j) => {
    py.on('error', j);
    py.on('exit', () => r());
  });
  console.log('Native CLI methods:', [...methods].join(', '));
  console.log('Successful responses:', [...responses].join(', '));
  if (rejected.size)
    console.log('Unsupported native methods:', [...rejected].join(', '));
  if (!responses.has('initialize') || !responses.has('thread/start'))
    throw new Error('Native TUI did not finish initialization. ' + stderr);
  if (runTask && !turnCompleted)
    throw new Error('Native TUI real model turn did not complete');
  console.log(
    runTask
      ? relay
        ? 'PASS: real native Codex TUI completed a model turn through Worker, Durable Object, Agent and Codex.'
        : 'PASS: real native Codex TUI completed a model turn through the guarded bridge.'
      : 'PASS: real native Codex TUI initialized through guarded WebSocket/stdio bridge. No prompt submitted.',
  );
} finally {
  codex?.close();
  if (relay) await relay.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}
