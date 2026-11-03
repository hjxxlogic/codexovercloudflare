import { retire } from '../apps/relay/src/connections.ts';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './helpers/do-state.ts';
import uploadFixtures from './upload-binding-fixtures.json';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: unknown,
    ) {
      ctx.getWebSockets ??= () => [];
      ctx.waitUntil ??= () => {};
    }
  },
}));
vi.mock('../apps/relay/src/common.ts', async (original) => ({
  ...(await original<typeof import('../apps/relay/src/common.ts')>()),
  registryCall: vi.fn(),
}));
import { HostRelayDO } from '../apps/relay/src/host.ts';
import { registryCall, failure, hostStatus } from '../apps/relay/src/common.ts';
import { AppError, operationWrite } from '../packages/protocol/src/index.ts';
const auth = {
  hash: 'a'.repeat(64),
  role: 'web',
  hostId: 'host',
  expires: Number.MAX_SAFE_INTEGER,
  version: 2,
  name: 'test',
  created: 0,
};
function socket(initial: any) {
  let attachment = {
    policy: createHash('sha256')
      .update(JSON.stringify([null, null, null, null, null]))
      .digest('hex'),
    ...structuredClone(initial),
  };
  return {
    readyState: 1,
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: (a: any) => {
      attachment = structuredClone(a);
    },
    send: vi.fn(),
    close: vi.fn(),
  };
}
function harness() {
  const storage = new MemoryStorage();
  storage.values.set('agentEpoch', 1);
  const agent = socket({
    id: 'agent',
    role: 'agent',
    auth: { ...auth, role: 'agent', hash: 'agent' },
    epoch: 1,
    protocol: 1,
    deliveryVersion: 2,
    deliveryInstance: 'test-agent-store',
    deadline: Number.MAX_SAFE_INTEGER,
  });
  const sockets = [agent];
  const waiting: Promise<unknown>[] = [];
  const ctx = {
    storage,
    getWebSockets: (tag?: string) =>
      sockets.filter(
        (s) =>
          !tag ||
          (tag === 'agent'
            ? s.deserializeAttachment().role === 'agent'
            : tag === 'session:' + s.deserializeAttachment().sessionId),
      ),
    waitUntil: (p: Promise<unknown>) => waiting.push(p),
  };
  const create = () =>
    new HostRelayDO(ctx as unknown as DurableObjectState, {} as never);
  let relay = create();
  const headers = {
    'x-auth': encodeURIComponent(JSON.stringify(auth)),
    'x-host': 'host',
    'x-coc-async': '1',
    'x-coc-delivery': '2',
  };
  const start = async (
    action = 'projects',
    data: any = {},
    extraHeaders: Record<string, string> = {},
  ) => {
    const response = await relay.fetch(
      new Request('https://internal/control', {
        method: 'POST',
        headers: {
          ...headers,
          ...(!operationWrite(action, data) || extraHeaders['x-coc-legacy-test']
            ? {}
            : {
                'idempotency-key':
                  data.requestId || data.key || crypto.randomUUID(),
                'x-coc-operation-instance': 'test-agent-store',
              }),
          ...extraHeaders,
        },
        body: JSON.stringify({ action, data }),
      }),
    );
    return { response, data: (await response.json()) as any };
  };
  const read = async (id: string, as = auth) => {
    const response = await relay.fetch(
      new Request('https://internal/operation/' + id, {
        headers: {
          ...headers,
          'x-auth': encodeURIComponent(JSON.stringify(as)),
        },
      }),
    );
    return { response, data: (await response.json()) as any };
  };
  const reply = async (
    frame: any,
    data: any,
    error?: any,
    ...receipt: [any?]
  ) =>
    relay.webSocketMessage(
      agent as unknown as WebSocket,
      JSON.stringify({
        v: 1,
        type: 'result',
        requestId: frame.requestId,
        ...(error ? { error } : { data }),
        ...((receipt.length ? receipt[0] : frame.intent)
          ? { intent: receipt.length ? receipt[0] : frame.intent }
          : {}),
      }),
    );
  const frames = () => agent.send.mock.calls.map(([raw]) => JSON.parse(raw));
  return {
    storage,
    agent,
    sockets,
    ctx,
    waiting,
    start,
    read,
    reply,
    frames,
    get relay() {
      return relay;
    },
    recreate() {
      relay = create();
    },
  };
}
beforeEach(() => {
  vi.mocked(registryCall)
    .mockReset()
    .mockResolvedValue({ expires: Number.MAX_SAFE_INTEGER });
});
afterEach(() => vi.useRealTimers());
it('rejects incomplete upload bindings and checksums before forwarding or durable cloud writes', async () => {
  const h = harness();
  const writes = vi.spyOn(h.storage, 'put');
  for (const fixture of uploadFixtures.filter((entry) => entry.error)) {
    const rejected = await h.start('files', {
      ...fixture.input,
      projectId: 'demo',
      owner: 'a'.repeat(64),
    });
    const result = rejected.data.operationId
      ? (await h.read(rejected.data.operationId)).data
      : rejected.data;
    expect(result.error.code, fixture.name).toBe('INVALID_REQUEST');
  }
  expect(h.agent.send).not.toHaveBeenCalled();
  expect(writes).not.toHaveBeenCalled();
});
describe('mailbox session identity', () => {
  it('derives identity from authenticated credentials and filters older Agent results', async () => {
    const h = harness();
    const headers = {
      'x-auth': encodeURIComponent(
        JSON.stringify({ ...auth, accountId: 'account-a' }),
      ),
    };
    const started = await h.start(
      'list',
      { mine: true, paged: true, cwAccountId: 'account-b' },
      headers,
    );
    const frame = h.frames().at(-1);
    expect(frame.data.cwAccountId).toBe('account-a');
    await h.reply(frame, {
      data: [
        { id: 'host~mine', cwAccountId: 'account-a' },
        { id: 'host~other', cwAccountId: 'account-b' },
        { id: 'host~legacy' },
      ],
      nextCursor: null,
    });
    const result = await h.read(started.data.operationId);
    expect(result.data.result.data.map((s: any) => s.id)).toEqual([
      'host~mine',
    ]);
  });
  it('rejects a mailbox listing without verified account identity', async () => {
    const h = harness();
    const started = await h.start('list', { mine: true });
    const result = await h.read(started.data.operationId);
    expect(result.data.error.code).toBe('FORBIDDEN');
    expect(h.frames()).toEqual([]);
  });
  it('ignores client supplied mailbox identity on session creation', async () => {
    const h = harness();
    await h.start('create', {
      projectId: 'demo',
      mode: 'web',
      cwAccountId: 'forged',
    });
    expect(h.frames().at(-1).data.cwAccountId).toBe('');
  });
});
describe('recoverable asynchronous controls', () => {
  it('uses the newest Agent epoch while the replaced socket still reports OPEN', async () => {
    const h = harness();
    const next = socket({
      ...h.agent.deserializeAttachment(),
      id: 'new-agent',
      epoch: 2,
    });
    h.sockets.push(next);
    h.storage.values.set('agentEpoch', 2);
    retire(h.agent as unknown as WebSocket, 1012, 'Agent reconnected');
    expect(h.agent.readyState).toBe(1);
    const first = await h.start();
    expect(first.response.status).toBe(202);
    expect(h.agent.send).not.toHaveBeenCalled();
    expect(next.send).toHaveBeenCalled();
    h.recreate();
    expect(h.relay.agent()).toBe(next);
    next.readyState = 3;
    const refused = await h.start();
    const result = refused.data.operationId
      ? (await h.read(refused.data.operationId)).data
      : refused.data;
    expect(result.error.code).toBe('HOST_OFFLINE');
    expect(h.agent.send).not.toHaveBeenCalled();
  });
  it('keeps original write forwarding in memory and binds receipts to authenticated intent across reconstruction', async () => {
    const h = harness();
    const client = { ...auth, hash: 'a'.repeat(64) };
    const instance = 'persistent-agent-store';
    h.agent.serializeAttachment({
      ...h.agent.deserializeAttachment(),
      deliveryInstance: instance,
    });
    const headers = {
      'x-auth': encodeURIComponent(JSON.stringify(client)),
      'idempotency-key': 'original-create',
      'x-coc-operation-instance': instance,
    };
    const writes = vi.spyOn(h.storage, 'put');
    const input = { key: 'create', projectId: 'project', mode: 'web' };
    const first = await h.start('create', input, headers);
    expect(first.data.operationId).toMatch(/^delivery_/);
    const original = h.frames()[0];
    expect(original.intent).toEqual({
      owner: client.hash,
      requestId: 'original-create',
      instance,
    });
    h.recreate();
    expect((await h.read(first.data.operationId, client)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
    const retry = await h.start('create', input, headers);
    const repeated = h.frames()[1];
    expect(repeated.intent).toEqual(original.intent);
    expect(repeated.requestId).not.toBe(original.requestId);
    await h.reply(original, { id: 'host~late' }, undefined, original.intent);
    expect((await h.read(retry.data.operationId, client)).data.state).toBe(
      'pending',
    );
    await h.reply(
      repeated,
      { id: 'host~original' },
      undefined,
      repeated.intent,
    );
    expect((await h.read(retry.data.operationId, client)).data).toEqual({
      state: 'completed',
      result: { id: 'host~original' },
      intent: original.intent,
    });
    expect(writes).not.toHaveBeenCalled();
    const ack = await h.start('create', input, {
      ...headers,
      'x-coc-operation-ack': '1',
    });
    const confirmation = h.frames().at(-1);
    expect(confirmation.intent).toEqual({ ...original.intent, ack: true });
    await h.reply(
      confirmation,
      { confirmed: true },
      undefined,
      confirmation.intent,
    );
    expect((await h.read(ack.data.operationId, client)).data.intent.ack).toBe(
      true,
    );
    expect(writes).not.toHaveBeenCalled();
  });
  it.each([
    ['create', { projectId: 'demo', mode: 'web' }],
    ['stop', { sessionId: 'host~session' }],
    [
      'queue',
      {
        sessionId: 'host~session',
        mode: 'web',
        requestId: 'old-queue',
        text: 'must not execute',
      },
    ],
    [
      'answer',
      {
        sessionId: 'host~session',
        mode: 'web',
        requestId: 'old-answer',
        approvalId: 'old',
        runtimeId: 'old',
        approvalVersion: 'old',
        allow: true,
      },
    ],
    [
      'files',
      {
        projectId: 'demo',
        owner: 'a'.repeat(64),
        operation: 'begin',
        uploadId: 'old',
        agentInstance: 'test-agent-store',
        sha256: 'a'.repeat(64),
        path: 'old.txt',
        size: 0,
      },
    ],
    [
      'files',
      {
        projectId: 'demo',
        owner: 'a'.repeat(64),
        operation: 'finish',
        uploadId: 'old',
        agentInstance: 'test-agent-store',
        sha256: 'a'.repeat(64),
      },
    ],
  ])(
    'rejects unbound legacy %s writes before forwarding a mutation',
    async (action, data) => {
      const h = harness();
      h.storage.values.set('session-mode:host~session', 'web');
      const writes = vi.spyOn(h.storage, 'put');
      const original = await h.start(action, data, {
        'x-coc-legacy-test': '1',
      });
      if (h.frames()[0]?.action === 'get')
        await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
      expect((await h.read(original.data.operationId)).data.error.code).toBe(
        'UPGRADE_REQUIRED',
      );
      expect(h.frames().every((frame) => frame.action === 'get')).toBe(true);
      expect(writes).not.toHaveBeenCalled();
    },
  );
  it('refuses the removed request lookup without forwarding to the Agent', async () => {
    const h = harness();
    const old = await h.start('request', {
      requestId: 'original',
      mode: 'web',
    });
    expect((await h.read(old.data.operationId)).data.error.code).toBe(
      'INVALID_REQUEST',
    );
    expect(h.agent.send).not.toHaveBeenCalled();
  });
  it('never grants a durable write receipt without a matching endpoint identity', async () => {
    const h = harness();
    h.agent.serializeAttachment({
      ...h.agent.deserializeAttachment(),
      deliveryInstance: 'agent-store',
    });
    const client = { ...auth, hash: 'a'.repeat(64) };
    const headers = {
      'x-auth': encodeURIComponent(JSON.stringify(client)),
      'idempotency-key': 'original',
      'x-coc-operation-instance': 'agent-store',
    };
    const input = { key: 'create', projectId: 'project', mode: 'web' };
    for (const receipt of [
      undefined,
      { owner: 'b'.repeat(64), requestId: 'original', instance: 'agent-store' },
    ]) {
      const started = await h.start('create', input, headers);
      await h.reply(
        h.frames().at(-1),
        { id: 'host~session' },
        undefined,
        receipt,
      );
      const result = (await h.read(started.data.operationId, client)).data;
      expect(result.error.code).toBe('RESULT_UNKNOWN');
      expect(result.intent).toBeUndefined();
      expect(result.result).toBeUndefined();
    }
    const before = h.frames().length;
    const wrong = await h.start('create', input, {
      ...headers,
      'x-coc-operation-instance': 'replacement-store',
    });
    expect((await h.read(wrong.data.operationId, client)).data.error.code).toBe(
      'DELIVERY_STATE_MISMATCH',
    );
    expect(h.frames()).toHaveLength(before);
  });
  it('checks session mode before forwarding an original stop or its confirmation', async () => {
    const h = harness();
    h.agent.serializeAttachment({
      ...h.agent.deserializeAttachment(),
      deliveryInstance: 'agent-store',
    });
    h.storage.values.set('session-mode:host~session', 'web');
    const client = { ...auth, hash: 'a'.repeat(64) };
    const headers = {
      'x-auth': encodeURIComponent(JSON.stringify(client)),
      'idempotency-key': 'original-stop',
      'x-coc-operation-instance': 'agent-store',
      'x-coc-operation-ack': '1',
    };
    const started = await h.start(
      'stop',
      { sessionId: 'host~session' },
      headers,
    );
    expect(h.frames()[0].action).toBe('get');
    expect(h.frames()[0].intent).toBeUndefined();
    await h.reply(h.frames()[0], { mode: 'cli', state: 'closed' });
    expect(h.frames()).toHaveLength(1);
    expect(
      (await h.read(started.data.operationId, client)).data.error.code,
    ).toBe('FORBIDDEN');
  });
  it('forwards history subscriptions and reads without durable business receipts or cloud revision writes', async () => {
    const h = harness();
    const reader = socket({
      id: 'reader',
      history: true,
      authenticated: true,
      role: 'web',
      auth,
      hostId: 'host',
      sessionId: 'host~session',
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const other = socket({
      ...reader.deserializeAttachment(),
      id: 'other-reader',
    });
    h.sockets.push(reader, other);
    const request = {
      operation: 'subscribe',
      requestId: 'open-reader',
      stream: 'reader-stream',
      instance: 'reader-storage',
      exchangeId: 'exchange',
      receivedRevision: 0,
      acknowledgedRevision: 0,
      owner: 'forged-owner',
      route: 'other-reader',
    };
    await h.relay.webSocketMessage(
      reader as unknown as WebSocket,
      JSON.stringify(request),
    );
    const opening = h.frames().at(-1)!;
    expect(opening.action).toBe('history');
    expect(opening.data.owner).toBe(auth.hash);
    expect(opening.data.route).toBe('reader');
    expect(opening.heads).toBeUndefined();
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire|send-head|receive-head|head-instance):/.test(
          key,
        ),
      ),
    ).toBe(false);
    h.recreate();
    await h.reply(opening, { maxRevision: 9 });
    expect(reader.send).not.toHaveBeenCalled();
    await h.relay.webSocketMessage(
      reader as unknown as WebSocket,
      JSON.stringify(request),
    );
    await h.reply(h.frames().at(-1)!, {
      stream: 'reader-stream',
      receivedRevision: 0,
      maxRevision: 9,
      exchangeId: 'exchange',
    });
    const window = JSON.parse(reader.send.mock.calls.at(-1)![0]);
    expect(window.type).toBe('history-window');
    expect(window.requestId).toBe('open-reader');
    expect(window.heads).toBeUndefined();
    reader.send.mockClear();
    await h.relay.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'history-notice',
        route: 'reader',
        sessionId: 'host~session',
        payload: { type: 'history-dirty', maxRevision: 9 },
      }),
    );
    await Promise.all(h.waiting);
    expect(JSON.parse(reader.send.mock.calls.at(-1)![0]).maxRevision).toBe(9);
    expect(other.send).not.toHaveBeenCalled();
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire|send-head|receive-head|head-instance):/.test(
          key,
        ),
      ),
    ).toBe(false);
    await h.relay.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'history-notice',
        route: 'missing-reader',
        sessionId: 'host~session',
        payload: { type: 'history-dirty', maxRevision: 9 },
      }),
    );
    expect(h.frames().at(-1)).toMatchObject({
      type: 'history-detached',
      route: 'missing-reader',
    });
  });
  it('registers Agent email capabilities and disconnects only revoked derived CW credentials', async () => {
    const h = harness();
    const revoked = socket({ role: 'web', auth: { ...auth, hash: 'removed' } });
    const retained = socket({ role: 'web', auth });
    h.sockets.push(revoked, retained);
    const relay = h.relay as any;
    relay.authorization.set('removed', { expires: Number.MAX_SAFE_INTEGER });
    vi.mocked(registryCall).mockImplementation(async (_env, op) =>
      op === 'agentSetAccessEmails'
        ? { hostId: 'host', revoked: [{ ...auth, hash: 'removed' }] }
        : { expires: Number.MAX_SAFE_INTEGER },
    );
    await h.relay.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'capabilities',
        delivery: 2,
        deliveryInstance: 'test-agent-store',
        protocol: 1,
        accessEmails: ['user@example.com'],
        build: {
          version: '0.5.15',
          commit: 'a'.repeat(40),
          sourceDigest: 'b'.repeat(64),
          target: 'linux-x86_64',
          protocol: 1,
          capabilities: [],
          dirty: false,
        },
      }),
    );
    expect(registryCall).toHaveBeenCalledWith(
      expect.anything(),
      'agentSetAccessEmails',
      { agentHash: 'agent', emails: ['user@example.com'] },
      'host',
    );
    expect(revoked.close).toHaveBeenCalledWith(
      4001,
      'Email association removed',
    );
    expect(retained.close).not.toHaveBeenCalled();
    expect(h.agent.close).not.toHaveBeenCalled();
    expect(relay.authorization.has('removed')).toBe(false);
  });
  it('preserves only bounded permission inputs and authorization fields across reconstruction', async () => {
    const h = harness();
    const operation = await (h.relay as any).start({
      auth,
      hostId: 'host',
      kind: 'ticket',
      stage: 'get',
      action: 'get',
      data: {
        sessionId: 'host~session',
        delivery: 2,
        claimId: 'claim',
        prompt: 'private business original',
      },
    });
    expect(operation.id).toMatch(/^permission_/);
    h.recreate();
    await h.reply(h.frames()[0], {
      mode: 'web',
      state: 'ready',
      sandbox: 'workspace-write',
      title: 'private session title',
      history: 'private transcript'.repeat(10000),
    });
    const stored = await (h.relay as any).loadOperation(operation.id);
    expect(stored.state).toBe('completed');
    expect(stored.result.ticket).toEqual(expect.any(String));
    expect(stored.info).toEqual({ mode: 'web', sandbox: 'workspace-write' });
    const serialized = JSON.stringify([...h.storage.values]);
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('history');
  });
  it('keeps permission capacity and expiry bounded across reconstruction', async () => {
    const h = harness();
    const input = {
      auth,
      hostId: 'host',
      kind: 'ticket',
      stage: 'get',
      action: 'get',
      data: { sessionId: 'host~session', delivery: 2 },
    };
    for (let i = 0; i < 64; i++) await (h.relay as any).start(input);
    h.recreate();
    await expect((h.relay as any).start(input)).rejects.toMatchObject({
      code: 'BACKPRESSURE',
    });
    expect(h.frames()).toHaveLength(64);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 300001);
    await (h.relay as any).expire();
    expect(
      (await h.storage.list({ prefix: 'permission-operation:' })).size,
    ).toBe(0);
    expect((await h.storage.list({ prefix: 'permission-wire:' })).size).toBe(0);
    await (h.relay as any).start(input);
    expect(h.frames()).toHaveLength(65);
  });
  it('recovers permission expiry after an exit before alarm scheduling', async () => {
    const h = harness();
    vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('Exit before alarm scheduling'),
    );
    await expect(
      (h.relay as any).start({
        auth,
        hostId: 'host',
        kind: 'ticket',
        stage: 'get',
        action: 'get',
        data: { sessionId: 'host~session', delivery: 2 },
      }),
    ).rejects.toThrow('Exit before alarm scheduling');
    expect(
      (await h.storage.list({ prefix: 'permission-operation:' })).size,
    ).toBe(1);
    expect((await h.storage.list({ prefix: 'due:' })).size).toBe(1);
    h.recreate();
    await (h.relay as any).prepare();
    expect(h.storage.alarm).toEqual(expect.any(Number));
    vi.useFakeTimers();
    vi.setSystemTime(h.storage.alarm! + 1);
    await (h.relay as any).expire();
    expect(
      (await h.storage.list({ prefix: 'permission-operation:' })).size,
    ).toBe(0);
    expect((await h.storage.list({ prefix: 'due:' })).size).toBe(0);
    expect(h.agent.send).not.toHaveBeenCalled();
  });
  it('stores a permission transaction in one bounded record and rejects overflow atomically', async () => {
    const h = harness();
    const relay = h.relay as any;
    const permission = {
      id: 'permission_snapshot',
      kind: 'ticket',
      state: 'pending',
      auth,
      expires: Date.now() + 300000,
      data: { sessionId: 'host~session' },
      wire: 'permission_old',
    };
    await relay.saveOperation(permission);
    expect(await relay.loadOperation(permission.id)).toEqual(permission);
    await expect(
      relay.saveOperation({
        ...permission,
        wire: 'permission_new',
        result: 'x'.repeat(16384),
      }),
    ).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    expect(await relay.loadOperation(permission.id)).toEqual(permission);
    expect(
      await h.storage.get('permission-wire:permission_new'),
    ).toBeUndefined();
    expect(await h.storage.get('permission-wire:permission_old')).toBe(
      permission.id,
    );
    expect(
      [...h.storage.values.keys()].some((key) => key.startsWith('part:')),
    ).toBe(false);
  });
  it('releases a late attachment for a closed controller without reusing its epoch', async () => {
    const h = harness();
    const sessionId = 'host~session';
    const client = socket({
      id: 'connecting',
      auth,
      role: 'web',
      hostId: 'host',
      sessionId,
      authenticated: false,
      deadline: Date.now() + 15000,
    });
    h.sockets.push(client);
    await (h.relay as any).start({
      auth,
      hostId: 'host',
      socketId: 'connecting',
      kind: 'attach',
      stage: 'get',
      action: 'attach',
      data: { sessionId, takeover: false },
    });
    await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
    const attach = h.frames()[1];
    client.readyState = 3;
    await h.relay.webSocketClose(client as unknown as WebSocket);
    await h.reply(attach, { attached: true });
    expect(h.storage.values.get('lease:' + sessionId).active).toBe(false);
    expect(h.frames()).toContainEqual({
      type: 'detach',
      sessionId,
      epoch: attach.data.epoch,
    });
    expect((await h.relay.reserve(sessionId, false)).epoch).toBeGreaterThan(
      attach.data.epoch,
    );
    expect(client.send).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])(
    'issues reconnect tickets only after the old controller stops being live (state %s)',
    async (state) => {
      const h = harness();
      const sessionId = 'host~session';
      const old = socket({
        id: 'old',
        auth,
        role: 'web',
        sessionId,
        authenticated: true,
        epoch: 1,
      });
      old.readyState = state;
      h.sockets.push(old);
      const operation = await (h.relay as any).start({
        auth,
        hostId: 'host',
        kind: 'ticket',
        stage: 'get',
        action: 'attach',
        data: { sessionId, takeover: false },
      });
      await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
      const receipt = (await h.read(operation.id)).data;
      expect(receipt.state).toBe('completed');
      if (state === 1) expect(receipt.error.code).toBe('SESSION_BUSY');
      else expect(receipt.result.ticket).toEqual(expect.any(String));
    },
  );
  it('reconciles an orphaned non-expiring controller lease with actual sockets', async () => {
    const h = harness();
    h.storage.values.set('lease:host~session', { epoch: 25, active: true });
    expect((await h.relay.reserve('host~session', false)).epoch).toBe(26);
    h.storage.values.set('lease:host~other', {
      epoch: 10,
      active: true,
      expires: Date.now() + 10000,
    });
    await expect(h.relay.reserve('host~other', false)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
  });
  it('keeps reads only in bounded memory and queries the Agent again after reconstruction', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { response, data } = await h.start();
    expect(response.status).toBe(202);
    expect(vi.getTimerCount()).toBe(0);
    expect((await h.read(data.operationId)).data.state).toBe('pending');
    expect(
      (await h.read(data.operationId, { ...auth, hash: 'foreign' })).response
        .status,
    ).toBe(404);
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire|due:.*operation):/.test(key),
      ),
    ).toBe(false);
    const lost = h.frames()[0];
    h.recreate();
    await h.reply(lost, [{ id: 'stale' }]);
    expect((await h.read(data.operationId)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
    const retried = await h.start();
    await h.reply(h.frames().at(-1), [{ id: 'project' }]);
    expect((await h.read(retried.data.operationId)).data).toEqual({
      state: 'completed',
      result: [{ id: 'project' }],
    });
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire):/.test(key),
      ),
    ).toBe(false);
    vi.advanceTimersByTime(20001);
    expect((await h.read(retried.data.operationId)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
  });
  it('bounds concurrent read results and replaces rejected bodies with backpressure errors', async () => {
    const h = harness();
    const accepted = await Promise.all(
      Array.from({ length: 128 }, () => h.start()),
    );
    expect((await h.start()).response.status).toBe(429);
    for (const frame of h.frames())
      await h.reply(frame, { body: 'x'.repeat(70000) });
    const results = await Promise.all(
      accepted.map((o) => h.read(o.data.operationId)),
    );
    expect(results.every((r) => r.data.state === 'completed')).toBe(true);
    expect(results.some((r) => r.data.result?.body.length === 70000)).toBe(
      true,
    );
    expect(results.some((r) => r.data.error?.code === 'BACKPRESSURE')).toBe(
      true,
    );
    expect(
      results
        .filter((r) => r.data.error)
        .every((r) => r.data.result === undefined),
    ).toBe(true);
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire):/.test(key),
      ),
    ).toBe(false);
  });
  it('preserves session-mode authorization across transient multi-stage approval reads', async () => {
    const h = harness();
    h.storage.values.set('session-mode:host~session', 'web');
    const writes = vi.spyOn(h.storage, 'put');
    const started = await h.start('approvals', {
      sessionId: 'host~session',
      mode: 'web',
    });
    expect(h.frames()[0].action).toBe('get');
    await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
    expect(h.frames()[1].action).toBe('approvals');
    await h.reply(h.frames()[1], { data: [] });
    expect((await h.read(started.data.operationId)).data.result).toEqual({
      data: [],
    });
    expect(writes).not.toHaveBeenCalled();
    const denied = await h.start('approvals', {
      sessionId: 'host~session',
      mode: 'web',
    });
    const count = h.frames().length;
    await h.reply(h.frames().at(-1), { mode: 'cli' });
    expect(h.frames()).toHaveLength(count);
    expect((await h.read(denied.data.operationId)).data.error.code).toBe(
      'FORBIDDEN',
    );
  });
  it.each([
    ['snapshot', { sessionId: 'host~session', mode: 'web' }],
    ['list', {}],
    ['threads', { projectId: 'demo' }],
    [
      'files',
      {
        projectId: 'demo',
        owner: 'a'.repeat(64),
        operation: 'read',
        path: 'proof.txt',
      },
    ],
    [
      'files',
      {
        projectId: 'demo',
        owner: 'a'.repeat(64),
        operation: 'status',
        agentInstance: 'test-agent-store',
        uploadId: 'upload',
      },
    ],
  ])('does not persist %s read bodies or results', async (action, input) => {
    const h = harness();
    const writes = vi.spyOn(h.storage, 'put');
    const started = await h.start(action, input);
    expect(started.response.status).toBe(202);
    await h.reply(h.frames()[0], { original: input });
    expect((await h.read(started.data.operationId)).data.result).toEqual({
      original: input,
    });
    expect(writes).not.toHaveBeenCalled();
  });
  it('does not deliver an old Agent epoch result to a replacement request', async () => {
    const h = harness();
    const { data } = await h.start();
    retire(h.agent as unknown as WebSocket, 1012, 'Agent replaced');
    await h.reply(h.frames()[0], { old: true });
    expect((await h.read(data.operationId)).data.state).toBe('pending');
    expect(h.agent.close).toHaveBeenCalled();
  });
  it('validates Agent identity before sending and preserves explicit rejection', async () => {
    const h = harness();
    vi.mocked(registryCall).mockImplementation(async (_env, _op, d: any) => {
      if (d.hash === 'agent') throw new Error('revoked');
      return {};
    });
    const failed = await h.start();
    expect(h.frames()).toHaveLength(0);
    expect((await h.read(failed.data.operationId)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
    vi.mocked(registryCall).mockResolvedValue({
      expires: Number.MAX_SAFE_INTEGER,
    });
    const started = await h.start();
    await h.reply(h.frames()[0], undefined, {
      code: 'FORBIDDEN',
      message: 'Wrong mode',
    });
    expect((await h.read(started.data.operationId)).data.error.code).toBe(
      'FORBIDDEN',
    );
  });
  it('coalesces concurrent status probes within one credential scope', async () => {
    const h = harness();
    const accepted = await Promise.all(
      Array.from({ length: 20 }, () => h.start('probe')),
    );
    expect(
      new Set(accepted.map((result) => result.data.operationId)).size,
    ).toBe(1);
    expect(h.frames()).toHaveLength(1);
    await h.reply(h.frames()[0], { online: true });
    expect(
      (await h.read(accepted[0].data.operationId)).data.result.online,
    ).toBe(true);
  });
  it('forwards large Unicode business data in memory and loses correlation on reconstruction', async () => {
    const h = harness();
    const text = '测'.repeat(60000);
    const request = await h.start('queue', {
      sessionId: 'host~session',
      requestId: 'same-request',
      mode: 'web',
      text,
    });
    await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
    const execution = h.frames()[1];
    expect(execution.data.text).toBe(text);
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire|permission-operation|permission-wire):/.test(
          key,
        ),
      ),
    ).toBe(false);
    h.recreate();
    await h.reply(execution, { state: 'queued' });
    expect((await h.read(request.data.operationId)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
    const retried = await h.start('queue', execution.data);
    expect(retried.data.operationId).not.toBe(request.data.operationId);
    expect((await h.read(retried.data.operationId)).data.state).toBe('pending');
  });
  it('bounds business forwards in memory and recovers capacity after reconstruction', async () => {
    const h = harness();
    for (let i = 0; i < 128; i++)
      expect(
        (await h.start('stop', { sessionId: 'host~session' })).response.status,
      ).toBe(202);
    expect(
      (await h.start('stop', { sessionId: 'host~session' })).response.status,
    ).toBe(429);
    h.recreate();
    expect(
      (await h.start('stop', { sessionId: 'host~session' })).response.status,
    ).toBe(202);
    expect(h.frames()).toHaveLength(129);
  });
  it('fences terminal requests by active project writer and current control proof', async () => {
    const h = harness();
    const proof = {
      controlEpoch: 1,
      controlId: 'terminal-control',
      owner: auth.hash,
      connectionGeneration: 3,
    };
    const data = {
      operation: 'close',
      projectId: 'project',
      sessionId: 'host~writer',
      control: proof,
      terminalId: 'terminal',
      owner: auth.hash,
      seq: 1,
      data: 'eA==',
    };
    await h.storage.put('lease:host~writer', {
      epoch: 3,
      active: true,
      controlEpoch: 1,
      controlId: proof.controlId,
      owner: auth.hash,
      projectId: 'project',
    });
    await h.storage.put('project-writer:project', 'host~writer');
    const accepted = await h.start('terminal', data);
    expect(accepted.response.status).toBe(202);
    const forward = JSON.parse(h.agent.send.mock.calls.at(-1)![0]);
    expect(forward.action).toBe('terminal');
    expect(forward.data.operation).toBe('close');
    for (const operation of ['read', 'input', 'resize']) {
      const rejected = await h.start('terminal', { ...data, operation });
      expect((await h.read(rejected.data.operationId)).data.error.code).toBe(
        'UPGRADE_REQUIRED',
      );
    }
    for (const invalid of [
      { ...data, control: { ...proof, connectionGeneration: 2 } },
      { ...data, owner: 'b'.repeat(64) },
      { ...data, projectId: 'another' },
    ]) {
      const calls = h.agent.send.mock.calls.length;
      const denied = await h.start('terminal', invalid);
      expect((await h.read(denied.data.operationId)).data.error.code).toBe(
        'PROJECT_READ_ONLY',
      );
      expect(h.agent.send.mock.calls.length).toBe(calls);
    }
    await h.storage.put('project-writer:project', 'host~other');
    const denied = await h.start('terminal', data);
    expect((await h.read(denied.data.operationId)).data.error.code).toBe(
      'PROJECT_READ_ONLY',
    );
  });
  it('allows one project writer across sessions, reconstruction and explicit takeover', async () => {
    const h = harness();
    await h.relay.reserve(
      'host~writer',
      false,
      undefined,
      'writer-claim',
      auth.hash,
      'shared',
    );
    h.recreate();
    await expect(
      h.relay.reserve(
        'host~reader',
        false,
        undefined,
        'reader-claim',
        auth.hash,
        'shared',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_READ_ONLY' });
    await expect(
      h.relay.reserve(
        'host~reader',
        true,
        undefined,
        'reader-claim',
        auth.hash,
        'shared',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_READ_ONLY' });
    await expect(
      h.relay.reserve(
        'host~other',
        false,
        undefined,
        'other-claim',
        auth.hash,
        'different',
      ),
    ).resolves.toMatchObject({ epoch: 1 });
    const lease = await h.storage.get<any>('lease:host~writer');
    await h.storage.put('lease:host~writer', {
      ...lease,
      epoch: lease.pending.epoch,
      pending: undefined,
      active: true,
    });
    const writer = socket({
      id: 'writer',
      role: 'web',
      sessionId: 'host~writer',
      epoch: lease.pending.epoch,
      authenticated: true,
    });
    h.sockets.push(writer);
    await expect(
      h.relay.reserve(
        'host~reader',
        false,
        undefined,
        'reader-claim',
        auth.hash,
        'shared',
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_READ_ONLY' });
    writer.readyState = 3;
    await h.relay.webSocketClose(writer as unknown as WebSocket);
    await expect(
      h.relay.reserve(
        'host~reader',
        false,
        undefined,
        'reader-claim',
        auth.hash,
        'shared',
      ),
    ).resolves.toMatchObject({ epoch: 1 });
  });
  it('releases a stopped project writer before its old socket finishes closing', async () => {
    const h = harness();
    await h.storage.put('lease:host~writer', {
      epoch: 1,
      active: true,
      projectId: 'shared',
    });
    await h.storage.put('project-writer:shared', 'host~writer');
    const writer = socket({
      role: 'web',
      sessionId: 'host~writer',
      epoch: 1,
      authenticated: true,
    });
    const history = socket({
      role: 'web',
      sessionId: 'host~writer',
      history: true,
      authenticated: true,
    });
    h.sockets.push(writer, history);
    await (h.relay as any).releaseStoppedSession('host~writer');
    expect(writer.close).toHaveBeenCalledWith(4000, 'Session ended');
    expect(writer.readyState).toBe(1);
    expect(history.close).not.toHaveBeenCalled();
    await expect(
      h.relay.reserve(
        'host~next',
        false,
        undefined,
        'next',
        auth.hash,
        'shared',
      ),
    ).resolves.toMatchObject({ epoch: 1 });
    await (h.relay as any).releaseStoppedSession('host~writer');
    expect(await h.storage.get('project-writer:shared')).toBe('host~next');
  });
  it('admits exactly one of five simultaneous project write claims', async () => {
    const h = harness();
    const claims = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        h.relay.reserve(
          'host~session-' + i,
          false,
          undefined,
          'claim-' + i,
          auth.hash,
          'shared',
        ),
      ),
    );
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(
      claims
        .filter((claim) => claim.status === 'rejected')
        .map((claim) => claim.reason.code),
    ).toEqual(Array(4).fill('PROJECT_READ_ONLY'));
  });
  it('retires the old controller on takeover before another data frame can dispatch', async () => {
    const h = harness();
    const writer = socket({
      id: 'writer',
      sessionId: 'host~writer',
      epoch: 1,
      auth,
      hostId: 'host',
      role: 'web',
      authenticated: true,
    });
    h.sockets.push(writer);
    await h.storage.put('lease:host~writer', {
      epoch: 1,
      active: true,
      projectId: 'shared',
      controllerId: 'writer',
      owner: auth.hash,
    });
    await h.storage.put('project-writer:shared', 'host~writer');
    await (h.relay as any).assertController(
      writer.deserializeAttachment(),
      h.agent.deserializeAttachment(),
    );
    await h.relay.reserve('host~writer', true);
    expect(writer.deserializeAttachment().retired).toBe(true);
    await expect(
      (h.relay as any).assertController(
        writer.deserializeAttachment(),
        h.agent.deserializeAttachment(),
      ),
    ).rejects.toMatchObject({ code: 'STALE_CONTROLLER' });
    expect(h.frames()).toHaveLength(0);
  });
  it('fences the old controller as soon as a takeover is reserved', async () => {
    const h = harness();
    h.storage.values.set('lease:host~session', { epoch: 4, active: true });
    const first = await h.relay.reserve('host~session', true);
    expect(first.epoch).toBe(5);
    await expect(h.relay.reserve('host~session', true)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    expect(h.storage.values.get('lease:host~session')).toMatchObject({
      epoch: 4,
      active: false,
      pending: { epoch: 5 },
    });
    const old = socket({
      ...auth,
      auth,
      role: 'web',
      sessionId: 'host~session',
      epoch: 3,
      authenticated: true,
    });
    await h.relay.webSocketClose(old as unknown as WebSocket);
    expect(h.storage.values.get('lease:host~session').active).toBe(false);
  });
  it('retains a pending claim across expiry and reconstruction without restoring old writes', async () => {
    const h = harness();
    await h.storage.put('lease:host~session', {
      epoch: 8,
      controlEpoch: 3,
      controlId: 'old-claim',
      owner: auth.hash,
      active: true,
    });
    const first = await h.relay.reserve(
      'host~session',
      true,
      undefined,
      'pending-claim',
      auth.hash,
    );
    expect(first.controlEpoch).toBe(4);
    h.storage.values.get('lease:host~session').pending.expires = 0;
    h.recreate();
    h.storage.values.get('lease:host~session').controllerId = 'old-controller';
    await expect(
      h.relay.reserve(
        'host~session',
        true,
        'old-controller',
        'old-claim',
        auth.hash,
      ),
    ).rejects.toMatchObject({ code: 'STALE_CONTROLLER' });
    const retry = await h.relay.reserve(
      'host~session',
      true,
      undefined,
      'pending-claim',
      auth.hash,
    );
    expect(retry.controlEpoch).toBe(4);
    expect(retry.epoch).toBeGreaterThan(first.epoch);
    expect(h.storage.values.get('lease:host~session').active).toBe(false);
    h.storage.values.get('lease:host~session').pending.expires = 0;
    const replacement = await h.relay.reserve(
      'host~session',
      true,
      undefined,
      'next-claim',
      auth.hash,
    );
    expect(replacement.controlEpoch).toBe(5);
  });
  it('keeps ordinary reconnection in the same control epoch with a new connection generation', async () => {
    const h = harness();
    await h.storage.put('lease:host~session', {
      epoch: 8,
      controlEpoch: 3,
      controlId: 'claim',
      controllerId: 'controller',
      owner: auth.hash,
      active: false,
    });
    const resumed = await h.relay.reserve(
      'host~session',
      true,
      'controller',
      'claim',
      auth.hash,
    );
    expect(resumed.controlEpoch).toBe(3);
    expect(resumed.controlId).toBe('claim');
    expect(resumed.epoch).toBe(9);
  });
  it('preserves the original web resume proof across repeatedly lost attachment confirmations and reconstruction', async () => {
    const h = harness();
    const sessionId = 'host~session';
    await h.storage.put('lease:' + sessionId, {
      epoch: 8,
      controlEpoch: 3,
      controlId: 'claim',
      controllerId: 'original-controller',
      owner: auth.hash,
      active: false,
      delivery: { id: 'browser', normal: 'normal', priority: 'priority' },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = socket({
        id: 'reconnect-' + attempt,
        auth,
        role: 'web',
        sessionId,
        authenticated: false,
        epoch: 0,
        deadline: Number.MAX_SAFE_INTEGER,
      });
      h.sockets.push(client);
      await (h.relay as any).start({
        auth,
        hostId: 'host',
        socketId: 'reconnect-' + attempt,
        kind: 'attach',
        stage: 'get',
        action: 'attach',
        data: {
          sessionId,
          claimId: 'claim',
          resume: { stream: 'browser', controller: 'original-controller' },
        },
      });
      await h.reply(h.frames().at(-1), {
        mode: 'web',
        state: 'ready',
        projectId: 'project',
      });
      expect(h.frames().at(-1).action).toBe('attach');
      await h.reply(h.frames().at(-1), {});
      const confirmation = JSON.parse(client.send.mock.calls.at(-1)![0]);
      expect(confirmation.type).toBe('attached');
      expect(confirmation.control.controlEpoch).toBe(3);
      expect(h.storage.values.get('lease:' + sessionId)).toMatchObject({
        controllerId: 'reconnect-' + attempt,
        previousControllerId: 'original-controller',
      });
      // The server committed, but the browser never receives this confirmation.
      client.readyState = 3;
      await h.relay.webSocketClose(client as unknown as WebSocket);
      h.recreate();
    }
  });
  it.each(['valid', 'owner', 'claim', 'stream', 'replaced', 'pending'])(
    'recovers an old lost-confirmation lease only with its current owner, claim and stream (%s)',
    async (variant) => {
      const h = harness();
      const sessionId = 'host~session';
      await h.storage.put('lease:' + sessionId, {
        epoch: 8,
        controlEpoch: 3,
        controlId: variant === 'replaced' ? 'new-claim' : 'claim',
        controllerId: 'lost-controller',
        owner: variant === 'owner' ? 'b'.repeat(64) : auth.hash,
        active: false,
        delivery: { id: 'browser', normal: 'normal', priority: 'priority' },
        ...(variant === 'pending'
          ? {
              pending: {
                controlEpoch: 4,
                epoch: 9,
                expires: Date.now() + 15000,
              },
            }
          : {}),
      });
      const client = socket({
        id: 'next-controller',
        auth,
        role: 'web',
        sessionId,
        authenticated: false,
        epoch: 0,
        deadline: Number.MAX_SAFE_INTEGER,
      });
      h.sockets.push(client);
      await (h.relay as any).start({
        auth,
        hostId: 'host',
        socketId: 'next-controller',
        kind: 'attach',
        stage: 'get',
        action: 'attach',
        data: {
          sessionId,
          claimId: variant === 'claim' ? 'forged' : 'claim',
          resume: {
            stream: variant === 'stream' ? 'forged' : 'browser',
            controller: 'original-controller',
          },
        },
      });
      await h.reply(h.frames().at(-1), { mode: 'web', state: 'ready' });
      if (variant === 'valid') {
        expect(h.frames().at(-1).action).toBe('attach');
        await h.reply(h.frames().at(-1), {});
        expect(JSON.parse(client.send.mock.calls.at(-1)![0]).type).toBe(
          'attached',
        );
      } else {
        expect(h.frames()).toHaveLength(1);
        expect(JSON.parse(client.send.mock.calls.at(-1)![0]).error.code).toBe(
          'STALE_CONTROLLER',
        );
      }
    },
  );
  it('requires negotiation and gives old clients an explicit upgrade error', async () => {
    const h = harness();
    h.agent.serializeAttachment({
      ...h.agent.deserializeAttachment(),
      protocol: undefined,
    });
    const operation = await h.start();
    expect((await h.read(operation.data.operationId)).data.error.code).toBe(
      'AGENT_NEGOTIATING',
    );
    expect(
      (await h.read(operation.data.operationId)).data.error.message,
    ).not.toMatch(/upgrade/i);
    const legacy = await h.relay.fetch(
      new Request('https://internal/control', {
        method: 'POST',
        body: JSON.stringify({ action: 'projects', data: {} }),
      }),
    );
    expect(((await legacy.json()) as any).error.code).toBe('UPGRADE_REQUIRED');
  });
});
describe('flow control and authorization on activity', () => {
  it('bounds zero-byte incoming frames by local and global records and releases every promise', async () => {
    const h = harness();
    const relay = h.relay as any;
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    vi.spyOn(relay, 'handleMessage').mockImplementation(() => gate);
    const peers = Array.from({ length: 3 }, (_, n) =>
      socket({ id: 'peer-' + n, role: 'web' }),
    );
    const work: Promise<unknown>[] = [];
    for (const peer of peers.slice(0, 2))
      for (let n = 0; n < 1024; n++)
        work.push(relay.webSocketMessage(peer, ''));
    await relay.webSocketMessage(peers[0], '');
    await relay.webSocketMessage(peers[2], '');
    expect(relay.incomingRecords).toBe(2048);
    expect(relay.incomingBytes).toBe(0);
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(peers[2].close).toHaveBeenCalledOnce();
    release();
    await Promise.all(work);
    expect(relay.incomingRecords).toBe(0);
    expect(relay.trafficMetrics.queueOverflows).toBe(2);
  });
  it('bounds zero-byte forwarding across sockets and keeps reservations until completion', async () => {
    const h = harness();
    const relay = h.relay as any;
    const peers = Array.from({ length: 3 }, (_, n) =>
      socket({ id: 'forward-' + n, auth, deadline: Number.MAX_SAFE_INTEGER }),
    );
    for (const peer of peers.slice(0, 2))
      for (let n = 0; n < 1000; n++) relay.forward(peer, { type: 'event' }, 0);
    relay.forward(peers[0], {}, 0);
    relay.forward(peers[2], {}, 0);
    expect(relay.forwardingRecords).toBe(2000);
    expect(relay.forwardingBytes).toBe(0);
    expect(peers[0].close).toHaveBeenCalledOnce();
    expect(peers[2].close).toHaveBeenCalledOnce();
    await Promise.all(h.waiting);
    expect(relay.forwardingRecords).toBe(0);
    expect(peers[0].send).not.toHaveBeenCalled();
    expect(peers[1].send).toHaveBeenCalledTimes(1000);
    expect(relay.trafficMetrics.queueOverflows).toBe(2);
  });
  it('caps distinct in-flight authorization checks while retaining same-identity coalescing', async () => {
    const h = harness();
    const relay = h.relay as any;
    let release!: (value: unknown) => void;
    const gate = new Promise((done) => {
      release = done;
    });
    vi.mocked(registryCall).mockImplementation(() => gate);
    const work = Array.from({ length: 128 }, (_, n) =>
      relay.authorized('identity-' + n),
    );
    const same = relay.authorized('identity-0');
    await expect(relay.authorized('extra')).rejects.toMatchObject({
      code: 'OVERLOADED',
    });
    expect(registryCall).toHaveBeenCalledTimes(128);
    release({ expires: Number.MAX_SAFE_INTEGER });
    await Promise.all([...work, same]);
    expect(relay.authorizing.size).toBe(0);
    expect(relay.authorization.size).toBe(128);
    expect(relay.trafficMetrics.queueOverflows).toBe(1);
  });

  it.each([
    [new Error('private storage failure'), 1011, 500],
    [new AppError('INVALID_REQUEST', 'Request failed', 400), 1011, 400],
    [new AppError('UNAUTHORIZED', 'Credential revoked', 401), 4001, 401],
  ])(
    'keeps admitted forwarding independent of backend failure but validates HTTP status: %s',
    async (error, _closeCode, status) => {
      const h = harness();
      const client = socket({
        id: 'client',
        auth,
        deadline: Number.MAX_SAFE_INTEGER,
      });
      h.sockets.push(client);
      vi.mocked(registryCall).mockRejectedValue(error);
      (h.relay as any).forward(client, { type: 'event' }, 10);
      await Promise.all(h.waiting);
      expect(client.send).toHaveBeenCalledOnce();
      expect(client.close).not.toHaveBeenCalled();
      const response = await h.relay.fetch(
        new Request('https://internal/status'),
      );
      if (status === 401) {
        expect(await response.json()).toMatchObject({ online: false });
        expect(h.agent.close).toHaveBeenCalledWith(4001, expect.any(String));
      } else {
        expect(response.status).toBe(status);
        expect(h.agent.close).not.toHaveBeenCalled();
      }
    },
  );
  it('does not label a forbidden operation as revoked credentials', async () => {
    const h = harness();
    const client = socket({
      id: 'subscriber',
      auth,
      subscription: true,
      role: 'web',
      deadline: Number.MAX_SAFE_INTEGER,
    });
    h.sockets.push(client);
    await h.relay.webSocketMessage(
      client as unknown as WebSocket,
      JSON.stringify({ type: 'invalid-command' }),
    );
    expect(client.close).toHaveBeenCalledWith(4000, expect.any(String));
    expect(client.close).not.toHaveBeenCalledWith(4001, expect.any(String));
  });
  it('propagates failed host status reads instead of publishing an offline-looking host', async () => {
    const env = {
      HOSTS: {
        idFromName: (id: string) => id,
        get: () => ({
          fetch: () =>
            Promise.resolve(
              Response.json(
                {
                  error: {
                    code: 'INTERNAL_ERROR',
                    message: 'Temporary backend failure',
                  },
                },
                { status: 503 },
              ),
            ),
        }),
      },
    };
    await expect(hostStatus(env as never, 'host')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      status: 503,
    });
  });
  it('reports unknown server failures without exposing details or blaming request syntax', async () => {
    const response = failure(new Error('private database details'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Service temporarily unavailable',
      },
    });
    expect(failure(new SyntaxError('invalid JSON')).status).toBe(400);
  });
  it('drops a forward to a socket that closed before the reply', () => {
    const h = harness();
    const closed = socket({ id: 'closed', role: 'web', authenticated: true });
    closed.readyState = 3;
    h.relay.send(closed as unknown as WebSocket, { type: 'delivery-window' });
    expect(closed.send).not.toHaveBeenCalled();
  });
  it('retains acknowledgement budgets across object reconstruction', async () => {
    const h = harness(),
      slow = socket({ id: 'reader', history: true });
    h.sockets.push(slow);
    for (let i = 0; i < 1000; i++)
      h.relay.send(slow as unknown as WebSocket, { type: 'event' });
    h.recreate();
    h.relay.send(slow as unknown as WebSocket, { type: 'event' });
    expect(slow.send).toHaveBeenCalledTimes(1000);
    expect(slow.close).toHaveBeenCalledWith(4008, expect.any(String));
  });
  it('invalidates a pending auth check rather than restoring a revoked cache entry', async () => {
    const h = harness();
    let release!: (value: unknown) => void;
    vi.mocked(registryCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const results = Promise.allSettled([
      h.relay.authorized('same'),
      h.relay.authorized('same'),
    ]);
    await h.relay.fetch(
      new Request('https://internal/revoke-auth', {
        method: 'POST',
        body: JSON.stringify({ hash: 'same' }),
      }),
    );
    release({ expires: Number.MAX_SAFE_INTEGER });
    expect(
      (await results).every((result) => result.status === 'rejected'),
    ).toBe(true);
    expect(registryCall).toHaveBeenCalledOnce();
  });
  it('does no authorization or periodic scheduling for permanent idle sockets', async () => {
    const h = harness();
    await h.relay.alarm();
    expect(h.storage.alarm).toBeNull();
    expect(registryCall).not.toHaveBeenCalled();
    expect(h.agent.close).not.toHaveBeenCalled();
  });
  it('keeps an unused host empty through status, notifications, and revocation', async () => {
    const h = harness();
    h.sockets.length = 0;
    h.storage.values.clear();
    const writes = vi.spyOn(h.storage, 'put');
    for (const path of ['/status', '/notify', '/revoke-auth']) {
      const response = await h.relay.fetch(
        new Request('https://internal' + path, {
          method: path === '/status' ? 'GET' : 'POST',
          ...(path === '/status'
            ? {}
            : { body: JSON.stringify({ scope: 'release', agent: true }) }),
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(h.storage.values.size).toBe(0);
    expect(h.storage.alarm).toBeNull();
    expect(registryCall).not.toHaveBeenCalled();
  });
  it('cleans an offline ticket exactly at its finite deadline', async () => {
    const h = harness();
    h.sockets.length = 0;
    const at = Date.now() + 60000;
    h.storage.values.set('ticket:test', { expires: at });
    h.storage.values.set(`due:${String(at).padStart(16, '0')}:ticket:test`, {
      key: 'ticket:test',
      at,
    });
    await h.relay.alarm();
    expect(h.storage.alarm).toBe(at);
    vi.useFakeTimers();
    vi.setSystemTime(at);
    await h.relay.alarm();
    expect(h.storage.values.has('ticket:test')).toBe(false);
    expect(h.storage.alarm).toBeNull();
  });
  it('preserves recipient event order without consulting the authorization backend', async () => {
    const h = harness();
    const slow = socket({
        history: true,
        authenticated: true,
        role: 'web',
        auth: { hash: 'slow' },
        deadline: Number.MAX_SAFE_INTEGER,
      }),
      fast = socket({
        history: true,
        authenticated: true,
        role: 'web',
        auth: { hash: 'fast' },
        deadline: Number.MAX_SAFE_INTEGER,
      });
    h.sockets.push(slow, fast);
    vi.mocked(registryCall).mockRejectedValue(new Error('Backend unavailable'));
    // All readers subscribe to this session; the Agent epoch is independent.
    for (const ws of [slow, fast])
      ws.serializeAttachment({
        ...ws.deserializeAttachment(),
        sessionId: 'host~session',
      });
    for (const seq of [1, 2])
      await h.relay.webSocketMessage(
        h.agent as unknown as WebSocket,
        JSON.stringify({
          type: 'event',
          sessionId: 'host~session',
          epoch: 1,
          payload: { event: { seq } },
        }),
      );
    await vi.waitFor(() => expect(fast.send).toHaveBeenCalledTimes(2));
    await Promise.all(h.waiting);
    expect(registryCall).not.toHaveBeenCalled();
    expect(
      slow.send.mock.calls.map(([raw]) => JSON.parse(raw).event.seq),
    ).toEqual([1, 2]);
  });
});

describe('reliable session streams', () => {
  async function connected() {
    const h = harness();
    const a = h.agent.deserializeAttachment();
    h.agent.serializeAttachment({
      ...a,
      deliveryVersion: 2,
      deliveryInstance: 'journal',
    });
    await h.storage.put('agentInstance', 'journal');
    const client = socket({
      id: 'controller',
      role: 'web',
      auth,
      hostId: 'host',
      sessionId: 'host~reliable',
      epoch: 5,
      authenticated: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    h.sockets.push(client);
    await h.storage.put('lease:host~reliable', {
      epoch: 5,
      active: true,
      owner: auth.hash,
      controllerId: 'controller',
      controlEpoch: 2,
      controlId: 'claim',
    });
    await h.relay.webSocketMessage(
      client as unknown as WebSocket,
      JSON.stringify({
        type: 'delivery-open',
        stream: 'browser',
        exchangeId: 'exchange',
        received: { normal: 0, priority: 0 },
        receivedBytes: { normal: 0, priority: 0 },
      }),
    );
    const opening = h.frames().filter((frame) => frame.action === 'delivery');
    expect(opening).toHaveLength(2);
    for (const frame of opening) {
      expect(frame.data.exchangeId).toBe('exchange');
      await h.reply(frame, {
        exchangeId: frame.data.exchangeId,
        controlReady: {
          ...frame.data.control,
          exchangeId: frame.data.exchangeId,
          instance: 'journal',
        },
        window: {
          stream: frame.data.stream,
          instance: 'journal',
          received: 0,
          receivedBytes: 0,
          sent: 0,
          credit: 4,
          byteCredit: 524288,
        },
      });
    }
    const request = async (data: unknown, as = auth) => {
      const response = await h.relay.fetch(
        new Request('https://internal/delivery', {
          method: 'POST',
          headers: {
            'x-auth': encodeURIComponent(JSON.stringify(as)),
            'x-host': 'host',
            'x-coc-async': '1',
            'x-coc-delivery': '2',
          },
          body: JSON.stringify({
            sessionId: 'host~reliable',
            ...(data as object),
          }),
        }),
      );
      return { status: response.status, body: (await response.json()) as any };
    };
    return {
      ...h,
      client,
      request,
      get current() {
        return h.relay;
      },
    };
  }
  it('does no credential or lease queries for established bidirectional data across cache expiry and hibernation', async () => {
    const h = await connected();
    vi.useFakeTimers();
    vi.advanceTimersByTime(6000);
    h.recreate();
    vi.mocked(registryCall)
      .mockClear()
      .mockRejectedValue(new Error('Registry offline'));
    const get = vi.spyOn(h.storage, 'get');
    for (const payload of [
      { action: 'models', requestId: 'read' },
      {
        type: 'delivery-command',
        stream: 'browser',
        lane: 'normal',
        instance: 'journal',
        streamSerial: 1,
        creditGeneration: 'generation',
        seq: 1,
        end: 2,
        body: '{}',
      },
      {
        type: 'delivery-receipt',
        stream: 'browser',
        lane: 'normal',
        instance: 'journal',
        streamSerial: 1,
        creditGeneration: 'generation',
        received: 0,
        receivedBytes: 0,
      },
    ])
      await h.current.webSocketMessage(
        h.client as unknown as WebSocket,
        JSON.stringify(payload),
      );
    await h.current.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'event',
        sessionId: 'host~reliable',
        epoch: 5,
        payload: { event: { type: 'sample' } },
      }),
    );
    await Promise.all(h.waiting);
    expect(registryCall).not.toHaveBeenCalled();
    expect(
      get.mock.calls
        .flat()
        .filter((key) => /^(lease:|project-writer:|auth:)/.test(String(key))),
    ).toEqual([]);
    expect(
      h.client.send.mock.calls.some(
        ([raw]) => JSON.parse(raw).event?.type === 'sample',
      ),
    ).toBe(true);
    expect(h.client.close).not.toHaveBeenCalled();
  });
  it.each([
    ['web', { action: 'prompt', requestId: 'raw', text: 'must not run' }],
    [
      'web',
      {
        action: 'interrupt',
        requestId: 'raw',
        target: {
          controlEpoch: 1,
          instance: 'journal',
          owner: 'client',
          requestId: 'web:original',
          stream: 'normal',
        },
      },
    ],
    ['web', { action: 'autoApproval', requestId: 'raw', enabled: true }],
    [
      'web',
      {
        action: 'approval',
        requestId: 'raw',
        approvalId: '1',
        runtimeId: 'rt',
        approvalVersion: 'v',
        allow: true,
      },
    ],
    ['cli', { id: 1, method: 'initialize', params: {} }],
    ['cli', { id: 1, method: 'thread/start', params: {} }],
    ['cli', { id: 1, method: 'turn/start', params: {} }],
    ['cli', { id: 1, method: 'turn/interrupt', params: {} }],
    ['cli', { id: 1, result: { decision: 'accept' } }],
  ])(
    'forwards raw %s business commands for authoritative Agent validation: %j',
    async (role, payload) => {
      const h = await connected();
      h.client.serializeAttachment({
        ...h.client.deserializeAttachment(),
        role,
      });
      h.agent.send.mockClear();
      h.client.send.mockClear();
      const put = vi.spyOn(h.storage, 'put');
      const remove = vi.spyOn(h.storage, 'delete');
      await h.current.webSocketMessage(
        h.client as unknown as WebSocket,
        JSON.stringify(payload),
      );
      expect(h.frames()).toContainEqual(expect.objectContaining({ payload }));
      expect(h.client.send).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['web', { action: 'sync', after: 0 }],
    ['web', { action: 'models', requestId: 'read' }],
    ['cli', { id: 1, method: 'model/list', params: {} }],
  ])('keeps allowlisted raw %s reads: %j', async (role, payload) => {
    const h = await connected();
    h.client.serializeAttachment({ ...h.client.deserializeAttachment(), role });
    h.agent.send.mockClear();
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify(payload),
    );
    expect(h.frames()).toContainEqual(
      expect.objectContaining({
        type: role === 'cli' ? 'rpc' : 'web',
        payload,
      }),
    );
    expect(h.client.close).not.toHaveBeenCalled();
  });
  it.each(['raw', 'delivery'])(
    'leaves unbound %s interruption validation to the Agent without cloud writes',
    async (mode) => {
      const h = await connected();
      const payload = { action: 'interrupt', requestId: 'unbound' };
      const body = JSON.stringify(payload);
      h.agent.send.mockClear();
      h.client.send.mockClear();
      const put = vi.spyOn(h.storage, 'put');
      const remove = vi.spyOn(h.storage, 'delete');
      await h.current.webSocketMessage(
        h.client as unknown as WebSocket,
        JSON.stringify(
          mode === 'raw'
            ? payload
            : {
                type: 'delivery-command',
                instance: 'journal',
                streamSerial: 1,
                creditGeneration: 'generation',
                stream: 'browser',
                lane: 'priority',
                seq: 1,
                end: Buffer.byteLength(body),
                body,
              },
        ),
      );
      expect(h.frames()).toContainEqual(expect.objectContaining({ payload }));
      expect(h.client.send).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );
  it('rejects late CONTROL_READY after another takeover reserved and after DO reconstruction', async () => {
    const h = await connected();
    const accepted = await h.request({
      operation: 'read',
      instance: 'journal',
      streamSerial: 1,
      creditGeneration: 'generation',
      stream: 'browser',
      lane: 'normal',
      controller: 'controller',
      exchangeId: 'late-exchange',
    });
    const frame = h.frames().at(-1)!;
    await h.current.reserve(
      'host~reliable',
      true,
      undefined,
      'new-claim',
      auth.hash,
    );
    await h.reply(frame, {
      exchangeId: 'late-exchange',
      controlReady: {
        ...frame.data.control,
        exchangeId: 'late-exchange',
        instance: 'journal',
      },
      window: { instance: 'journal' },
    });
    const result = await h.read(accepted.body.operationId);
    expect(result.data.error.code).toBe('STALE_CONTROLLER');
    h.recreate();
    expect(h.storage.values.get('lease:host~reliable').active).toBe(false);
    const before = h.frames().length;
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify({
        type: 'delivery-open',
        stream: 'browser',
        exchangeId: 'old-retry',
        received: { normal: 0, priority: 0 },
        receivedBytes: { normal: 0, priority: 0 },
      }),
    );
    expect(h.frames()).toHaveLength(before);
  });
  it('refuses a forged readiness identity and only activates the current Agent proof', async () => {
    const h = await connected();
    h.storage.values.get('lease:host~reliable').active = false;
    const accepted = await h.request({
      operation: 'read',
      instance: 'journal',
      streamSerial: 1,
      creditGeneration: 'generation',
      stream: 'browser',
      lane: 'normal',
      controller: 'controller',
      exchangeId: 'check-proof',
    });
    const frame = h.frames().at(-1)!;
    await h.reply(frame, {
      exchangeId: 'check-proof',
      controlReady: {
        ...frame.data.control,
        controlEpoch: 1,
        exchangeId: 'check-proof',
        instance: 'journal',
      },
      window: { instance: 'journal' },
    });
    expect((await h.read(accepted.body.operationId)).data.error.code).toBe(
      'STALE_CONTROLLER',
    );
    expect(h.storage.values.get('lease:host~reliable').active).toBe(false);
  });
  it('preserves the Agent recovery identity through WebSocket and HTTP reads', async () => {
    const h = await connected();
    const windows = h.client.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((frame) => frame.type === 'delivery-window');
    expect(windows).toHaveLength(2);
    expect(windows.every((frame) => frame.exchangeId === 'exchange')).toBe(
      true,
    );
    const accepted = await h.request({
      operation: 'read',
      instance: 'journal',
      streamSerial: 1,
      creditGeneration: 'generation',
      stream: 'browser',
      lane: 'normal',
      controller: 'controller',
      exchangeId: 'http-exchange',
    });
    expect(accepted.status).toBe(202);
    const frame = h.frames().at(-1)!;
    expect(frame.data.exchangeId).toBe('http-exchange');
    await h.reply(frame, {
      exchangeId: 'http-exchange',
      controlReady: {
        ...frame.data.control,
        exchangeId: 'http-exchange',
        instance: 'journal',
      },
      window: {
        stream: frame.data.stream,
        instance: 'journal',
        received: 0,
        receivedBytes: 0,
        credit: 4,
        byteCredit: 524288,
      },
    });
    const receipt = await h.read(accepted.body.operationId);
    expect(receipt.data.result.exchangeId).toBe('http-exchange');
  });
  it('forwards result receipts after reconstruction without saving cloud result progress', async () => {
    const h = await connected();
    await Promise.all(h.waiting);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) h.recreate();
      const writes = vi.spyOn(h.storage, 'put');
      const result = await h.request({
        type: 'delivery-receipt',
        streamSerial: 1,
        creditGeneration: 'generation',
        stream: 'browser',
        lane: 'normal',
        instance: 'journal',
        received: 100,
        receivedBytes: 2048,
      });
      expect(result.status).toBe(200);
      expect(h.frames().at(-1)).toMatchObject({
        type: 'delivery-receipt',
        streamSerial: 1,
        creditGeneration: 'generation',
        sessionId: 'host~reliable',
        instance: 'journal',
        mode: 'web',
        received: 100,
        receivedBytes: 2048,
      });
      expect(writes).not.toHaveBeenCalled();
      writes.mockRestore();
    }
    expect(
      [...h.storage.values.keys()].some(
        (key) =>
          key.includes('result-received:') || key.includes('send-head:result:'),
      ),
    ).toBe(false);
  });
  it('binds content reads to the authenticated stream and preserves byte offsets', async () => {
    const h = await connected();
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify({
        type: 'delivery-content',
        streamSerial: 1,
        creditGeneration: 'generation',
        stream: 'browser',
        lane: 'normal',
        instance: 'journal',
        resultSeq: 2,
        offset: 16384,
      }),
    );
    const frame = h.frames().at(-1)!;
    expect(frame.action).toBe('delivery');
    expect(frame.data).toMatchObject({
      mode: 'web',
      sessionId: 'host~reliable',
      contentSeq: 2,
      offset: 16384,
    });
    expect(frame.data.stream).not.toBe('browser');
    const read = await h.request({
      operation: 'read',
      instance: 'journal',
      streamSerial: 1,
      creditGeneration: 'generation',
      stream: 'browser',
      lane: 'normal',
      contentSeq: 2,
      offset: 16384,
    });
    expect(read.status).toBe(202);
    expect(h.frames().at(-1)!.data.stream).toBe(frame.data.stream);
    expect(h.frames().at(-1)!.data.contentSeq).toBe(2);
    expect(h.frames().at(-1)!.data.offset).toBe(16384);
    expect(
      (
        await h.request({
          operation: 'read',
          instance: 'journal',
          streamSerial: 1,
          creditGeneration: 'generation',
          stream: 'browser',
          lane: 'normal',
          contentSeq: 2,
          offset: -1,
        })
      ).status,
    ).toBe(400);
  });
  it('loses only transient delivery queries on reconstruction and recovers from the Agent without cloud business writes', async () => {
    const h = await connected();
    const writes = vi.spyOn(h.storage, 'put');
    const query = {
      operation: 'read',
      instance: 'journal',
      streamSerial: 1,
      creditGeneration: 'generation',
      stream: 'browser',
      lane: 'normal',
      resultReceived: 0,
      resultBytes: 0,
    };
    const first = await h.request(query);
    const lost = h.frames().at(-1)!;
    expect(lost.heads).toBeUndefined();
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(operation|part|wire):/.test(key),
      ),
    ).toBe(false);
    h.recreate();
    expect((await h.read(first.body.operationId)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
    await h.reply(lost, { results: ['retired callback must be ignored'] });
    const retry = await h.request(query);
    const frame = h.frames().at(-1)!;
    expect(frame.data.stream).toBe(lost.data.stream);
    await h.current.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'result',
        requestId: frame.requestId,
        heads: { agent: 999, rpc: 999 },
        data: {
          window: {
            stream: frame.data.stream,
            instance: 'journal',
            received: 0,
            receivedBytes: 0,
            sent: 0,
            resultBytes: 0,
            credit: 4,
            byteCredit: 524288,
          },
          results: [],
        },
      }),
    );
    const receipt = await h.read(retry.body.operationId);
    expect(receipt.data.state).toBe('completed');
    expect(receipt.data.result.results).toEqual([]);
    expect(writes).not.toHaveBeenCalled();
  });
  it('forwards live result windows without merging or recording cloud progress', async () => {
    const h = await connected();
    const writes = vi.spyOn(h.storage, 'put');
    const window = {
      stream: 'agent-stream',
      instance: 'journal',
      received: 0,
      receivedBytes: 0,
      sent: 1,
      resultBytes: 2,
      credit: 16,
      byteCredit: 2 * 1024 * 1024,
    };
    for (let n = 0; n < 1000; n++) {
      const type = n % 2 ? 'delivery-result' : 'delivery-window';
      await h.current.webSocketMessage(
        h.agent as unknown as WebSocket,
        JSON.stringify({
          type: 'notice',
          epoch: 5,
          sessionId: 'host~reliable',
          heads: { agent: 999, rpc: 999 },
          payload: {
            type,
            lane: 'normal',
            window,
            heads: { agent: 3, rpc: 2 },
          },
        }),
      );
      if (n % 100 === 99) {
        await Promise.all(h.waiting);
        const packet = JSON.parse(h.client.send.mock.calls.at(-1)![0]);
        await h.current.webSocketMessage(
          h.client as unknown as WebSocket,
          JSON.stringify({ type: 'receipt', receiptId: packet.receiptId }),
        );
      }
    }
    await Promise.all(h.waiting);
    const forwarded = h.client.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((frame) => frame.window?.stream === 'agent-stream');
    expect(forwarded).toHaveLength(1000);
    expect(
      forwarded.every(
        (frame) =>
          frame.heads.agent === 3 &&
          frame.heads.rpc === 2 &&
          frame.window.sent === 1,
      ),
    ).toBe(true);
    expect(writes).not.toHaveBeenCalled();
  });
  it.each([
    ['DELIVERY_STATE_MISMATCH', 'delivery-reset'],
    ['STREAM_CLOSED', 'delivery-reset'],
    ['RESULT_UNAVAILABLE', 'delivery-reset'],
    ['STALE_CONTROLLER', 'delivery-reset'],
    ['UNAUTHORIZED', 'delivery-reset'],
    ['FORBIDDEN', 'delivery-reset'],
    ['RESULT_UNKNOWN', 'error'],
    ['RESULT_PENDING', 'error'],
    ['BACKPRESSURE', 'error'],
    ['HOST_OFFLINE', 'error'],
  ])(
    'classifies recovery error %s as %s without a cloud receipt',
    async (code, type) => {
      const h = await connected();
      await h.current.webSocketMessage(
        h.client as unknown as WebSocket,
        JSON.stringify({
          type: 'delivery-open',
          stream: 'browser',
          exchangeId: 'current-reset',
          received: { normal: 0, priority: 0 },
          receivedBytes: { normal: 0, priority: 0 },
        }),
      );
      const frames = h.frames().slice(-2);
      for (const frame of frames)
        await h.reply(frame, undefined, {
          code,
          message: 'Receiver lost acknowledged results',
        });
      const resets = h.client.send.mock.calls
        .map(([raw]) => JSON.parse(raw))
        .filter(
          (frame) =>
            frame.type === type && frame.exchangeId === 'current-reset',
        );
      expect(resets).toHaveLength(2);
      expect(
        resets.every((frame) => frame.exchangeId === 'current-reset'),
      ).toBe(true);
      expect(
        [...h.storage.values.keys()].some((key) =>
          /^(operation|wire|part):/.test(key),
        ),
      ).toBe(false);
    },
  );
  it('forwards output confirmations without cloud publication state and still fences a replaced Agent', async () => {
    const h = await connected();
    h.client.serializeAttachment({
      ...h.client.deserializeAttachment(),
      role: 'cli',
      auth: { ...auth, role: 'cli' },
      deliveryVersion: 2,
    });
    const writes = vi.spyOn(h.storage, 'put');
    const receipt = {
      type: 'delivery-output',
      received: 9,
      credit: 12,
      byteCredit: 2048,
      replay: true,
    };
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify(receipt),
    );
    expect(h.frames().at(-1)).toMatchObject({
      ...receipt,
      sessionId: 'host~reliable',
      epoch: 5,
    });
    expect(h.frames().at(-1).heads).toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    retire(h.agent as unknown as WebSocket, 1012, 'Agent replaced');
    const count = h.frames().length;
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify(receipt),
    );
    expect(h.frames()).toHaveLength(count);
    expect(JSON.parse(h.client.send.mock.calls.at(-1)![0]).error.code).toBe(
      'HOST_OFFLINE',
    );
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(send-head|receive-head|head-instance):/.test(key),
      ),
    ).toBe(false);
  });
  it('forwards commands and reads across reconstruction without any cloud transport progress', async () => {
    const h = await connected();
    const body = JSON.stringify({
      action: 'interrupt',
      requestId: 'cancel',
      target: {
        controlEpoch: 1,
        instance: 'journal',
        owner: 'client',
        requestId: 'web:original',
        stream: 'normal',
      },
    });
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify({
        type: 'delivery-command',
        streamSerial: 1,
        creditGeneration: 'generation',
        instance: 'journal',
        stream: 'browser',
        lane: 'priority',
        seq: 1,
        end: Buffer.byteLength(body),
        body,
      }),
    );
    const command = h.frames().at(-1)!;
    expect(command.type).toBe('web');
    expect(command.delivery.stream).not.toBe('browser');
    expect(command.heads).toBeUndefined();
    await h.current.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'event',
        epoch: 5,
        sessionId: 'host~reliable',
        payload: {
          type: 'event',
          event: {
            seq: 9,
            revision: 9,
            time: 0,
            type: 'item/agentMessage/delta',
            data: { delta: 'new' },
          },
          maxRevision: 9,
          previousRevision: 0,
        },
      }),
    );
    await Promise.all(h.waiting);
    h.recreate();
    await h.current.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify({ action: 'sync', after: 0 }),
    );
    expect(h.frames().at(-1)!.heads).toBeUndefined();
    const forwarded = h.client.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .find((frame) => frame.type === 'event');
    expect(forwarded.heads).toBeUndefined();
    expect(
      [...h.storage.values.keys()].some((key) =>
        /^(send-head|receive-head|head-instance):/.test(key),
      ),
    ).toBe(false);
  });
  it('requires the current controller proof for HTTP mutations but not for scoped receipt reads', async () => {
    const h = await connected();
    const body = JSON.stringify({
      action: 'prompt',
      requestId: 'prompt',
      text: 'one task',
    });
    const frame = {
      type: 'delivery-command',
      streamSerial: 1,
      creditGeneration: 'generation',
      instance: 'journal',
      stream: 'browser',
      lane: 'normal',
      seq: 1,
      end: Buffer.byteLength(body),
      body,
      controller: 'controller',
    };
    const before = h.frames().length;
    expect(
      (await h.request({ ...frame, controller: 'another-tab' })).status,
    ).toBe(409);
    expect(
      (await h.request(frame, { ...auth, hash: 'other-device' })).status,
    ).toBe(409);
    expect(h.frames()).toHaveLength(before);
    expect((await h.request(frame)).status).toBe(200);
    expect(h.frames().at(-1)!.delivery.seq).toBe(1);
    const bound = h.storage.values.get('lease:host~reliable');
    h.storage.values.set('lease:host~reliable', {
      ...bound,
      projectId: 'shared',
    });
    h.storage.values.set('project-writer:shared', 'host~replacement');
    const readOnly = await h.request(frame);
    expect(readOnly.status).toBe(409);
    expect(readOnly.body.error.code).toBe('PROJECT_READ_ONLY');
    await h.storage.put('lease:host~reliable', {
      epoch: 6,
      active: true,
      owner: 'other-device',
      controllerId: 'replacement',
    });
    expect((await h.request(frame)).status).toBe(409);
    const read = await h.request({
      operation: 'read',
      instance: 'journal',
      streamSerial: 1,
      creditGeneration: 'generation',
      stream: 'browser',
      lane: 'normal',
      seq: 1,
    });
    expect(read.status).toBe(202);
    expect(h.frames().at(-1)!.action).toBe('delivery');
    expect(h.frames().at(-1)!.data.mode).toBe('web');
  });
  it('delegates execution-window reads to Agent validation and rejects malformed result receipts', async () => {
    const h = await connected();
    const body = JSON.stringify({ action: 'models', requestId: 'read' });
    expect(
      (
        await h.request({
          type: 'delivery-command',
          streamSerial: 1,
          creditGeneration: 'generation',
          instance: 'journal',
          stream: 'browser',
          lane: 'normal',
          seq: 1,
          end: body.length,
          body,
          controller: 'controller',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request({
          type: 'delivery-receipt',
          streamSerial: 1,
          creditGeneration: 'generation',
          stream: 'browser',
          lane: 'normal',
          received: 100,
        })
      ).status,
    ).toBe(400);
    expect(h.frames().some((frame) => frame.type === 'web')).toBe(true);
  });
  it.each([true, false])(
    'requires the original CLI resume proof (valid=%s)',
    async (valid) => {
      const h = harness();
      h.agent.serializeAttachment({
        ...h.agent.deserializeAttachment(),
        deliveryVersion: 2,
        deliveryInstance: 'journal',
      });
      const cli = { ...auth, role: 'cli' };
      await h.storage.put('lease:host~cli', {
        epoch: 2,
        active: false,
        owner: cli.hash,
        controllerId: 'proof',
        delivery: {
          id: 'terminal',
          normal: 'normal-stream',
          priority: 'priority-stream',
        },
      });
      const operation = await (h.relay as any).start({
        auth: cli,
        hostId: 'host',
        kind: 'ticket',
        stage: 'get',
        action: 'get',
        data: {
          sessionId: 'host~cli',
          delivery: 2,
          resume: {
            stream: 'terminal',
            controller: valid ? 'proof' : 'forged',
          },
        },
      });
      await h.reply(h.frames()[0], {
        mode: 'cli',
        state: 'ready',
        canReattach: false,
      });
      if (valid)
        expect(h.frames().at(-1)!.data.deliveryResume).toBe('normal-stream');
      else {
        expect(h.frames()).toHaveLength(1);
        expect((await h.read(operation.id, cli)).data.error.code).toBe(
          'STALE_CONTROLLER',
        );
      }
    },
  );
});

