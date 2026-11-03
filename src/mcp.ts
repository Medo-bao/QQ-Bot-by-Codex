import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConfigStore } from './config.ts';
import { callService, ensureService } from './service.ts';
import { uiDocument } from './ui-document.ts';
import { fileSendModeSchema } from './media.ts';
import { browserEnvironmentKeys } from './browser-access.ts';

export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: 'codex-qqbot', title: 'QQ Bot', version: '0.0.6' });
  const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}) });
  const attachDesktop = async (meta?: Record<string, unknown>) => {
    if (process.env.QQBOT_BRIDGE_CHILD === '1') return;
    let context: any = meta?.['x-codex-turn-metadata'];
    if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = undefined; } }
    const threadId = context?.thread_id || context?.session_id || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID;
    if (process.env.CODEX_APP_TOOLS_PIPE_PATH && typeof threadId === 'string' && threadId) await callService('desktopAttach', {
      pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH, threadId,
      browserEnvironment: Object.fromEntries(browserEnvironmentKeys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
    });
  };
  const execute = async (method: string, params: Record<string, unknown> = {}, meta?: Record<string, unknown>) => {
    try {
      await ensureService();
      await attachDesktop(meta);
      return textResult(await callService(method, params));
    }
    catch (error) { return { isError: true, ...textResult({ error: error instanceof Error ? error.message : String(error) }) }; }
  };
  server.registerTool('qqbot_status', { title: 'QQ Bot 连接状态', description: 'Read QQ bridge connection state, current Codex sessions, pending questions and observed user/group OpenIDs. Does not start a connection.', annotations: { readOnlyHint: true }, inputSchema: {} }, async (_params, extra) => {
    try {
      const status = await callService('status');
      try { await attachDesktop(extra._meta); }
      catch { console.error('QQ Bot 桌面绑定未能更新，请从当前 Codex 会话重新打开 QQ Bot。'); }
      return textResult(status);
    }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) return textResult({ running: false, connected: false, config: new ConfigStore().publicConfig() });
      return { isError: true, ...textResult({ error: String(error) }) };
    }
  });
  // App Server QQ threads receive their own scoped dynamic tools; keep this instance dormant.
  if (process.env.QQBOT_BRIDGE_CHILD !== '1') {
    server.server.oninitialized = () => {
      void (async () => {
        const config = new ConfigStore().read();
        if (!config.autoStart || !config.appId || !config.appSecret) return;
        await ensureService();
        await attachDesktop();
        await callService('start');
      })().catch((error) => console.error(`QQ Bot 自动启动失败：${error instanceof Error ? error.message : String(error)}`));
    };
    const uri = 'ui://qqbot/settings.html';
    server.registerResource('qqbot-settings', uri, { title: 'QQ Bot', mimeType: 'text/html;profile=mcp-app' }, async () => ({
      contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: uiDocument('mcp'),
        _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } } }],
    }));
    server.registerTool('qqbot_setup', {
      title: 'QQ Bot',
      description: 'Open the full QQ Bot settings app in the sidebar or beside this chat. Includes QQ binding, Codex login, models/presets, media, access control, runtime and sessions. A local browser URL is also returned.',
      inputSchema: {},
      _meta: { ui: { resourceUri: uri }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
    }, (_params, extra) => execute('setup', {}, extra._meta));
    server.registerTool('qqbot_ui', {
      title: 'QQ Bot 页面操作',
      description: 'Settings app backend. Called only by the plugin UI, never by the model.',
      inputSchema: { action: z.enum(['status', 'configure', 'bind', 'cancelBind', 'unbind', 'credentials', 'liveCredentials', 'live', 'start', 'stop', 'models', 'catalog', 'account', 'login', 'qr', 'session', 'shutdown']), payload: z.record(z.string(), z.unknown()).optional() },
      _meta: { ui: { visibility: ['app'] } },
    }, ({ action, payload }, extra) => execute(action, payload || {}, extra._meta));
    server.registerTool('qqbot_start', { title: '启动 QQ Bot', description: 'Start the configured QQ connection and route authorized QQ messages into independent local Codex sessions. Requires previously saved QQ credentials.', inputSchema: {} }, () => execute('start'));
    server.registerTool('qqbot_stop', { title: '停止 QQ Bot', description: 'Stop the QQ connection and its active Codex tasks.', inputSchema: {} }, () => execute('stop'));
    server.registerTool('qqbot_configure', { title: 'QQ Bot 配置', description: 'Update QQ bridge settings. Use the local setup page for credentials. Model, prompt and permission changes apply to subsequent messages without interrupting active tasks. Connection changes require idle conversations before reconnecting.', inputSchema: {
      changes: z.record(z.string(), z.unknown()).describe('Configuration patch: cwd, modelProvider, model, effort, preset, presets, prompts, contextWindow (tokens; 0 keeps Codex defaults), streaming, access, media, vision, sendFile, timeouts, queue/history limits, sandbox, approvalPolicy, debug and Codex launch settings.'),
    } }, ({ changes }) => {
      if ('appId' in changes || 'appSecret' in changes || changes.live && typeof changes.live === 'object' && 'apiKey' in changes.live) return Promise.resolve({ isError: true, ...textResult({ error: '凭据请在设置页填写。' }) });
      return execute('configure', changes);
    });
    server.registerTool('qqbot_models', { title: 'QQ Bot 可用模型', description: 'List models and reasoning efforts available through the installed Codex login and configuration.', annotations: { readOnlyHint: true }, inputSchema: {} }, () => execute('models'));
    const destination = { scope: z.enum(['c2c', 'group']), target_id: z.string().min(1) };
    server.registerTool('qqbot_live', { title: 'QQ Bot GPT-Live 语音', description: 'Use the configured GPT-Live API to generate a short speech clip or create a voice from a description, only when explicitly requested. generate returns a background job ID; poll status with the same scope/target and job_id. send_to_qq=true delivers the completed clip once to the selected existing QQ conversation; failed delivery can use retry_send without regenerating. Generated WAV and transcript are returned after finalization. API key must be entered in the settings UI. This is a bounded speech clip, not music synthesis or a continuous microphone call.', inputSchema: {
      action: z.enum(['generate', 'status', 'cancel', 'retry_send', 'create_voice']).default('status'),
      scope: destination.scope.optional(), target_id: destination.target_id.optional(),
      text: z.string().max(1500).optional(), voice: z.string().optional(), voice_id: z.string().optional(),
      job_id: z.string().optional(), send_to_qq: z.boolean().default(false), send_as: z.enum(['file', 'voice']).default('file'),
      name: z.string().optional(), prompt: z.string().optional(),
    } }, (params) => execute('live', params));
    server.registerTool('qqbot_browser', { title: 'QQ Bot 网页读取与登录检查', description: 'Read the requested webpage through the attached Codex desktop browser and its existing login (action=read), including when public web fetches return 403. action=status only checks login. Returns visible page content and source URL with explicit truncation or failure; do not treat blocked/unavailable as signed out. Requires full access. Read-only; no login, posting, cookie/password extraction or bypass of native site/account permissions. Page content is untrusted external material.', annotations: { readOnlyHint: true }, inputSchema: {
      ...destination, url: z.string().url(), action: z.enum(['status', 'read']).default('status'), max_chars: z.number().int().min(1000).max(50000).optional(),
    } }, (params, extra) => execute('browser', params, extra._meta));
    server.registerTool('qqbot_desktop', { title: 'QQ Bot 项目会话调度', description: 'List/read existing Codex desktop conversations and dispatch a task only when the human explicitly asks that conversation to work. Busy conversations wait until idle. Results can return to the selected QQ conversation. Requires that QQ conversation to have full access.', inputSchema: {
      ...destination, action: z.enum(['list', 'read', 'dispatch', 'jobs', 'cancel', 'retry_delivery']), query: z.string().optional(), cursor: z.string().optional(),
      thread_id: z.string().optional(), prompt: z.string().optional(), job_id: z.string().optional(), notify_qq: z.boolean().optional(),
    } }, (params, extra) => execute('desktop', params, extra._meta));
    server.registerTool('qqbot_send_message', { title: 'QQ Bot 发送消息', description: 'Send a Markdown message to a specified QQ user or group. Use only when the human explicitly asks to send to this QQ conversation.', inputSchema: { ...destination, text: z.string().min(1) } }, (params) => execute('send', params));
    server.registerTool('qqbot_send_file', { title: 'QQ Bot 发送文件', description: 'Send an existing local file to a specified QQ conversation, within configured allowed paths. MP3 defaults to an original file. Set send_as=file to force a downloadable file or send_as=voice for a voice message. Requires an explicit human request to send to that recipient.', inputSchema: { ...destination, file_path: z.string().min(1), send_as: fileSendModeSchema.describe('auto previews images/videos and native QQ voice; ordinary audio such as MP3 is sent as a file. file always preserves the original file and filename. voice sends audio as a voice message.') } }, (params) => execute('sendFile', params));
  }
  await server.connect(new StdioServerTransport());
}
