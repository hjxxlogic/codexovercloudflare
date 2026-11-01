// Runtime scheduling only: durable pending work and authorization decide whether
// to retry. A restart may reset attempts but must retain the original identity.
export function recoveryDelay(
  attempt: number,
  fastAttempts = 3,
  random: () => number = Math.random,
): number {
  return attempt < fastAttempts
    ? Math.min(10000, 1000 * 2 ** attempt)
    : 30000 + Math.floor(random() * 30001);
}