it.each([undefined, '1', '3'])(
  'rejects business delivery version %s before forwarding or storing an operation',
  async (version) => {
    const h = harness();
    const headers = new Headers();
    headers.set('x-auth', encodeURIComponent(JSON.stringify(auth)));
    headers.set('x-host', 'host');
    headers.set('x-coc-async', '1');
    if (version !== undefined) headers.set('x-coc-delivery', version);
    const response = await h.relay.fetch(
      new Request('https://internal/control', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'projects', data: {} }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'UPGRADE_REQUIRED' },
    });
    expect(h.agent.send).not.toHaveBeenCalled();
    expect(
      [...h.storage.values.keys()].some((key) => key.startsWith('operation:')),
    ).toBe(false);
  },
);
it.each([undefined, 1, 3])(
  'rejects Agent business delivery version %s before capability admission',
  async (delivery) => {
    const h = harness();
    await h.relay.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'capabilities',
        protocol: 1,
        ...(delivery === undefined ? {} : { delivery }),
      }),
    );
    expect(h.agent.close).toHaveBeenCalled();
    expect(h.frames()).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
      }),
    );
  },
);

it('retires routes before a closing handshake completes and drops queued forwards', async () => {
  const h = harness();
  const client = socket({ id: 'retired', auth, authenticated: true });
  h.sockets.push(client);
  (h.relay as any).forward(client, { secret: 'queued' }, 10);
  const response = await h.relay.fetch(
    new Request('https://internal/revoke-auth', {
      method: 'POST',
      body: JSON.stringify({ hash: auth.hash }),
    }),
  );
  await Promise.all(h.waiting);
  expect(response.status).toBe(200);
  expect(client.readyState).toBe(1);
  expect(client.deserializeAttachment().retired).toBe(true);
  // A frame queued before control processing may finish before the revoke
  // body is read, but no later frame can pass the retired route.
  client.send.mockClear();
  (h.relay as any).forward(client, { secret: 'late' }, 10);
  await Promise.all(h.waiting);
  expect(client.send).not.toHaveBeenCalled();
});

