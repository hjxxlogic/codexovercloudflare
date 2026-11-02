// A snapshot can confirm completion before the durable prompt ACK arrives.
// Only a snapshot at/after this prompt's recorded event can confirm it idle.
export function promptAcknowledged(
  progress: 'sending' | 'waiting' | 'replying' | undefined,
  queued: boolean,
  running: boolean,
  stateSeq: number,
  promptSeq: unknown,
): 'sending' | 'waiting' | 'replying' | undefined {
  if (
    queued ||
    (!running &&
      typeof promptSeq === 'number' &&
      promptSeq > 0 &&
      stateSeq >= promptSeq)
  )
    return undefined;
  return progress === 'sending' ? 'waiting' : progress;
}
