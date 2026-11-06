import { AppError } from '../../../packages/protocol/src/admission.ts';

// Retained in the same object until an operator exports and reconciles it.
// Backups and progress are outside the legacy key range scanned by this pass.
const prefix = '~opaque-v1:';
// Operator reconciliation is compare-and-swap and preserves the original lease.
// Permission operations are deliberately excluded: their effects need separate review.
export async function retireLegacyLeases(
  storage: DurableObjectStorage,
  hostId: string,
  entries: unknown,
) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 64)
    throw new AppError('INVALID_INPUT', 'Expected 1–64 reviewed leases', 400);
  await storage.transaction(async (tx) => {
    if ((await tx.get('channelVersion')) !== undefined)
      throw new AppError('CONFLICT', 'Migration already completed', 409);
    for (const entry of entries) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        !entry[0].startsWith('lease:' + hostId + '~')
      )
        throw new AppError(
          'INVALID_INPUT',
          'Only this host’s legacy leases may be retired',
          400,
        );
      const current = await tx.get(entry[0]);
      if (!current || JSON.stringify(current) !== JSON.stringify(entry[1]))
        throw new AppError(
          'CONFLICT',
          'Legacy lease changed; review it again',
          409,
        );
    }
    for (const [key, value] of entries) {
      const backup = prefix + 'reconciled:' + key;
      if ((await tx.get(backup)) === undefined) await tx.put(backup, value);
      const retired = { ...value, active: false };
      delete retired.pending;
      await tx.put(key, retired);
    }
  });
}
export async function migrateHost(storage: DurableObjectStorage) {
  const version = await storage.get('channelVersion');
  if (version === 1) return;
  if (version !== undefined)
    throw new AppError(
      'MIGRATION_FAILED',
      'Unknown relay storage version',
      503,
    );
  for (;;) {
    const done = await storage.transaction(async (tx) => {
      const cursor = (await tx.get<string>(prefix + 'cursor')) || '';
      const page = await tx.list({
        startAfter: cursor,
        end: prefix,
        limit: 64,
      });
      if (!page.size) {
        await tx.put('channelVersion', 1);
        await tx.put(prefix + 'complete', true);
        await tx.deleteAlarm();
        return true;
      }
      for (const [key, value] of page) {
        // Unknown pending permission side effects require explicit reconciliation.
        // Fail before touching the batch. Registry invalidations stay in RegistryDO.
        if (
          (key.startsWith('permission-operation:') &&
            (value as any)?.state !== 'completed') ||
          (key.startsWith('lease:') &&
            ((value as any)?.active === true || (value as any)?.pending))
        )
          throw new AppError(
            'MIGRATION_PENDING',
            'Retire legacy controllers and reconcile permission operations before upgrading',
            503,
          );
      }
      for (const [key, value] of page) {
        const backup = prefix + 'backup:' + key;
        await tx.put(backup, value);
        if (JSON.stringify(await tx.get(backup)) !== JSON.stringify(value))
          throw new AppError(
            'MIGRATION_FAILED',
            'Legacy snapshot verification failed',
            503,
          );
        if (key !== 'wakeUntil') await tx.delete(key);
      }
      await tx.put(prefix + 'cursor', [...page.keys()].at(-1)!);
      return false;
    });
    if (done) return;
  }
}
