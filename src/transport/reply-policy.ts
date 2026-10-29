import type { ChatScope } from '../types.ts';

/** QQ API v2 passive reply windows and per-message quotas. */
export const replyPolicy: Record<ChatScope, { ttlMs: number; limit: number }> = {
  c2c: { ttlMs: 60 * 60 * 1000, limit: 4 },
  group: { ttlMs: 5 * 60 * 1000, limit: 5 },
};
