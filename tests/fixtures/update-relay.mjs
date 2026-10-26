// Deterministic update test peer: creates one native runtime and serves release bytes.
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { WebSocketServer } from 'ws';
const state = { created: false, stopped: false };
let peer;
const server = createServer(async (request, response) => {
  if (request.url === '/state') {
    response.end(JSON.stringify(state));
    return;
  }
  if (request.url === '/stop' && request.method === 'POST') {
    peer.send(
      JSON.stringify({
        type: 'control',
        action: 'stop',
        requestId: 'stop',
        data: { sessionId: state.sessionId },
      }),
    );
    response.end('{}');
    return;
  }
  if (request.url.startsWith('/downloads/')) {
    if (request.headers.authorization) {
      response.writeHead(400).end('Download must not use credentials');
      return;
    }
    const upstream = await globalThis.fetch(process.argv[2] + request.url);
    response.writeHead(upstream.status);
    response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  response.writeHead(404).end();
});
const sockets = new WebSocketServer({ server, path: '/ws/v1/agent' });
sockets.on('connection', (socket) => {
  peer = socket;
  socket.send(JSON.stringify({ type: 'hello', demand: 1, minProtocol: 1 }));
  socket.send(
    JSON.stringify({
      type: 'control',
      action: 'create',
      requestId: 'create',
      data: { key: 'update-test', projectId: 'project', mode: 'cli' },
    }),
  );
  socket.on('message', (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    if (message.type === 'result' && message.requestId === 'create') {
      state.created = !message.error;
      state.error = message.error;
      state.sessionId = message.data?.id;
    }
    if (message.type === 'result' && message.requestId === 'stop')
      state.stopped = !message.error;
  });
});
server.listen(0, '127.0.0.1', () =>
  console.log(JSON.stringify({ port: server.address().port })),
);
