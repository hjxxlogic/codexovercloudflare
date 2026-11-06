import { useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icon.tsx';
import { IconButton } from './icon-button.tsx';
import { t } from '../i18n.ts';

type Level = 'hosts' | 'projects' | 'sessions';
type Host = { id: string; name: string; online: boolean };
type Project = { id: string; name: string; path: string; available?: boolean };
export function WorkspaceNavigation({
  hosts,
  projects,
  host,
  project,
  session,
  sessionTitle,
  locked,
  refreshing,
  refresh,
  onHost,
  onProject,
  authorization,
  requestAuthorization,
  projectAction,
  children,
}: {
  hosts: Host[];
  projects: Project[];
  host: string;
  project: string;
  session?: string;
  sessionTitle?: string;
  locked: boolean;
  refreshing: boolean;
  refresh: () => void;
  onHost: (host: string) => void;
  onProject: (project: string) => void;
  authorization: ReactNode;
  requestAuthorization: () => void;
  projectAction: ReactNode;
  children: ReactNode;
}) {
  const [active, setActive] = useState<Level>('hosts');
  const currentHost = hosts.find((item) => item.id === host);
  const currentProject =
    currentHost &&
    projects.find((item) => item.id === project && item.available !== false);
  const valid = {
    hosts: true,
    projects: !!currentHost,
    sessions: !!currentProject,
  };
  const expanded = valid[active] ? active : currentHost ? 'projects' : 'hosts';
  useEffect(() => {
    if (session && currentProject) setActive('sessions');
  }, [session, !!currentProject]);
  const levels: {
    id: Level;
    label: string;
    icon: IconName;
    selection?: string;
  }[] = [
    {
      id: 'hosts',
      label: t('主机'),
      icon: 'devices',
      selection: currentHost?.name,
    },
    {
      id: 'projects',
      label: t('项目'),
      icon: 'folder',
      selection: currentProject?.name,
    },
    { id: 'sessions', label: t('会话'), icon: 'chat', selection: sessionTitle },
  ];
  return (
    <div className="workspace-navigation">
      {levels.map((level) => (
        <section className="navigation-level" key={level.id}>
          <h2>
            <button
              id={`navigation-${level.id}-heading`}
              aria-label={t('选择{0}', level.label)}
              aria-expanded={expanded === level.id}
              aria-controls={`navigation-${level.id}`}
              disabled={!valid[level.id]}
              onClick={() => setActive(level.id)}
            >
              <Icon name={level.icon} />
              <span>
                {level.label}
                <small>{level.selection || t('未选择')}</small>
              </span>
              <Icon
                name="chevron"
                style={{
                  transform:
                    expanded === level.id ? 'rotate(90deg)' : undefined,
                }}
              />
            </button>
          </h2>
          <div
            className="navigation-level-body"
            id={`navigation-${level.id}`}
            role="region"
            aria-labelledby={`navigation-${level.id}-heading`}
            hidden={expanded !== level.id}
          >
            {level.id === 'hosts' && (
              <>
                <div className="navigation-list" aria-label={t('主机列表')}>
                  {hosts.map((item) => (
                    <button
                      className="navigation-option"
                      data-host-id={item.id}
                      key={item.id}
                      aria-pressed={item.id === host}
                      disabled={locked}
                      onClick={() => {
                        onHost(item.id);
                        setActive('projects');
                      }}
                    >
                      <span>
                        {item.name}
                        <small>{item.online ? t('在线') : t('离线')}</small>
                      </span>
                      {item.id === host && <Icon name="check" />}
                    </button>
                  ))}
                  {!hosts.length && (
                    <p className="empty-hint">{t('尚无已授权主机')}</p>
                  )}
                </div>
                <div className="navigation-level-actions">
                  <IconButton
                    icon="refresh"
                    label={t('刷新主机')}
                    disabled={refreshing}
                    onClick={refresh}
                  />
                  <IconButton
                    icon="shield"
                    label={t('申请授权')}
                    onClick={requestAuthorization}
                  />
                </div>
                {authorization}
              </>
            )}
            {level.id === 'projects' && (
              <>
                <div className="navigation-list" aria-label={t('项目列表')}>
                  {projects.map((item) => (
                    <button
                      key={item.id}
                      data-project-id={item.id}
                      className="navigation-option"
                      aria-pressed={item.id === project}
                      disabled={locked || item.available === false}
                      onClick={() => {
                        onProject(item.id);
                        setActive('sessions');
                      }}
                    >
                      <span>
                        {item.name}
                        <small>{item.path}</small>
                      </span>
                      {item.id === project && <Icon name="check" />}
                    </button>
                  ))}
                  {!projects.length && (
                    <p className="empty-hint">{t('尚未登记项目')}</p>
                  )}
                </div>
                <div className="navigation-project-action">{projectAction}</div>
              </>
            )}
            {level.id === 'sessions' && children}
          </div>
        </section>
      ))}
    </div>
  );
}
