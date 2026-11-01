import { describe, expect, it } from 'vitest';
import fixtures from './protocol-fixtures.json';
import uploadFixtures from './upload-binding-fixtures.json';
import emailFixtures from './access-email-fixtures.json';
import operationFixtures from './operation-intent-fixtures.json';
import writeFixtures from './original-write-fixtures.json';
import allocationFixtures from './delivery-allocation-fixtures.json';
import {
  deliveryAllocationSchema,
  deliveryFrameSchema,
} from '../packages/protocol/src/delivery.ts';
import {
  agentConfigSchema,
  accessEmailsSchema,
  webCommandSchema,
  workspaceFileCommandSchema,
  operationIntentSchema,
  operationWrite,
  controlCommandSchema,
} from '../packages/protocol/src/index.ts';
describe('shared C++/Zod protocol examples', () => {
  it('requires the same original upload instance and complete checksum as native', () => {
    for (const fixture of uploadFixtures)
      expect(
        workspaceFileCommandSchema.safeParse(fixture.input).success,
        fixture.name,
      ).toBe(!fixture.error);
  });
  it('requires an original HTTP ledger only for the same writes as native', () => {
    for (const fixture of writeFixtures)
      expect(operationWrite(fixture.action, fixture.data)).toBe(fixture.write);
    expect(
      controlCommandSchema.safeParse({
        action: 'request',
        data: { requestId: 'old', mode: 'web' },
      }).success,
    ).toBe(false);
  });
  it('requires the same receiver allocation identity as native validation', () => {
    for (const fixture of allocationFixtures) {
      const parsed = deliveryAllocationSchema.safeParse(fixture.input);
      expect(parsed.success).toBe(!fixture.error);
      if (parsed.success) expect(parsed.data).toEqual(fixture.output);
    }
    const initial = {
      sessionId: 'host~session',
      mode: 'web',
      stream: 'stream',
      lane: 'normal',
      exchangeId: 'exchange',
      resultReceived: 0,
      resultBytes: 0,
    };
    expect(
      controlCommandSchema.safeParse({ action: 'delivery', data: initial })
        .success,
    ).toBe(true);
    for (const unsafe of [
      { resultReceived: 1 },
      { resultBytes: 1 },
      { seq: 1 },
      { contentSeq: 1, offset: 0 },
    ]) {
      expect(
        controlCommandSchema.safeParse({
          action: 'delivery',
          data: { ...initial, ...unsafe },
        }).success,
      ).toBe(false);
      expect(
        controlCommandSchema.safeParse({
          action: 'delivery',
          data: {
            ...initial,
            ...unsafe,
            instance: 'agent-storage',
            streamSerial: 1,
            creditGeneration: 'credit-generation',
          },
        }).success,
      ).toBe(true);
    }
    for (const type of [
      'delivery-command',
      'delivery-query',
      'delivery-content',
      'delivery-receipt',
    ]) {
      const frame = {
        type,
        stream: 'stream',
        lane: 'normal',
        instance: 'agent-storage',
        streamSerial: 1,
        creditGeneration: 'credit-generation',
        seq: 1,
        end: 10,
        body: '{}',
        received: 0,
        receivedBytes: 0,
        resultSeq: 1,
        offset: 0,
      };
      expect(deliveryFrameSchema.safeParse(frame).success).toBe(true);
      for (const field of ['instance', 'streamSerial', 'creditGeneration']) {
        const missing = { ...frame } as Record<string, unknown>;
        delete missing[field];
        expect(deliveryFrameSchema.safeParse(missing).success).toBe(false);
      }
    }
  });
  it('validates original operation identities and confirmations consistently with native', () => {
    for (const fixture of operationFixtures) {
      const result = operationIntentSchema.safeParse(fixture.input);
      expect(result.success).toBe(!fixture.error);
      if (result.success) expect(result.data).toEqual(fixture.output);
    }
  });
  for (const [index, fixture] of fixtures.entries())
    it(`normalizes or rejects example ${index}`, () => {
      const result = webCommandSchema.safeParse(fixture.input);
      if (fixture.error) expect(result.success).toBe(false);
      else {
        expect(result.success).toBe(true);
        if (result.success) expect(result.data).toEqual(fixture.output);
      }
    });
});
it('normalizes and validates Agent email access consistently with native configuration', () => {
  for (const fixture of emailFixtures) {
    const parsed = accessEmailsSchema.safeParse(fixture.input);
    expect(parsed.success).toBe(!fixture.error);
    if (parsed.success) expect(parsed.data).toEqual(fixture.output);
  }
  expect(
    accessEmailsSchema.safeParse(Array(21).fill('user@example.com')).success,
  ).toBe(true);
});
it('preserves update opt-out and validates the Codex proxy opt-in in Agent configuration', () => {
  const input = {
    hostId: 'test-host',
    token: 'x'.repeat(32),
    dataDir: '/tmp/test',
    projects: [{ id: 'project', name: 'Project', path: '/tmp/project' }],
    autoUpdate: false,
  };
  expect(agentConfigSchema.parse(input).autoUpdate).toBe(false);
  expect(agentConfigSchema.parse(input).codexUseProxy).toBe(false);
  expect(
    agentConfigSchema.parse({ ...input, codexUseProxy: true }).codexUseProxy,
  ).toBe(true);
  for (const value of ['true', 1, null])
    expect(
      agentConfigSchema.safeParse({ ...input, codexUseProxy: value }).success,
    ).toBe(false);
  expect(
    agentConfigSchema.safeParse({ ...input, autoUpdate: 'false' }).success,
  ).toBe(false);
});
