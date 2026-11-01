import {
  deliveryDigest,
  deliveryResultSchema,
  transferDescriptorSchema,
  type DeliveryWindow,
} from '../../../packages/protocol/src/delivery.ts';

type StoredResult = {
  seq: number;
  command: number;
  end: number;
  body: string;
  digest: string;
  content?: string;
};
export type ResultJournal = {
  received: number;
  bytes: number;
  buffer: Record<string, StoredResult>;
  cache: StoredResult[];
};
export const emptyResults = (): ResultJournal => ({
  received: 0,
  bytes: 0,
  buffer: {},
  cache: [],
});
const size = (body: string) => new TextEncoder().encode(body).length;

// Work on a copy: the caller commits this journal, command terminal states and
// its receive window together before emitting an ACK or notifying the UI.
export async function receiveResults(
  current: ResultJournal,
  commands: { seq: number; end: number; body: string }[],
  envelopes: unknown[],
  window: DeliveryWindow,
  resolveContent?: (resultSeq: number, descriptor: unknown) => Promise<string>,
) {
  const journal = structuredClone(current);
  let entries = commands;
  const completed: { body: string; payload: any }[] = [];
  for (const envelope of envelopes) {
    const result = deliveryResultSchema.parse(envelope);
    if (
      result.resultStream !== window.stream + '_r' ||
      result.resultSeq > (window.sent ?? 0) ||
      result.resultEnd > (window.resultBytes ?? 0)
    )
      throw new Error('Result exceeds its published stream');
    if ((await deliveryDigest(result.resultBody)) !== result.resultDigest)
      throw new Error('Result digest mismatch');
    let payload = JSON.parse(result.resultBody);
    const known =
      journal.buffer[result.resultSeq] ||
      journal.cache.find((v) => v.seq === result.resultSeq);
    if (
      known &&
      (known.command !== result.seq ||
        known.end !== result.resultEnd ||
        known.digest !== result.resultDigest ||
        known.body !== result.resultBody)
    )
      throw new Error('Result identity reused with different content');
    if (known || result.resultSeq <= journal.received) continue;
    const entry = entries.find((v) => v.seq === result.seq);
    if (!entry) throw new Error('Result has no matching pending command');
    let content: string | undefined;
    if (payload?.type === 'delivery-content') {
      const descriptor = transferDescriptorSchema.parse(payload);
      if (!resolveContent)
        throw new Error('Transfer result requires its complete content');
      content = await resolveContent(result.resultSeq, descriptor);
      if (
        size(content) !== descriptor.length ||
        (await deliveryDigest(content)) !== descriptor.digest ||
        descriptor.contentId !== descriptor.digest
      )
        throw new Error('Transfer result content verification failed');
      payload = JSON.parse(content);
    }
    const original = JSON.parse(entry.body);
    if (
      (payload?.requestId !== undefined &&
        original.requestId !== undefined &&
        payload.requestId !== original.requestId) ||
      (payload?.id !== undefined &&
        original.id !== undefined &&
        payload.id !== original.id)
    )
      throw new Error('Result request identity changed');
    const record: StoredResult = {
      seq: result.resultSeq,
      command: result.seq,
      end: result.resultEnd,
      body: result.resultBody,
      digest: result.resultDigest,
      ...(content === undefined ? {} : { content }),
    };
    journal.buffer[record.seq] = record;
    if (
      Object.keys(journal.buffer).length > 100 ||
      Object.values(journal.buffer).reduce(
        (n, v) => n + size(v.body) + size(v.content ?? ''),
        0,
      ) >
        2 * 1024 * 1024
    )
      throw new Error('Result receive buffer is full');
    journal.cache.push(record);
    while (
      journal.cache.length > 64 ||
      journal.cache.reduce(
        (n, v) => n + size(v.body) + size(v.content ?? ''),
        0,
      ) >
        2 * 1024 * 1024
    )
      journal.cache.shift();
    entries = entries.filter((v) => v !== entry);
    completed.push({ body: entry.body, payload });
    while (journal.buffer[journal.received + 1]) {
      const next = journal.buffer[journal.received + 1];
      if (next.end !== journal.bytes + size(next.body))
        throw new Error('Result is not a continuous byte boundary');
      journal.received++;
      journal.bytes = next.end;
      delete journal.buffer[next.seq];
    }
  }
  return { journal, entries, completed };
}
