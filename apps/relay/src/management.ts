import { AppError, MAX_QUEUE } from '../../../packages/protocol/src/index.ts';

// This channel deliberately has no Durable Object storage dependency. Configuration
// bodies and replies exist only in a live HTTP request and the native endpoint.
export class ManagementRequests {
  private bytes = 0;
  private pending = new Map<
    string,
    {
      socket: WebSocket;
      finish: (reply: any) => void;
    }
  >();

  request(socket: WebSocket, command: unknown): Promise<any> {
    const bytes = new TextEncoder().encode(JSON.stringify(command)).length;
    if (this.bytes + bytes > MAX_QUEUE || this.pending.size >= 128)
      throw new AppError('OVERLOADED', 'Management requests are busy', 429);
    const wire = crypto.randomUUID();
    this.bytes += bytes;
    return new Promise((resolve, reject) => {
      const finish = (reply: any) => {
        if (!this.pending.delete(wire)) return;
        clearTimeout(timer);
        this.bytes -= bytes;
        if (reply.error)
          reject(
            new AppError(
              reply.error.code || 'MANAGEMENT_FAILED',
              reply.error.message || 'Management request failed',
              409,
            ),
          );
        else resolve(reply.result);
      };
      const timer = setTimeout(
        () =>
          finish({
            error: {
              code: 'RESULT_UNKNOWN',
              message:
                'No acknowledgement; retry the same request ID to avoid repeating the operation',
            },
          }),
        20000,
      );
      this.pending.set(wire, { socket, finish });
      try {
        socket.send(
          JSON.stringify({ type: 'management-request', wire, data: command }),
        );
      } catch {
        finish({
          error: {
            code: 'TARGET_OFFLINE',
            message: 'Target disconnected; operation result is unknown',
          },
        });
      }
    });
  }

  reply(socket: WebSocket, reply: any) {
    const pending = this.pending.get(reply.wire);
    if (pending?.socket === socket) pending.finish(reply);
  }
}
