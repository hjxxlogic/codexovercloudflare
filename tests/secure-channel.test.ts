import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SecureChannel } from '../packages/channel/src/secure.ts';

async function pair(aBinding = 'binding', bBinding = aBinding) {
  const a = await SecureChannel.create(true, aBinding),
    b = await SecureChannel.create(false, bBinding);
  const ah = a.exchange(b.publicKey),
    bh = b.exchange(a.publicKey);
  a.accept(bh);
  b.accept(ah);
  return { a, b };
}
describe('endpoint encrypted stream', () => {
  it('roundtrips Unicode bidirectionally and hides business contents', async () => {
    const { a, b } = await pair();
    try {
      const plain = JSON.stringify({
        method: 'sensitive-method',
        text: '中文 🔐',
        path: '/private',
      });
      const cipher = a.seal(plain);
      expect(cipher).not.toContain('private');
      expect(b.open(cipher)).toBe(plain);
      expect(a.open(b.seal('reply'))).toBe('reply');
    } finally {
      a.close();
      b.close();
    }
  });
  it.each(['replay', 'tamper', 'order', 'binding', 'reconnect'])(
    'rejects %s and poisons the receiving link',
    async (kind) => {
      const { a, b } = await pair(
        'binding',
        kind === 'binding' ? 'other' : 'binding',
      );
      try {
        let cipher = a.seal('first');
        if (kind === 'replay') {
          b.open(cipher);
        }
        if (kind === 'tamper') {
          cipher = (cipher[0] === 'A' ? 'B' : 'A') + cipher.slice(1);
        }
        if (kind === 'order') {
          cipher = a.seal('second');
        }
        if (kind === 'reconnect') {
          const other = await pair();
          try {
            cipher = other.a.seal('old link');
          } finally {
            other.a.close();
            other.b.close();
          }
        }
        expect(() => b.open(cipher)).toThrow('SECURE_CHANNEL_FAILED');
        expect(b.ready).toBe(false);
        expect(() => b.open(a.seal('late'))).toThrow();
      } finally {
        a.close();
        b.close();
      }
    },
  );
  it('rejects low order peer keys, malformed headers and oversized records', async () => {
    const a = await SecureChannel.create(true, 'binding');
    expect(() =>
      a.exchange('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    ).toThrow();
    a.close();
    const { a: b, b: c } = await pair();
    try {
      expect(() => b.seal('x'.repeat(128 * 1024 + 1))).toThrow();
    } finally {
      b.close();
      c.close();
    }
  });
  it('interoperates with the real C++ libsodium endpoint', async () => {
    const child = spawn('./build/coc-channel-tests', ['--peer'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    const readers: ((line: string) => void)[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const reader = readers.shift();
      if (reader) reader(line);
      else lines.push(line);
    });
    const read = () =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Native peer timeout')),
          3000,
        );
        const receive = (line: string) => {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        };
        const line = lines.shift();
        if (line) receive(line);
        else readers.push(receive);
      });
    const call = async (value: unknown) => {
      child.stdin.write(JSON.stringify(value) + '\n');
      return read();
    };
    const a = await SecureChannel.create(true, 'coc-channel-1:interop');
    try {
      const hello = await read();
      const header = a.exchange(hello.key);
      const peer = await call({ key: a.publicKey });
      a.accept(peer.header);
      expect((await call({ header })).ready).toBe(true);
      const cipher = a.seal('interop 中文');
      expect((await call({ cipher })).plain).toBe('interop 中文');
      expect(a.open((await call({ plain: 'native reply' })).cipher)).toBe(
        'native reply',
      );
      expect((await call({ cipher })).failed).toBe(true);
    } finally {
      a.close();
      rl.close();
      child.kill();
    }
  });
});
