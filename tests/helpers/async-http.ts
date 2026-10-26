import WebSocket from 'ws';
// Test callers participate in the public asynchronous protocol, like real clients.
export async function resolveAsync(
  response: Response,
  origin: string,
  headers: Record<string, string>,
): Promise<Response> {
  if (response.status !== 202) return response;
  const accepted: any = await response.json();
  if (!accepted.accepted) throw new Error('Missing async receipt');
  return new Promise<Response>((resolve, reject) => {
    let ended = false,
      running = false,
      dirty = false;
    const options = { headers, closeTimeout: 1000 };
    const socket = new WebSocket(
      origin.replace(/^http/, 'ws') + '/ws/v1/hosts/' + accepted.hostId,
      options,
    );
    const finish = (error?: unknown, value?: Response) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      socket.close();
      if (error) reject(error);
      else resolve(value!);
    };
    const deadline = setTimeout(
      () =>
        finish(new Error('Async receipt timed out: ' + accepted.operationId)),
      30000,
    );
    const read = async () => {
      if (ended) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      try {
        const path =
          origin +
          '/api/v1/hosts/' +
          accepted.hostId +
          '/operations/' +
          accepted.operationId;
        const r = await fetch(path, { headers });
        const receipt: any = await r.json();
        if (!r.ok)
          return finish(
            undefined,
            Response.json(receipt, { status: r.status }),
          );
        if (receipt.state !== 'completed') return;
        await fetch(path, { method: 'POST', headers, body: '{}' });
        finish(
          undefined,
          Response.json(
            receipt.error ? { error: receipt.error } : receipt.result,
            {
              status: receipt.error
                ? receipt.error.status || errorStatus(receipt.error.code)
                : 200,
            },
          ),
        );
      } catch (error) {
        finish(error);
      } finally {
        running = false;
        if (dirty && !ended) void read();
      }
    };
    socket.on('message', (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.receiptId)
        socket.send(
          JSON.stringify({ type: 'receipt', receiptId: d.receiptId }),
        );
      if (d.type === 'subscribed' || d.operationId === accepted.operationId)
        void read();
    });
    socket.on('error', (error) => finish(error));
  });
}
function errorStatus(code: string) {
  if (code === 'FORBIDDEN') return 403;
  if (code === 'UNAUTHORIZED') return 401;
  if (
    ['SESSION_NOT_FOUND', 'CONTENT_NOT_FOUND', 'PROJECT_NOT_FOUND'].includes(
      code,
    )
  )
    return 404;
  if (['CAPACITY', 'BACKPRESSURE'].includes(code)) return 429;
  if (code === 'MESSAGE_TOO_LARGE') return 413;
  if (code === 'RESULT_UNKNOWN') return 504;
  return 409;
}
