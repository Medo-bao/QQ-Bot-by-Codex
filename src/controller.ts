import { startQrConnect } from '@tencent-connect/qqbot-connector';
import { ConfigStore } from './config.ts';
import { CodexClient, openAIHttpProvider } from './codex-client.ts';
import { QQBridge } from './bridge.ts';
import { QQTransport } from './qq-transport.ts';
import type { Logger, ReplyTarget } from './types.ts';
import QRCode from 'qrcode';
import { SessionStore, sessionNameSchema, sessionSettingsSchema, sessionPermissions } from './session-store.ts';
import { readConversation } from './conversation.ts';
import { ConversationStorage } from './storage.ts';
import { MediaStore, fileSendModeSchema } from './media.ts';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export class BotController {
  private bridge?: QQBridge;
  private connecting?: Promise<unknown>;
  private stopBinding?: () => void;
  private bindGeneration = 0;
  private binding: { phase: string; qrUrl?: string; reason?: string } = { phase: 'idle' };
  private lastError?: string;
  private connected = false;
  private controlClient?: CodexClient;
  constructor(readonly store: ConfigStore, private readonly logger: Logger) {}

  status() {
    const storage = new ConversationStorage(this.store.directory, this.store.read());
    return { running: Boolean(this.bridge), connected: this.connected, error: this.lastError,
      binding: this.binding, config: this.store.publicConfig(), dataDirectory: this.store.directory, storageDirectory: storage.root,
      ...(this.bridge?.status() || { sessions: new SessionStore(this.store.directory).list(this.store.read().appId).map((session) => ({ ...session, permissions: sessionPermissions(this.store.read(), session), storage: storage.paths({ scope: session.scope as 'c2c' | 'group', targetId: session.peerId }) })), observedPeers: {}, pending: [] }) };
  }

  async start(): Promise<unknown> {
    if (this.connecting) return this.connecting;
    if (this.bridge && this.connected) return this.status();
    this.connecting = this.startOnce().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async startOnce(): Promise<unknown> {
    if (this.bridge) await this.stop();
    const config = this.store.read();
    if (!config.appId || !config.appSecret) throw new Error('尚未绑定 QQ 机器人，请打开 qqbot_setup 返回的本地页面扫码或手动填写 AppID / AppSecret。');
    this.lastError = undefined;
    const logger: Logger = { ...this.logger,
      debug: (text) => { if (config.debug) this.logger.info(text); else this.logger.debug(text); } };
    const transport = new QQTransport(config, logger);
    const client = new CodexClient(config, logger);
    const bridge = new QQBridge(config, this.store.directory, transport, client, logger);
    this.bridge = bridge;
    transport.onDisconnected = (reason) => { if (this.bridge === bridge) { this.connected = false; this.lastError = reason; } };
    transport.onConnected = () => { if (this.bridge === bridge) { this.connected = true; this.lastError = undefined; } };
    client.onExit((error) => { this.lastError = error.message; });
    try { await bridge.start(); this.connected = true; return this.status(); }
    catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await bridge.close(); this.bridge = undefined; this.connected = false; throw error;
    }
  }

  async stop(): Promise<unknown> {
    const bridge = this.bridge;
    this.bridge = undefined; this.connected = false;
    if (bridge) await bridge.close();
    return this.status();
  }

  async configure(patch: Record<string, unknown>): Promise<unknown> {
    const bridge = this.bridge;
    const config = this.store.preview(patch);
    const restart = bridge?.requiresRestart(config);
    if (bridge && restart && bridge.status().sessions.some(session => session.busy || session.queued)) {
      throw new Error('此设置需要重新连接 QQ，请等待当前任务与排队消息处理完成后保存，或先中止任务。');
    }
    this.store.update(patch);
    if (bridge && !restart) { bridge.applyThreadSettings(config); return this.status(); }
    if (this.controlClient) { await this.controlClient.close(); this.controlClient = undefined; }
    if (bridge) { await this.stop(); return this.start(); }
    return this.status();
  }

  bind(): unknown {
    this.cancelBinding();
    const generation = this.bindGeneration;
    this.binding = { phase: 'starting' };
    this.stopBinding = startQrConnect({
      onQrDisplayed: (url) => { if (generation === this.bindGeneration) this.binding = { phase: 'waiting', qrUrl: url }; },
      onQrExpired: () => { if (generation === this.bindGeneration) this.binding = { phase: 'expired' }; },
      onFailure: (error) => { if (generation === this.bindGeneration) this.binding = { phase: 'failed', reason: error.message }; },
      onSuccess: (credentials) => {
        if (generation !== this.bindGeneration) return;
        const credential = credentials[0];
        if (!credential) { this.binding = { phase: 'failed', reason: '扫码未返回机器人凭据。' }; return; }
        this.binding = { phase: 'saving' };
        void this.configure({ appId: credential.appId, appSecret: credential.appSecret })
          .then(() => this.start())
          .then(() => { if (generation === this.bindGeneration) this.binding = { phase: 'bound' }; })
          .catch((error: Error) => { if (generation === this.bindGeneration) this.binding = { phase: 'failed', reason: error.message }; });
      },
    }, { displayQrCodeToConsole: false, source: 'codex' });
    return this.status();
  }

  cancelBinding(): void {
    this.bindGeneration++;
    this.stopBinding?.(); this.stopBinding = undefined;
    this.binding = { phase: 'idle' };
  }

  async unbind(): Promise<unknown> {
    this.cancelBinding(); await this.stop();
    if (process.env.QQBOT_APPID || process.env.QQBOT_SECRET) throw new Error('请先移除 QQBOT_APPID / QQBOT_SECRET 环境变量，再解绑。');
    this.store.update({ appId: '', appSecret: '' });
    return this.status();
  }

  async send(target: ReplyTarget, text: string): Promise<unknown> {
    if (!this.bridge || !this.connected) throw new Error('QQ 连接尚未启动。');
    await this.bridge.send(target, text); return { sent: true };
  }

  async sendFile(target: ReplyTarget, path: string, sendAs?: unknown): Promise<unknown> {
    if (!this.bridge || !this.connected) throw new Error('QQ 连接尚未启动。');
    await this.bridge.sendFile(target, path, fileSendModeSchema.parse(sendAs)); return { sent: true };
  }

  async models(): Promise<unknown> {
    const owned = !this.bridge;
    const client = this.bridge?.client || new CodexClient(this.store.read(), this.logger);
    try { await client.start(); return await client.call('model/list', {}); }
    finally { if (owned) await client.close(); }
  }

  private async controls(): Promise<CodexClient> {
    this.controlClient ||= new CodexClient(this.store.read(), this.logger);
    await this.controlClient.start(); return this.controlClient;
  }

  async account(): Promise<unknown> {
    const result = await (await this.controls()).call('account/read', { refreshToken: false });
    return { authenticated: Boolean(result.account), type: result.account?.type || null, plan: result.account?.planType || null,
      requiresOpenaiAuth: result.requiresOpenaiAuth };
  }

  async login(): Promise<unknown> { return (await this.controls()).call('account/login/start', { type: 'chatgpt' }); }

  async dispose(): Promise<void> {
    this.cancelBinding(); await this.stop(); await this.controlClient?.close(); this.controlClient = undefined;
  }

  async catalog(): Promise<unknown> {
    const owned = !this.bridge;
    const client = this.bridge?.client || new CodexClient(this.store.read(), this.logger);
    try {
      await client.start();
      const config = (await client.call('config/read', { includeLayers: false })).config;
      const providers = Object.entries(config.model_providers || {}).filter(([id]) => id !== openAIHttpProvider).map(([id, item]: [string, any]) => ({ id, name: item.name || id }));
      if (!providers.some((provider) => provider.id === 'openai')) providers.unshift({ id: 'openai', name: 'OpenAI' });
      const skills = await client.call('skills/list', { cwds: [this.store.read().cwd] });
      return { providers, skills: (skills.data || []).flatMap((entry: any) => entry.skills || []).map((skill: any) => ({ name: skill.name, description: skill.description, path: skill.path, enabled: skill.enabled })) };
    } finally { if (owned) await client.close(); }
  }

  async session(scope: 'c2c' | 'group', peerId: string, action: string, settings: Record<string, unknown> = {}): Promise<unknown> {
    if (this.bridge && (action === 'reset' || action === 'compact')) this.bridge.startContextOperation(scope, peerId, action);
    else if (this.bridge) await this.bridge.manageSession(scope, peerId, action, settings);
    else if (action === 'rename') {
      const name = sessionNameSchema.parse(settings.name);
      const sessions = new SessionStore(this.store.directory);
      const key = `${this.store.read().appId}:${scope}:${peerId}`;
      sessions.set(key, { ...sessions.get(key), name });
    } else if (action === 'configure') {
      const patch = sessionSettingsSchema.parse(settings);
      const config = this.store.read();
      if (patch.preset && !config.presets[patch.preset]) throw new Error(`预设不存在：${patch.preset}`);
      const sessions = new SessionStore(this.store.directory);
      const key = `${config.appId}:${scope}:${peerId}`;
      const saved = sessions.get(key);
      if (patch.preset !== undefined && patch.preset !== saved.preset) {
        saved.previousThreadId = saved.threadId || saved.previousThreadId;
        saved.threadId = undefined; saved.activePreset = undefined;
      }
      sessions.set(key, { ...saved, ...patch });
    } else throw new Error('请先启动 QQ 连接。');
    if (!this.bridge) {
      const saved = new SessionStore(this.store.directory).get(`${this.store.read().appId}:${scope}:${peerId}`);
      new ConversationStorage(this.store.directory, this.store.read()).saveSession({ scope, targetId: peerId }, saved.name || '', saved.threadId, saved.previousThreadId);
    }
    return this.status();
  }

  async conversation(scope: 'c2c' | 'group', peerId: string, cursor?: string) {
    const saved = new SessionStore(this.store.directory).get(`${this.store.read().appId}:${scope}:${peerId}`);
    const live = this.bridge?.liveConversation(scope, peerId);
    const threadId = live?.threadId || saved.threadId;
    if (!threadId) return { threadId: null, messages: [], activities: [], turnIds: [], nextCursor: null, pending: live?.pending || [] };
    const page = await readConversation(this.bridge?.client || await this.controls(), threadId, cursor);
    if (!cursor && live) {
      const current = this.bridge!.liveConversation(scope, peerId);
      if (current.threadId === threadId) {
        if (current.input && current.turnId && !page.turnIds.includes(current.turnId)) {
          page.messages.push({ ...current.input, turnId: current.turnId }); page.turnIds.push(current.turnId);
        }
        for (const message of current.messages) {
          const index = page.messages.findIndex((item) => item.id === message.id);
          const visible = { ...message, turnId: current.turnId };
          if (index >= 0) page.messages[index] = { ...page.messages[index]!, ...visible }; else page.messages.push(visible);
        }
        for (const activity of current.activities) {
          const index = page.activities.findIndex((item) => item.id === activity.id);
          if (index >= 0) page.activities[index] = activity; else page.activities.push(activity);
        }
      }
    }
    return { threadId, messages: page.messages, activities: page.activities, activeTurnId: this.bridge?.liveConversation(scope, peerId).turnId,
      turnIds: page.turnIds, nextCursor: page.nextCursor, pending: this.bridge?.liveConversation(scope, peerId).pending || [] };
  }

  private async previewImage(scope: 'c2c' | 'group', peerId: string, path: string) {
    const config = this.store.read(); const target = { scope, targetId: peerId };
    const saved = new SessionStore(this.store.directory).get(`${config.appId}:${scope}:${peerId}`);
    if (!saved.threadId) throw new Error('会话不存在。');
    const storage = new ConversationStorage(this.store.directory, config);
    const actual = await new MediaStore(this.store.directory, config).allowedFile(path, [storage.paths(target).directory, saved.cwd || config.presets[saved.preset || config.preset]?.cwd || config.cwd]);
    if (config.sendFile.restrictPaths) storage.assertFile(target, actual);
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
    const mime = types[extname(actual).toLowerCase()]; if (!mime) throw new Error('该文件类型不支持图片预览。');
    if ((await stat(actual)).size > config.vision.maxBytes) throw new Error('图片超过预览大小上限，请从存储目录查看。');
    return { name: basename(actual), dataUrl: `data:${mime};base64,${(await readFile(actual)).toString('base64')}` };
  }

  async invoke(action: string, params: Record<string, any> = {}): Promise<unknown> {
    switch (action) {
      case 'status': return this.status();
      case 'start': return this.start();
      case 'stop': return this.stop();
      case 'configure':
        if (params.effort === null) params.effort = undefined;
        return this.configure(params);
      case 'bind': return this.bind();
      case 'cancelBind': this.cancelBinding(); return this.status();
      case 'unbind': return this.unbind();
      case 'models': return this.models();
      case 'catalog': return this.catalog();
      case 'account': return this.account();
      case 'login': return this.login();
      case 'credentials':
        if (typeof params.appId !== 'string' || !params.appId || typeof params.appSecret !== 'string' || !params.appSecret) throw new Error('请填写 AppID 与 AppSecret。');
        await this.configure({ appId: params.appId, appSecret: params.appSecret }); return this.start();
      case 'qr': {
        if (!this.binding.qrUrl) throw new Error('暂无二维码。');
        return { dataUrl: await QRCode.toDataURL(this.binding.qrUrl, { width: 360, margin: 2 }) };
      }
      case 'session':
        if ((params.scope !== 'c2c' && params.scope !== 'group') || !params.target_id) throw new Error('需要有效的会话目标。');
        if (params.action === 'preview') {
          if (typeof params.file_path !== 'string') throw new Error('需要有效的图片路径。');
          return this.previewImage(params.scope, params.target_id, params.file_path);
        }
        if (params.action === 'history') return this.conversation(params.scope, params.target_id, params.cursor);
        if (params.action === 'rename') return this.session(params.scope, params.target_id, 'rename', { name: params.name });
        if (params.action === 'upload') {
          if (!this.bridge || !this.connected) throw new Error('QQ 连接尚未启动。');
          if (!this.bridge.status().sessions.some(session => session.scope === params.scope && session.peerId === params.target_id)) throw new Error('请先选择已有的 QQ 会话。');
          const config = this.store.read();
          const storage = new ConversationStorage(this.store.directory, config);
          return new MediaStore(this.store.directory, config).uploadChunk(storage.files({ scope: params.scope, targetId: params.target_id }, 'direct'), {
            upload_id: params.upload_id, file_name: params.file_name, file_size: params.file_size, offset: params.offset, data: params.data,
          });
        }
        if (params.action === 'sendFile') {
          if (typeof params.file_path !== 'string' || !params.file_path) throw new Error('请选择要发送的文件。');
          return this.sendFile({ scope: params.scope, targetId: params.target_id }, params.file_path, params.send_as);
        }
        if (params.action === 'send') {
          if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('请输入要发送的消息。');
          return this.send({ scope: params.scope, targetId: params.target_id }, params.text);
        }
        if (params.action === 'chat') {
          if (!this.bridge || !this.connected) throw new Error('请先启动 QQ 连接。');
          if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('请输入消息。');
          this.bridge.submitLocal(params.scope, params.target_id, params.text.trim());
          return { accepted: true, ...this.status() };
        }
        return this.session(params.scope, params.target_id, params.action, params.settings);
      default: throw new Error(`未知设置操作：${action}`);
    }
  }
}