it('invalidates credentials through a control event and never revives a retired socket', async () => {
  const h = harness();
  const client = socket({ id: 'client', auth, authenticated: true });
  h.sockets.push(client);
  vi.mocked(registryCall).mockImplementation(async (_env, _op, data: any) => {
    if (data.hash === auth.hash)
      throw new AppError('UNAUTHORIZED', 'Revoked', 401);
    return { expires: Number.MAX_SAFE_INTEGER };
  });
  expect(
    (
      await h.relay.fetch(
        new Request('https://internal/authorization-change', {
          method: 'POST',
        }),
      )
    ).status,
  ).toBe(200);
  expect(client.deserializeAttachment().retired).toBe(true);
  expect(h.agent.deserializeAttachment().retired).not.toBe(true);
  h.recreate();
  await h.relay.webSocketMessage(
    client as unknown as WebSocket,
    JSON.stringify({ action: 'models' }),
  );
  expect(client.send).not.toHaveBeenCalled();
});

it('expires an active connection from its alarm without receiving a data frame', async () => {
  const h = harness();
  vi.useFakeTimers();
  const deadline = Date.now() + 1000;
  const client = socket({ id: 'finite', auth, authenticated: true, deadline });
  h.sockets.push(client);
  h.storage.values.set(
    `due:${String(deadline).padStart(16, '0')}:connection:finite`,
    { key: 'connection:finite', at: deadline },
  );
  vi.setSystemTime(deadline);
  await h.relay.alarm();
  expect(client.deserializeAttachment().retired).toBe(true);
  expect(registryCall).not.toHaveBeenCalled();
});

