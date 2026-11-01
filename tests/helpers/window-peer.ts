import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import {
  deliveryDigest,
  deliveryResultSchema,
  deliveryWindowSchema,
  rpcDeliveryLane,
  webDeliveryLane,
  type DeliveryLane,
  type DeliveryWindow,
} from '../../packages/protocol/src/delivery.ts';

// A wire fixture, not a client journal. Keep results unacknowledged deliberately:
// duplicate-command checks must exercise the Agent's retained original result.
export class WindowPeer {
  readonly stream = randomUUID();
  readonly exchangeId = randomUUID();
  readonly windows: Partial<Record<DeliveryLane, DeliveryWindow>> = {};
  private entries = new Map<
    string,
    { lane: DeliveryLane; seq: number; end: number; body: string }
  >();
  private heads = {
    normal: { seq: 0, bytes: 0 },
    priority: { seq: 0, bytes: 0 },
  };
  private pending: Promise<void> = Promise.resolve();
  private failure?: unknown;
  constructor(
    private ws: WebSocket,
    private messages: any[],
    private mode: 'web' | 'cli',
    private control: any,
  ) {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      this.pending = this.pending
        .then(() => this.receive(frame))
        .catch((error) => {
          this.failure = error;
        });
    });
    ws.send(
      JSON.stringify({
        type: 'delivery-open',
        stream: this.stream,
        exchangeId: this.exchangeId,
        received: { normal: 0, priority: 0 },
        receivedBytes: { normal: 0, priority: 0 },
      }),
    );
  }
  get ready() {
    if (this.failure) throw this.failure;
    return !!this.windows.normal && !!this.windows.priority;
  }
  send = (text: string) => {
    if (this.failure) throw this.failure;
    const payload = JSON.parse(text);
    if (
      !(this.mode === 'web'
        ? payload.action
        : payload.method || payload.id !== undefined)
    ) {
      this.ws.send(text);
      return;
    }
    const lane =
      this.mode === 'web' ? webDeliveryLane(payload) : rpcDeliveryLane(payload);
    if (!lane) {
      this.ws.send(text);
      return;
    }
    const window = this.windows[lane];
    assert(
      window && this.ready,
      'Wait for both CONTROL_READY windows before writing',
    );
    const key =
      this.mode === 'web'
        ? payload.requestId
        : JSON.stringify([payload.method, payload.id]);
    let entry = this.entries.get(key);
    if (!entry) {
      const head = this.heads[lane];
      entry = {
        lane,
        seq: head.seq + 1,
        end: head.bytes + Buffer.byteLength(text),
        body: text,
      };
      assert(
        entry.seq <= window.credit && entry.end <= window.byteCredit,
        'Fixture command exceeds credit',
      );
      // Save the immutable original before publishing its sequence.
      this.entries.set(key, entry);
      head.seq = entry.seq;
      head.bytes = entry.end;
    }
    assert.equal(entry.lane, lane);
    this.ws.send(
      JSON.stringify({
        type: 'delivery-command',
        stream: this.stream,
        lane,
        instance: window.instance,
        streamSerial: window.streamSerial,
        creditGeneration: window.creditGeneration,
        seq: entry.seq,
        end:
          entry.end - Buffer.byteLength(entry.body) + Buffer.byteLength(text),
        body: text,
      }),
    );
  };
  private async receive(frame: any) {
    if (frame.type === 'delivery-rejected') {
      const entry = [...this.entries.values()].find(
        (v) => v.lane === frame.lane && v.seq === frame.seq,
      );
      const original = entry && JSON.parse(entry.body);
      this.messages.push({
        type: 'error',
        requestId: original?.requestId,
        error: frame.error,
      });
      return;
    }
    if (frame.type === 'delivery-data') {
      assert.equal(this.mode, 'cli');
      this.messages.push(JSON.parse(frame.body));
      this.ws.send(
        JSON.stringify({
          type: 'delivery-output',
          received: frame.seq,
          credit: frame.seq + 32,
          byteCredit: frame.end + 2 * 1024 * 1024,
        }),
      );
      return;
    }
    if (!['delivery-window', 'delivery-result'].includes(frame.type)) return;
    const lane: DeliveryLane = frame.lane;
    const window = deliveryWindowSchema.parse(frame.window);
    if (!this.windows[lane]) {
      assert.equal(frame.exchangeId, this.exchangeId);
      for (const [key, value] of Object.entries(this.control))
        assert.equal(frame.controlReady?.[key], value);
      assert.equal(frame.controlReady?.instance, window.instance);
      assert.equal(frame.controlReady?.exchangeId, this.exchangeId);
    } else {
      const old = this.windows[lane]!;
      for (const key of [
        'instance',
        'streamSerial',
        'creditGeneration',
      ] as const)
        assert.equal(window[key], old[key]);
      assert(
        window.received >= old.received &&
          window.receivedBytes >= old.receivedBytes,
      );
    }
    this.windows[lane] = window;
    if (this.mode === 'cli' && this.ready && !this.heads.normal.seq)
      this.ws.send(
        JSON.stringify({
          type: 'delivery-output',
          received: 0,
          credit: 32,
          byteCredit: 2 * 1024 * 1024,
          replay: true,
        }),
      );
    if (frame.type === 'delivery-result') {
      const result = deliveryResultSchema.parse(frame);
      assert.equal(result.resultStream, window.stream + '_r');
      assert.equal(
        await deliveryDigest(result.resultBody),
        result.resultDigest,
      );
      const original = [...this.entries.values()].find(
        (v) => v.lane === lane && v.seq === result.seq,
      );
      assert(original, 'Result has no original command');
      let payload = JSON.parse(result.resultBody);
      if (payload?.error && !payload.type && this.mode === 'web')
        payload = {
          type: 'error',
          requestId: JSON.parse(original.body).requestId,
          error: payload.error,
        };
      if (payload) this.messages.push(payload);
    }
  }
}
