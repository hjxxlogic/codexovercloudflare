import { relayPath } from './routes.ts';
type Listener = (event: any) => void;
type Channel = {
  socket: WebSocket;
  listeners: Set<Listener>;
  ready: boolean;
  attempts: number;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
};
const channels = new Map<string, Channel>();
function connect(path: string, channel: Channel) {
  channel.ready = false;
  const socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${relayPath(path)}`,
  );
  channel.socket = socket;
  socket.onmessage = (event) => {
    if (channel.socket !== socket) return;
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
      channel.ready = true;
      channel.attempts = 0;
      channel.revision = data.revision || 0;
    }
    for (const listener of channel.listeners) listener(data);
  };
  socket.onclose = (event) => {
    if (channel.socket !== socket) return;
    channel.ready = false;
    for (const listener of channel.listeners)
      listener({ type: 'disconnected' });
    if (
      channels.get(path) === channel &&
      event.code !== 4001 &&
      channel.attempts < 3
    )
      channel.timer = setTimeout(
        () => connect(path, channel),
        1000 * 2 ** channel.attempts++,
      );
  };
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
