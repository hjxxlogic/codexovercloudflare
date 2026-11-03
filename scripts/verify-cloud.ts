import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, request, type APIRequestContext } from '@playwright/test';
import access from '../config/cloudflare-service-token.json' with { type: 'json' };

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'https://r.xlogic.cc' },
    output: { type: 'string' },
    'storage-state': { type: 'string' },
    'agent-config': { type: 'string' },
  },
});
assert(values.output, '--output is required');
const base = new URL(values.base).origin;
assert(base.startsWith('https://'), 'Verification requires HTTPS');
assert(
  access.origins.includes(base),
  'Origin must be in the trusted Access configuration',
);
mkdirSync(values.output, { recursive: true, mode: 0o700 });
const report: Record<string, unknown> = {
  time: new Date().toISOString(),
  target: base,
  scope:
    'Health, admission boundaries and optional authenticated read-only browser/Agent checks; no model, PTY, takeover, task mutation or credential revocation',
};
const checks: { name: string; status: number }[] = [];
report.checks = checks;
async function json(context: APIRequestContext, path: string, data?: unknown) {
  const response = await context.fetch(base + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    data,
    maxRedirects: 0,
  });
  assert(
    response.headers()['content-type']?.includes('application/json'),
    'Expected JSON: ' + path,
  );
  return { response, data: await response.json() };
}
async function call(context: APIRequestContext, path: string, data?: unknown) {
  let result = await json(context, path, data);
  assert(
    result.response.ok(),
    'HTTP ' + result.response.status() + ': ' + path,
  );
  if (result.response.status() !== 202) return result.data;
  const receipt =
    '/hosts/' +
    encodeURIComponent(result.data.hostId) +
    '/operations/' +
    encodeURIComponent(result.data.operationId);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    result = await json(context, receipt);
    assert(result.response.ok(), 'Receipt query failed');
    if (result.data.state === 'completed') {
      await json(context, receipt, {});
      assert(!result.data.error, 'Agent returned ' + result.data.error?.code);
      return result.data.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Read-only Agent request timed out');
}
const admission = await request.newContext({
  extraHTTPHeaders: {
    'CF-Access-Client-Id': access.clientId,
    'CF-Access-Client-Secret': access.clientSecret,
    Origin: base,
  },
  timeout: 30000,
});
let authenticated: APIRequestContext | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const health = await call(admission, '/healthz');
  assert.equal(health.ok, true);
  report.health = health;
  for (const [path, status, code] of [
    ['/hosts', 403, 'ACCESS_USER_REQUIRED'],
    ['/sessions?hostId=verification', 401, 'UNAUTHORIZED'],
    ['/admin/hosts', 401, 'UNAUTHORIZED'],
    ['/auth/me', 401, 'UNAUTHORIZED'],
  ] as const) {
    const result = await json(admission, path);
    assert.equal(
      result.response.status(),
      status,
      'Unexpected rejection status: ' + path,
    );
    assert.equal(
      result.data.error?.code,
      code,
      'Entry token must not grant CoC roles',
    );
    checks.push({ name: path, status: result.response.status() });
  }
  for (const path of [
    '/ws/v1/admin',
    '/ws/v1/hosts/verification',
    '/ws/v1/hosts/verification/terminal',
  ]) {
    const response = await admission.get(base + path, {
      maxRedirects: 0,
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    assert.equal(
      response.status(),
      401,
      'WebSocket must require CoC credentials: ' + path,
    );
    checks.push({ name: path, status: response.status() });
  }
  if (values['storage-state']) {
    authenticated = await request.newContext({
      storageState: values['storage-state'],
      timeout: 30000,
      extraHTTPHeaders: {
        Origin: base,
        'X-CoC-Async': '1',
        'X-CoC-Delivery': '2',
        'X-CoC-Demand': '1',
      },
    });
    const email = await call(authenticated, '/auth/email');
    assert(
      email.autoAdmin === true,
      'Existing email administrator identity required',
    );
    await call(authenticated, '/auth/email/admin', {});
    const hosts = await call(authenticated, '/admin/hosts');
    report.administratorVerified = true;
    report.hostCount = hosts.length;
    const removed = await json(authenticated, '/admin/state/migrate', {});
    assert.equal(removed.response.status(), 404);
    checks.push({ name: 'removed-storage-migration', status: 404 });
    let hostId: string | undefined;
    if (values['agent-config']) {
      hostId = JSON.parse(readFileSync(values['agent-config'], 'utf8')).hostId;
      assert(typeof hostId === 'string' && /^[\w-]+$/.test(hostId));
      assert(
        hosts.some((host: { id: string }) => host.id === hostId),
        'Configured host must already exist',
      );
      await call(authenticated, '/auth/email/restore', { hostId });
      const probe = await call(
        authenticated,
        '/hosts/' + hostId + '/probe',
        {},
      );
      report.agentReachable = probe !== undefined;
      const sessions = await call(
        authenticated,
        '/sessions?paged=true&hostId=' + hostId,
      );
      const page = sessions.data ?? sessions;
      assert(Array.isArray(page));
      report.sessionPageCount = page.length;
      const project = page.find(
        (session: { projectId?: string }) => session.projectId,
      )?.projectId;
      if (project) {
        const info = await call(
          authenticated,
          '/hosts/' + hostId + '/terminal',
          { operation: 'info', projectId: project },
        );
        report.terminal = { enabled: info.enabled, streaming: info.streaming };
      }
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      storageState: await authenticated.storageState(),
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const transportErrors: string[] = [];
    report.webSocketTransportErrors = transportErrors;
    page.on('console', (message) => {
      if (message.type() === 'error' && /WebSocket/i.test(message.text()))
        transportErrors.push(
          message
            .text()
            .replace(/(?:https?|wss?):\/\/[^' \n]+/g, '[URL]')
            .slice(0, 500),
        );
    });
    const socketStatuses: number[] = [];
    report.webSocketHandshakeStatuses = socketStatuses;
    const network = await context.newCDPSession(page);
    await network.send('Network.enable');
    network.on('Network.webSocketFrameError', (event) =>
      transportErrors.push(event.errorMessage),
    );
    network.on('Network.webSocketHandshakeResponseReceived', (event) =>
      socketStatuses.push(event.response.status),
    );

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    await page.goto(base, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(
      new URL(page.url()).origin,
      base,
      'Browser must stay on the application origin',
    );
    assert(
      await page.locator('#root').textContent(),
      'Application must render',
    );
    if (hostId) {
      await page.evaluate(
        (host) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(
              'wss://' + location.host + '/ws/v1/hosts/' + host + '?delivery=2',
            );
            const deadline = setTimeout(() => {
              socket.close();
              reject(new Error('Subscription admission timed out'));
            }, 15000);
            socket.onopen = () => {
              clearTimeout(deadline);
              setTimeout(() => {
                const open = socket.readyState === WebSocket.OPEN;
                socket.close();
                if (open) resolve();
                else reject(new Error('Subscription closed while idle'));
              }, 6000);
            };
            socket.onerror = () => {
              clearTimeout(deadline);
              socket.close();
              reject(new Error('Subscription transport failed'));
            };
          }),
        hostId,
      );
      report.subscriptionOpenAfterSixSeconds = true;
    }
    assert.deepEqual(errors, [], 'Browser must have no uncaught errors');
    await page.screenshot({ path: join(values.output, 'browser.png') });
    report.browser = { rendered: true, uncaughtErrors: errors.length };
    await context.close();
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error =
    error instanceof Error
      ? error.message.split('\n')[0]
      : 'Verification failed';
  process.exitCode = 1;
} finally {
  await browser?.close();
  await authenticated?.dispose();
  await admission.dispose();
  const path = join(values.output, 'verification.json');
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(JSON.stringify(report, null, 2));
}
