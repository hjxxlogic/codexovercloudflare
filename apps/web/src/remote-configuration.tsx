import { useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { t } from './i18n.ts';
import { configurationTextSchema } from '../../../packages/protocol/src/management.ts';

type Target = {
  id: string;
  kind: 'agent' | 'client';
  path: string;
  pid: number;
  build: { version: string };
};
type Pending = {
  host: string;
  target: string;
  command: Record<string, unknown>;
};

export function RemoteConfiguration({
  hosts,
}: {
  hosts: { id: string; name: string }[];
}) {
  const [host, setHost] = useState('');
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [revision, setRevision] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<Pending>();
  const running = useRef(false);
  const endpoint = (id: string) => `/admin/hosts/${id}/configuration`;

  async function refresh() {
    if (running.current || !host) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api(endpoint(host));
      setTargets(result.targets);
      if (!result.targets.some((item: Target) => item.id === target)) {
        setTarget('');
        setRevision('');
        setText('');
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function execute(request: Pending) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const mutation = request.command.action !== 'read';
    if (mutation) setPending(request);
    try {
      const result = await api(endpoint(request.host), {
        target: request.target,
        command: request.command,
      });
      setRevision(result.revision);
      if (request.command.action === 'read') setText(result.text);
      setMessage(
        request.command.action === 'restart'
          ? t('已确认重启请求。请刷新在线目标，确认重新连接。')
          : request.command.action === 'replace'
            ? t('配置已完整替换，重启后生效。')
            : t('已读取远程配置。'),
      );
      setPending(undefined);
    } catch (cause) {
      setError(String(cause));
      if (
        cause instanceof ApiError &&
        cause.status < 500 &&
        !['RESULT_UNKNOWN', 'TARGET_OFFLINE'].includes(cause.code)
      )
        setPending(undefined);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function command(action: 'read' | 'replace' | 'restart') {
    if (busy || !target || !host) return;
    if (action === 'replace') {
      if (!configurationTextSchema.safeParse(text).success) {
        setError(t('配置不得超过 64 KiB。'));
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        setError(t('配置必须是有效的 JSON。'));
        return;
      }
      if (
        !window.confirm(
          t('完整替换远程配置文件？连接凭据错误可能需要在目标机器上恢复。'),
        )
      )
        return;
    }
    if (
      action === 'restart' &&
      !window.confirm(
        t(
          '重启会中断当前工作。coc-client 会关闭 TUI 并重新执行原启动命令，可能重复执行命令。是否继续？',
        ),
      )
    )
      return;
    void execute({
      host,
      target,
      command:
        action === 'read'
          ? { action }
          : {
              action,
              requestId: crypto.randomUUID(),
              revision,
              ...(action === 'replace' ? { text } : { allowActive: true }),
            },
    });
  }

  return (
    <section
      className="card remote-configuration"
      aria-label={t('远程配置与重启')}
    >
      <h3>{t('远程配置与重启')}</h3>
      <p>
        {t(
          '仅管理员可操作。仅列出支持此功能的在线 Agent 和 coc-client；客户端退出后不可管理。',
        )}
      </p>
      <p>
        {t(
          '配置包含敏感凭据，仅保留在当前页面内存中。完整替换前会校验并在目标机器保留上一份配置备份；启动参数仍优先于文件配置。',
        )}
      </p>
      <label>
        {t('主机')}
        <select
          aria-label={t('主机')}
          value={host}
          disabled={busy || !!pending}
          onChange={(event) => {
            setHost(event.target.value);
            setTarget('');
            setTargets([]);
            setText('');
            setRevision('');
            setMessage('');
            setError('');
          }}
        >
          <option value="">{t('选择主机')}</option>
          {hosts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name || item.id}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!host || busy || !!pending}
        onClick={() => void refresh()}
      >
        {t('刷新在线目标')}
      </button>
      <label>
        {t('在线目标')}
        <select
          aria-label={t('在线目标')}
          value={target}
          disabled={busy || !!pending}
          onChange={(event) => {
            setTarget(event.target.value);
            setText('');
            setRevision('');
            setError('');
            setMessage('');
          }}
        >
          <option value="">{t('选择在线目标')}</option>
          {targets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.kind === 'agent' ? 'coc-agent' : 'coc-client'} ·{' '}
              {item.build.version} · PID {item.pid} · {item.path}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!target || busy || !!pending}
        onClick={() => command('read')}
      >
        {t('读取配置')}
      </button>
      {revision && (
        <>
          <label>
            {t('完整配置 JSON')}
            <textarea
              aria-label={t('完整配置 JSON')}
              spellCheck={false}
              autoComplete="off"
              value={text}
              disabled={busy || !!pending}
              onChange={(event) => setText(event.target.value)}
              rows={18}
            />
          </label>
          <button
            disabled={busy || !!pending}
            onClick={() => command('replace')}
          >
            {t('完整替换配置')}
          </button>
          <button
            disabled={busy || !!pending}
            onClick={() => command('restart')}
          >
            {t('远程重启')}
          </button>
          <button
            disabled={busy || !!pending}
            onClick={() => {
              setText('');
              setRevision('');
              setMessage('');
            }}
          >
            {t('清除页面中的配置')}
          </button>
        </>
      )}
      {pending && !busy && (
        <p>
          {t(
            '请求结果未确认。重试将使用原请求编号；重启回执只表示已接受，不保证进程已恢复。',
          )}
          <code>{String(pending.command.requestId)}</code>
          <button onClick={() => void execute(pending)}>
            {t('重试原请求')}
          </button>
          <button
            onClick={() => {
              if (
                window.confirm(t('放弃确认不会撤销已提交的操作。是否继续？'))
              ) {
                setPending(undefined);
                setRevision('');
                setText('');
              }
            }}
          >
            {t('放弃确认并清除配置')}
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
