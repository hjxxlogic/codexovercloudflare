import { expect, test } from 'vitest';
import { historyStorageSchema } from '../packages/protocol/src/index.ts';
import fixtures from './history-policy-fixtures.json';
for (const fixture of fixtures) {
  test('history policy: ' + fixture.name, () => {
    expect(historyStorageSchema.safeParse(fixture.input).success).toBe(
      fixture.valid,
    );
  });
}
