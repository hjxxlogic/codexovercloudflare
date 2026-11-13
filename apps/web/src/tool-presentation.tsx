import { t } from './i18n.ts';
import { FileText } from './file-links.tsx';
import {
  fileChanges,
  diffLines,
  diffStats,
  type FileChange,
} from './file-changes.ts';
import { objectValue } from './streaming-json.ts';
import { toolStatus, text, list } from './tool-model.ts';
export function Diff({ text }: { text: string }) {
  return (
    <pre tabIndex={0}>
      {diffLines(text).map(({ text: line, kind }, index) => (
        <span
          className={
            kind === 'add'
              ? 'diff-add'
              : kind === 'remove'
                ? 'diff-remove'
                : undefined
          }
          key={index}
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
export function FileChanges({ changes }: { changes: FileChange[] }) {
  return (
    <div className="file-changes">
      {changes.length === 0 && (
        <p>{t('当前请求未附带可显示的文件变更明细。')}</p>
      )}
      {changes.map((change, index) => {
        const stats = diffStats(change.diff);
        const move = change.kind?.move_path || change.kind?.movePath;
        const kind = change.kind?.type;
        return (
          <details className="file-change" key={index}>
            <summary>
              <span
                className={`file-change-kind file-change-kind-${kind === 'add' || kind === 'delete' ? kind : 'update'}`}
              >
                {move
                  ? t('移动')
                  : kind === 'add'
                    ? t('新增')
                    : kind === 'delete'
                      ? t('删除')
                      : t('修改')}
              </span>
              <span className="file-change-path">
                {change.path}
                {move ? ` → ${move}` : ''}
              </span>
              <span className="file-change-stats">
                <span className="file-change-added">+{stats.added}</span>{' '}
                <span className="file-change-removed">−{stats.removed}</span>
              </span>
            </summary>
            {change.diff ? (
              <Diff text={change.diff} />
            ) : (
              <p>{t('无可显示的差异')}</p>
            )}
          </details>
        );
      })}
    </div>
  );
}

function OutputText({ value }: { value: unknown }) {
  return typeof value === 'string' && value ? (
    <pre tabIndex={0}>
      <FileText text={value} />
    </pre>
  ) : null;
}
function SafeLink({ url, title }: { url: string; title?: string }) {
  return /^https?:\/\//i.test(url) ? (
    <a href={url} target="_blank" rel="noreferrer noopener">
      {title || url}
    </a>
  ) : (
    <span>
      {title ? `${title} · ` : ''}
      {url}
    </span>
  );
}
const fieldLabels: Record<string, string> = {
  arguments: '参数',
  result: '结果',
  structuredContent: '结构化结果',
  error: '错误',
  cwd: '工作目录',
  durationMs: '耗时（毫秒）',
  processId: '进程',
  query: '搜索内容',
  queries: '搜索内容',
  url: '网址',
  pattern: '查找内容',
  prompt: '提示词',
  model: '模型',
  reasoningEffort: '推理强度',
  receiverThreadIds: '目标会话',
  senderThreadId: '来源会话',
  agentsStates: '代理状态',
  path: '路径',
  savedPath: '保存位置',
  revisedPrompt: '提示词',
  inputImages: '输入图片',
  status: '状态',
  message: '消息',
  failure: '错误',
  text: '正文',
  review: '审查内容',
  summary: '摘要',
  content: '内容',
  kind: '活动',
  agentPath: '代理',
  agentThreadId: '会话',
  name: '名称',
  namespace: '命名空间',
};
export function ToolValue({
  value,
  depth = 0,
  labelFields = false,
}: {
  value: unknown;
  depth?: number;
  labelFields?: boolean;
}) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return <OutputText value={value} />;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (depth >= 8) return <OutputText value={JSON.stringify(value, null, 2)} />;
  if (Array.isArray(value))
    return (
      <div className="tool-values">
        {value.map((entry, index) => (
          <ToolValue key={index} value={entry} depth={depth + 1} />
        ))}
      </div>
    );
  const object = objectValue(value)!;
  // MCP and dynamic tools return typed content blocks, often streamed mid-text.
  if (
    ['text', 'inputText'].includes(text(object.type)) &&
    typeof object.text === 'string'
  )
    return <OutputText value={object.text} />;
  if (
    object.type === 'image' &&
    typeof object.data === 'string' &&
    /^image\/(png|jpeg|webp|gif)$/.test(text(object.mimeType))
  )
    return (
      <img
        className="tool-image"
        src={`data:${text(object.mimeType)};base64,${object.data}`}
        alt={t('工具返回图片')}
      />
    );
  if (object.type === 'inputImage') {
    const url = text(object.imageUrl);
    return /^data:image\/(png|jpeg|webp|gif);base64,/i.test(url) ? (
      <img className="tool-image" src={url} alt={t('工具返回图片')} />
    ) : (
      <p>
        <SafeLink url={url} title={t('查看图片')} />
      </p>
    );
  }
  if (object.type === 'audio' || object.type === 'inputAudio')
    return (
      <details>
        <summary>{t('音频内容')}</summary>
        <Fields item={object} names={['mimeType', 'format', 'audioUrl']} />
      </details>
    );
  if (object.type === 'resource' && objectValue(object.resource))
    return <ToolValue value={object.resource} depth={depth + 1} />;
  if (typeof object.url === 'string' && !object.type)
    return (
      <div className="tool-search-result">
        <SafeLink url={object.url} title={text(object.title)} />
        <OutputText
          value={object.snippet || object.description || object.text}
        />
      </div>
    );
  return (
    <dl className="tool-fields">
      {Object.entries(object)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => (
          <div key={key}>
            <dt>{labelFields ? t(fieldLabels[key] || key) : key}</dt>
            <dd>
              <ToolValue value={entry} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
function Fields({
  item,
  names,
}: {
  item: Record<string, unknown>;
  names: string[];
}) {
  return (
    <ToolValue
      labelFields
      value={Object.fromEntries(
        names
          .filter(
            (name) =>
              item[name] !== undefined &&
              item[name] !== null &&
              item[name] !== '' &&
              !(Array.isArray(item[name]) && item[name].length === 0),
          )
          .map((name) => [name, item[name]]),
      )}
    />
  );
}
function ToolResult({ value }: { value: unknown }) {
  const result = objectValue(value);
  if (!result || !Array.isArray(result.content))
    return <ToolValue value={value} />;
  return (
    <>
      <ToolValue value={result.content} />
      <Fields item={result} names={['structuredContent']} />
      <ToolValue
        value={Object.fromEntries(
          Object.entries(result).filter(
            ([key]) =>
              !['content', 'structuredContent', 'isError'].includes(key),
          ),
        )}
      />
    </>
  );
}
export function ToolBody({ item }: { item: Record<string, unknown> }) {
  const type = text(item.type);
  if (type === 'contextCompaction')
    return <p className="tool-loading">{t('上下文压缩')}</p>;
  if (type === 'fileChange') {
    const changes = fileChanges(item, true) || [];
    const otherChanges = list(item.changes).filter(
      (value) => typeof objectValue(value)?.path !== 'string',
    );
    return (
      <>
        <FileChanges changes={changes} />
        <ToolValue value={otherChanges} />
        <OutputText value={item.aggregatedOutput} />
      </>
    );
  }
  if (type === 'commandExecution')
    return (
      <div className="tool-command">
        <OutputText value={item.command} />
        <Fields item={item} names={['cwd', 'processId', 'durationMs']} />
        <OutputText value={item.aggregatedOutput} />
      </div>
    );
  if (type === 'mcpToolCall' || type === 'dynamicToolCall')
    return (
      <>
        <Fields item={item} names={['arguments']} />
        <OutputText value={item.progress} />
        {item.result != null && (
          <section className="tool-result">
            <strong>{t('结果')}</strong>
            <ToolResult value={item.result} />
          </section>
        )}
        <ToolValue value={item.contentItems} />
        <Fields item={item} names={['error', 'durationMs']} />
      </>
    );
  if (type === 'webSearch') {
    const action = objectValue(item.action) || {};
    const queries = [
      ...new Set(
        [item.query, action.query, ...list(action.queries)].filter(
          (value): value is string => typeof value === 'string' && !!value,
        ),
      ),
    ];
    return (
      <>
        <Fields item={{ queries }} names={['queries']} />
        <Fields item={action} names={['pattern']} />
        {typeof action.url === 'string' && (
          <p>
            <SafeLink url={action.url} />
          </p>
        )}
        <ToolValue value={item.results} />
      </>
    );
  }
  if (type === 'collabAgentToolCall')
    return (
      <>
        <Fields
          item={item}
          names={['prompt', 'model', 'reasoningEffort', 'receiverThreadIds']}
        />
        <div className="tool-agent-states">
          {Object.entries(objectValue(item.agentsStates) || {}).map(
            ([id, value]) => {
              const state = objectValue(value) || {};
              return (
                <section key={id}>
                  <strong>{id}</strong>
                  <span className="tool-status">
                    {toolStatus(
                      state,
                      ['shutdown', 'notFound'].includes(text(state.status)),
                    )}
                  </span>
                  <OutputText value={state.message} />
                </section>
              );
            },
          )}
        </div>
      </>
    );
  if (type === 'planUpdate')
    return (
      <>
        <OutputText value={item.explanation} />
        <ol className="tool-plan">
          {list(item.plan).map((value, index) => {
            const step = objectValue(value) || {};
            return (
              <li key={index} data-status={text(step.status)}>
                <span className="tool-status">
                  {toolStatus(step, step.status === 'completed')}
                </span>
                <FileText text={text(step.step)} />
              </li>
            );
          })}
        </ol>
      </>
    );
  const fields: Record<string, string[]> = {
    subAgentActivity: [
      'agentPath',
      'agentThreadId',
      'kind',
      'model',
      'reasoningEffort',
    ],
    imageView: ['path'],
    imageGeneration: ['revisedPrompt', 'savedPath', 'inputImages', 'failure'],
    plan: ['text'],
    reasoning: ['summary', 'content'],
    functionCallOutput: ['name', 'namespace', 'output'],
    sleep: ['durationMs'],
    enteredReviewMode: ['review'],
    exitedReviewMode: ['review'],
    hookPrompt: ['fragments'],
    contextCompaction: [],
  };
  return (
    <Fields
      item={item}
      names={
        fields[type] ||
        Object.keys(item).filter(
          (key) => !['id', 'type', 'status'].includes(key),
        )
      }
    />
  );
}
