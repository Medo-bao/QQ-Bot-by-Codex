import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type DesktopTool = 'list_threads' | 'list_projects' | 'read_thread' | 'send_message_to_thread' | 'wait_threads';
export interface DesktopCaller { threadId?: string; turnId?: string; }

/** Uses the same local tool transport as the bundled Codex desktop plugin. */
export class DesktopAppClient {
  private catalog?: Promise<Map<string, string>>;
  private socket?: Socket;
  private connecting?: Promise<void>;
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH || '',
    private readonly ownerThreadId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || '') {}

  get available(): boolean { return Boolean(this.pipePath); }
  get callerThreadId(): string { return this.ownerThreadId; }

  private connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (!this.pipePath) return Promise.reject(new Error('当前后台未连接 Codex 桌面，请从 Codex 中重新打开 QQ Bot。'));
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.pipePath);
      socket.once('error', reject);
      socket.once('connect', () => {
        this.socket = socket;
        socket.on('error', error => { if (this.socket === socket) this.disconnect(error); });
        socket.on('close', () => { if (this.socket === socket) this.disconnect(new Error('Codex 桌面连接已断开，请重新打开 Codex 后重试。')); });
        resolve();
      });
      socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (length > 16 * 1024 * 1024) { this.disconnect(new Error('Codex 桌面返回的数据过大，请缩小查询范围。')); return; }
          if (this.buffer.length < length + 4) return;
          try {
            const response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
            this.buffer = this.buffer.subarray(length + 4);
            const pending = this.pending.get(Number(response.id));
            if (!pending) continue;
            clearTimeout(pending.timer); this.pending.delete(Number(response.id));
            if (response.error) pending.reject(Object.assign(new Error(response.error.message), { code: response.error.code })); else pending.resolve(response.result);
          } catch (error) { this.disconnect(error instanceof Error ? error : new Error(String(error))); return; }
        }
      });
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private disconnect(error: Error): void {
    const socket = this.socket; this.socket = undefined; socket?.destroy(); this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  close(): void { this.disconnect(new Error('Codex 桌面连接已关闭。')); }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    await this.connect();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 桌面会话控制请求超时。')); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
      const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      this.socket!.write(Buffer.concat([header, payload]));
    });
  }

  async call(tool: DesktopTool, args: Record<string, unknown>, caller: DesktopCaller = {}): Promise<any> {
    this.catalog ||= this.request('tools/list', { threadStartKind: 'all' }).then(result =>
      new Map<string, string>((result.tools || []).map((item: any) => [item.name, item.namespace]))).catch(error => { this.catalog = undefined; throw error; });
    const namespace = (await this.catalog).get(tool);
    if (!namespace) throw new Error(`当前 Codex 桌面未提供 ${tool}，请更新 Codex 后重试。`);
    const threadId = caller.threadId || this.ownerThreadId;
    if (!threadId) throw new Error('缺少发起会话信息，请从 Codex 重新打开 QQ Bot。');
    let turnId = caller.turnId || 'mcp-turn-context';
    // Desktop history projections can lag; obtain the live caller turn from the app.
    if (!caller.turnId && ['wait_threads', 'send_message_to_thread'].includes(tool)) {
      const readNamespace = (await this.catalog).get('read_thread');
      if (!readNamespace) throw new Error('Codex 桌面未提供会话读取接口。');
      const context = await this.invoke('read_thread', readNamespace, { threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 }, threadId, turnId);
      turnId = context.turns?.[0]?.id;
      if (!turnId) throw new Error('无法读取桌面控制会话，请从 Codex 会话中重新打开 QQ Bot。');
    }
    return this.invoke(tool, namespace, args, threadId, turnId);
  }

  private async invoke(tool: DesktopTool, namespace: string, args: Record<string, unknown>, threadId: string, turnId: string): Promise<any> {
    const result = await this.request('tools/call', { namespace, tool, arguments: args, callerSource: 'codex', threadId, turnId, callId: `qqbot-desktop-${randomUUID()}` });
    const text = (result.contentItems || []).filter((item: any) => item.type === 'inputText').map((item: any) => item.text).join('\n');
    if (!result.success) throw new Error(text || 'Codex 桌面会话操作失败。');
    try { return JSON.parse(text); } catch { return { text }; }
  }
}
