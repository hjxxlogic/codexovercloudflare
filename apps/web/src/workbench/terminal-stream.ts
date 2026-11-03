import {
  terminalStreamServerSchema,
  type ControlProof,
} from '../../../../packages/protocol/src/index.ts';
import { relaySocketPath } from '../routes.ts';
// Ephemeral bytes never enter the reliable operation journal or browser storage.
export class TerminalStream {
  private socket: WebSocket;
  private pending?: {
    next: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private heartbeat: ReturnType<typeof setInterval>;
  private deadline: ReturnType<typeof setTimeout>;
  private stopped = false;
  private bound = false;
  private next = 1;
  private offset: number;
  constructor(
    host: string,
    scope: {
      projectId: string;
      sessionId: string;
      terminalId: string;
      control: ControlProof;
      offset: number;
    },
    private callbacks: {
      ready: () => void;
      output: (bytes: Uint8Array, gap: boolean, rendered: () => void) => void;
      offset: (value: number) => void;
      exit: (code: number) => void;
      error: (error: Error) => void;
    },
  ) {
    this.offset = scope.offset;
    this.socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${relaySocketPath(`/ws/v1/hosts/${host}/terminal`)}`,
    );
    this.deadline = setTimeout(
      () => this.fail(new Error('Terminal stream handshake timed out')),
      20000,
    );
    this.heartbeat = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN)
        this.send({ type: 'ping' });
    }, 15000);
    this.socket.onopen = () => this.send({ type: 'bind', ...scope });
    this.socket.onmessage = (event) => {
      if (this.stopped) return;
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.type === 'error')
          throw new Error(envelope.error?.code || 'Terminal stream rejected');
        if (envelope.type !== 'terminal-stream')
          throw new Error('Invalid Terminal stream envelope');
        const frame = terminalStreamServerSchema.parse(envelope.frame);
        if (!this.bound && !['ready', 'error'].includes(frame.type))
          throw new Error('Terminal stream not bound');
        const receipt = () => {
          if (envelope.receiptId)
            this.sendEnvelope({
              type: 'receipt',
              receiptId: envelope.receiptId,
            });
        };
        if (frame.type === 'output') {
          const bytes = Uint8Array.from(atob(frame.data), (ch) =>
            ch.charCodeAt(0),
          );
          if (
            (!frame.gap && frame.offset !== this.offset + bytes.length) ||
            frame.offset <= this.offset ||
            frame.offset < bytes.length ||
            bytes.length > 16384 ||
            (frame.gap && frame.offset - bytes.length < this.offset)
          )
            throw new Error('Terminal output offset mismatch');
          this.offset = frame.offset;
          this.callbacks.output(bytes, frame.gap, () => {
            this.callbacks.offset(frame.offset);
            if (this.stopped) return;
            receipt();
            this.send({ type: 'ack', offset: frame.offset });
          });
          return;
        }
        receipt();
        if (frame.type === 'ready') {
          if (this.bound) throw new Error('Terminal stream already bound');
          this.bound = true;
          clearTimeout(this.deadline);
          this.next = frame.next;
          this.callbacks.ready();
        } else if (frame.type === 'ack') {
          if (!this.pending || frame.next !== this.pending.next)
            throw new Error('Terminal input acknowledgment mismatch');
          clearTimeout(this.pending.timer);
          this.next = frame.next;
          this.pending.resolve();
          this.pending = undefined;
        } else if (frame.type === 'exit') {
          this.callbacks.exit(frame.exitCode);
          this.close();
        } else if (frame.type === 'error')
          throw new Error(frame.error.code + ': ' + frame.error.message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.socket.onerror = () =>
      this.fail(new Error('Terminal stream transport failed'));
    this.socket.onclose = () =>
      this.fail(
        new Error(
          'Terminal stream disconnected; unconfirmed input was not replayed',
        ),
      );
  }
  private send(frame: object) {
    this.sendEnvelope({ type: 'terminal-stream', frame });
  }
  private sendEnvelope(envelope: object) {
    if (this.stopped || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 65536) {
      this.fail(new Error('Terminal stream backpressure'));
      return;
    }
    try {
      this.socket.send(JSON.stringify(envelope));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  write(
    frame:
      | { type: 'input'; data: string }
      | { type: 'resize'; cols: number; rows: number },
  ): Promise<void> {
    if (
      this.stopped ||
      !this.bound ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.pending
    )
      return Promise.reject(
        new Error('Terminal stream is not ready for input'),
      );
    return new Promise((resolve, reject) => {
      this.pending = {
        next: this.next + 1,
        resolve,
        reject,
        timer: setTimeout(
          () =>
            this.fail(
              new Error(
                'Terminal input result unknown; input was not replayed',
              ),
            ),
          15000,
        ),
      };
      this.send({ ...frame, seq: this.next });
    });
  }
  private fail(error: Error) {
    if (this.stopped) return;
    this.close();
    this.callbacks.error(error);
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(
        new Error('Terminal input result unknown; input was not replayed'),
      );
      this.pending = undefined;
    }
    this.socket.onclose =
      this.socket.onerror =
      this.socket.onmessage =
      this.socket.onopen =
        null;
    this.socket.close();
  }
}
