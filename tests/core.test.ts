import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME,
  accessEmailsSchema,
  agentConfigSchema,
  historyCommandSchema,
  parseFrame,
  relayUrl,
  webCommandSchema,
  wakeUrlSchema,
} from '../packages/protocol/src/index.ts';
import wakeUrls from './wake-url-fixtures.json';
describe('protocol boundaries', () => {
  it('accepts more than twenty projects and associated emails', () => {
    const emails = Array.from({ length: 25 }, (_, i) => `user${i}@example.com`);
    expect(accessEmailsSchema.parse(emails)).toHaveLength(25);
    expect(
      agentConfigSchema.parse({
        hostId: 'agent',
        token: 'x'.repeat(24),
        dataDir: '/tmp/state',
        projects: emails.map((_, i) => ({
          id: `p${i}`,
          name: `P${i}`,
          path: `/tmp/p${i}`,
        })),
        accessEmails: emails,
      }).projects,
    ).toHaveLength(25);
  });
  it('validates wake URLs with the native shared fixtures', () => {
    for (const fixture of wakeUrls)
      expect(
        wakeUrlSchema.safeParse(fixture.value).success,
        String(fixture.value),
      ).toBe(fixture.valid);
    expect(
      wakeUrlSchema.safeParse('https://wake.example/' + 'x'.repeat(2048))
        .success,
    ).toBe(false);
  });
  it('allows TLS and loopback only', () => {
    expect(relayUrl('https://r.xlogic.cc')).toBe('https://r.xlogic.cc');
    expect(relayUrl('http://127.0.0.1:8787')).toContain('8787');
    for (const u of [
      'http://example.com',
      'https://u:p@example.com',
      'https://example.com/path',
    ])
      expect(() => relayUrl(u)).toThrow();
  });
  it('bounds history cursors and accepts one read direction only', () => {
    expect(
      historyCommandSchema.parse({
        operation: 'page',
        requestId: 'read',
        before: -20,
      }),
    ).toMatchObject({ before: -20 });
    for (const data of [
      { operation: 'page', before: 2, after: 3 },
      { operation: 'page', after: -1 },
      { operation: 'page', before: Number.MAX_SAFE_INTEGER + 1 },
      { operation: 'content', seq: 2, offset: -1 },
      { operation: 'prompt' },
    ])
      expect(() =>
        historyCommandSchema.parse({ ...data, requestId: 'read' }),
      ).toThrow();
  });
  it('rejects oversized frames and unknown web commands', () => {
    expect(() => parseFrame(' '.repeat(MAX_FRAME + 1))).toThrow();
    expect(() =>
      webCommandSchema.parse({ action: 'exec', command: 'pwd' }),
    ).toThrow();
  });
});
