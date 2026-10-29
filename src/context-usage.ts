export interface ContextUsage {
  threadId: string;
  usedTokens: number;
  windowTokens: number | null;
  updatedAt: number;
  stale?: boolean;
}

export function contextUsage(threadId: string, used: unknown, window: unknown, updatedAt = Date.now()): ContextUsage | undefined {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return;
  return { threadId, usedTokens: used, windowTokens: typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null, updatedAt };
}
