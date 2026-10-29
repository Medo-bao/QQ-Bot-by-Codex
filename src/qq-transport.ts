import { QQBot, contentSanitizer, envelopeFormatter, errorHandler, mentionGate, messageFilter, rateLimiter, typingIndicator } from '@tencent-connect/qqbot-nodejs';
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { cacheEventId, cacheMsgId } from './transport/msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from './transport/reply-target.ts';
import { ReplyLimiter } from './transport/reply-limiter.ts';
import { replyPolicy } from './transport/reply-policy.ts';
import type { BotConfig } from './config.ts';
import type { Logger, RawAttachment, ReplyTarget } from './types.ts';
import type { QQBotSender } from './transport/outbound-buffer.ts';
import { extname } from 'node:path';
import { referenceFromMessage, type MessageReference } from './message-reference.ts';

export interface IncomingMessage {
  target: ReplyTarget;
  senderId: string;
  senderName?: string;
  text: string;
  envelope?: string;
  shouldAnswer: boolean;
  attachments: RawAttachment[];
  receivedAt?: number;
  sentAt?: number;
  contextId?: string;
  messageIndex?: string;
  reference?: MessageReference;
}

export interface IncomingInteraction {
  target: ReplyTarget;
  senderId: string;
  data: string;
}

export interface ChatTransport extends QQBotSender {
  connect(onMessage: (message: IncomingMessage) => Promise<void>, onInteraction: (event: IncomingInteraction) => boolean): Promise<void>;
  close(): void;
  sendFile(target: ReplyTarget, path: string, fileName: string): Promise<unknown>;
}

export class QQTransport implements ChatTransport {
  private readonly bot: QQBot;
  private readonly limiters = { c2c: new ReplyLimiter(replyPolicy.c2c), group: new ReplyLimiter(replyPolicy.group) };
  private stopping = false;
  private cancelConnect?: () => void;
  onDisconnected?: (reason: string) => void;
  onConnected?: () => void;

  constructor(config: BotConfig, private readonly logger: Logger) {
    this.bot = new QQBot({
      appId: config.appId,
      appSecret: config.appSecret,
      transport: 'websocket',
      userAgent: 'codex-qqbot/0.0.1',
      logger,
      baseUrl: process.env.QQBOT_BASE_URL || 'https://api.bot.qq.com',
      tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL || 'https://api.bot.qq.com',
    });
    this.bot.use(errorHandler());
    this.bot.use(messageFilter({ skipSelfEcho: false }));
    this.bot.use(rateLimiter());
    this.bot.use(mentionGate({ requireMentionInGroup: config.requireMention, passthrough: true }));
    this.bot.use(contentSanitizer({ parseFaceTags: true }));
    this.bot.use(typingIndicator());
    this.bot.use(envelopeFormatter({ historyLimit: config.historyLimit, includeQuote: false, includeSender: true }));
    this.bot.on('error', (error) => logger.error(`QQ: ${error instanceof Error ? error.message : error}`));
    this.bot.on('resumed', () => { if (!this.stopping) this.onConnected?.(); });
    this.bot.on('disconnected', (event) => {
      if (!this.stopping) {
        logger.warn(`QQ 连接中断: ${event.reason || event.code}, reconnect=${event.willReconnect}`);
        this.onDisconnected?.(event.reason || String(event.code));
      }
    });
  }

  connect(onMessage: (message: IncomingMessage) => Promise<void>, onInteraction: (event: IncomingInteraction) => boolean): Promise<void> {
    this.stopping = false;
    this.bot.on('message', async (context) => {
      const message = context.message;
      const target: ReplyTarget = {
        scope: message.kind === 'group' ? 'group' : 'c2c',
        targetId: message.kind === 'group' ? message.groupOpenid! : message.senderId,
        msgId: message.messageId,
        ...(message.kind === 'group' ? { replyUserId: message.senderId } : {}),
      };
      if (!target.targetId) return;
      const sentAt = Date.parse(message.timestamp);
      cacheMsgId(target.scope, target.targetId, target.msgId, Number.isFinite(sentAt) ? Math.min(sentAt, Date.now()) : Date.now(), message.senderId);
      const mention = context.state.mention as { shouldAnswer?: boolean } | undefined;
      try {
        await onMessage({ target, senderId: message.senderId, senderName: message.senderName, text: message.content,
          envelope: context.state.envelope as string | undefined,
          shouldAnswer: mention?.shouldAnswer !== false,
          attachments: (message.attachments || []) as RawAttachment[],
          receivedAt: context.receivedAt,
          sentAt,
          messageIndex: message.msgIdx,
          reference: referenceFromMessage(message),
        });
      } catch (error) {
        this.logger.error(`QQ 消息处理失败: ${error instanceof Error ? error.message : error}`);
      }
    });
    this.bot.on('interaction', async (_context, event: InteractionEvent) => {
      const scope = event.scene === 'group' ? 'group' : 'c2c';
      const targetId = scope === 'group' ? event.group_openid : event.user_openid;
      const senderId = event.user_openid;
      const data = event.data?.resolved?.button_data;
      if (!targetId || !senderId || !data) {
        await this.bot.acknowledgeInteraction(event.id, 3);
        return;
      }
      cacheEventId(scope, targetId, event.id, senderId);
      const matched = onInteraction({ target: { scope, targetId }, senderId, data });
      await this.bot.acknowledgeInteraction(event.id, matched ? 0 : 3);
    });
    return new Promise((resolve, reject) => {
      const clearPending = () => { clearTimeout(timer); this.cancelConnect = undefined; };
      const timer = setTimeout(() => { clearPending(); this.bot.stop(); reject(new Error('QQ 网关连接超时。')); }, 30000);
      this.cancelConnect = () => { clearPending(); reject(new Error('QQ 连接已停止。')); };
      this.bot.on('ready', () => { if (!this.stopping) this.onConnected?.(); clearPending(); resolve(); });
      void this.bot.start().catch((error: Error) => {
        clearPending();
        reject(error);
        if (!this.stopping) this.onDisconnected?.(error.message);
      });
    });
  }

  sendMarkdown(target: ReplyTarget, text: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown> {
    return sendResolvedMarkdown(this.bot, resolveReplyTarget(target, this.limiters[target.scope], true), text, opts);
  }

  openStream(target: ReplyTarget) {
    if (target.scope !== 'c2c' || !target.msgId) throw new Error('流式回复需要私聊消息 ID。');
    const resolved = resolveReplyTarget(target, this.limiters.c2c, false);
    if (!resolved.msgId) throw new Error('私聊被动回复已过期或达到次数上限，将使用普通消息回复。');
    return this.bot.openStream({ target: { scope: resolved.scope, targetId: resolved.targetId, msgId: resolved.msgId } });
  }

  sendFile(target: ReplyTarget, path: string, fileName: string): Promise<unknown> {
    const resolved = resolveReplyTarget(target, this.limiters[target.scope], false);
    const extension = extname(path).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension)) return this.bot.sendImage(resolved, { localPath: path });
    if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(extension)) return this.bot.sendVideo(resolved, { localPath: path });
    if (['.silk', '.amr', '.mp3', '.wav', '.ogg', '.aac'].includes(extension)) return this.bot.sendVoice(resolved, { localPath: path });
    return this.bot.sendFile(resolved, { localPath: path }, { fileName });
  }

  close(): void { this.stopping = true; this.cancelConnect?.(); this.bot.stop(); }
}
