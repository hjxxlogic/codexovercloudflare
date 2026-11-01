import { historyReferenceSchema } from '../packages/protocol/src/index.ts';
import historyReferences from './history-reference-fixtures.json';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  emptyResults,
  receiveResults,
} from '../apps/web/src/delivery-results.ts';

const commands = [1, 2].map((seq) => ({
  seq,
  end: seq * 20,
  body: JSON.stringify({ requestId: 'command-' + seq }),
}));
function completion(command: number, resultSeq: number, prior = 0) {
  const resultBody = JSON.stringify({
    type: 'ack',
    requestId: 'command-' + command,
  });
  return {
    seq: command,
    resultSeq,
    resultEnd: prior + Buffer.byteLength(resultBody),
    resultBody,
    resultDigest: createHash('sha256').update(resultBody).digest('hex'),
    resultStream: 'receiver_r',
  };
}
const window = {
  stream: 'receiver',
  instance: 'journal',
  streamSerial: 1,
  creditGeneration: 'generation',
  received: 2,
  receivedBytes: 40,
  sent: 2,
  resultBytes: 1024,
  credit: 18,
  byteCredit: 2048,
};
it('acknowledges completion order independently of command order', async () => {
  const first = completion(2, 1),
    second = completion(1, 2, first.resultEnd);
  const a = await receiveResults(emptyResults(), commands, [first], window);
  expect(a.journal.received).toBe(1);
  expect(a.entries.map((v) => v.seq)).toEqual([1]);
  const b = await receiveResults(a.journal, a.entries, [second], window);
  expect(b.journal.received).toBe(2);
  expect(b.journal.bytes).toBe(second.resultEnd);
  expect(b.entries).toEqual([]);
});
it('preserves out-of-order results through restart without acknowledging a gap', async () => {
  const first = completion(2, 1),
    second = completion(1, 2, first.resultEnd);
  const a = await receiveResults(emptyResults(), commands, [second], window);
  expect(a.journal.received).toBe(0);
  expect(a.journal.bytes).toBe(0);
  expect(a.completed).toHaveLength(1);
  expect(a.journal.cache).toEqual([]);
  expect(Object.keys(a.journal.buffer)).toEqual(['2']);
  const saved = JSON.parse(JSON.stringify(a));
  const duplicate = await receiveResults(
    saved.journal,
    saved.entries,
    [second],
    window,
  );
  expect(duplicate.completed).toHaveLength(0);
  const b = await receiveResults(
    duplicate.journal,
    duplicate.entries,
    [first],
    window,
  );
  expect(b.journal.received).toBe(2);
  expect(b.journal.bytes).toBe(second.resultEnd);
  expect(b.journal.buffer).toEqual({});
  expect(b.journal.cache.map((v) => v.seq)).toEqual([1, 2]);
  console.info('delivery_acceptance', {
    scenario: 'result-gap-and-restart',
    endpoint: 'CW',
    gapsBeforeRecovery: second.resultSeq - a.journal.received - 1,
    bufferedResultsBeforeRecovery: Object.keys(a.journal.buffer).length,
    acknowledgedBeforeRecovery: a.journal.received,
    acknowledgedAfterRecovery: b.journal.received,
    confirmedResultBytes: b.journal.bytes,
  });
});
it('rejects corruption, identity conflicts and broken byte boundaries atomically', async () => {
  const first = completion(2, 1);
  const initial = emptyResults();
  await expect(
    receiveResults(
      initial,
      commands,
      [{ ...first, resultBody: 'corrupt' }],
      window,
    ),
  ).rejects.toThrow('digest');
  await expect(
    receiveResults(
      initial,
      commands,
      [{ ...first, resultEnd: first.resultEnd + 1 }],
      window,
    ),
  ).rejects.toThrow('byte boundary');
  expect(initial).toEqual(emptyResults());
  const accepted = await receiveResults(initial, commands, [first], window);
  await expect(
    receiveResults(
      accepted.journal,
      accepted.entries,
      [{ ...completion(1, 1) }],
      window,
    ),
  ).rejects.toThrow('identity');
  expect(accepted.entries.map((v) => v.seq)).toEqual([1]);
});
it('rejects a result for another stream or request without retiring its command', async () => {
  await expect(
    receiveResults(
      emptyResults(),
      commands,
      [{ ...completion(2, 1), resultStream: 'other_r' }],
      window,
    ),
  ).rejects.toThrow('published stream');
  await expect(
    receiveResults(
      emptyResults(),
      commands,
      [{ ...completion(2, 1), seq: 1 }],
      window,
    ),
  ).rejects.toThrow('request identity');
});
it('requires complete verified transfer content before retiring the command or acknowledging the result', async () => {
  const content = JSON.stringify({
    type: 'ack',
    requestId: 'command-1',
    text: '结果'.repeat(100000),
  });
  const digest = createHash('sha256').update(content).digest('hex');
  const descriptor = {
    type: 'delivery-content',
    retention: 'transfer',
    contentId: digest,
    revision: 1,
    length: Buffer.byteLength(content),
    digest,
  };
  const resultBody = JSON.stringify(descriptor);
  const result = {
    ...completion(1, 1),
    resultBody,
    resultEnd: Buffer.byteLength(resultBody),
    resultDigest: createHash('sha256').update(resultBody).digest('hex'),
  };
  const initial = emptyResults();
  await expect(
    receiveResults(initial, commands, [result], window),
  ).rejects.toThrow('complete content');
  await expect(
    receiveResults(initial, commands, [result], window, async () =>
      content.slice(0, -1),
    ),
  ).rejects.toThrow('verification');
  expect(initial.received).toBe(0);
  const accepted = await receiveResults(
    initial,
    commands,
    [result],
    window,
    async () => content,
  );
  expect(accepted.journal.received).toBe(1);
  expect(accepted.journal.bytes).toBe(result.resultEnd);
  expect(accepted.journal.cache[0].content).toBe(content);
  expect(accepted.completed[0].payload.text).toBe('结果'.repeat(100000));
});

