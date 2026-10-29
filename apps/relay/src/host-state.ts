import { AppError } from '../../../packages/protocol/src/index.ts';
import { json, type Auth, type Env } from './common.ts';
import { D1State, d1Enabled } from './state.ts';
import type { HostLocation } from './host-lifecycle.ts';

// Reads use one SQL snapshot; acknowledgements use CAS so a concurrent
// completion cannot be erased. Unrelated live writes must not starve polling.
export async function d1Receipt(
  env: Env,
  hostId: string,
  id: string,
  auth: Auth,
  acknowledge: boolean,
): Promise<Response | undefined> {
  if (!d1Enabled(env)) return;
  const state = new D1State(env.STATE_DB, 'host:' + hostId);
  const metadata = await state.getMany(['@migrated', '@location', 'presence']);
  if (!metadata.has('@migrated') || metadata.get('@location')?.owner === 'do')
    return;
  // A live Host owns the transaction queue. Route acknowledgements there so
  // Workers cannot repeatedly invalidate a handshake's scope revision.
  if (acknowledge && metadata.get('presence')?.connected) return;
  if (!acknowledge) {
    const prefix = `part:${id}:`;
    const rows = await env.STATE_DB.prepare(
      "SELECT key, value FROM relay_state WHERE scope = ? AND (key IN (?, '@location') OR (key >= ? AND key < ?)) ORDER BY key COLLATE BINARY",
    )
      .bind('host:' + hostId, 'operation:' + id, prefix, prefix + '\uffff')
      .all<{ key: string; value: string }>();
    const values = new Map(
      rows.results.map((row) => [row.key, JSON.parse(row.value)]),
    );
    // Activation may have claimed ownership since the metadata read. Check
    // routing in the SAME snapshot as the receipt, never return an old copy.
    if (values.get('@location')?.owner === 'do') return;
    const operation = decodeReceipt(values.get('operation:' + id), values);
    return json({
      state: operation.state,
      result: operation.result,
      error: operation.error,
    });
  }
  return state.transaction(async (tx) => {
    if ((await tx.get<HostLocation>('@location'))?.owner === 'do') return;
    const index = await tx.get<any>('operation:' + id);
    const parts = index?.parts
      ? await tx.list<string>({ prefix: `part:${id}:` })
      : new Map<string, string>();
    const operation = decodeReceipt(index, parts);
    if (operation.state === 'completed')
      await tx.delete([
        'operation:' + id,
        ...parts.keys(),
        ...(index.wire ? ['wire:' + index.wire] : []),
      ]);
    return json({ ok: true });
  });

  function decodeReceipt(index: any, parts: Map<string, any>) {
    if (!index || index.auth.hash !== auth.hash)
      throw new AppError('NOT_FOUND', 'Unknown operation', 404);
    if (index.expires <= Date.now())
      throw new AppError(
        'RESULT_UNKNOWN',
        'Result receipt expired; query original request identity',
        409,
      );
    let operation = index;
    if (index.parts) {
      const values = Array.from({ length: index.parts }, (_, i) =>
        parts.get(`part:${id}:${i}`),
      );
      if (values.some((part) => part === undefined))
        throw new AppError(
          'RESULT_UNKNOWN',
          'Incomplete operation receipt',
          409,
        );
      operation = JSON.parse(values.join(''));
    }
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
            ...(value.wire ? ['wire:' + value.wire] : []),
            ...Array.from(
              { length: value.parts || 0 },
              (_, i) => `part:${key.slice(10)}:${i}`,
            ),
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
