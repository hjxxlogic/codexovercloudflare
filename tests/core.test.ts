import { describe, expect, it } from 'vitest';
import {
  MAX_FRAME,
  parseFrame,
  relayUrl,
  webCommandSchema,
} from '../packages/protocol/src/index.ts';
describe('protocol boundaries', () => {
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
  it('rejects oversized frames and unknown web commands', () => {
    expect(() => parseFrame(' '.repeat(MAX_FRAME + 1))).toThrow();
    expect(() =>
      webCommandSchema.parse({ action: 'exec', command: 'pwd' }),
    ).toThrow();
  });
});
