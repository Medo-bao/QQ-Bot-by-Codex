/**
 * dsh-im-qqbot 插件内部类型定义
 */

/** 会话作用域 */
export type ChatScope = 'c2c' | 'group';

export const fileSendModes = ['auto', 'file', 'voice'] as const;
export type FileSendMode = typeof fileSendModes[number];

export interface GroupMember { id: string; name?: string; }
export interface GroupMemberPage { members: GroupMember[]; source: 'qq' | 'history'; nextCursor?: string; }
export interface DirectMentions { memberIds?: readonly string[]; everyone?: boolean; }
export const maxGroupMentions = 10;

export function isGroupMemberId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    && !['all', 'everyone', 'unknown', 'qqbot', 'qqbot-local-ui'].includes(value.toLowerCase());
}

/** QQ 回复目标 */
export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
  /** 互动事件 id（带 INTERACTION_CREATE 前缀），填 event_id 字段，与 msgId 互斥 */
  eventId?: string;
  /** 群聊本轮提问者，用于 @ 回复及选择同一成员的有效消息 ID。 */
  replyUserId?: string;
}

/** SDK 原始消息附件（snake_case 字段，来自 QQ 网关 C2C_MESSAGE_CREATE） */
export interface RawAttachment {
  content_type: string;
  filename: string;
  size: number;
  url: string;
  asr_refer_text?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

/** 引用消息附件（quoteRef 中间件解析的 camelCase 视图） */
export interface QuotedAttachment {
  contentType?: string;
  url?: string;
  filename?: string;
  asrText?: string;
}

/** 插件 Logger 接口 */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}
