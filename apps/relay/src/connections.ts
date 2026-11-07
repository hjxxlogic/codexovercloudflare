// Retirement is persisted in the hibernation attachment before starting the
// closing handshake. readyState can remain OPEN while queued callbacks run.
export function live(ws: WebSocket | undefined) {
  if (!ws || ws.readyState >= 2) return false;
  const attachment = ws.deserializeAttachment();
  return !attachment?.retired && !attachment?.blocked;
}
export function retire(ws: WebSocket, code: number, reason: string) {
  const attachment = ws.deserializeAttachment();
  ws.serializeAttachment({ ...attachment, retired: true });
  try {
    ws.close(code, reason);
  } catch {
    // A transport that already failed may reject the closing handshake. The
    // attachment fence still applies; callers must finish retiring its peers.
  }
}
