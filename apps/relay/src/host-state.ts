import { AppError } from '../../../packages/protocol/src/index.ts';
import { json, type Auth, type Env } from './common.ts';
import { D1State, d1Enabled } from './state.ts';
import type { HostLocation } from './host-lifecycle.ts';

// Only permission handshakes have cloud receipts. Business correlation and
// payloads are memory-only and can never be reconstructed from D1.
export async function d1PermissionReceipt(
  env: Env,
  hostId: string,
  id: string,
  auth: Auth,
  acknowledge: boolean,
): Promise<Response | undefined> {
  if (!d1Enabled(env)) return;
  const state = new D1State(env.STATE_DB, 'host:' + hostId);
  const key = 'permission-operation:' + id;
  const snapshot = await state.getMany([
    '@migrated',
    '@location',
    'presence',
    key,
  ]);
  if (!snapshot.has('@migrated') || snapshot.get('@location')?.owner === 'do')
    return;
  if (acknowledge && snapshot.get('presence')?.connected) return;
  if (!acknowledge) {
    const operation = decode(snapshot.get(key));
    return json({
      state: operation.state,
      result: operation.result,
      error: operation.error,
    });
  }
  return state.transaction(async (tx) => {
    if ((await tx.get<HostLocation>('@location'))?.owner === 'do') return;
    const operation = decode(await tx.get<any>(key));
    if (operation.state === 'completed')
      await tx.delete([
        key,
        ...(operation.wire ? ['permission-wire:' + operation.wire] : []),
        `due:${String(operation.expires).padStart(16, '0')}:${key}`,
      ]);
    return json({ ok: true });
  });

  function decode(operation: any) {
    if (!operation || operation.auth.hash !== auth.hash)
      throw new AppError('NOT_FOUND', 'Unknown permission transaction', 404);
    if (operation.expires <= Date.now())
      throw new AppError(
        'RESULT_UNKNOWN',
        'Permission transaction expired; request a new ticket',
        409,
      );
    return operation;
  }
}

// No Host DO is woken for offline expiry. A bounded hourly sweep handles rows
// whose local alarms were removed by deleteAll; live scopes keep their alarms.
export async function collectIdleState(env: Env) {
  if (!d1Enabled(env)) return;
  const now = Date.now();
  const scopes = await env.STATE_DB.prepare(
    "SELECT d.scope FROM relay_state d WHERE d.key >= ? AND d.key < ? AND d.scope LIKE 'host:%' AND json_extract((SELECT p.value FROM relay_state p WHERE p.scope = d.scope AND p.key = 'presence'), '$.connected') = 0 AND COALESCE(json_extract((SELECT l.value FROM relay_state l WHERE l.scope = d.scope AND l.key = '@location'), '$.owner'), 'd1') = 'd1' GROUP BY d.scope ORDER BY MIN(d.key) LIMIT 4",
  )
    .bind('due:', `due:${String(now + 1).padStart(16, '0')}:`)
    .all<{ scope: string }>();
  for (const { scope } of scopes.results) {
    const state = new D1State(env.STATE_DB, scope);
    await state.transaction(async (tx) => {
      if ((await tx.get<HostLocation>('@location'))?.owner === 'do') return;
      if ((await tx.get<any>('presence'))?.connected !== 0) return;
      const due = await tx.list<{ key: string; at: number }>({
        prefix: 'due:',
        end: `due:${String(now + 1).padStart(16, '0')}:`,
        limit: 2,
      });
      for (const [index, { key, at }] of due) {
        if (at > now) continue;
        const value = await tx.get<any>(key);
        if (value?.expires <= now) {
          const keys = [
            key,
            ...(key.startsWith('permission-operation:') && value.wire
              ? ['permission-wire:' + value.wire]
              : []),
          ];
          if (key.startsWith('ticket:') && value.epoch) {
            const lease = await tx.get<any>('lease:' + value.sessionId);
            if (lease?.epoch === value.epoch)
              await tx.put('lease:' + value.sessionId, {
                ...lease,
                active: false,
              });
          }
          await tx.delete(keys);
        }
        await tx.delete(index);
      }
    });
  }
}
