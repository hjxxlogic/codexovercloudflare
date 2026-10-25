// Deterministic original app-server peer; no commands or model calls.
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
export class SharedApprovals {
  readonly server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  readonly requests: { method: string; threadId?: string; params: any }[] = [];
  readonly pending = new Map<string, any>();
  readonly decisions = new Map<string, any>();
  private subscriptions = new Map<WebSocket, string>();
  private sequence = 0;
  constructor(private cwd: string) {
    this.server.on('connection', (socket) => {
      socket.on('error', () => {});
      socket.on('close', () => this.subscriptions.delete(socket));
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (!message.method) {
          const pending = this.pending.get(String(message.id));
          assert(pending, 'Only a pending request may be answered');
          assert.equal(pending.params.threadId, this.subscriptions.get(socket));
          this.decisions.set(String(message.id), message.result);
          this.resolve(String(message.id));
          return;
        }
        if (message.method === 'initialized') return;
        this.requests.push({
          method: message.method,
          threadId: message.params?.threadId,
          params: message.params,
        });
        let result: any = {};
        if (message.method === 'initialize')
          result = { userAgent: 'shared-approval-fixture' };
        else if (message.method === 'thread/read')
          result = {
            thread: {
              id: message.params.threadId,
              cwd:
                message.params.threadId === 'external-foreign-approval'
                  ? '/other-project'
                  : this.cwd,
              status: {
                type:
                  message.params.threadId === 'external-unloaded'
                    ? 'notLoaded'
                    : 'active',
              },
            },
          };
        else if (message.method === 'thread/resume') {
          assert.deepEqual(Object.keys(message.params).sort(), [
            'excludeTurns',
            'threadId',
          ]);
          this.subscriptions.set(socket, message.params.threadId);
        } else assert.fail('Unexpected shared server method ' + message.method);
        socket.send(JSON.stringify({ id: message.id, result }));
        if (message.method === 'thread/resume')
          for (const pending of this.pending.values())
            if (pending.params.threadId === message.params.threadId)
              socket.send(JSON.stringify(pending));
      });
    });
  }
  async ready() {
    if (!this.server.address())
      await new Promise<void>((resolve) =>
        this.server.once('listening', resolve),
      );
    return `ws://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }
  add(threadId: string, method = 'item/commandExecution/requestApproval') {
    const id = 'shared-approval-' + ++this.sequence;
    const request = {
      id,
      method,
      params: {
        threadId,
        turnId: 'external-turn',
        itemId: id,
        cwd: this.cwd,
        command: 'echo external-approval',
        reason: 'Explicit remote approval fixture',
        permissions: { network: { enabled: true }, fileSystem: null },
        availableDecisions: ['accept', 'decline'],
      },
    };
    this.pending.set(id, request);
    for (const [socket, thread] of this.subscriptions)
      if (thread === threadId) {
        if (method === 'item/fileChange/requestApproval')
          socket.send(
            JSON.stringify({
              method: 'item/started',
              params: {
                threadId,
                turnId: 'external-turn',
                item: {
                  id,
                  type: 'fileChange',
                  status: 'inProgress',
                  changes: [
                    {
                      path: 'remote-approval.txt',
                      kind: { type: 'add' },
                      diff: '+remote approval patch preview',
                    },
                  ],
                },
              },
            }),
          );
        socket.send(JSON.stringify(request));
      }
    return id;
  }
  resolve(id: string) {
    const pending = this.pending.get(id);
    assert(pending);
    this.pending.delete(id);
    for (const [socket, thread] of this.subscriptions)
      if (thread === pending.params.threadId)
        socket.send(
          JSON.stringify({
            method: 'serverRequest/resolved',
            params: { threadId: thread, requestId: id },
          }),
        );
  }
  async close() {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
