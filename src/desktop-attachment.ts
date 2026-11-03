import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from './config.ts';
import { browserEnvironmentKeys } from './browser-access.ts';
import type { Logger } from './types.ts';

export interface DesktopAttachment {
  pipePath: string;
  threadId: string;
  browserEnvironment: Record<string, string>;
}

/** Local desktop routing survives a bridge restart; native authorization still checks every browser call. */
export class DesktopAttachmentStore {
  private readonly path: string;
  private saved?: DesktopAttachment;
  constructor(directory: string, private readonly logger: Logger) {
    this.path = join(directory, 'desktop-attachment.json');
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!value || typeof value.pipePath !== 'string' || !value.pipePath || typeof value.threadId !== 'string' || !value.threadId) throw new Error('invalid desktop binding');
      this.saved = { pipePath: value.pipePath, threadId: value.threadId, browserEnvironment: this.environment(value.browserEnvironment) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('桌面绑定记录无法读取，请从 Codex 重新打开 QQ Bot 以更新绑定。');
    }
  }

  private environment(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') return {};
    const source = value as Record<string, unknown>;
    return Object.fromEntries(browserEnvironmentKeys.flatMap(key => typeof source[key] === 'string' && source[key] ? [[key, source[key] as string]] : []));
  }

  read(): DesktopAttachment | undefined { return this.saved && structuredClone(this.saved); }

  update(value: Record<string, unknown>): DesktopAttachment | undefined {
    const browser = this.environment(value.browserEnvironment);
    const pipePath = typeof value.pipePath === 'string' && value.pipePath ? value.pipePath : this.saved?.pipePath;
    const threadId = typeof value.threadId === 'string' && value.threadId ? value.threadId : this.saved?.threadId;
    if (!pipePath || !threadId) return this.read();
    const completeBrowser = ['BROWSER_USE_ACCESS_EXECUTOR_ID', 'BROWSER_USE_ACCESS_PIPE_PATH', 'BROWSER_USE_ACCESS_VERIFYING_IDENTITY'].every(key => browser[key]);
    const next = { pipePath, threadId, browserEnvironment: completeBrowser ? browser : this.saved?.browserEnvironment || {} };
    if (JSON.stringify(next) !== JSON.stringify(this.saved)) {
      writeJson(this.path, next);
      this.saved = next;
    }
    return this.read();
  }
}
