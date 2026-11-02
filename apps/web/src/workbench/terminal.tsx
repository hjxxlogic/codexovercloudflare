import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, queryApi, ApiError } from '../api.ts';
import type { OperationClient } from '../operations.ts';
import type { ControlProof } from '../../../../packages/protocol/src/index.ts';
import { t } from '../i18n.ts';
import { FullscreenButton } from './fullscreen.tsx';
type Props = {
  host: string;
  project: string;
  session?: string;
  control?: ControlProof;
  operations?: OperationClient | null;
  enabled: boolean;
  visible: boolean;
  close: () => void;
};
export default function InteractiveTerminal({
  host,
  project,
  session,
  control,
  operations,
  enabled,
  visible,
  close,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>(null);
  const fit = useRef<FitAddon>(null);
  const [metadata, setMetadata] = useState<{
    enabled: boolean;
    deliveryInstance: string;
  }>();
  const [error, setError] = useState('');
  const [runtime, setRuntime] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const pending = useRef<
    { id: string; body: Record<string, unknown> } | undefined
  >(undefined);
  const next = useRef(1),
    offset = useRef(0);
  const queue = useRef('');
  const sending = useRef(false);
  const active = useRef(true);
  const path = `/hosts/${host}/terminal`;
  const scope = () => ({ projectId: project, sessionId: session, control });
  useEffect(() => {
    const controller = new AbortController();
    void queryApi(
      path,
      { operation: 'info', projectId: project },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setMetadata(data);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [host, project, path]);
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 3000,
      fontSize: 13,
      allowProposedApi: false,
      disableStdin: true,
      theme: { background: '#11151c', foreground: '#e8edf5' },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    terminal.current = term;
    fit.current = addon;
    term.open(container.current!);
    // Do not install link or clipboard addons. OSC clipboard writes stay disabled.
    term.parser.registerOscHandler(52, () => true);
    const resize = new ResizeObserver(() => {
      if (container.current?.offsetWidth) addon.fit();
    });
    resize.observe(container.current!);
    return () => {
      active.current = false;
      resize.disconnect();
      term.dispose();
    };
  }, []);
  useEffect(() => {
    if (visible) requestAnimationFrame(() => fit.current?.fit());
  }, [visible]);
  useEffect(() => {
    if (terminal.current)
      terminal.current.options.disableStdin = !connected || !enabled;
  }, [connected, enabled]);
  useEffect(() => {
    if (!runtime || !enabled || !control) {
      setConnected(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await queryApi(
          path,
          {
            ...scope(),
            operation: 'read',
            terminalId: runtime,
            offset: offset.current,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.gap) terminal.current?.writeln('\r\n' + t('终端输出已截断'));
        if (result.data)
          terminal.current?.write(
            Uint8Array.from(atob(result.data), (ch) => ch.charCodeAt(0)),
          );
        offset.current = result.offset;
        next.current = Math.max(next.current, result.next);
        if (result.exited && !result.more) {
          setConnected(false);
          terminal.current?.writeln(`\r\n${t('退出码：')}${result.exitCode}`);
          return;
        }
        setConnected(!result.exited);
        timer = setTimeout(() => void read(), result.more ? 0 : 500);
      } catch (e: unknown) {
        if (!controller.signal.aborted) {
          setConnected(false);
          setError(String(e));
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // Controller changes invalidate all outstanding terminal reads.
  }, [runtime, enabled, host, project, session, control, retry]);
  useEffect(() => {
    const term = terminal.current;
    if (!term || !runtime || !enabled || !connected) return;
    const controller = new AbortController();
    async function send(data: Record<string, unknown>) {
      const result = await api(
        path,
        { ...scope(), terminalId: runtime, seq: next.current, ...data },
        controller.signal,
      );
      if (!controller.signal.aborted)
        next.current = Math.max(next.current, result.next);
    }
    const input = term.onData((value) => {
      if (value.includes('\n') || (value.length > 1 && value.includes('\r'))) {
        if (!confirm(t('将多行文本粘贴到远程终端？其中可能包含命令。'))) return;
      }
      if (new TextEncoder().encode(queue.current + value).length > 4096) {
        setError(t('终端输入队列已满'));
        return;
      }
      queue.current += value;
    });
    let size = {
      cols: Math.min(term.cols, 500),
      rows: Math.min(term.rows, 500),
    };
    let resizePending = true;
    const timer = setInterval(() => {
      if (sending.current || (!queue.current && !resizePending)) return;
      const value = queue.current;
      queue.current = '';
      sending.current = true;
      // Input remains memory-only; unknown writes are never replayed.
      let request: Record<string, unknown>;
      if (value) {
        const bytes = new TextEncoder().encode(value);
        request = {
          operation: 'input',
          data: btoa(
            Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''),
          ),
        };
      } else {
        resizePending = false;
        request = { operation: 'resize', ...size };
      }
      void send(request)
        .catch((e: unknown) => {
          if (!controller.signal.aborted) {
            setError(String(e));
            setConnected(false);
          }
        })
        .finally(() => {
          sending.current = false;
        });
    }, 100);
    const resized = term.onResize(({ cols, rows }) => {
      if (cols < 2 || rows < 2) return;
      size = { cols: Math.min(cols, 500), rows: Math.min(rows, 500) };
      resizePending = true;
    });
    return () => {
      controller.abort();
      clearInterval(timer);
      input.dispose();
      resized.dispose();
      queue.current = '';
    };
  }, [runtime, enabled, connected, control, host, project, session]);
  async function original(operation: 'open' | 'close') {
    if (!operations || !metadata || !enabled || !session || !control) return;
    if (!pending.current)
      pending.current = {
        id: crypto.randomUUID(),
        body: {
          ...scope(),
          operation,
          ...(operation === 'close'
            ? { terminalId: runtime }
            : {
                cols: terminal.current?.cols || 80,
                rows: terminal.current?.rows || 24,
              }),
        },
      };
    setStarting(true);
    setError('');
    try {
      const result = await operations.submit(
        path,
        pending.current.body,
        pending.current.id,
        { terminal: operation },
        metadata.deliveryInstance,
      );
      pending.current = undefined;
      if (!active.current) return;
      if (operation === 'open') {
        next.current = result.next;
        offset.current = 0;
        setRuntime(result.terminalId);
      } else {
        setRuntime(undefined);
        setConnected(false);
      }
    } catch (e: unknown) {
      if (
        e instanceof ApiError &&
        !['RESULT_UNKNOWN', 'RESULT_PENDING', 'BACKPRESSURE'].includes(e.code)
      )
        pending.current = undefined;
      if (active.current) setError(String(e));
    } finally {
      if (active.current) setStarting(false);
    }
  }
  return (
    <section
      className="interactive-terminal"
      hidden={!visible}
      aria-label="Terminal"
    >
      <header className="pane-heading">
        <h2>Terminal · {connected ? t('已连接') : t('未连接')}</h2>
        <FullscreenButton pane="terminal" />
        <button onClick={close}>{t('收起')}</button>
      </header>
      <p className="terminal-scope">
        {host} / {project} · {t('隔离项目终端；终端存活期间助手任务互斥。')}
      </p>
      {!metadata?.enabled && (
        <p role="status">
          {t(
            '交互终端需要启用 Linux Agent 的 terminal.enabled 并安装 bubblewrap。',
          )}
        </p>
      )}
      {!enabled && (
        <p role="status">{t('终端需要当前项目写权限和空闲的助手会话。')}</p>
      )}
      <div className="row">
        <button
          disabled={!metadata?.enabled || !enabled || starting || !!runtime}
          onClick={() => {
            if (
              confirm(
                t('打开隔离 Shell？可以修改项目文件，且会占用项目执行权限。'),
              )
            )
              void original('open');
          }}
        >
          {pending.current?.body.operation === 'open'
            ? t('重试原请求')
            : t('打开终端')}
        </button>
        <button
          disabled={!runtime || starting || !enabled}
          onClick={() => {
            if (confirm(t('终止终端及其子进程？'))) void original('close');
          }}
        >
          {t('终止终端')}
        </button>
        <button
          disabled={!runtime || connected || !enabled}
          onClick={() => {
            setError('');
            setRetry(retry + 1);
          }}
        >
          {t('重新连接')}
        </button>
        <button onClick={() => terminal.current?.clear()}>{t('清屏')}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div ref={container} className="xterm-container" />
    </section>
  );
}
