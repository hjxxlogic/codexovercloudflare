import { AppError } from '../../../packages/protocol/src/admission.ts';

// Retained in the same object until an operator exports and reconciles it.
// Backups and progress are outside the legacy key range scanned by this pass.
const prefix = '~opaque-v1:';
export async function migrateHost(storage: DurableObjectStorage) {
  if ((await storage.get('channelVersion')) === 1) return;
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
          key.startsWith('permission-operation:') &&
          (value as any)?.state !== 'completed'
        )
          throw new AppError(
            'MIGRATION_PENDING',
            'Reconcile legacy permission operations before upgrading',
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
