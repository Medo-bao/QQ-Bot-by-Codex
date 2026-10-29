import { randomUUID } from 'node:crypto';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { ChatTransport, IncomingInteraction, IncomingMessage } from './qq-transport.ts';
import type { ReplyTarget } from './types.ts';

interface Pending {
  token: string;
  requestId: number | string;
  threadId: string;
  target: ReplyTarget;
  senderId: string;
  options: string[];
  freeText: boolean;
  multiple?: boolean;
  text: string;
  kind?: 'question' | 'approval';
  resolve: (answer: string | null) => void;
  timer: NodeJS.Timeout;
}

/** Correlate every button to a live request, peer and initiating user. */
export class InteractionBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly transport: ChatTransport, private readonly timeoutMs: number) {}

  list() {
    return [...this.pending.values()].map(({ token, threadId, target, senderId, text, options, multiple, freeText, kind }) => ({ token, threadId, target, senderId, text, options, multiple, freeText, kind }));
  }

  /** The authenticated local UI may answer a request in its selected conversation. */
  localText(target: ReplyTarget, text: string): boolean {
    const explicit = /^\/answer\s+(\S+)\s+([\s\S]+)$/i.exec(text.trim());
    const entries = [...this.pending.values()].filter((entry) => entry.target.scope === target.scope && entry.target.targetId === target.targetId);
    const entry = explicit ? entries.find((item) => item.token === explicit[1]) : entries.length === 1 ? entries[0] : undefined;
    return Boolean(entry && this.text({ target, senderId: entry.senderId, text, attachments: [], shouldAnswer: true }));
  }

  async ask(input: {
    requestId: number | string; threadId: string; target: ReplyTarget; senderId: string;
    text: string; options: string[]; freeText?: boolean; multiple?: boolean; kind?: 'question' | 'approval';
  }): Promise<string | null> {
    const token = randomUUID().slice(0, 8);
    let resolveAnswer!: (value: string | null) => void;
    const answer = new Promise<string | null>((resolve) => { resolveAnswer = resolve; });
    const entry: Pending = { ...input, token, freeText: input.freeText ?? false, resolve: resolveAnswer,
      timer: setTimeout(() => this.finish(token, null), this.timeoutMs) };
    this.pending.set(token, entry);
    const buttons = (input.multiple ? [] : input.options).map((option, index) => ({
      id: `${token}-${index}`,
      render_data: { label: option.slice(0, 10), visited_label: '已选择', style: 1 },
      action: { type: 1, permission: { type: 2 }, click_limit: 1, data: JSON.stringify({ r: token, i: index }) },
      group_id: token,
    }));
    const keyboard: InlineKeyboard = { content: { rows: [] } };
    for (let i = 0; i < buttons.length; i += 2) keyboard.content.rows.push({ buttons: buttons.slice(i, i + 2) });
    const optionsText = input.options.map((label, i) => `${i + 1}. ${label}`).join('\n');
    const text = `${input.text}\n\n${optionsText}\n\n回复 /answer ${token} 答案${input.multiple ? '（多选编号用逗号分隔）' : input.freeText ? '（可直接输入文字）' : '（选项编号）'}；仅本轮发起者可作答。`;
    try {
      try { await this.transport.sendMarkdown(input.target, text, buttons.length ? { keyboard } : undefined); }
      catch {
        // Some QQ bot accounts cannot render keyboards; numbered replies use the same request.
        await this.transport.sendMarkdown(input.target, text);
      }
    } catch (error) { this.finish(token, null); throw error; }
    return answer;
  }

  interaction(event: IncomingInteraction): boolean {
    let data: { r?: string; i?: number };
    try { data = JSON.parse(event.data); } catch { return false; }
    if (!data || typeof data.r !== 'string' || !Number.isInteger(data.i)) return false;
    const entry = this.pending.get(data.r);
    if (!entry || !this.matches(entry, event.target, event.senderId)) return false;
    const label = entry.options[data.i!];
    if (label === undefined) return false;
    this.finish(entry.token, label);
    return true;
  }

  text(message: IncomingMessage): boolean {
    const text = message.text.trim();
    if (/^\/(?:stop|new|reset|clear|model|compact|effort|preset)(?:\s|$)|^\/bot-/i.test(text)) return false;
    const explicit = /^\/answer\s+(\S+)\s+([\s\S]+)$/i.exec(text);
    const candidates = [...this.pending.values()].filter((entry) => this.matches(entry, message.target, message.senderId));
    const entry = explicit ? candidates.find((candidate) => candidate.token === explicit[1]) : candidates.length === 1 ? candidates[0] : undefined;
    if (!entry) return false;
    const raw = (explicit?.[2] || text).trim();
    if (entry.multiple && /^\d+(?:\s*[,， ]\s*\d+)*$/.test(raw)) {
      const selected = [...new Set(raw.split(/[,，\s]+/).map((index) => entry.options[Number(index) - 1]))];
      if (selected.some((option) => option === undefined)) return false;
      this.finish(entry.token, JSON.stringify(selected)); return true;
    }
    const index = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
    const selected = entry.options[index] || entry.options.find((option) => option === raw);
    if (!selected && !entry.freeText) return false;
    this.finish(entry.token, selected || raw);
    return true;
  }

  cancelRequest(requestId: number | string): void {
    for (const entry of this.pending.values()) if (String(entry.requestId) === String(requestId)) this.finish(entry.token, null);
  }

  cancelThread(threadId: string): void {
    for (const entry of this.pending.values()) if (entry.threadId === threadId) this.finish(entry.token, null);
  }

  settleApprovals(threadId: string, allow: boolean): void {
    for (const entry of this.pending.values()) if (entry.threadId === threadId && entry.kind === 'approval') this.finish(entry.token, allow ? '允许一次' : '拒绝');
  }

  close(): void { for (const token of this.pending.keys()) this.finish(token, null); }

  private matches(entry: Pending, target: ReplyTarget, senderId: string): boolean {
    return entry.senderId === senderId && entry.target.scope === target.scope && entry.target.targetId === target.targetId;
  }

  private finish(token: string, value: string | null): void {
    const entry = this.pending.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(token);
    entry.resolve(value);
  }
}
