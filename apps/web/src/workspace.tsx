import { useEffect, useState } from 'react';
import type { Event } from '../../../packages/protocol/src/index.ts';
import { CopyText, Diff } from './conversation.tsx';

export function WorkspaceHeader({
  host,
  project,
  status,
  onDetails,
}: {
  host: string;
  project: string;
  status: string;
  onDetails: () => void;
}) {
  return (
    <button className="workspace-context" onClick={onDetails}>
      <span>
        {host || '未选择服务器'} / {project || '未选择项目'}
      </span>
      <span role="status">{status}</span>
    </button>
  );
}

export function ApprovalQueue({
  approvals,
  events,
  target,
  ready,
  pending,
  onAnswer,
}: {
  approvals: {
    approvalId: string;
    method: string;
    params: Record<string, unknown>;
  }[];
  events: Event[];
  target: string;
  ready: boolean;
  pending: boolean;
  onAnswer: (id: string, allow: boolean) => void;
}) {
  const [index, setIndex] = useState(0);
  useEffect(
    () => setIndex((v) => Math.min(v, Math.max(0, approvals.length - 1))),
    [approvals.length],
  );
  if (!approvals.length) return null;
  const approval = approvals[Math.min(index, approvals.length - 1)];
  const params = approval.params;
  const command =
    typeof params.command === 'string' ? params.command : undefined;
  const reason = typeof params.reason === 'string' ? params.reason : undefined;
  const cwd = typeof params.cwd === 'string' ? params.cwd : undefined;
  const grantRoot =
    typeof params.grantRoot === 'string' ? params.grantRoot : undefined;
  const fileItem = [...events].reverse().find((event) => {
    const item = (event.data as { item?: Record<string, unknown> })?.item;
    return (
      typeof params.itemId === 'string' &&
      item?.id === params.itemId &&
      item?.type === 'fileChange'
    );
  })?.data as { item?: { changes?: unknown[] } } | undefined;
  const changes = Array.isArray(fileItem?.item?.changes)
    ? fileItem.item.changes.filter(
        (
          change,
        ): change is {
          path: string;
          diff: string;
          kind?: { type?: string; move_path?: string };
        } =>
          !!change &&
          typeof change === 'object' &&
          typeof (change as Record<string, unknown>).path === 'string' &&
          typeof (change as Record<string, unknown>).diff === 'string',
      )
    : [];
  return (
    <section className="approval-queue" aria-label="待确认请求">
      <div className="approval-heading">
        <strong>
          等待你的确认 · {index + 1} / {approvals.length}
        </strong>
        {approvals.length > 1 && (
          <div className="row">
            <button disabled={index === 0} onClick={() => setIndex(index - 1)}>
              上一项
            </button>
            <button
              disabled={index >= approvals.length - 1}
              onClick={() => setIndex(index + 1)}
            >
              下一项
            </button>
          </div>
        )}
      </div>
      <div className="approval-body">
        <h3>
          {approval.method === 'item/fileChange/requestApproval'
            ? '请求修改文件'
            : '请求运行命令'}
        </h3>
        <p>
          {target}
          {cwd ? ` · ${cwd}` : ''}
        </p>
        {reason && <p>{reason}</p>}
        {command && (
          <>
            <pre tabIndex={0}>{command}</pre>
            <CopyText text={command} />
          </>
        )}
        {grantRoot && <p>请求写入范围：{grantRoot}</p>}
        {changes.map((change, position) => (
          <details key={`${change.path}:${position}`}>
            <summary>
              {change.path} ·{' '}
              {change.kind?.type === 'add'
                ? '新增'
                : change.kind?.type === 'delete'
                  ? '删除'
                  : '修改'}
              {change.kind?.move_path ? ` → ${change.kind.move_path}` : ''}
            </summary>
            <Diff text={change.diff} />
          </details>
        ))}
        {approval.method === 'item/fileChange/requestApproval' &&
          !changes.length && <p>当前请求未附带可显示的文件变更明细。</p>}
        <details>
          <summary>请求技术详情</summary>
          <pre tabIndex={0}>{JSON.stringify(params, null, 2)}</pre>
        </details>
      </div>
      <div className="approval-actions">
        <button
          disabled={!ready || pending}
          onClick={() => onAnswer(approval.approvalId, false)}
        >
          拒绝
        </button>
        <button
          className="primary"
          disabled={!ready || pending}
          onClick={() => onAnswer(approval.approvalId, true)}
        >
          允许本次
        </button>
        {pending && <span role="status">正在提交决定…</span>}
        {!ready && <small>连接恢复后可提交决定；可在下方停止任务。</small>}
      </div>
    </section>
  );
}
