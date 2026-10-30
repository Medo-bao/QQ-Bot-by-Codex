import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConfigStore } from './config.ts';
import { callService, ensureService } from './service.ts';
import { uiDocument } from './ui-document.ts';
import { fileSendModeSchema } from './media.ts';

export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: 'codex-qqbot', title: 'QQ Bot', version: '0.0.3' });
  const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}) });
  const execute = async (method: string, params: Record<string, unknown> = {}) => {
    try { await ensureService(); return textResult(await callService(method, params)); }
    catch (error) { return { isError: true, ...textResult({ error: error instanceof Error ? error.message : String(error) }) }; }
  };
  server.registerTool('qqbot_status', { title: 'QQ Bot 连接状态', description: 'Read QQ bridge connection state, current Codex sessions, pending questions and observed user/group OpenIDs. Does not start a connection.', annotations: { readOnlyHint: true }, inputSchema: {} }, async () => {
    try { return textResult(await callService('status')); }
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
    }, () => execute('setup'));
    server.registerTool('qqbot_ui', {
      title: 'QQ Bot 页面操作',
      description: 'Settings app backend. Called only by the plugin UI, never by the model.',
      inputSchema: { action: z.enum(['status', 'configure', 'bind', 'cancelBind', 'unbind', 'credentials', 'start', 'stop', 'models', 'catalog', 'account', 'login', 'qr', 'session', 'shutdown']), payload: z.record(z.string(), z.unknown()).optional() },
      _meta: { ui: { visibility: ['app'] } },
    }, ({ action, payload }) => execute(action, payload || {}));
    server.registerTool('qqbot_start', { title: '启动 QQ Bot', description: 'Start the configured QQ connection and route authorized QQ messages into independent local Codex sessions. Requires previously saved QQ credentials.', inputSchema: {} }, () => execute('start'));
    server.registerTool('qqbot_stop', { title: '停止 QQ Bot', description: 'Stop the QQ connection and its active Codex tasks.', inputSchema: {} }, () => execute('stop'));
    server.registerTool('qqbot_configure', { title: 'QQ Bot 配置', description: 'Update QQ bridge settings. Use the local setup page for credentials. Model, prompt and permission changes apply to subsequent messages without interrupting active tasks. Connection changes require idle conversations before reconnecting.', inputSchema: {
      changes: z.record(z.string(), z.unknown()).describe('Configuration patch: cwd, modelProvider, model, effort, preset, presets, prompts, streaming, access, media, vision, sendFile, timeouts, queue/history limits, sandbox, approvalPolicy, debug and Codex launch settings.'),
    } }, ({ changes }) => {
      if ('appId' in changes || 'appSecret' in changes) return Promise.resolve({ isError: true, ...textResult({ error: '凭据请在设置页填写。' }) });
      return execute('configure', changes);
    });
    server.registerTool('qqbot_models', { title: 'QQ Bot 可用模型', description: 'List models and reasoning efforts available through the installed Codex login and configuration.', annotations: { readOnlyHint: true }, inputSchema: {} }, () => execute('models'));
    const destination = { scope: z.enum(['c2c', 'group']), target_id: z.string().min(1) };
    server.registerTool('qqbot_send_message', { title: 'QQ Bot 发送消息', description: 'Send a Markdown message to a specified QQ user or group. Use only when the human explicitly asks to send to this QQ conversation.', inputSchema: { ...destination, text: z.string().min(1) } }, (params) => execute('send', params));
    server.registerTool('qqbot_send_file', { title: 'QQ Bot 发送文件', description: 'Send an existing local file to a specified QQ conversation, within configured allowed paths. MP3 defaults to an original file. Set send_as=file to force a downloadable file or send_as=voice for a voice message. Requires an explicit human request to send to that recipient.', inputSchema: { ...destination, file_path: z.string().min(1), send_as: fileSendModeSchema.describe('auto previews images/videos and native QQ voice; ordinary audio such as MP3 is sent as a file. file always preserves the original file and filename. voice sends audio as a voice message.') } }, (params) => execute('sendFile', params));
  }
  await server.connect(new StdioServerTransport());
}
