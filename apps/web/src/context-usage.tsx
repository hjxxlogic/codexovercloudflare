import {
  contextUsageSchema,
  type Session,
} from '../../../packages/protocol/src/index.ts';
import { t, localeTag } from './i18n.ts';

export function contextUsageFromEvent(data: any, threadId?: string) {
  if (!threadId || data?.threadId !== threadId) return;
  const parsed = contextUsageSchema.safeParse({
    usedTokens: data?.tokenUsage?.last?.totalTokens,
    contextWindow: data?.tokenUsage?.modelContextWindow ?? null,
  });
  return parsed.success ? parsed.data : undefined;
}

// Match Codex TUI's user-controllable context estimate (12k baseline).
// https://github.com/openai/codex/blob/main/codex-rs/tui/src/token_usage.rs
export function contextRemaining(used: number, window: number) {
  if (window <= 12000) return 0;
  return Math.round(
    Math.max(
      0,
      Math.min(
        1,
        (window - 12000 - Math.max(0, used - 12000)) / (window - 12000),
      ),
    ) * 100,
  );
}

export function ContextUsage({ usage }: { usage?: Session['contextUsage'] }) {
  const remaining = usage?.contextWindow
    ? contextRemaining(usage.usedTokens, usage.contextWindow)
    : undefined;
  const format = (value: number) => value.toLocaleString(localeTag());
  const detail = usage
    ? `${t('最近上下文占用')} ${format(usage.usedTokens)} tokens${
        usage.contextWindow
          ? ` / ${format(usage.contextWindow)} · ${t('剩余')} ${format(Math.max(0, usage.contextWindow - usage.usedTokens))} tokens`
          : ''
      }`
    : t('等待 Codex 报告上下文用量');
  return (
    <span
      className="context-usage"
      title={detail}
      aria-label={`${t('Context 剩余')} ${remaining === undefined ? t('未知') : `${remaining}%`} · ${detail}`}
    >
      {t('Context 剩余')}{' '}
      {remaining === undefined ? t('未知') : `${remaining}%`}
    </span>
  );
}
