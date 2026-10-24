import { describe, expect, it } from 'vitest';
import fixtures from './protocol-fixtures.json';
import { webCommandSchema } from '../packages/protocol/src/index.ts';
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
