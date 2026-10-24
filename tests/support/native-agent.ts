// Test-only process harness; all Agent behavior lives in the native executable.
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import type { AgentConfig } from '../../packages/protocol/src/index.ts';
export class Agent {
  stopped = false;
  socket?: WebSocket;
  private child?: ChildProcess;
  private proxy?: WebSocketServer;
  private peers = new Set<WebSocket>();
  private starting?: Promise<void>;
  constructor(private config: AgentConfig) {}
  start() {
    this.starting = this.launch();
    void this.starting.catch((e) =>
      console.error('Native Agent launch failed:', e.message),
    );
  }
  private async launch() {
    const proxy = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    this.proxy = proxy;
    await new Promise<void>((r) => proxy.once('listening', r));
    proxy.on('connection', (downstream, req) => {
      const upstream = new WebSocket(
        this.config.relayUrl.replace(/^http/, 'ws') + '/ws/v1/agent',
        {
          headers: { Authorization: req.headers.authorization || '' },
        },
      );
      this.socket = upstream;
      this.peers.add(downstream);
      this.peers.add(upstream);
      const queue: string[] = [];
      downstream.on('message', (d) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(d.toString());
        else queue.push(d.toString());
      });
      upstream.on('open', () => {
        for (const d of queue) upstream.send(d);
        queue.length = 0;
      });
      upstream.on('message', (d) => {
        if (downstream.readyState === WebSocket.OPEN)
          downstream.send(d.toString());
      });
      upstream.on('close', (code) => {
        this.peers.delete(upstream);
        downstream.close(code === 4001 ? 4001 : 1012);
      });
      downstream.on('close', () => {
        this.peers.delete(downstream);
        upstream.terminate();
      });
      upstream.on('error', () => downstream.close(1012));
      downstream.on('error', () => upstream.terminate());
    });
    const file = join(
      this.config.projects[0].path,
      'native-agent-' + this.config.hostId + '.json',
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...this.config,
        relayUrl: 'http://127.0.0.1:' + (proxy.address() as any).port,
      }),
      { mode: 0o600 },
    );
    this.child = spawn(
      resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
      ['run', '--config', file],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child.stdout?.resume();
    this.child.stderr?.on('data', (d) => process.stderr.write(d));
    this.child.on('exit', () => {
      this.stopped = true;
      for (const p of this.peers) p.terminate();
      proxy.close();
    });
    this.child.on('error', (e) => {
      this.stopped = true;
      proxy.close();
      console.error(e.message);
    });
  }
  async close() {
    await this.starting;
    if (this.child && this.child.exitCode === null && !this.stopped) {
      await new Promise<void>((r) => {
        this.child!.once('exit', () => r());
        this.child!.kill('SIGTERM');
      });
    }
    for (const p of this.peers) p.terminate();
    this.proxy?.close();
    this.stopped = true;
  }
}
