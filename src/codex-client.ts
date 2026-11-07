import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, relative, toNamespacedPath } from 'node:path';
import { createInterface } from 'node:readline';
import type { BotConfig } from './config.ts';
import type { Logger } from './types.ts';
import { isolateThreadInstructions } from './prompt-policy.ts';
import { botCodexHome } from './codex-home.ts';
import { contextUsage, type ContextUsage } from './context-usage.ts';
import { refreshThreadTools, type ThreadToolSpec } from './thread-tool-cache.ts';

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string };
}

export const openAIHttpProvider = 'qqbot-openai-http';

/** Prefer a native executable on Windows, without invoking a shell or quoting user text. */
export function codexExecutable(command: string): { command: string; prefix: string[] } {
  if (extname(command) === '.js' || extname(command) === '.mjs') return { command: process.execPath, prefix: [command] };
  if (isAbsolute(command) && !/\.(cmd|bat)$/i.test(command)) return { command, prefix: [] };
  const paths = (process.env.PATH || '').split(delimiter);
  if (process.platform === 'win32') {
    for (const directory of paths) {
      const executable = join(directory, command.replace(/\.(cmd|exe)$/i, '') + '.exe');
      if (existsSync(executable)) return { command: executable, prefix: [] };
    }
    const scriptRoots = isAbsolute(command) ? [join(command, '..')] : paths;
    for (const directory of scriptRoots) {
      const script = join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(script)) return { command: process.execPath, prefix: [script] };
    }
    throw new Error('找不到 Codex 可执行文件，请配置 codexCommand 为 codex.exe 或 @openai/codex/bin/codex.js 的绝对路径。');
  }
  return { command, prefix: [] };
}

export class CodexClient {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private starting?: Promise<void>;
  private pending = new Map<number | string, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private notificationHandlers = new Set<(message: RpcMessage) => void>();
  private exitHandlers = new Set<(error: Error, threads: ReadonlySet<string>) => void>();
  private providerConnections = new Map<string, CodexClient>();
  private threadConnections = new Map<string, CodexClient>();
  requestHandler?: (message: RpcMessage) => Promise<unknown>;
  private closing = false;
  private runtimeHome?: string;
  private defaultModelProvider = 'openai';

  constructor(private readonly config: Pick<BotConfig, 'codexCommand' | 'codexArgs' | 'cwd' | 'responsesTransport'>,
    private readonly logger: Logger, private readonly startupProvider?: string) {}

  generatedImageDirectory(threadId: string): string | undefined {
    return this.runtimeHome ? join(this.runtimeHome, 'generated_images', threadId) : undefined;
  }

  async refreshThreadTools(threadId: string, tools: readonly ThreadToolSpec[], options: { created?: boolean } = {}): Promise<boolean> {
    if (!this.runtimeHome) throw new Error('Codex App Server 尚未启动。');
    return refreshThreadTools(this.threadConnections.get(threadId) || this, this.runtimeHome, threadId, tools, options);
  }

