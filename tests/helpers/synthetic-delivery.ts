// In-memory receiver for UI stress fixtures. Real durability/fault tests use A.
import { createHash } from 'node:crypto';
type Lane = {
  received: number;
  bytes: number;
  sent: number;
  resultBytes: number;
  results: Map<number, any>;
};
export class SyntheticDelivery {
  private lanes = new Map<string, Lane>();
  private pending = new Map<
    string,
    { stream: string; lane: string; seq: number }
  >();
  readonly control = {
    controlEpoch: 1,
    controlId: 'ui-control',
    owner: 'a'.repeat(64),
    connectionGeneration: 1,
  };
  private lane(stream: string, lane: string) {
    const key = stream + ':' + lane;
    if (!this.lanes.has(key))
      this.lanes.set(key, {
        received: 0,
        bytes: 0,
        sent: 0,
        resultBytes: 0,
        results: new Map(),
      });
    return this.lanes.get(key)!;
  }
  read(stream: string, lane: string, seq?: number, exchangeId?: string) {
    const state = this.lane(stream, lane);
    return {
      window: {
        stream: stream + '-' + lane,
        instance: 'ui-agent',
        streamSerial: 1,
        creditGeneration: 'ui-credit',
        received: state.received,
        receivedBytes: state.bytes,
        credit: state.received + (lane === 'priority' ? 4 : 16),
        byteCredit: state.bytes + 2 * 1024 * 1024,
        sent: state.sent,
        resultBytes: state.resultBytes,
      },
      ...(exchangeId
        ? {
            exchangeId,
            controlReady: { ...this.control, instance: 'ui-agent', exchangeId },
          }
        : {}),
      results: [...state.results.values()],
      ...(seq
        ? {
            seq,
            record: state.results.has(seq)
              ? { phase: 'finished', ...state.results.get(seq) }
              : { phase: 'started' },
          }
        : {}),
    };
  }
  receive(frame: any, send: (value: any) => void): any {
    if (frame.type === 'delivery-open') {
      for (const lane of ['normal', 'priority'])
        send({
          type: 'delivery-window',
          lane,
          ...this.read(frame.stream, lane, undefined, frame.exchangeId),
        });
      return;
    }
    if (frame.type === 'delivery-receipt') return;
    if (frame.type === 'delivery-query') {
      send({
        type: 'delivery-window',
        lane: frame.lane,
        ...this.read(frame.stream, frame.lane, frame.seq),
      });
      return;
    }
    if (frame.type !== 'delivery-command') return frame;
    const state = this.lane(frame.stream, frame.lane);
    if (frame.seq <= state.received) {
      send({
        type: 'delivery-window',
        lane: frame.lane,
        ...this.read(frame.stream, frame.lane, frame.seq),
      });
      return;
    }
    if (frame.seq !== state.received + 1)
      throw new Error('Synthetic command gap');
    const command = JSON.parse(frame.body);
    state.received = frame.seq;
    state.bytes = frame.end;
    this.pending.set(command.requestId, {
      stream: frame.stream,
      lane: frame.lane,
      seq: frame.seq,
    });
    send({
      type: 'delivery-window',
      lane: frame.lane,
      ...this.read(frame.stream, frame.lane),
    });
    return command;
  }
  result(payload: any): any {
    const original = this.pending.get(payload.requestId);
    if (!original || !['ack', 'error'].includes(payload.type)) return payload;
    this.pending.delete(payload.requestId);
    const state = this.lane(original.stream, original.lane);
    const body = JSON.stringify(payload);
    state.sent++;
    state.resultBytes += Buffer.byteLength(body);
    const result = {
      seq: original.seq,
      resultStream: original.stream + '-' + original.lane + '_r',
      resultSeq: state.sent,
      resultEnd: state.resultBytes,
      resultBody: body,
      resultDigest: createHash('sha256').update(body).digest('hex'),
    };
    state.results.set(original.seq, result);
    return {
      type: 'delivery-result',
      lane: original.lane,
      ...this.read(original.stream, original.lane),
      ...result,
    };
  }
}
