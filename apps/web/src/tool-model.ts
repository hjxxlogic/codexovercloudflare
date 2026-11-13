import type { Event } from '../../../packages/protocol/src/index.ts';
import { t } from './i18n.ts';
import { streamingJson, objectValue, itemFromValue } from './streaming-json.ts';

export const toolItemTypes = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
  'plan',
  'reasoning',
  'functionCallOutput',
  'sleep',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
  'hookPrompt',
]);
export const text = (value: unknown) =>
  typeof value === 'string' ? value : '';
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export function toolStatus(item: Record<string, unknown>, completed = false) {
  if (item.status === 'pending' || item.status === 'pendingInit')
    return t('待执行');
  if (item.status === 'shutdown') return t('已关闭');
  if (item.status === 'notFound') return t('未找到');
  if (item.status === 'declined') return t('已拒绝');
  if (item.status === 'interrupted' || item.status === 'cancelled')
    return t('已中断');
  if (
    item.status === 'failed' ||
    item.status === 'errored' ||
    item.success === false ||
    item.error ||
    item.failure ||
    objectValue(item.result)?.isError === true ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0)
  )
    return t('失败');
  if (item.status === 'completed' || completed) return t('已完成');
  return t('进行中');
}
export function toolLabel(item: Record<string, unknown>) {
  const action = objectValue(list(item.commandActions)[0]);
  const commandLabel =
    action?.type === 'read'
      ? `${t('读取文件')} · ${text(action.name) || text(action.path)}`
      : action?.type === 'listFiles'
        ? `${t('列出文件')} · ${text(action.path)}`
        : action?.type === 'search'
          ? `${t('搜索文件')} · ${text(action.query) || text(action.path)}`
          : text(item.command);
  const webAction = objectValue(item.action);
  const agentTools: Record<string, string> = {
    spawnAgent: '创建子代理',
    sendInput: '发送任务',
    resumeAgent: '恢复代理',
    wait: '等待代理',
    closeAgent: '关闭代理',
    sendMessage: '发送消息',
    followupTask: '追加任务',
    interruptAgent: '中断代理',
    listAgents: '列出代理',
  };
  const labels: Record<string, string> = {
    fileChange: t(
      '修改文件{0}',
      Array.isArray(item.changes) ? t(' · {0} 项', item.changes.length) : '',
    ),
    commandExecution: commandLabel || t('运行命令'),
    mcpToolCall:
      [text(item.server), text(item.tool)].filter(Boolean).join(' / ') || 'MCP',
    dynamicToolCall:
      [text(item.namespace), text(item.tool)].filter(Boolean).join(' / ') ||
      t('动态工具'),
    collabAgentToolCall: t(
      agentTools[text(item.tool)] || text(item.tool) || '子代理',
    ),
    subAgentActivity: `${t('子代理')} · ${text(item.agentPath)}`,
    webSearch:
      webAction?.type === 'openPage'
        ? t('打开网页')
        : webAction?.type === 'findInPage'
          ? t('页内查找')
          : t('网页搜索'),
    imageView: t('查看图片'),
    imageGeneration: t('生成图片'),
    plan: t('执行计划'),
    reasoning: t('思考过程'),
    functionCallOutput: text(item.name) || t('工具结果'),
    sleep: t('等待'),
    enteredReviewMode: t('进入审查'),
    exitedReviewMode: t('审查结果'),
    contextCompaction: t('压缩上下文'),
    hookPrompt: t('Hook 提示'),
  };
  return labels[text(item.type)] || text(item.type) || t('工具调用');
}

export function toolModel(event: Event, source: string | undefined) {
  const data = objectValue(event.data) || {};
  const metadata = objectValue(data.item);
  const referenced = event.contentSeq !== undefined;
  const decoded = source === undefined ? undefined : streamingJson(source);
  const parsed = itemFromValue(decoded?.value);
  // Plain command output may itself be JSON. Only native item/envelope shapes
  // are decoded; arbitrary JSON returned by a command remains output text.
  const wrapped =
    objectValue(objectValue(decoded?.value)?.data)?.item ||
    objectValue(decoded?.value)?.item;
  const structured =
    !!metadata &&
    !!parsed &&
    (parsed.type === metadata.type ||
      (metadata.type === 'fileChange' && Array.isArray(parsed.changes)) ||
      (!decoded?.complete &&
        (metadata.type !== 'commandExecution' ||
          !!wrapped ||
          typeof parsed.aggregatedOutput === 'string')));
  let item = metadata
    ? { ...metadata, ...(structured ? parsed : {}) }
    : undefined;
  if (
    item?.type === 'fileChange' &&
    structured &&
    Array.isArray(parsed?.changes)
  ) {
    item = {
      ...item,
      changes: Array.from(
        {
          length: decoded?.complete
            ? parsed.changes.length
            : Math.max(parsed.changes.length, list(metadata?.changes).length),
        },
        (_, index) => {
          const known = objectValue(list(metadata?.changes)[index]);
          const update = objectValue(list(parsed.changes)[index]);
          return {
            ...known,
            ...update,
            ...(!decoded?.complete && known?.path ? { path: known.path } : {}),
          };
        },
      ),
    };
  }
  if (item && metadata?.type !== undefined) item.type = metadata.type;
  if (item && metadata?.status !== undefined) item.status = metadata.status;
  if (
    item?.type === 'commandExecution' &&
    referenced &&
    source !== undefined &&
    !structured
  )
    item = { ...item, aggregatedOutput: source };
  return {
    item,
    structured,
    decoded,
    data,
    payload:
      objectValue(objectValue(decoded?.value)?.data) ??
      objectValue(decoded?.value),
  };
}

// Copy the visible semantic content rather than a serialized event envelope.
export function toolCopy(item: Record<string, unknown>): string {
  if (item.type === 'fileChange')
    return list(item.changes)
      .map((value) => {
        const change = objectValue(value) || {};
        return `${text(change.path)}\n${text(change.diff)}`;
      })
      .join('\n\n');
  const format = (value: unknown, depth = 0): string => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'object') return String(value);
    if (depth > 12) return JSON.stringify(value);
    if (Array.isArray(value))
      return value
        .map((entry) => format(entry, depth + 1))
        .filter(Boolean)
        .join('\n');
    const object = objectValue(value)!;
    if (['text', 'inputText'].includes(text(object.type)))
      return text(object.text);
    if (
      ['image', 'audio', 'inputImage', 'inputAudio'].includes(text(object.type))
    )
      return text(object.type) + ' ' + text(object.mimeType);
    return Object.entries(object)
      .filter(([key]) => depth !== 0 || !['id', 'type'].includes(key))
      .map(([key, entry]) => `${key}: ${format(entry, depth + 1)}`)
      .join('\n');
  };
  return `${toolLabel(item)}\n${format(item)}`;
}
