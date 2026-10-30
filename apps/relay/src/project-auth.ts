import { AppError } from '../../../packages/protocol/src/index.ts';
import { adminEmailVersion, accessEnabled } from './access.ts';
import { digest, type Auth, type Env } from './common.ts';
export function effectiveAdminEmail(host: any): string {
  return host.adminEmailOverride ?? host.agentAdminEmail ?? '';
}
export async function managesProjects(
  env: Env,
  auth: Auth,
  host: any,
): Promise<boolean> {
  if (auth.role === 'owner')
    return (
      auth.ownerVersion === (await digest(env.OWNER_SECRET)) &&
      (auth.ownerSource !== 'email' ||
        auth.adminEmailVersion === (await adminEmailVersion(env)))
    );
  if (auth.hostId !== host.id) return false;
  const manager = auth.manager;
  if (manager?.kind === 'owner')
    return (
      manager.ownerVersion === (await digest(env.OWNER_SECRET)) &&
      (manager.ownerSource !== 'email' ||
        manager.adminEmailVersion === (await adminEmailVersion(env)))
    );
  const identity =
    auth.role === 'web'
      ? auth
      : manager?.kind === 'email'
        ? manager
        : undefined;
  const email = effectiveAdminEmail(host);
  return !!(
    identity &&
    email &&
    accessEnabled(env) &&
    identity.email === email &&
    identity.accountId ===
      (await digest(JSON.stringify([env.ACCESS_TEAM_DOMAIN, email])))
  );
}
export async function requireProjectManager(env: Env, auth: Auth, host: any) {
  if (!(await managesProjects(env, auth, host)))
    throw new AppError(
      'FORBIDDEN',
      'Agent administrator email or platform administrator required',
      403,
    );
}
