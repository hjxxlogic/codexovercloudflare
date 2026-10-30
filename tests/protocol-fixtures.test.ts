import { describe, expect, it } from 'vitest';
import fixtures from './protocol-fixtures.json';
import emailFixtures from './access-email-fixtures.json';
import {
  agentConfigSchema,
  accessEmailsSchema,
  webCommandSchema,
} from '../packages/protocol/src/index.ts';
describe('shared C++/Zod protocol examples', () => {
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
it('preserves the automatic-update opt-out in parsed Agent configuration', () => {
  const input = {
    hostId: 'test-host',
    token: 'x'.repeat(32),
    dataDir: '/tmp/test',
    projects: [{ id: 'project', name: 'Project', path: '/tmp/project' }],
    autoUpdate: false,
  };
  expect(agentConfigSchema.parse(input).autoUpdate).toBe(false);
  expect(
    agentConfigSchema.safeParse({ ...input, autoUpdate: 'false' }).success,
  ).toBe(false);
});
