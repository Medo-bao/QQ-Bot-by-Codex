import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const browserEnvironmentKeys = ['BROWSER_USE_ACCESS_EXECUTOR_ID', 'BROWSER_USE_ACCESS_PIPE_PATH',
  'BROWSER_USE_ACCESS_VERIFYING_IDENTITY', 'CODEX_WINDOWS_REGISTERED_CORE'] as const;
export interface BrowserContext { threadId: string; turnId: string; }
export interface BrowserLoginResult {
  state: 'signed_in' | 'signed_out' | 'unknown'; url: string; checkedAt: string; evidence: string[]; account?: string; reason?: string;
}

/** Only visible controls establish a login state; HTTP errors and missing tools do not. */
export function browserLoginState(url: string, snapshot: string): Omit<BrowserLoginResult, 'checkedAt'> {
  const page = new URL(url); const safeUrl = page.origin + page.pathname;
  const unknown = { state: 'unknown' as const, url: safeUrl, evidence: [] };
  if (/^\s*- (?:heading|alert|generic|paragraph) "(?:Access denied|Forbidden|Verify you are human|Something went wrong|访问受限|验证您是真人|出了点问题)/im.test(snapshot)) {
    return { ...unknown, reason: '页面访问受限或要求验证，无法判断登录状态。' };
  }
  const x = /(^|\.)(x|twitter)\.com$/i.test(page.hostname);
  const accountMenu = /^\s*- button "(?:Account menu|账号菜单|账户菜单)"/im.test(snapshot);
  const signOut = /^\s*- (?:button|link) "(?:Log out|Sign out|退出登录|登出)(?:[" ·])/im.test(snapshot);
  if (signOut || x && accountMenu) {
    const profile = /- link "(?:Profile|个人资料)"[^\n]*\n\s*- \/url: \/([\w]+)\s*$/im.exec(snapshot)?.[1];
    return { state: 'signed_in', url: safeUrl, evidence: [accountMenu ? '页面显示账户菜单。' : '页面显示退出登录控件。'], ...(profile ? { account: `@${profile}` } : {}) };
  }
  const loginHeading = /^\s*- heading "(?:Sign in to X|Log in to X|登录 X|登入 X|登录到 X|登录|Sign in|Log in)"/im.test(snapshot);
  const passwordField = /^\s*- (?:textbox|text field) "[^"\n]*(?:Password|密码)/im.test(snapshot);
  const loggedOutX = x && /^\s*- (?:button|link) "(?:Log in|Sign in|登录|登入)"/im.test(snapshot) &&
    /^\s*- (?:button|link) "(?:Sign up|Create account|Create an account|创建账号|创建账户|注册)"/im.test(snapshot);
  if (loginHeading && (passwordField || x && page.pathname.startsWith('/i/flow/login')) || loggedOutX) {
    return { state: 'signed_out', url: safeUrl, evidence: [loginHeading ? '页面显示登录表单。' : 'X 页面显示登录和注册入口，未显示账户菜单。'] };
  }
  return { ...unknown, reason: '页面没有足以确认登录或退出状态的控件。' };
}

