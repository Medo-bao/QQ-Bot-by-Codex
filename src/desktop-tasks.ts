import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from './config.ts';
import { DesktopAppClient } from './desktop-app-client.ts';
import type { Logger, ReplyTarget } from './types.ts';

interface DesktopJob {
  id: string; threadId: string; title: string; cwd: string; prompt: string; target: ReplyTarget;
  status: 'queued' | 'submitting' | 'submitted' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: number; updatedAt: number; baselineTurnId?: string; turnId?: string;
  progress?: string; result?: string; error?: string; notify: boolean; delivered?: boolean; deliveryError?: string;
}
const terminal = (job: DesktopJob) => ['completed', 'failed', 'cancelled', 'unknown'].includes(job.status);
const sourceKey = (target: ReplyTarget) => `${target.scope}:${target.targetId}`;

export class DesktopTasks {
  private client = new DesktopAppClient();
  private attachment = `${process.env.CODEX_APP_TOOLS_PIPE_PATH || ''}\0${process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || ''}`;
  private jobs: DesktopJob[];
  private readonly path: string;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private pollOffset = 0;
  private closed = false;
  private monitorError?: string;
  constructor(directory: string, private readonly logger: Logger,
    private readonly notify: (target: ReplyTarget, text: string) => Promise<unknown>, private readonly enabled: () => boolean) {
    this.path = join(directory, 'desktop-jobs.json');
    this.jobs = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    for (const job of this.jobs) if (job.status === 'submitting') { job.status = 'unknown'; job.error = '后台在派发期间关闭，结果尚未确认，请查看目标会话后再决定是否重发。'; }
    this.schedule();
  }
  get available(): boolean { return this.client.available; }
  async browserContext(): Promise<{ threadId: string; turnId: string }> {
    const threadId = this.client.callerThreadId;
    if (!threadId) throw new Error('尚未绑定桌面浏览器，请从 Codex 重新打开 QQ Bot。');
    const history = await this.client.call('read_thread', { threadId, hostId: 'local', turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 });
    const turnId = history.turns?.[0]?.id;
    if (!turnId) throw new Error('无法读取绑定的桌面会话，请从 Codex 会话中重新打开 QQ Bot。');
    return { threadId, turnId };
  }
  attach(pipePath: string, threadId: string): void {
    if (!pipePath || !threadId) return;
    const attachment = `${pipePath}\0${threadId}`;
    if (attachment === this.attachment) return;
    this.attachment = attachment; this.monitorError = undefined;
    this.client.close(); this.client = new DesktopAppClient(pipePath, threadId);
    this.schedule();
  }
  private save(): void { writeJson(this.path, this.jobs); }
  private schedule(): void {
    if (this.closed || this.timer || !this.jobs.some(job => !terminal(job) || job.notify && !job.delivered && !job.deliveryError)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll().finally(() => this.schedule()); }, this.monitorError ? 15000 : 3000);
    this.timer.unref();
  }
  listJobs(target: ReplyTarget) { return this.jobs.filter(job => sourceKey(job.target) === sourceKey(target)).map(job => ({ ...job, target: undefined, ...(this.monitorError && !terminal(job) ? { progress: this.monitorError } : {}) })).slice(-30).reverse(); }
  async list(target: ReplyTarget, query = '', cursor?: string): Promise<unknown> {
    const result = await this.client.call('list_threads', { mode: 'history', source: 'codex', hostId: 'local', limit: 50, ...(cursor ? { cursor } : {}) });
    const threads = (result.threads || []).filter((thread: any) => thread.id !== this.client.callerThreadId);
    const search = query.trim().toLowerCase();
    return { available: true, threads: threads.filter((thread: any) => !search || `${thread.title} ${thread.cwd}`.toLowerCase().includes(search)),
      nextCursor: result.nextCursor || null, jobs: this.listJobs(target) };
  }
  async read(threadId: string, cursor?: string): Promise<any> {
    return this.client.call('read_thread', { threadId, hostId: 'local', turnLimit: 8, includeOutputs: false, maxOutputCharsPerItem: 2500, ...(cursor ? { cursor } : {}) });
  }
  async dispatch(target: ReplyTarget, threadId: string, prompt: string, notify = true): Promise<Omit<DesktopJob, 'target'>> {
    if (threadId === this.client.callerThreadId) throw new Error('请选择其他桌面会话，不能向当前控制会话派发任务。');
    const history = await this.read(threadId);
    if (history.thread?.kind !== 'codex') throw new Error('只能调度已有的 Codex 会话。');
    const job: DesktopJob = { id: randomUUID(), threadId, title: history.thread.title, cwd: history.thread.cwd || '', prompt, target,
      status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), notify };
    this.jobs.push(job); this.save();
    await this.poll(); this.schedule();
    const { target: _target, ...result } = job; return result;
  }
  async action(target: ReplyTarget, params: Record<string, any>): Promise<any> {
    if (params.action === 'list') return this.list(target, params.query, params.cursor);
    if (params.action === 'read') {
      if (typeof params.thread_id !== 'string' || !params.thread_id) throw new Error('请选择桌面会话。');
      return this.read(params.thread_id, params.cursor);
    }
    if (params.action === 'dispatch') {
      if (typeof params.thread_id !== 'string' || !params.thread_id || typeof params.prompt !== 'string' || !params.prompt.trim()) throw new Error('请选择目标会话并填写任务。');
      if (params.prompt.length > 32000) throw new Error('任务内容最多 32000 字符。');
      return this.dispatch(target, params.thread_id, params.prompt.trim(), params.notify_qq !== false);
    }
    if (params.action === 'jobs') return { available: this.available, jobs: this.listJobs(target) };
    const job = this.jobs.find(job => job.id === params.job_id && sourceKey(job.target) === sourceKey(target));
    if (!job) throw new Error('当前 QQ 会话中没有这项派发任务。');
    if (params.action === 'cancel') {
      if (job.status !== 'queued') throw new Error('任务已经交给桌面会话，请在目标会话中中止；此处只可取消尚未派发的任务。');
      job.status = 'cancelled'; job.result = '已取消等待派发的任务。'; job.notify = false; job.updatedAt = Date.now(); this.save();
    } else if (params.action === 'retry_delivery') { job.deliveryError = undefined; await this.deliver(job); this.save(); }
    else throw new Error('未知桌面会话操作。');
    return { ...job, target: undefined };
  }
  private async taskHistory(threadId: string, cursor?: string): Promise<any> {
    return this.client.call('read_thread', { threadId, hostId: 'local', turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 16000, ...(cursor ? { cursor } : {}) });
  }
  private async locate(job: DesktopJob, history: any): Promise<any> {
    const marker = `QQ Bot 任务 #${job.id}`;
    const cursors = new Set<string>();
    for (;;) {
      const turns = history.turns || [];
      const baseline = turns.findIndex((turn: any) => turn.id === job.baselineTurnId);
      const candidates = baseline < 0 ? turns : turns.slice(0, baseline);
      const turn = candidates.find((turn: any) => job.turnId ? turn.id === job.turnId : turn.items?.some((item: any) =>
        item.type === 'userMessage' && item.content?.some((part: any) => typeof part.text === 'string' && part.text.includes(marker)) ||
        item.type === 'agentMessage' && typeof item.text === 'string' && item.text.split(/\r?\n/).some((line: string) => line.trim() === marker)));
      if (turn) { job.turnId = turn.id; return turn; }
      // Other desktop users can add turns between the snapshot and dispatch.
      // Only the task marker (or an already verified turn ID) establishes ownership.
      if (baseline >= 0) return;
      const cursor = history.page?.nextCursor;
      if (!cursor || cursors.has(cursor)) return;
      cursors.add(cursor); history = await this.taskHistory(job.threadId, cursor);
    }
  }
  private finish(job: DesktopJob, turn: any, finalText?: string): void {
    if (turn.status === 'inProgress') return;
    job.status = turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'cancelled' : 'completed';
    job.error = turn.error?.message;
    job.result = this.withoutMarker(job, finalText || (turn.items || []).filter((item: any) => item.type === 'agentMessage' && item.phase !== 'commentary').map((item: any) => item.text).join('\n\n')) || job.error || '目标会话任务已结束，请打开目标会话查看结果。';
  }
  private withoutMarker(job: DesktopJob, text: string): string {
    return text.split(/\r?\n/).filter(line => line.trim() !== `QQ Bot 任务 #${job.id}`).join('\n').trim();
  }
  async poll(): Promise<void> {
    if (this.polling || this.closed || !this.enabled() || !this.available) return;
    this.polling = true;
    try {
      const pending = this.jobs.filter(job => !terminal(job));
      const allTargets = [...new Set(pending.map(job => job.threadId))];
      const offset = this.pollOffset % (allTargets.length || 1);
      const targets = [...allTargets.slice(offset), ...allTargets.slice(0, offset)].slice(0, 8);
      this.pollOffset = (offset + targets.length) % (allTargets.length || 1);
      const jobs = pending.filter(job => targets.includes(job.threadId));
      if (jobs.length) {
        // Native wait_threads is bound to an active caller turn; background QQ jobs outlive that turn.
        const histories = await Promise.allSettled(targets.map(threadId => this.taskHistory(threadId)));
        const snapshots = new Map(targets.map((threadId, index) => [threadId, histories[index]]));
        this.monitorError = undefined;
        for (const job of jobs) {
          if (terminal(job)) continue;
          const snapshot = snapshots.get(job.threadId)!;
          if (snapshot.status === 'rejected') { job.progress = `等待桌面连接恢复：${snapshot.reason instanceof Error ? snapshot.reason.message : snapshot.reason}`; continue; }
          const history = snapshot.value;
          const latest = history.turns?.[0]; job.updatedAt = Date.now();
          if (job.status === 'queued') {
            if (latest?.status === 'inProgress' || jobs.some(other => other !== job && other.threadId === job.threadId && ['submitting', 'submitted', 'running', 'waiting'].includes(other.status))) { job.progress = '目标会话正在工作，等待空闲后派发。'; continue; }
            job.baselineTurnId = latest?.id; job.status = 'submitting'; job.progress = '正在派发到桌面会话…'; this.save();
            try {
              await this.client.call('send_message_to_thread', { threadId: job.threadId, hostId: 'local', prompt: `QQ Bot 任务 #${job.id}\n以下是用户通过 QQ Bot 下达的任务，请在当前会话中继续执行，沿用本会话的设置。\n为确保结果回传给正确任务，请在首次进度和最终回复中各用单独一行原样写出上面的任务标识；无需调用其他会话或 QQ 发送工具，插件会自动回传结果。\n\n${job.prompt}` });
              job.status = 'submitted'; job.progress = '已交给原会话，等待开始执行。';
            } catch (error) { job.status = 'unknown'; job.error = `派发结果未确认，请查看目标会话后再决定是否重发：${error instanceof Error ? error.message : error}`; }
            this.save(); continue;
          }
          const turn = await this.locate(job, history);
          if (!turn) { job.progress = '等待目标会话确认任务标识，暂不回传其他轮次结果。'; continue; }
          const waiting = turn.status === 'inProgress' && history.thread?.status?.activeFlags?.some((flag: string) => /waiting|approval|input/i.test(flag));
          job.status = waiting ? 'waiting' : 'running';
          const message = turn.items?.findLast((item: any) => item.type === 'agentMessage');
          job.progress = waiting ? '目标会话正在等待确认，请在 Codex 中处理。' : message?.phase === 'commentary' ? this.withoutMarker(job, message.text) || '原会话正在执行任务。' : '原会话正在执行任务。';
          this.finish(job, turn);
        }
      }
      for (const job of this.jobs) if (terminal(job) && job.notify && !job.delivered && !job.deliveryError) await this.deliver(job);
      if (jobs.length) this.save();
    } catch (error) {
      const message = `等待桌面连接恢复：${error instanceof Error ? error.message : error}`;
      if (this.monitorError !== message) this.logger.warn(message);
      this.monitorError = message;
    } finally { this.polling = false; }
  }
  private async deliver(job: DesktopJob): Promise<void> {
    try {
      await this.notify(job.target, `Codex 会话「${job.title}」${job.status === 'completed' ? '已完成' : job.status === 'cancelled' ? '已中止' : '状态提醒'}\n\n${job.result || job.error || job.progress || ''}`);
      job.delivered = true; job.deliveryError = undefined;
    } catch (error) { job.deliveryError = error instanceof Error ? error.message : String(error); }
    this.save();
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.client.close(); }
}