  async readContextUsage(threadId: string): Promise<ContextUsage | undefined> {
    const result = await this.call('thread/read', { threadId, includeTurns: false });
    const path = result.thread?.path;
    if (!this.runtimeHome || typeof path !== 'string') return;
    const rel = relative(toNamespacedPath(join(this.runtimeHome, 'sessions')), toNamespacedPath(path));
    if (rel.startsWith('..') || isAbsolute(rel)) return;
    let latest: ContextUsage | undefined;
    const handle = await open(path, 'r');
    const stream = handle.createReadStream({ encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let item: any; try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'event_msg' && item.payload?.type === 'token_count' && item.payload.info) {
          const info = item.payload.info;
          latest = contextUsage(threadId, info.last_token_usage?.total_tokens, info.model_context_window, Date.parse(item.timestamp)) || latest;
        } else if (item.type === 'compacted' && latest) latest.stale = true;
      }
    } finally { lines.close(); stream.destroy(); }
    return latest;
  }

  onNotification(handler: (message: RpcMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onExit(handler: (error: Error, threads: ReadonlySet<string>) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.closing = false;
    this.starting = this.initialize().catch((error) => { this.starting = undefined; throw error; });
    return this.starting;
  }

  private async initialize(): Promise<void> {
    const executable = codexExecutable(this.config.codexCommand);
    this.runtimeHome = botCodexHome();
    // Plugin MCP discovery happens at server startup, before per-thread config applies.
    const child = spawn(executable.command, [...executable.prefix, 'app-server', ...this.config.codexArgs,
      ...(this.config.responsesTransport !== 'auto' || this.startupProvider === openAIHttpProvider
        ? ['-c', `model_providers.${openAIHttpProvider}={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`] : []),
      ...(this.startupProvider ? ['-c', `model_provider=${JSON.stringify(this.startupProvider)}`] : []),
      '-c', 'plugins.codex-qqbot@qqbot-local.enabled=false',
      '-c', 'notify=[]',
      '-c', 'shell_environment_policy.set.PYTHONUTF8="1"',
      '-c', 'shell_environment_policy.set.PYTHONIOENCODING="utf-8"',
      '-c', 'developer_instructions=""', '-c', 'project_doc_max_bytes=0', '-c', 'personality="none"',
      '-c', 'memories.use_memories=false', '-c', 'memories.generate_memories=false'], {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: this.runtimeHome, QQBOT_BRIDGE_CHILD: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.logger.warn(`Codex protocol: ${error instanceof Error ? error.message : error}`); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.logger.debug(chunk.trim()));
    child.stdin.on('error', (error) => this.failed(error));
    child.on('error', (error) => {
      if (this.child === child) { this.child = undefined; this.starting = undefined; }
      this.failed(error);
    });
    child.on('exit', (code, signal) => {
      lines.close();
      if (this.child === child) {
        this.child = undefined;
        this.starting = undefined;
        this.failed(new Error(`Codex App Server 已退出 (code=${code}, signal=${signal})`));
      }
    });
    await this.call('initialize', {
      clientInfo: { name: 'codex_qqbot', title: 'QQ Bot', version: '0.0.7' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    const settings = await this.call('config/read', { includeLayers: false });
    this.defaultModelProvider = settings.config?.model_provider || 'openai';
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 60000): Promise<any> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const owner = threadId ? this.threadConnections.get(threadId) : undefined;
    if (method !== 'thread/start' && method !== 'thread/resume') return (owner || this).request(method, params, timeoutMs);

    const selected = typeof params.modelProvider === 'string' ? params.modelProvider : '';
    const requested = selected || this.defaultModelProvider;
    let provider = requested === 'openai' && this.config.responsesTransport !== 'auto' ? openAIHttpProvider : requested;
    if (method === 'thread/resume' && threadId) {
      // Newer Codex validates the stored provider against the process configuration
      // before applying resume overrides. Read the stored provider without resuming.
      const saved = owner?.startupProvider || (await (owner || this).request('thread/read', { threadId, includeTurns: false }, timeoutMs)).thread?.modelProvider;
      if (typeof saved === 'string' && saved) {
        const logicalProvider = (value: string) => value === openAIHttpProvider ? 'openai' : value;
        // An explicit provider change continues in a fork, keeping the old thread intact.
        if (selected && logicalProvider(saved) !== logicalProvider(provider)) method = 'thread/fork';
        else provider = saved;
      }
    }
    const connection = await this.connectionFor(provider);
    const result = await connection.request(method, isolateThreadInstructions({ ...params, modelProvider: provider }), timeoutMs);
    if (typeof result.thread?.id === 'string') this.threadConnections.set(result.thread.id, connection);
    return result;
  }

  private async connectionFor(provider: string): Promise<CodexClient> {
    if (this.closing) throw new Error('Codex App Server 已关闭。');
    if (provider === this.defaultModelProvider) return this;
    let connection = this.providerConnections.get(provider);
    if (!connection) {
      const client = new CodexClient(this.config, this.logger, provider);
      client.requestHandler = (message) => this.handleRequest(message);
      client.onNotification((message) => this.emitNotification(message));
      client.onExit((error) => this.emitExit(error, client));
      this.providerConnections.set(provider, client);
      connection = client;
    }
    await connection.start();
    return connection;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closing || !this.child || this.child.killed || !this.child.stdin.writable) return Promise.reject(new Error('Codex App Server 未启动或已关闭。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.closing && this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private receive(message: RpcMessage): void {
    if (message.method && message.id !== undefined) {
      void this.answer(message);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
      else pending.resolve(message.result);
    } else if (message.method) this.emitNotification(message);
  }

  private emitNotification(message: RpcMessage): void {
    for (const handler of this.notificationHandlers) handler(message);
  }

  private async handleRequest(message: RpcMessage): Promise<unknown> {
    if (!this.requestHandler) throw new Error(`没有请求处理器: ${message.method}`);
    return this.requestHandler(message);
  }

  private async answer(message: RpcMessage): Promise<void> {
    const child = this.child;
    let response: RpcMessage;
    try {
      response = { id: message.id, result: await this.handleRequest(message) };
    } catch (error) {
      response = { id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
    if (!this.closing && this.child === child && child?.stdin.writable) child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private failed(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emitExit(error, this);
  }

  private emitExit(error: Error, connection: CodexClient): void {
    if (this.closing) return;
    const threads = new Set<string>();
    for (const [id, owner] of this.threadConnections) if (owner === connection) {
      threads.add(id);
      this.threadConnections.delete(id);
    }
    for (const handler of this.exitHandlers) handler(error, threads);
  }

  async close(): Promise<void> {
    this.closing = true;
    const connections = [...this.providerConnections.values()];
    this.providerConnections.clear();
    this.threadConnections.clear();
    await Promise.all([this.closeProcess(), ...connections.map(connection => connection.close())]);
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 3000);
    await done;
    clearTimeout(killTimer);
    this.starting = undefined;
  }
}
