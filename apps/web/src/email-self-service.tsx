import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { t } from './i18n.ts';

export function EmailSelfServiceSettings() {
  const [settings, setSettings] = useState<{
    enabled: boolean;
    configured: boolean;
  }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void api('/admin/email-self-service')
      .then(setSettings)
      .catch((error) => setMessage(String(error)));
  }, []);
  async function save(enabled: boolean) {
    const previous = settings;
    setSettings((value) => (value ? { ...value, enabled } : value));
    setBusy(true);
    setMessage('');
    try {
      setSettings(await api('/admin/email-self-service', { enabled }));
      setMessage(t('邮箱自助授权设置已保存'));
    } catch (error) {
      setSettings(previous);
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>{t('邮箱自助授权')}</h3>
      <p>
        {t(
          '开启后，已验证邮箱可自行批准 Agent 注册及同邮箱客户端配对。Agent 管理邮箱固定为批准者邮箱。',
        )}
      </p>
      <label>
        <input
          type="checkbox"
          checked={settings?.enabled ?? false}
          disabled={busy || !settings?.configured}
          onChange={(event) => void save(event.target.checked)}
        />
        {t('允许同邮箱免管理员审批')}
      </label>
      {settings && !settings.configured && (
        <p>{t('请先配置 SETTINGS KV 绑定。')}</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function AgentSetup({ selfService }: { selfService: boolean }) {
  return (
    <section className="card agent-setup">
      <h2>{t('配置你的 coc-agent')}</h2>
      <p>
        {t(
          '当前邮箱尚未配置自己的 Agent。请在运行 Codex 的电脑上完成以下步骤。',
        )}
      </p>
      <ol>
        <li>
          {t('安装并登录 Codex，下载适合系统的 CoC 程序并加入 PATH。')}{' '}
          <a href="/downloads/">{t('下载程序')}</a>
        </li>
        <li>
          {t(
            selfService
              ? '运行登录命令，用当前邮箱打开终端中的链接，核对配对码并批准注册。'
              : '运行登录命令，将配对码交给管理员批准。',
          )}
          <pre>
            <code>{`coc-agent login --relay ${location.origin}`}</code>
          </pre>
          <p>
            {t(
              '测试站若需要专用 Access 配置，请使用站点提供的文件，并在登录命令后添加 --access-config /path/to/access.json。',
            )}
          </p>
        </li>
        <li>
          {t('在项目目录登记项目，然后启动 Agent。')}
          <pre>
            <code>
              {'coc-agent project add . --name "My project"\ncoc-agent run'}
            </code>
          </pre>
        </li>
        <li>{t('返回本页刷新，即可选择自己的服务器和项目。')}</li>
      </ol>
    </section>
  );
}

export function DeviceAuthorization({
  id,
  changed,
}: {
  id: string;
  changed: () => Promise<void>;
}) {
  const [request, setRequest] = useState<{
    name: string;
    role: string;
    hostId?: string;
  }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void api(`/auth/device/${id}/authorize`)
      .then(setRequest)
      .catch((error) => setMessage(String(error)));
  }, [id]);
  async function decide(decision: string) {
    setBusy(true);
    setMessage('');
    try {
      await api(`/auth/device/${id}/authorize`, { code, decision });
      setRequest(undefined);
      setMessage(t('设备配对已处理'));
      await changed();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>{t('确认设备配对')}</h2>
      <p>{t('仅批准你刚刚在自己电脑上发起的请求。请输入终端显示的配对码。')}</p>
      {request && (
        <>
          <p>
            {request.name} ·{' '}
            {request.role === 'agent' ? t('服务器 Agent') : t('命令行客户端')}{' '}
            {request.hostId}
          </p>
          {request.role === 'agent' && (
            <p>{t('批准后，当前已验证邮箱将成为此 Agent 的管理邮箱。')}</p>
          )}
          <label>
            {t('终端配对码')}
            <input
              value={code}
              maxLength={8}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
            />
          </label>
          <button
            disabled={busy || code.length !== 8}
            onClick={() => void decide('approve')}
          >
            {t('批准')}
          </button>
          <button
            disabled={busy || code.length !== 8}
            onClick={() => void decide('reject')}
          >
            {t('拒绝')}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