it('binds Terminal once and forwards both directions without credential or lease queries', async () => {
  const h = harness();
  h.agent.serializeAttachment({
    ...h.agent.deserializeAttachment(),
    terminalStreaming: 2,
  });
  const control = {
    controlEpoch: 1,
    connectionGeneration: 3,
    controlId: 'control',
    owner: auth.hash,
  };
  h.storage.values.set('lease:host~terminal', {
    epoch: 3,
    active: true,
    projectId: 'project',
    ...control,
  });
  h.storage.values.set('project-writer:project', 'host~terminal');
  const terminal = socket({
    id: 'terminal',
    role: 'web',
    hostId: 'host',
    auth,
    terminalStream: true,
    authenticated: false,
  });
  h.sockets.push(terminal);
  const send = (frame: object) =>
    h.relay.webSocketMessage(
      terminal as unknown as WebSocket,
      JSON.stringify({ type: 'terminal-stream', frame }),
    );
  await send({
    type: 'bind',
    projectId: 'project',
    sessionId: 'host~terminal',
    terminalId: 'pty',
    control,
    offset: 0,
  });
  expect(terminal.deserializeAttachment().authenticated).toBe(true);
  vi.useFakeTimers();
  vi.advanceTimersByTime(6000);
  vi.mocked(registryCall)
    .mockClear()
    .mockRejectedValue(new Error('Registry offline'));
  const get = vi.spyOn(h.storage, 'get');
  for (const frame of [
    { type: 'input', seq: 1, data: 'eA==' },
    { type: 'resize', seq: 2, cols: 80, rows: 24 },
    { type: 'ack', offset: 1 },
  ])
    await send(frame);
  await h.relay.webSocketMessage(
    h.agent as unknown as WebSocket,
    JSON.stringify({
      type: 'terminal-stream',
      route: 'terminal',
      terminalId: 'pty',
      sessionId: 'host~terminal',
      frame: { type: 'output', offset: 1, data: 'eA==', gap: false },
    }),
  );
  await Promise.all(h.waiting);
  expect(registryCall).not.toHaveBeenCalled();
  expect(
    get.mock.calls
      .flat()
      .filter((key) => /^(lease:|project-writer:|auth:)/.test(String(key))),
  ).toEqual([]);
  expect(
    terminal.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .some((frame) => frame.frame?.type === 'output'),
  ).toBe(true);
  expect(terminal.close).not.toHaveBeenCalled();
});

it('recovers suspended routes when an authorization control event must retry', async () => {
  const h = harness();
  const relay = h.relay as any;
  const list = vi
    .spyOn(h.storage, 'list')
    .mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(relay.authorizationChanged()).rejects.toThrow(
    'Storage unavailable',
  );
  expect(h.agent.deserializeAttachment().blocked).toBe(true);
  list.mockRestore();
  await relay.authorizationChanged();
  expect(h.agent.deserializeAttachment().blocked).toBe(false);
  expect(h.agent.deserializeAttachment().retired).not.toBe(true);
});

it('rejects an expired pending principal before activating a handshake', async () => {
  const h = harness();
  const client = socket({
    id: 'expired',
    auth: { ...auth, expires: Date.now() - 1 },
    authenticated: false,
  });
  h.sockets.push(client);
  await expect(
    (h.relay as any).operationAuthorized({ socketId: 'expired', auth }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
