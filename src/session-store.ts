import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, type BotConfig } from './config.ts';
import { z } from 'zod';
import { normalizePermissions } from './permissions.ts';
import type { ContextUsage } from './context-usage.ts';

export const sessionNameSchema = z.string().trim().max(80, '会话名称最多 80 个字符。');
export const sessionSettingsSchema = z.object({
  model: z.string().trim(), modelProvider: z.string().trim(), cwd: z.string().trim(), preset: z.string().trim(),
  effort: z.enum(['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  prompt: z.string().nullable(),
  sandbox: z.enum(['', 'read-only', 'workspace-write', 'danger-full-access']),
  approvalPolicy: z.enum(['', 'untrusted', 'on-request', 'never']),
  approvalsReviewer: z.enum(['', 'user', 'auto_review']),
  networkAccess: z.enum(['', 'enabled', 'disabled']),
  webSearch: z.enum(['', 'disabled', 'cached', 'indexed', 'live']),
  autoCompact: z.boolean().nullable(),
  autoCompactThreshold: z.number().int().min(10).max(95).nullable(),
}).partial().strict().transform(patch => patch.sandbox === 'danger-full-access'
  ? { ...patch, approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const, networkAccess: 'enabled' as const } : patch);
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export function sessionPermissions(config: BotConfig, session: Pick<SessionSettings, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer' | 'networkAccess' | 'webSearch'>) {
  return normalizePermissions({ sandbox: session.sandbox || config.sandbox, approvalPolicy: session.approvalPolicy || config.approvalPolicy,
    approvalsReviewer: session.approvalsReviewer || config.approvalsReviewer,
    networkAccess: session.networkAccess ? session.networkAccess === 'enabled' : config.networkAccess, webSearch: session.webSearch || config.webSearch });
}
export interface SavedSession extends Omit<SessionSettings, 'effort'> {
  name?: string;
  threadId?: string; effort?: string; activePreset?: string; activePrompt?: string;
  promptPolicyVersion?: number; previousThreadId?: string;
  contextUsage?: ContextUsage;
}

export class SessionStore {
  private readonly path: string;
  private readonly sessions: Record<string, SavedSession>;
  constructor(directory: string) {
    this.path = join(directory, 'sessions.json');
    this.sessions = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }
  get(key: string): SavedSession { return this.sessions[key] || {}; }
  entries(): Array<[string, SavedSession]> { return Object.entries(this.sessions); }
  list(appId: string) {
    return this.entries().flatMap(([key, session]) => {
      if (!key.startsWith(`${appId}:`)) return [];
      const [scope, ...target] = key.slice(appId.length + 1).split(':');
      if ((scope !== 'c2c' && scope !== 'group') || !target.length) return [];
      return [{ ...session, scope, peerId: target.join(':'), busy: false, queued: 0, loaded: false }];
    });
  }
  set(key: string, session: SavedSession): void { this.sessions[key] = session; writeJson(this.path, this.sessions); }
}
