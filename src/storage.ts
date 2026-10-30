import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson, type BotConfig } from './config.ts';
import { readConversation, type ConversationMessage } from './conversation.ts';
import type { CodexClient } from './codex-client.ts';
import type { ReplyTarget } from './types.ts';

const segment = (value: string) => encodeURIComponent(value).replace(/[.!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const contains = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

/** User-facing files are grouped by stable QQ identity, independently of workspace and display name. */
export class ConversationStorage {
  readonly root: string;
  constructor(directory: string, private readonly config: Pick<BotConfig, 'storageDir' | 'appId'>) {
    this.root = resolve(config.storageDir || join(directory, 'storage'));
  }

  paths(target: ReplyTarget) {
    const directory = join(this.root, `bot-${segment(this.config.appId)}`, target.scope === 'group' ? 'group' : 'private', `peer-${segment(target.targetId)}`);
    return { directory, history: join(directory, 'history'), attachments: join(directory, 'attachments'), files: join(directory, 'files') };
  }

  files(target: ReplyTarget, threadId: string): string { return join(this.paths(target).files, segment(threadId)); }
  historyFile(target: ReplyTarget, threadId: string): string { return join(this.paths(target).history, `${segment(threadId)}.json`); }

  saveSession(target: ReplyTarget, name: string, threadId?: string, previousThreadId?: string): void {
    const paths = this.paths(target);
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
    writeJson(join(paths.directory, 'session.json'), { name, scope: target.scope, peerId: target.targetId, threadId, previousThreadId });
  }

  assertFile(target: ReplyTarget, actual: string): void {
    if (contains(this.root, actual) && !contains(this.paths(target).directory, actual)) throw new Error('文件属于其他 QQ 会话的存储目录。');
  }

  async importFile(target: ReplyTarget, source: string, threadId = 'direct'): Promise<string> {
    this.assertFile(target, source);
    const root = this.files(target, threadId);
    await mkdir(root, { recursive: true });
    const path = join(await mkdtemp(join(root, 'import-')), basename(source));
    try { await copyFile(source, path); }
    catch (error) { await rm(path, { force: true }); throw error; }
    return path;
  }

  async prepareImages(target: ReplyTarget, threadId: string, nativePath: string): Promise<void> {
    const destination = join(this.files(target, threadId), 'images');
    await mkdir(destination, { recursive: true });
    await mkdir(dirname(nativePath), { recursive: true });
    const source = await lstat(nativePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    const link = () => symlink(destination, nativePath, process.platform === 'win32' ? 'junction' : 'dir');
    if (!source) { await link(); return; }
    const original = await realpath(nativePath);
    if (original === await realpath(destination)) return;
    if (!source.isDirectory() && !source.isSymbolicLink()) throw new Error('生成图片路径不是目录。');
    await cp(original, destination, { recursive: true });
    if (source.isSymbolicLink()) {
      await unlink(nativePath);
      try { await link(); } catch (error) { await symlink(original, nativePath, process.platform === 'win32' ? 'junction' : 'dir'); throw error; }
    } else {
      // The backup is a checked sibling of this thread's generated-image directory.
      const parent = await realpath(dirname(nativePath));
      const backup = join(parent, `${basename(nativePath)}.${randomUUID()}.migrating`);
      await rename(nativePath, backup);
      try { await link(); } catch (error) { await rename(backup, nativePath); throw error; }
      await rm(backup, { recursive: true });
    }
  }

  async archive(client: CodexClient, target: ReplyTarget, threadId: string, full = false): Promise<void> {
    const directory = this.paths(target).history;
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${segment(threadId)}.json`);
    const existing: ConversationMessage[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).messages : [];
    const complete = full || !existsSync(path);
    const pages: ConversationMessage[][] = [];
    let cursor: string | undefined;
    do {
      const page = await readConversation(client, threadId, cursor);
      pages.unshift(page.messages);
      cursor = complete ? page.nextCursor || undefined : undefined;
    } while (cursor);
    const messages = [...new Map([...existing, ...pages.flat()].map((message) => [message.id, message])).values()];
    writeJson(path, { threadId, messages });
    const text = messages.map((message) => {
      const author = message.role === 'assistant' ? `QQ Bot${message.replyToName || message.replyToId ? ` → ${message.replyToName || message.replyToId}` : ''}`
        : message.source === 'local' ? '本机' : message.authorName || message.authorId || 'QQ 用户';
      return `## ${author}${message.role === 'user' && message.authorId ? ` (${message.authorId})` : ''}\n\n${message.text}\n`;
    }).join('\n');
    writeFileSync(join(directory, `${segment(threadId)}.md`), `# QQ Bot 会话记录\n\n${text}`, 'utf8');
  }
}
