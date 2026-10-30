import { appendFileSync, createReadStream, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ConversationStorage } from './storage.ts';
import type { RawAttachment, ReplyTarget } from './types.ts';

export interface ReferenceFile { path: string; name: string; contentType: string; url?: string; }
export interface MessageReference {
  key: string; text?: string; senderId?: string; senderName?: string; isBot?: boolean; timestamp?: number;
  attachments?: RawAttachment[]; files?: ReferenceFile[]; references?: MessageReference[];
}
interface ReferenceEntry extends MessageReference { keys: string[]; }

/** Keep platform message indexes separate from passive-reply IDs; neither is a global identity. */
export function referenceFromMessage(message: any): MessageReference | undefined {
  const ext: string[] = message.messageScene?.ext || [];
  const explicit = ext.find(item => item.trim().startsWith('ref_msg_idx='))?.split('=').slice(1).join('=').trim();
  const key = explicit || message.refMsgIdx;
  if (!key && message.msgType !== 103) return;
  const elements: any[] = message.raw?.msg_elements || message.msgElements || [];
  const matching = elements.filter(element => element.msg_idx === key);
  const selected = matching.length ? matching : key ? elements.filter(element => !element.msg_idx) : elements;
  const parse = (element: any): MessageReference => {
    const author = element.author || {};
    const card = element.ark_data;
    const text = element.content || (card ? [card.prompt, card.fields?.title, card.fields?.desc, card.fields?.jump_url].filter(Boolean).join('\n') : '');
    return { key: element.msg_idx || '', text, senderId: author.member_openid || author.user_openid || author.id,
      senderName: author.username || undefined, isBot: author.bot,
      attachments: (element.attachments || []).map((item: any) => ({ content_type: item.content_type || 'file', filename: item.filename || '',
        size: item.size || 0, url: item.url || '', asr_refer_text: item.asr_refer_text })),
      references: element.msg_elements?.map(parse) };
  };
  if (selected.length === 1) return { ...parse(selected[0]), key: key || selected[0].msg_idx || '' };
  return { key: key || '', references: selected.map(parse) };
}

/** Per-conversation append-only index: full text on disk, only hot references in memory. */
export class MessageReferenceStore {
  private readonly cache = new Map<string, ReferenceEntry>();
  constructor(private readonly storage: ConversationStorage) {}
  path(target: ReplyTarget): string { return join(this.storage.paths(target).directory, 'message-references.jsonl'); }
  private cacheEntry(target: ReplyTarget, entry: ReferenceEntry): void {
    for (const key of entry.keys) this.cache.set(`${this.path(target)}\0${key}`, entry);
    while (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value!);
  }
  remember(target: ReplyTarget, keys: (string | undefined)[], message: MessageReference): void {
    const aliases = [...new Set(keys.filter((key): key is string => Boolean(key)))];
    if (!aliases.length) return;
    const previous = aliases.map(key => this.cache.get(`${this.path(target)}\0${key}`)).find(Boolean);
    const entry = { ...message, files: message.files?.length ? message.files : previous?.files, key: aliases[0]!, keys: aliases };
    mkdirSync(this.storage.paths(target).directory, { recursive: true });
    appendFileSync(this.path(target), JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (entry.attachments?.length && !entry.files?.length) {
      // A redelivery may follow a restart. Let disk lookup retain earlier downloads.
      for (const key of aliases) this.cache.delete(`${this.path(target)}\0${key}`);
    } else this.cacheEntry(target, entry);
  }
  private async find(target: ReplyTarget, key: string): Promise<ReferenceEntry | undefined> {
    const cached = this.cache.get(`${this.path(target)}\0${key}`);
    if (cached) return cached;
    let found: ReferenceEntry | undefined;
    const scan = async (path: string, legacy = false) => {
      const input = createReadStream(path, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const entry = JSON.parse(line);
          if (!legacy && entry.keys?.includes(key)) found = { ...entry, files: entry.files?.length ? entry.files : found?.files };
          else if (legacy && entry.type === 'message' && entry.id === `qq:${key}`) found = {
            key, keys: [key], text: entry.text, senderId: entry.senderId, senderName: entry.senderName,
            isBot: entry.role === 'assistant', timestamp: entry.timestamp,
            files: entry.files?.filter((file: any) => file.path).map((file: any) => ({ ...file, contentType: /\.(png|jpe?g|gif|webp)$/i.test(file.path) ? 'image/*' : 'file' })),
          };
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      finally { lines.close(); input.destroy(); }
    };
    await scan(this.path(target));
    if (!found && target.scope === 'group') await scan(join(this.storage.paths(target).directory, 'group-messages.jsonl'), true);
    if (found) this.cacheEntry(target, found);
    return found;
  }
  async resolve(target: ReplyTarget, reference: MessageReference): Promise<MessageReference & { keys?: string[]; source: 'archive' | 'push' | 'missing' }> {
    const stored = reference.key ? await this.find(target, reference.key) : undefined;
    const attachments = new Map((stored?.attachments || []).map(item => [item.filename || item.url, item]));
    for (const item of reference.attachments || []) attachments.set(item.filename || item.url, item);
    return { ...stored, ...reference, text: stored?.text || reference.text,
      senderId: reference.senderId || stored?.senderId, senderName: reference.senderName || stored?.senderName,
      isBot: reference.isBot ?? stored?.isBot, files: stored?.files?.length ? stored.files : reference.files, attachments: [...attachments.values()],
      references: reference.references?.length ? reference.references : stored?.references,
      source: stored ? 'archive' : reference.text || reference.attachments?.length || reference.files?.length || reference.references?.length ? 'push' : 'missing' };
  }
  sent(target: ReplyTarget, receipt: any, text: string, files?: ReferenceFile[]): void {
    const message = receipt?.message && typeof receipt.message === 'object' ? receipt.message : receipt;
    this.remember(target, [message?.ext_info?.ref_idx, message?.id], {
      key: '', text, senderId: 'qqbot', senderName: 'QQ Bot', isBot: true, timestamp: Date.now(), files,
    });
  }
}
