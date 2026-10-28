import { useEffect, useState } from 'react';
import { z } from 'zod';
import { modelIdSchema } from '../../../packages/protocol/src/index.ts';
import { t } from './i18n.ts';

export const modelPageSchema = z.object({
  data: z
    .array(
      z.object({
        model: modelIdSchema,
        displayName: z.string(),
        description: z.string().optional(),
        hidden: z.boolean().optional(),
        isDefault: z.boolean().optional(),
      }),
    )
    .max(100),
  nextCursor: z.string().max(4096).nullable().optional(),
});
export type ModelPage = z.infer<typeof modelPageSchema>;

export function ModelPicker({
  load,
  current,
  disabled,
  onChoose,
}: {
  load: (cursor?: string) => Promise<ModelPage>;
  current: string;
  disabled: boolean;
  onChoose: (model: string) => Promise<void>;
}) {
  const [models, setModels] = useState<ModelPage['data']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    setModels([]);
    void (async () => {
      try {
        const all = new Map<string, ModelPage['data'][number]>();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await load(cursor);
          if (disposed) return;
          for (const model of page.data)
            if (!model.hidden) all.set(model.model, model);
          cursor = page.nextCursor || undefined;
          if (cursor && (cursors.has(cursor) || cursors.size >= 20))
            throw new Error(t('模型列表分页异常，请重试。'));
          if (cursor) cursors.add(cursor);
        } while (cursor);
        setModels([...all.values()]);
      } catch (error) {
        if (!disposed) setError(String(error));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [load, retry]);
  return (
    <section className="model-picker" aria-label={t('选择模型')}>
      <p>{t('选择后从下一条消息开始使用；不会中断当前任务。')}</p>
      {current && <p>{t('后续消息模型：{0}', current)}</p>}
      {disabled && (
        <p role="status">{t('请等待当前任务或提交结束后切换模型。')}</p>
      )}
      {loading && <p role="status">{t('正在加载模型…')}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !models.length && <p>{t('没有可用模型。')}</p>}
      {models.map((model) => (
        <button
          key={model.model}
          type="button"
          className="model-option"
          aria-pressed={current === model.model}
          disabled={disabled || saving || loading}
          onClick={() => {
            setSaving(true);
            setError('');
            void onChoose(model.model)
              .catch((error) => setError(String(error)))
              .finally(() => setSaving(false));
          }}
        >
          <strong>
            {model.displayName}
            {model.isDefault ? t('（默认）') : ''}
          </strong>
          <code>{model.model}</code>
          {model.description && <span>{model.description}</span>}
        </button>
      ))}
      <button
        type="button"
        disabled={loading || saving}
        onClick={() => setRetry((n) => n + 1)}
      >
        {t('刷新模型列表')}
      </button>
    </section>
  );
}
