import { recoveryDelay } from './recovery.ts';
import { api, ApiError, retryable } from './api.ts';
import type { HistoryCache } from './history.ts';
import type { OperationClient } from './operations.ts';

const key = 'delivery-outbox-upload:v2';
const chunkSize = 65536;
export type UploadRecord = {
  id: string;
  host: string;
  project: string;
  path: string;
  size: number;
  overwrite: boolean;
  sha256: string;
  digest: string;
  chunks?: string[];
  instance?: string;
  phase:
    'queued' | 'uploading' | 'finishing' | 'completed' | 'failed' | 'unknown';
  result?: { state: string; size: number; sha256: string };
  error?: string;
};
type State = { version: 2; records: UploadRecord[] };
type Journal = Pick<HistoryCache, 'record' | 'updateRecord'>;
const mismatch = (message: string) =>
  new ApiError('DELIVERY_STATE_MISMATCH', message, 409);
function state(input: any): State {
  if (input == null) return { version: 2, records: [] };
  if (
    input.version !== 2 ||
    !Array.isArray(input.records) ||
    input.records.length > 128 ||
    new Set(input.records.map((r: any) => r?.id)).size !==
      input.records.length ||
    input.records.some(
      (r: any) =>
        !r ||
        typeof r.id !== 'string' ||
        ![
          'queued',
          'uploading',
          'finishing',
          'completed',
          'failed',
          'unknown',
        ].includes(r.phase),
    )
  )
    throw mismatch('Invalid durable upload journal');
  return input;
}
export async function uploadRecords(journal: Journal): Promise<UploadRecord[]> {
  return state(await journal.record(key)).records;
}
async function update(
  journal: Journal,
  id: string,
  change: (record: UploadRecord) => void,
) {
  await journal.updateRecord(key, (previous) => {
    const current = state(previous);
    const record = current.records.find((entry) => entry.id === id);
    if (!record) throw mismatch('Original upload identity disappeared');
    change(record);
    return current;
  });
}
async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
async function intentionDigest(record: Omit<UploadRecord, 'digest' | 'phase'>) {
  return sha256(
    new TextEncoder().encode(
      JSON.stringify({
        id: record.id,
        host: record.host,
        project: record.project,
        path: record.path,
        size: record.size,
        overwrite: record.overwrite,
        sha256: record.sha256,
      }),
    ),
  );
}
export async function prepareUpload(
  journal: Journal,
  operations: OperationClient,
  file: Blob,
  options: Pick<UploadRecord, 'host' | 'project' | 'path' | 'overwrite'>,
  signal: AbortSignal,
): Promise<string> {
  if (
    file.size > 20 * 1024 * 1024 ||
    !options.path ||
    options.path.length > 4096
  )
    throw new ApiError(
      'MESSAGE_TOO_LARGE',
      'Upload exceeds its reserved slot',
      413,
    );
  // Shared peer/global locks bound file materialization before the IndexedDB admission.
  return operations.exchange(signal, async () => {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256(bytes);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      let binary = '';
      for (const byte of bytes.subarray(offset, offset + chunkSize))
        binary += String.fromCharCode(byte);
      chunks.push(btoa(binary));
    }
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    const original = { ...options, id, size: file.size, sha256: hash };
    const digest = await intentionDigest(original);
    await journal.updateRecord(key, (previous) => {
      const current = state(previous);
      if (
        current.records.length >= 128 ||
        current.records.some(
          (r) => r.phase !== 'completed' && r.phase !== 'failed',
        )
      )
        throw new ApiError(
          'BACKPRESSURE',
          'Resolve the original pending upload before creating another intention',
          429,
        );
      current.records.push({ ...original, digest, chunks, phase: 'queued' });
      return current;
    });
    return id;
  });
}
function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function resumeUpload(
  journal: Journal,
  operations: OperationClient,
  id: string,
  signal: AbortSignal,
  progress: (offset: number, total: number) => void = () => {},
): Promise<UploadRecord['result']> {
  if (!navigator.locks)
    throw new ApiError(
      'STORAGE_REQUIRED',
      'Upload recovery requires Web Locks',
      409,
    );
  return navigator.locks.request(
    'coc-upload-peer:' + operations.peerKey,
    { signal },
    async () => {
      let record = (await uploadRecords(journal)).find((r) => r.id === id);
      if (!record) throw mismatch('Unknown original upload');
      if (record.phase === 'completed') return record.result;
      if (record.phase === 'failed')
        throw new ApiError(
          'UPLOAD_FAILED',
          record.error || 'Original upload failed',
          409,
        );
      if (record.phase === 'unknown')
        throw new ApiError(
          'RESULT_UNKNOWN',
          record.error ||
            'Reconcile the original upload before a new intention',
          409,
        );
      try {
        // Reconstruct and verify the fixed body once, before any write or result confirmation.
        if (
          !Number.isSafeInteger(record.size) ||
          record.size < 0 ||
          record.size > 20 * 1024 * 1024 ||
          !Array.isArray(record.chunks) ||
          record.chunks.length !== Math.ceil(record.size / chunkSize)
        )
          throw mismatch('Original upload body is missing');
        if ((await intentionDigest(record)) !== record.digest)
          throw mismatch('Original upload target changed');
        const bytes = new Uint8Array(record.size);
        for (let index = 0; index < record.chunks.length; index++) {
          if (
            typeof record.chunks[index] !== 'string' ||
            record.chunks[index].length > 87384
          )
            throw mismatch('Invalid original upload chunk');
          let binary: string;
          try {
            binary = atob(record.chunks[index]);
          } catch {
            throw mismatch('Invalid original upload encoding');
          }
          if (
            binary.length !==
              Math.min(chunkSize, record.size - index * chunkSize) ||
            btoa(binary) !== record.chunks[index]
          )
            throw mismatch('Original upload chunk changed');
          for (let i = 0; i < binary.length; i++)
            bytes[index * chunkSize + i] = binary.charCodeAt(i);
        }
        if ((await sha256(bytes)) !== record.sha256)
          throw mismatch('Original upload checksum changed');
        signal.throwIfAborted();
        const endpoint = `/hosts/${record.host}/files`;
        if (record.phase === 'queued') {
          const previous = (await operations.records()).find(
            (r) => r.requestId === id + '-begin',
          );
          // An acknowledged HTTP result can leave its bounded tail before this
          // journal commits. Its retained identity still pins the staging lookup.
          if (!(previous?.state === 'confirmed' && !previous.result))
            await operations.submit(
              endpoint,
              {
                operation: 'begin',
                projectId: record.project,
                uploadId: id,
                path: record.path,
                size: record.size,
                overwrite: record.overwrite,
                sha256: record.sha256,
              },
              id + '-begin',
              { kind: 'upload-begin', uploadId: id },
              undefined,
              signal,
            );
          signal.throwIfAborted();
          const original = (await operations.records()).find(
            (r) => r.requestId === id + '-begin',
          );
          if (!original?.instance)
            throw mismatch('Upload receiver binding is missing');
          const instance = original.agentInstance ?? original.instance;
          await update(journal, id, (current) => {
            if (current.phase !== 'queued')
              throw mismatch('Original upload changed during begin');
            current.instance = instance;
            current.phase = 'uploading';
          });
          record = {
            ...record,
            instance,
            phase: 'uploading',
          };
        }
        if (!record.instance)
          throw mismatch('Original upload receiver binding is missing');
        const raw = async (data: Record<string, unknown>) => {
          let attempts = 0;
          for (;;) {
            signal.throwIfAborted();
            try {
              return await operations.exchange(signal, () =>
                api(
                  endpoint,
                  {
                    ...data,
                    projectId: record!.project,
                    uploadId: id,
                    agentInstance: record!.instance,
                  },
                  signal,
                ),
              );
            } catch (error) {
              signal.throwIfAborted();
              if (
                !retryable(error) &&
                !(
                  error instanceof ApiError &&
                  [
                    'RESULT_UNKNOWN',
                    'HOST_OFFLINE',
                    'AGENT_NEGOTIATING',
                  ].includes(error.code)
                )
              )
                throw error;
              const delay = recoveryDelay(attempts);
              attempts = Math.min(3, attempts + 1);
              await wait(delay, signal);
            }
          }
        };
        if (record.phase === 'uploading') {
          const remote = await raw({ operation: 'status' });
          if (remote.state !== 'completed') {
            if (
              remote.state !== 'uploading' ||
              !Number.isSafeInteger(remote.offset) ||
              remote.offset < 0 ||
              remote.offset > record.size ||
              (remote.offset !== record.size && remote.offset % chunkSize !== 0)
            )
              throw new ApiError(
                'UPLOAD_RECONCILIATION_REQUIRED',
                'Original staging state is unavailable; reconcile its target file',
                409,
              );
            for (
              let offset = remote.offset;
              offset < record.size;
              offset += chunkSize
            ) {
              const chunk = await raw({
                operation: 'chunk',
                offset,
                data: record.chunks![offset / chunkSize],
              });
              if (
                !Number.isSafeInteger(chunk.offset) ||
                chunk.offset < Math.min(offset + chunkSize, record.size) ||
                chunk.offset > record.size ||
                (chunk.offset !== record.size && chunk.offset % chunkSize !== 0)
              )
                throw mismatch('Invalid durable upload chunk boundary');
              progress(Math.min(offset + chunkSize, record.size), record.size);
            }
          }
          signal.throwIfAborted();
          await update(journal, id, (current) => {
            current.phase = 'finishing';
          });
          record.phase = 'finishing';
        }
        signal.throwIfAborted();
        const finish = (await operations.records()).find(
          (r) => r.requestId === id + '-finish',
        );
        const result =
          finish?.state === 'confirmed' && !finish.result
            ? await raw({ operation: 'status' })
            : await operations.submit(
                endpoint,
                {
                  operation: 'finish',
                  projectId: record.project,
                  uploadId: id,
                  agentInstance: record.instance,
                  sha256: record.sha256,
                },
                id + '-finish',
                {
                  kind: 'upload-finish',
                  sha256: record.sha256,
                  size: record.size,
                },
                record.instance,
                signal,
              );
        if (
          result?.state !== 'completed' ||
          result?.sha256 !== record.sha256 ||
          result?.size !== record.size
        )
          throw mismatch(
            'Published file does not match the original intention',
          );
        await update(journal, id, (current) => {
          current.phase = 'completed';
          current.result = result;
          delete current.chunks;
        });
        return result;
      } catch (error) {
        if (signal.aborted) throw error;
        if (record.phase === 'queued') {
          const original = (await operations.records().catch(() => [])).find(
            (entry) => entry.requestId === id + '-begin',
          );
          if (
            original?.result?.error &&
            original.result.error.code !== 'RESULT_UNKNOWN'
          )
            await update(journal, id, (current) => {
              current.phase = 'failed';
              current.error = original.result!.error!.message;
              delete current.chunks;
            }).catch(() => {});
        }
        // Transport uncertainty retries above; an endpoint terminal or storage conflict pauses the fixed intention.
        if (
          error instanceof ApiError &&
          [
            'DELIVERY_STATE_MISMATCH',
            'RESULT_UNKNOWN',
            'RESULT_UNAVAILABLE',
            'UPLOAD_RECONCILIATION_REQUIRED',
          ].includes(error.code)
        )
          await update(journal, id, (current) => {
            current.phase = 'unknown';
            current.error = error.message;
          }).catch(() => {});
        throw error;
      }
    },
  );
}
