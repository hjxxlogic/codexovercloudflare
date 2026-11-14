import { eventBelongsToThread } from '../apps/web/src/events.ts';
import type { Event } from '../packages/protocol/src/index.ts';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ContextUsage,
  contextRemaining,
  contextUsageFromEvent,
} from '../apps/web/src/context-usage.tsx';

it('uses the latest context rather than cumulative usage and isolates child threads', () => {
  const event = {
    threadId: 'main',
    tokenUsage: {
      last: { totalTokens: 112000 },
      total: { totalTokens: 999999 },
      modelContextWindow: 212000,
    },
  };
  expect(contextUsageFromEvent(event, 'main')).toEqual({
    usedTokens: 112000,
    contextWindow: 212000,
  });
  expect(contextUsageFromEvent(event, 'child')).toBeUndefined();
  expect(
    contextUsageFromEvent(
      { ...event, tokenUsage: { last: { totalTokens: -1 } } },
      'main',
    ),
  ).toBeUndefined();
  expect(
    contextUsageFromEvent(
      { ...event, tokenUsage: { last: { totalTokens: 1000 } } },
      'main',
    ),
  ).toEqual({ usedTokens: 1000, contextWindow: null });
});

it('matches the Codex baseline estimate and handles compaction and exhausted windows', () => {
  expect(contextRemaining(112000, 212000)).toBe(50);
  expect(contextRemaining(12000, 212000)).toBe(100);
  expect(contextRemaining(1000, 212000)).toBe(100);
  expect(contextRemaining(300000, 212000)).toBe(0);
  expect(contextRemaining(1, 1000)).toBe(0);
});

it('shows unknown until reported and exposes exact latest token counts', () => {
  expect(renderToStaticMarkup(<ContextUsage />)).toContain('未知');
  expect(
    renderToStaticMarkup(
      <ContextUsage usage={{ usedTokens: 112000, contextWindow: 212000 }} />,
    ),
  ).toContain('50%');
  expect(
    renderToStaticMarkup(
      <ContextUsage usage={{ usedTokens: 112000, contextWindow: null }} />,
    ),
  ).toContain('112,000');
});

it('filters child messages, lifecycle and usage before presentation while retaining parent tool activity', () => {
  for (const type of [
    'item/agentMessage/delta',
    'turn/started',
    'turn/completed',
    'thread/tokenUsage/updated',
  ]) {
    const event: Event = { seq: 1, time: 1, type, data: { threadId: 'child' } };
    expect(eventBelongsToThread(event, 'main')).toBe(false);
    expect(
      eventBelongsToThread({ ...event, data: { threadId: 'main' } }, 'main'),
    ).toBe(true);
  }
  expect(
    eventBelongsToThread(
      {
        seq: 1,
        time: 1,
        type: 'item/started',
        data: {
          threadId: 'main',
          item: { type: 'collabAgentToolCall', receiverThreadIds: ['child'] },
        },
      },
      'main',
    ),
  ).toBe(true);
});
