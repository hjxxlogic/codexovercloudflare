import { useEffect, useState } from 'react';
import { queryApi } from '../api.ts';
import { t } from '../i18n.ts';
export type Entry = { name: string; directory: boolean; size: number };
export function Explorer({
  host,
  project,
  open,
  upload,
}: {
  host: string;
  project: string;
  open: (path: string) => void;
  upload: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [generation, setGeneration] = useState(0);
  const [sort, setSort] = useState('name');
  return (
    <section
      className="explorer"
      aria-label={t('文件浏览器')}
      onKeyDown={(event) => {
        const target = event.target;
        if (
          !(target instanceof HTMLButtonElement) ||
          !target.classList.contains('explorer-entry')
        )
          return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '.explorer-entry',
          ),
        );
        const index = buttons.indexOf(target);
        let next: HTMLButtonElement | undefined;
        if (event.key === 'ArrowDown') next = buttons[index + 1];
        else if (event.key === 'ArrowUp') next = buttons[index - 1];
        else if (event.key === 'Home') next = buttons[0];
        else if (event.key === 'End') next = buttons.at(-1);
        else if (event.key === 'ArrowRight') {
          if (target.getAttribute('aria-expanded') === 'false') target.click();
          else if (target.getAttribute('aria-expanded') === 'true')
            next = buttons[index + 1];
        } else if (event.key === 'ArrowLeft') {
          if (target.getAttribute('aria-expanded') === 'true') target.click();
          else
            next =
              target
                .closest('ul')
                ?.closest('li')
                ?.querySelector<HTMLButtonElement>(':scope > button') ||
              undefined;
        } else return;
        event.preventDefault();
        next?.focus();
      }}
    >
      <header className="pane-heading">
        <h2>{t('文件浏览器')}</h2>
        <button onClick={() => setGeneration(generation + 1)}>
          {t('刷新')}
        </button>
      </header>
      <input
        aria-label={t('筛选已加载项')}
        placeholder={t('筛选已加载项')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <select
        aria-label={t('排序已加载项')}
        value={sort}
        onChange={(event) => setSort(event.target.value)}
      >
        <option value="name">{t('按名称')}</option>
        <option value="size">{t('按大小')}</option>
      </select>
      <button onClick={upload}>{t('上传 / 传输')}</button>
      {host && project ? (
        <Directory
          key={`${host}:${project}:${generation}`}
          host={host}
          project={project}
          path=""
          filter={filter}
          sort={sort}
          open={open}
          depth={0}
        />
      ) : (
        <p>{t('请先选择项目')}</p>
      )}
    </section>
  );
}
function Directory({
  host,
  project,
  path,
  filter,
  sort,
  open,
  depth,
}: {
  host: string;
  project: string;
  path: string;
  filter: string;
  sort: string;
  open: (path: string) => void;
  depth: number;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void queryApi(
      `/hosts/${host}/files`,
      { projectId: project, operation: 'list', path, after: page },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setEntries((old) =>
          page
            ? [
                ...old,
                ...result.entries.filter(
                  (entry: Entry) => !old.some((v) => v.name === entry.name),
                ),
              ]
            : result.entries,
        );
        setNext(result.next);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [host, project, path, page, retry]);
  return (
    <ul
      className="directory"
      aria-label={path || t('项目根目录')}
      aria-busy={loading}
    >
      {entries
        .filter(
          (entry) =>
            entry.directory ||
            entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            (sort === 'size' ? b.size - a.size : 0) ||
            a.name.localeCompare(b.name),
        )
        .map((entry) => {
          const child = path ? `${path}/${entry.name}` : entry.name;
          const visible = expanded.includes(entry.name);
          return (
            <li key={entry.name}>
              <button
                className="explorer-entry"
                title={child}
                aria-expanded={entry.directory ? visible : undefined}
                onClick={() =>
                  entry.directory
                    ? setExpanded((old) =>
                        visible
                          ? old.filter((v) => v !== entry.name)
                          : [...old, entry.name],
                      )
                    : open(child)
                }
              >
                <span aria-hidden="true">
                  {entry.directory ? (visible ? '▾' : '▸') : '·'}
                </span>
                <span>{entry.name}</span>
                {!entry.directory && (
                  <small>
                    {entry.size < 1024
                      ? `${entry.size} B`
                      : `${Math.ceil(entry.size / 1024)} KiB`}
                  </small>
                )}
              </button>
              {entry.directory &&
                visible &&
                (depth < 32 ? (
                  <Directory
                    host={host}
                    project={project}
                    path={child}
                    filter={filter}
                    sort={sort}
                    open={open}
                    depth={depth + 1}
                  />
                ) : (
                  <small>{t('目录层级过深')}</small>
                ))}
            </li>
          );
        })}
      {loading && <li role="status">{t('正在读取…')}</li>}
      {error && (
        <li role="alert">
          {error}
          <button onClick={() => setRetry(retry + 1)}>{t('重试')}</button>
        </li>
      )}
      {!loading && !error && !entries.length && <li>{t('空目录')}</li>}
      {next && (
        <li>
          <button disabled={loading} onClick={() => setPage(next)}>
            {t('加载更多文件')}
          </button>
        </li>
      )}
    </ul>
  );
}
