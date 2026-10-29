import type { ReplyTarget } from '../types.ts';

export interface StreamSessionLike {
  update(text: string): Promise<unknown>;
  complete(): Promise<unknown>;
}

export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, text: string, opts?: { keyboard?: any }): Promise<unknown>;
  openStream(target: ReplyTarget): StreamSessionLike;
}