/** Reads the attached desktop browser through its official CUA MCP runtime. No arbitrary scripts or account actions are exposed. */
export class BrowserAccess {
  private client?: Client;
  private environment: Record<string, string> = {};
  private identity?: string;
  private boundContext?: string;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly context: () => Promise<BrowserContext>) {
    this.attach(Object.fromEntries(browserEnvironmentKeys.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])));
  }
  attach(values: Record<string, unknown> = {}): void {
    const environment = Object.fromEntries(browserEnvironmentKeys.flatMap(key => typeof values[key] === 'string' && values[key] ? [[key, values[key] as string]] : []));
    if (!environment.BROWSER_USE_ACCESS_PIPE_PATH) return;
    if (JSON.stringify(environment) !== JSON.stringify(this.environment)) { this.environment = environment; this.identity = undefined; void this.close(); }
  }
  private runtime(): any {
    const base = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
    if (existsSync(base)) for (const version of readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      const manifest = join(base, version, '.mcp.json');
      if (existsSync(manifest)) {
        const server = JSON.parse(readFileSync(manifest, 'utf8')).mcpServers?.cua_repl;
        if (server?.command && server.enabled !== false) return server;
      }
    }
    throw new Error('未找到 Codex 桌面的浏览器运行组件，请更新并打开 Codex。');
  }
  private ownIdentity(): string {
    const desktop = JSON.parse(this.environment.BROWSER_USE_ACCESS_EXECUTOR_ID || 'null');
    if (!Array.isArray(desktop) || !desktop[0] || !this.environment.BROWSER_USE_ACCESS_PIPE_PATH || !this.environment.BROWSER_USE_ACCESS_VERIFYING_IDENTITY) {
      throw new Error('尚未连接桌面浏览器，请从 Codex 重新打开 QQ Bot。');
    }
    // The desktop authorizer verifies this account-bound identity and its own browser policy.
    // Never remove its access check or borrow a different account's identity.
    try {
      const auth = JSON.parse(readFileSync(join(this.directory, 'codex-home', 'auth.json'), 'utf8'));
      const claims = JSON.parse(Buffer.from(auth.tokens?.id_token?.split('.')[1] || '', 'base64url').toString('utf8'))['https://api.openai.com/auth'];
      if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.account_id || claims?.chatgpt_account_id !== auth.tokens.account_id || !claims?.chatgpt_user_id) throw new Error('missing identity');
      return JSON.stringify([desktop[0], auth.tokens.account_id, claims.chatgpt_user_id]);
    } catch { throw new Error('无法确认机器人账号的浏览器身份，请检查 Codex 登录。'); }
  }
  private async connect(): Promise<Client> {
    if (this.disposed) throw new Error('网站登录检查已关闭。');
    const identity = this.ownIdentity();
    if (this.client && this.identity === identity) return this.client;
    await this.close();
    const server = this.runtime();
    const transport = new StdioClientTransport({ command: server.command, args: server.args || [],
      env: { ...process.env, ...server.env, ...this.environment, BROWSER_USE_ACCESS_EXECUTOR_ID: identity }, stderr: 'pipe' });
    const client = new Client({ name: 'qqbot-browser', version: '0.0.5' });
    // Runtime diagnostics stay local and must not echo browser credentials into QQ.
    transport.stderr?.on('data', () => {});
    try { await client.connect(transport); }
    catch (error) { await client.close().catch(() => {}); throw error; }
    this.identity = identity; this.client = client; return client;
  }
  private async js(code: string, context: BrowserContext): Promise<string[]> {
    const client = await this.connect();
    const response = await client.callTool({ name: 'js', arguments: { code, title: 'QQ Bot 网站登录检查', timeout_ms: 30000 },
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: context.threadId, thread_id: context.threadId, turn_id: context.turnId }) } });
    const texts = (response.content as any[] || []).filter(item => item.type === 'text').map(item => item.text as string);
    if (response.isError) throw new Error(texts.at(-1) || '浏览器读取失败。');
    return texts;
  }
  private json(texts: string[]): any {
    for (const text of [...texts].reverse()) { try { return JSON.parse(text); } catch { /* The runtime also emits its documentation. */ } }
    throw new Error('浏览器没有返回可读取的页面状态。');
  }
  inspect(url: string): Promise<BrowserLoginResult> {
    const operation = this.queue.then(() => this.inspectOnce(url));
    this.queue = operation.catch(() => {}); return operation;
  }
  private async inspectOnce(url: string): Promise<BrowserLoginResult> {
    let owned = false; let failed = false; let context: BrowserContext | undefined; let safeUrl = '';
    const checkedAt = new Date().toISOString();
    try {
      const requested = new URL(url);
      safeUrl = requested.origin + requested.pathname;
      if (!['http:', 'https:'].includes(requested.protocol) || requested.username || requested.password) throw new Error('请提供有效的 HTTP(S) 网站地址。');
      context = await this.context();
      if (this.boundContext && this.boundContext !== context.threadId) await this.close();
      await this.connect();
      // A fresh CUA session's first call selects a browser and reads the runtime's instructions.
      if (!this.boundContext) { await this.js('var qqLoginBrowser = await cua.getBrowser({ id: "iab" });', context); this.boundContext = context.threadId; }
      const tabs = this.json(await this.js('nodeRepl.write(JSON.stringify(await cua.listTabs({ browser: qqLoginBrowser.browserId, emit: false })));', context));
      const existing = tabs.find((tab: any) => tab.url === requested.href) || tabs.find((tab: any) => {
        try { return new URL(tab.url).origin === requested.origin; } catch { return false; }
      });
      if (existing) await this.js(`var qqLoginTab = await qqLoginBrowser.tabs.get(${JSON.stringify(existing.id)});`, context);
      else {
        await this.js(`var qqLoginTab = await cua.createBrowserTab(qqLoginBrowser.browserId, ${JSON.stringify(requested.href)}, { visible: false });`, context);
        owned = true;
      }
      const page = this.json(await this.js('nodeRepl.write(JSON.stringify({ url: await qqLoginTab.url(), snapshot: await qqLoginTab.playwright.domSnapshot() }));', context));
      if (new URL(page.url).origin !== requested.origin) return { state: 'unknown', url: safeUrl, checkedAt, evidence: [], reason: '页面跳转到其他站点，无法确认目标网站的登录状态。' };
      const result = browserLoginState(page.url, page.snapshot);
      return { ...result, checkedAt };
    } catch (error) {
      failed = true;
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      return { state: 'unknown', url: safeUrl, checkedAt, evidence: [], reason };
    } finally {
      if (owned && context) await this.js('await qqLoginTab.close();', context).catch(() => {});
      if (failed) await this.close();
    }
  }
  async close(): Promise<void> { const client = this.client; this.client = undefined; this.boundContext = undefined; await client?.close().catch(() => {}); }
  async dispose(): Promise<void> { this.disposed = true; await this.close(); }
}
