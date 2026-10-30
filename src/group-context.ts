import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJson } from './config.ts';
import type { ConversationMessage } from './conversation.ts';
import type { ConversationStorage } from './storage.ts';
import type { ReplyTarget } from './types.ts';

export interface GroupContextEntry {
  id: string; role: 'user' | 'assistant'; senderId: string; senderName?: string; text: string;
  timestamp?: number; files?: Array<{ path?: string; name: string; contentType?: string; unavailable?: string }>;
}
interface State { threadId?: string; entries: GroupContextEntry[]; }

/** The reply gate controls model turns; received group context survives process restarts. */
export class GroupContextStore {
  private readonly states = new Map<string, State>();
  constructor(private readonly storage: ConversationStorage, private readonly maxEntries: number) {}

  private paths(target: ReplyTarget) {
    const directory = this.storage.paths(target).directory;
    return { state: join(directory, 'context.json'), archive: join(directory, 'group-messages.jsonl') };
  }
  private state(target: ReplyTarget): State {
    const path = this.paths(target).state;
    if (!this.states.has(path)) this.states.set(path, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { entries: [] });
    return this.states.get(path)!;
  }
  private save(target: ReplyTarget): void {
    const paths = this.paths(target); mkdirSync(dirname(paths.state), { recursive: true });
    writeJson(paths.state, this.state(target));
  }
  seed(target: ReplyTarget, threadId: string, historyPath: string): void {
    if (existsSync(this.paths(target).state)) return;
    const messages: ConversationMessage[] = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')).messages : [];
    const state = this.state(target); state.threadId = threadId;
    for (const message of messages) {
      if (message.phase === 'commentary' || message.phase === 'error' || (!message.text && !message.files?.length)) continue;
      this.append(target, { id: `native:${threadId}:${message.id}`, role: message.role,
        senderId: message.role === 'assistant' ? 'qqbot' : message.authorId || (message.source === 'local' ? 'qqbot-local-ui' : 'unknown'),
        senderName: message.role === 'assistant' ? 'QQ Bot' : message.authorName || (message.source === 'local' ? '本机' : undefined),
        text: message.text, files: message.files });
    }
    this.save(target);
  }
  append(target: ReplyTarget, entry: GroupContextEntry): void {
    const state = this.state(target);
    if (state.entries.some((item) => item.id === entry.id)) return;
    state.entries.push(entry); state.entries = state.entries.slice(-this.maxEntries);
    this.save(target);
    appendFileSync(this.paths(target).archive, JSON.stringify({ type: 'message', ...entry }) + '\n', { mode: 0o600 });
  }
  attach(target: ReplyTarget, id: string, files: GroupContextEntry['files']): void {
    const entry = this.state(target).entries.find((item) => item.id === id); if (!entry || !files?.length) return;
    if (JSON.stringify(entry.files) === JSON.stringify(files)) return;
    entry.files = files; this.save(target);
    appendFileSync(this.paths(target).archive, JSON.stringify({ type: 'message', ...entry }) + '\n', { mode: 0o600 });
  }
  before(target: ReplyTarget, id: string, limit: number): GroupContextEntry[] {
    if (limit <= 0) return [];
    const state = this.state(target); const index = state.entries.findIndex((entry) => entry.id === id);
    return index < 0 ? [] : state.entries.filter((entry, position) => position < index || entry.role === 'assistant').slice(-limit);
  }
  get(target: ReplyTarget, id: string): GroupContextEntry | undefined { return this.state(target).entries.find(entry => entry.id === id); }
  bind(target: ReplyTarget, threadId: string): void {
    const state = this.state(target);
    if (state.threadId && state.threadId !== threadId) this.clear(target);
    state.threadId = threadId; this.save(target);
  }
  clear(target: ReplyTarget): void {
    const state = this.state(target); state.entries = []; state.threadId = undefined; this.save(target);
    appendFileSync(this.paths(target).archive, JSON.stringify({ type: 'reset', timestamp: Date.now() }) + '\n', { mode: 0o600 });
  }
  archivePath(target: ReplyTarget): string { return this.paths(target).archive; }
}
