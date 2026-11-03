// HTTP endpoint fixtures retain the first original identity before sending a
// mutation. Actual browser/CC durability is tested through their real journals.
import { randomUUID } from 'node:crypto';
import { operationWrite } from '../../packages/protocol/src/index.ts';
export class OriginalHttpRequests {
  private originals = new Map<string, { instance: string; body: string }>();
  async prepare(
    path: string,
    data: any,
    headers: Record<string, string>,
    probe: (path: string) => Promise<any>,
  ) {
    if (data === undefined) return;
    let host = '',
      action = '';
    const project = path.match(
      /^\/(admin\/)?hosts\/([\w-]+)\/project-management$/,
    );
    const file = path.match(/^\/hosts\/([\w-]+)\/files$/);
    const session = path.match(
      /^\/sessions\/([\w~-]+)\/(stop|queue|approval)$/,
    );
    if (path === '/sessions') {
      host = data.hostId;
      action = 'create';
    } else if (project) {
      host = project[2];
      action = 'projectManage';
    } else if (file) {
      host = file[1];
      action = 'files';
    } else if (session) {
      host = session[1].split('~')[0];
      action = session[2] === 'approval' ? 'answer' : session[2];
    }
    if (!host || !operationWrite(action, data)) return;
    const id = (headers['Idempotency-Key'] ||= randomUUID());
    const key = JSON.stringify([
      headers.Authorization,
      headers.Cookie,
      host,
      id,
    ]);
    let original = this.originals.get(key);
    if (!original) {
      const state = await probe(`/${project?.[1] || ''}hosts/${host}/probe`);
      // Let the requested endpoint report authentication/availability failures.
      if (typeof state?.deliveryInstance !== 'string') return;
      original = {
        instance: state.operationInstance ?? state.deliveryInstance,
        body: JSON.stringify(data),
      };
      this.originals.set(key, original);
    }
    headers['X-CoC-Operation-Instance'] = original.instance;
  }
}
