#!/usr/bin/env node
// Real local bridge handshake, no model calls or production credentials.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.164.0');
  process.exit(0);
}
const url = new URL(process.argv[process.argv.indexOf('--remote') + 1]);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.protocol, 'ws:');
const ws = new WebSocket(url, {
  headers: { Authorization: 'Bearer ' + process.env.COC_REMOTE_TICKET },
});
const deadline = setTimeout(() => process.exit(2), 10000);
ws.on('message', (raw) => {
  assert.equal(JSON.parse(raw).test, 'shared-access-bridge');
  ws.send(JSON.stringify({ test: 'bridge-reply' }));
  clearTimeout(deadline);
  ws.close();
});
ws.on('error', () => process.exit(3));
