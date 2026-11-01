import { expect, it } from 'vitest';
import fixtures from './recovery-delay-fixtures.json';
import { recoveryDelay } from '../apps/web/src/recovery.ts';
it('shares fast/slow recovery boundaries with native without retry counter overflow', () => {
  for (const sample of fixtures) {
    let calls = 0;
    const delay = recoveryDelay(sample.attempt, sample.fast, () => {
      calls++;
      return (sample.jitter + 0.25) / 30001;
    });
    expect(delay).toBe(sample.delay);
    expect(calls).toBe(sample.attempt < sample.fast ? 0 : 1);
  }
});
