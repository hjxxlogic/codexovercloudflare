import { expect, it } from 'vitest';
import { promptAcknowledged } from '../apps/web/src/prompt-state.ts';
it('does not restore a waiting indicator when completion snapshot precedes the prompt ACK', () => {
  expect(promptAcknowledged('sending', false, false, 103, 100)).toBeUndefined();
  expect(promptAcknowledged('waiting', false, false, 103, 100)).toBeUndefined();
});
it('does not treat an idle snapshot from before this prompt as its completion', () => {
  expect(promptAcknowledged('sending', false, false, 99, 100)).toBe('waiting');
  expect(promptAcknowledged('sending', false, false, 103, undefined)).toBe(
    'waiting',
  );
});
it('retains active task progress and separates external queue acceptance', () => {
  expect(promptAcknowledged('sending', false, true, 103, 100)).toBe('waiting');
  expect(promptAcknowledged('replying', false, true, 103, 100)).toBe(
    'replying',
  );
  expect(promptAcknowledged('sending', true, false, 99, 100)).toBeUndefined();
});
