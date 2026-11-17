import { useRef, useState } from 'react';
import { z } from 'zod';
import { version as webVersion } from '../../../package.json';
import { api } from './api.ts';
import { t } from './i18n.ts';

const releaseSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  protocol: z.literal(1),
});

export function AgentUpdates() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');

  async function notify() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setVersion('');
    try {
      const response = await fetch('/downloads/index.json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok || response.redirected)
        throw new Error(t('无法读取已发布版本，请稍后重试。'));
      const parsed = releaseSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new Error(t('无法读取已发布版本，请稍后重试。'));
      const release = parsed.data;
      await api('/admin/releases', {
        version: release.version,
        commit: release.commit,
      });
      setVersion(release.version);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('更新通知失败，请重试。'),
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label={t('Agent 更新')}>
      <h3>{t('Agent 更新')}</h3>
      <p>
        {t(
          '网页版本：{0}。Agent 更新使用单独发布的下载版本，可能与网页版本不同。',
          webVersion,
        )}
      </p>
      <p>
        {t(
          '通知所有已授权 Agent 检查已发布版本。仅启用自动更新的 Agent 会升级，并等待所有会话结束；相同版本不重复通知。',
        )}
      </p>
      <button disabled={busy} onClick={() => void notify()}>
        {busy ? t('正在发送更新通知…') : t('通知所有 coc-agent 更新')}
      </button>
      {version && (
        <p role="status">
          {t(
            '已提交 Agent {0} 更新通知；目标版本来自已发布的 Agent 下载包。',
            version,
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