it('shares immutable history reference validation with the native endpoint', () => {
  for (const fixture of historyReferences)
    expect(
      historyReferenceSchema.safeParse(fixture.input).success,
      fixture.name,
    ).toBe(!fixture.error);
});
it('commits a history reference and terminal result without reading temporary transfer content', async () => {
  const descriptor = historyReferences[0].input;
  const resultBody = JSON.stringify({
    type: 'ack',
    requestId: 'command-1',
    result: { turnId: 'original-turn', history: descriptor },
  });
  const frame = {
    ...completion(1, 1),
    resultBody,
    resultEnd: Buffer.byteLength(resultBody),
    resultDigest: createHash('sha256').update(resultBody).digest('hex'),
  };
  let reads = 0;
  const received = await receiveResults(
    emptyResults(),
    commands,
    [frame],
    window,
    async () => {
      reads++;
      throw new Error('History must not use transfer lifetime');
    },
  );
  expect(reads).toBe(0);
  expect(received.journal.received).toBe(1);
  expect(received.entries.map((entry) => entry.seq)).toEqual([2]);
  expect(JSON.parse(received.journal.cache[0].body).result.history).toEqual(
    descriptor,
  );
  expect(received.completed[0].payload.result.turnId).toBe('original-turn');
  const invalidBody = JSON.stringify({
    type: 'ack',
    requestId: 'command-1',
    result: { history: { ...descriptor, revision: -1 } },
  });
  await expect(
    receiveResults(
      emptyResults(),
      commands,
      [
        {
          ...frame,
          resultBody: invalidBody,
          resultEnd: Buffer.byteLength(invalidBody),
          resultDigest: createHash('sha256').update(invalidBody).digest('hex'),
        },
      ],
      window,
    ),
  ).rejects.toThrow();
});

it('compacts an earlier duplicated journal when its gap closes', async () => {
  const first = completion(2, 1);
  const second = completion(1, 2, first.resultEnd);
  const accepted = await receiveResults(
    emptyResults(),
    commands,
    [second],
    window,
  );
  const saved = JSON.parse(JSON.stringify(accepted));
  saved.journal.cache.push(saved.journal.buffer['2']);
  const recovered = await receiveResults(
    saved.journal,
    saved.entries,
    [first],
    window,
  );
  expect(recovered.journal.received).toBe(2);
  expect(recovered.journal.cache.map((v) => v.seq)).toEqual([1, 2]);
  expect(recovered.completed).toHaveLength(1);
});
