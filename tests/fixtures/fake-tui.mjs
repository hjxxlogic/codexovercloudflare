#!/usr/bin/env node
// Observe the C++ CLI launcher without invoking a model or exposing test tickets.
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.164.0');
  process.exit(0);
}
writeFileSync(
  process.env.COC_TUI_CAPTURE,
  JSON.stringify({
    args: process.argv.slice(2),
    ticket: process.env.COC_REMOTE_TICKET,
  }),
  { mode: 0o600 },
);
