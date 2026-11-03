import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalStream } from '../apps/web/src/workbench/terminal-stream.ts';
class Socket {
  static OPEN = 1;
  static last: Socket;
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Socket.last = this;
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  receive(frame: unknown, receiptId?: string) {
    this.onmessage?.({
      data: JSON.stringify({ type: 'terminal-stream', frame, receiptId }),
    });
  }
}
const scope = {
  projectId: 'project',
  sessionId: 'host~session',
  terminalId: 'runtime',
  offset: 0,
  control: {
    controlEpoch: 1,
    controlId: 'control',
    owner: 'a'.repeat(64),
    connectionGeneration: 1,
  },
};
function setup() {
  const callbacks = {
    ready: vi.fn(),
    output: vi.fn(),
    offset: vi.fn(),
    exit: vi.fn(),
    error: vi.fn(),
  };
  const stream = new TerminalStream('host', scope, callbacks);
  const socket = Socket.last;
  socket.onopen?.();
  socket.receive({ type: 'ready', next: 1 });
  return { stream, socket, callbacks };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('streaming Terminal', () => {
  it('sends no application frames while a bound terminal is idle', () => {
    const { stream, socket } = setup();
    const sent = structuredClone(socket.sent);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(socket.sent).toEqual(sent);
    stream.close();
  });
  it('acknowledges output only after rendering and accepts explicit gaps', () => {
    const { stream, socket, callbacks } = setup();
    socket.receive(
      { type: 'output', data: btoa('hello'), offset: 5, gap: false },
      '1:100',
    );
    expect(callbacks.output.mock.calls[0][0]).toEqual(
      new TextEncoder().encode('hello'),
    );
    expect(socket.sent).toHaveLength(1);
    callbacks.output.mock.calls[0][2]();
    expect(callbacks.offset).toHaveBeenCalledWith(5);
    expect(socket.sent.at(-1).frame).toEqual({ type: 'ack', offset: 5 });
    socket.receive({
      type: 'output',
      data: btoa('tail'),
      offset: 100,
      gap: true,
    });
    expect(callbacks.output.mock.calls[1][1]).toBe(true);
    expect(callbacks.error).not.toHaveBeenCalled();
    stream.close();
  });
  it('waits for the exact input sequence confirmation', async () => {
    const { stream, socket } = setup();
    const done = vi.fn();
    const pending = stream.write({ type: 'input', data: btoa('x') }).then(done);
    expect(socket.sent.at(-1).frame.seq).toBe(1);
    expect(done).not.toHaveBeenCalled();
    await expect(
      stream.write({ type: 'input', data: btoa('y') }),
    ).rejects.toThrow('not ready');
    socket.receive({ type: 'ack', next: 2 });
    await pending;
    expect(done).toHaveBeenCalled();
    const resize = stream.write({ type: 'resize', cols: 80, rows: 24 });
    expect(socket.sent.at(-1).frame.seq).toBe(2);
    socket.receive({ type: 'ack', next: 3 });
    await resize;
    stream.close();
  });
  it('fails closed on offset mismatch', () => {
    const { socket, callbacks } = setup();
    socket.receive({ type: 'output', data: btoa('x'), offset: 10, gap: false });
    expect(callbacks.output).not.toHaveBeenCalled();
    expect(callbacks.error).toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  });
  it('does not send a late render receipt while the socket is closing', () => {
    const { stream, socket, callbacks } = setup();
    socket.receive(
      { type: 'output', data: btoa('x'), offset: 1, gap: false },
      '1:100',
    );
    socket.readyState = 2;
    const count = socket.sent.length;
    expect(() => callbacks.output.mock.calls[0][2]()).not.toThrow();
    expect(callbacks.offset).toHaveBeenCalledWith(1);
    expect(socket.sent).toHaveLength(count);
    stream.close();
  });
  it('does not replay unknown input after disconnection', async () => {
    const { stream, socket, callbacks } = setup();
    const pending = stream.write({ type: 'input', data: btoa('x') });
    socket.onclose?.();
    await expect(pending).rejects.toThrow('unknown');
    await vi.advanceTimersByTimeAsync(60000);
    expect(socket.sent.filter((v) => v.frame?.type === 'input')).toHaveLength(
      1,
    );
    expect(callbacks.error).toHaveBeenCalledOnce();
  });
  it('times out unconfirmed writes and cancels late rendering acknowledgments', async () => {
    const { stream, socket, callbacks } = setup();
    socket.receive({ type: 'output', data: btoa('x'), offset: 1, gap: false });
    const pending = stream.write({ type: 'input', data: btoa('x') });
    const rejected = expect(pending).rejects.toThrow('unknown');
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    const count = socket.sent.length;
    callbacks.output.mock.calls[0][2]();
    expect(socket.sent).toHaveLength(count);
    expect(callbacks.offset).toHaveBeenCalledWith(1);
  });
});
