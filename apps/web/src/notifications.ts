import { relayPath } from './routes.ts';
type Listener = (event: any) => void;
type Channel = {
  socket: WebSocket;
  listeners: Set<Listener>;
  ready: boolean;
  attempts: number;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  handshake?: ReturnType<typeof setTimeout>;
};
const channels = new Map<string, Channel>();
function connect(path: string, channel: Channel) {
  clearTimeout(channel.timer);
  clearTimeout(channel.handshake);
  channel.ready = false;
  const socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${relayPath(path)}`,
  );
  channel.socket = socket;
  let ended = false;
  const disconnect = (code = 4000) => {
    if (ended || channel.socket !== socket) return;
    ended = true;
    clearTimeout(channel.handshake);
    channel.ready = false;
    socket.close();
    for (const listener of channel.listeners)
      listener({ type: 'disconnected' });
    if (channels.get(path) === channel && code !== 4001 && channel.attempts < 3)
      channel.timer = setTimeout(
        () => connect(path, channel),
        1000 * 2 ** channel.attempts++,
      );
  };
  // An OPEN socket is not a completed subscription. Do not depend on a close
  // event arriving from a stalled transport before starting bounded recovery.
  channel.handshake = setTimeout(disconnect, 15000);
  socket.onmessage = (event) => {
    if (ended || channel.socket !== socket) return;
    const data = JSON.parse(event.data);
    if (data.receiptId)
      socket.send(
        JSON.stringify({ type: 'receipt', receiptId: data.receiptId }),
      );
    if (data.type === 'change' && typeof data.revision === 'number') {
      if (data.revision <= channel.revision) return;
      if (data.revision > channel.revision + 1)
        for (const listener of channel.listeners)
          listener({ type: 'subscribed', gap: true });
      channel.revision = data.revision;
    }
    if (data.type === 'subscribed') {
      clearTimeout(channel.handshake);
      channel.ready = true;
      channel.attempts = 0;
      channel.revision = data.revision || 0;
    }
    for (const listener of channel.listeners) listener(data);
  };
  socket.onclose = (event) => disconnect(event.code);
}
export function observe(path: string, listener: Listener) {
  let channel = channels.get(path);
  if (!channel) {
    channel = {
      socket: undefined!,
      listeners: new Set(),
      ready: false,
      attempts: 0,
      revision: 0,
    };
    channels.set(path, channel);
    connect(path, channel);
  }
  channel.listeners.add(listener);
  if (channel.ready)
    queueMicrotask(() => {
      if (channel!.listeners.has(listener)) listener({ type: 'subscribed' });
    });
  return () => {
    channel!.listeners.delete(listener);
    if (!channel!.listeners.size) {
      channels.delete(path);
      clearTimeout(channel!.timer);
      clearTimeout(channel!.handshake);
      channel!.socket.close();
    }
  };
}
export function recoverNotifications(force = false) {
  for (const [path, channel] of channels) {
    if (!force && channel.socket.readyState < WebSocket.CLOSING) continue;
    channel.socket.close();
    clearTimeout(channel.timer);
    channel.attempts = 0;
    connect(path, channel);
  }
}
