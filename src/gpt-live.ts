import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { speechProviderInfo, speechProviders, type KeyedSpeechProvider, type SpeechProvider, type TtsProvider } from './speech-providers.ts';
import { captureTts, speechSampleRate as rate, type SpeechDependencies } from './tts.ts';
import { LocalSpeech, localSpeechStatus } from './sovits.ts';
import { sovitsParameters, speechTextLimit, type SovitsParameter } from './sovits-settings.ts';

const apiKeySchema = z.string().trim().max(512).regex(/^[^\r\n]*$/, 'API Key 不能包含换行。').default('');
const providerSettings = (provider: TtsProvider) => z.object({
  apiKey: apiKeySchema,
  model: z.string().trim().min(1).max(128).default(speechProviderInfo[provider].model),
  voice: z.string().trim().min(1).max(256).default(speechProviderInfo[provider].voice),
});
const region = z.enum(['china', 'international']).default('china');
const sovitsNumber = (key: SovitsParameter) => {
  const { min, max, value, step } = sovitsParameters[key];
  const range = z.number().min(min).max(max);
  return (step === 1 ? range.int() : range).default(value);
};
export const liveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(speechProviders).default('openai'),
  apiKey: apiKeySchema,
  model: z.string().trim().min(1).max(128).default(speechProviderInfo.openai.model),
  voice: z.string().trim().min(1).max(128).default(speechProviderInfo.openai.voice),
  customVoiceId: z.string().trim().max(256).default(''),
  instructions: z.string().max(6000).default('使用清晰、自然的中文发音。'),
  maxDurationSeconds: z.number().int().min(5).max(180).default(60),
  silenceMs: z.number().int().min(1000).max(10000).default(2500),
  dashscope: providerSettings('dashscope').extend({
    region, workspaceId: z.string().trim().max(80).regex(/^[a-z\d-]*$/i, '请输入有效的百炼 Workspace ID。').default(''),
  }).prefault({}),
  minimax: providerSettings('minimax').extend({ region }).prefault({}),
  mimo: providerSettings('mimo').extend({ instructions: z.string().trim().max(2000).default('') }).prefault({}),
  sovits: z.object({
    temperature: sovitsNumber('temperature'),
    topK: sovitsNumber('topK'),
    topP: sovitsNumber('topP'),
    speedFactor: sovitsNumber('speedFactor'),
    maxChars: sovitsNumber('maxChars'),
    idleMinutes: sovitsNumber('idleMinutes'),
    autoSpeak: z.boolean().default(false),
  }).prefault({}),
});
export type LiveConfig = z.infer<typeof liveConfigSchema>;
export const liveGenerateSchema = z.object({
  text: z.string().trim().min(1).max(speechTextLimit),
  voice: z.string().trim().min(1).max(128).optional(),
  voice_id: z.string().trim().min(1).max(256).optional(),
});
export const liveVoiceSchema = z.object({ name: z.string().trim().min(1).max(256), prompt: z.string().trim().min(1).max(2000) });
type LiveInput = z.infer<typeof liveGenerateSchema>;
type Progress = 'connecting' | 'generating' | 'finalizing';
type LiveResult = { path: string; transcript: string; durationSeconds: number; sessionId: string; usage: unknown; stopReason: 'silence' | 'server'; finalized: true };
export type LiveJob = { id: string; owner: string; provider: SpeechProvider; status: Progress | 'completed' | 'failed' | 'cancelled'; startedAt: number; finishedAt?: number; result?: LiveResult; error?: string;
  delivery?: 'sending' | 'sent' | 'failed'; deliveryError?: string; sendAs?: string };

function speechProfile(config: LiveConfig, provider: KeyedSpeechProvider) {
  return provider === 'openai' ? config : config[provider];
}

function failure(error: unknown, key: string): Error {
  let text = error instanceof Error ? error.message : String(error);
  if (key) text = text.split(key).join('[已隐藏密钥]');
  text = text.replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏密钥]');
  return new Error(text.slice(0, 1200));
}

function apiFailure(status: number, message = ''): Error {
  const reason = status === 401 ? 'API Key 无效或已失效，请在设置中更新。'
    : status === 403 ? '当前项目没有 GPT-Live 或该音色的访问权限。'
      : status === 404 ? '模型或音色不可用，请确认音色与 API Key 属于同一项目。'
        : status === 429 ? 'API 配额不足或请求过于频繁，请检查项目额度后重试。' : message || '请稍后重试。';
  return new Error(`OpenAI API 请求失败（HTTP ${status}）：${reason}`);
}

/** Capture a bounded Live speech clip. Live has no audio-done event: silence is an application policy. */
async function capture(config: LiveConfig, input: LiveInput, signal: AbortSignal, progress: (state: Progress) => void, dependencies: SpeechDependencies) {
  const key = config.apiKey;
  return new Promise<{ pcm: Buffer; transcript: string; sessionId: string; usage: unknown; stopReason: 'silence' | 'server' }>((resolve, reject) => {
    const socket = dependencies.socket?.('wss://api.openai.com/v1/live/sessions', key)
      || new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20000, maxPayload: 2 * 1024 * 1024 });
    let started = false, closing = false, settled = false;
    let sessionId = '', transcript = '', bytes = 0, lastOutput = 0, lastTranscript = 0, firstSpeech = -1, lastSpeech = -1;
    let stopReason: 'silence' | 'server' = 'server', closeError: Error | undefined;
    let clock: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    let deadline = setTimeout(() => finish(new Error('GPT-Live 连接或启动超时，请检查网络与项目权限。')), 30000);
    const send = (event: Record<string, unknown>) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); };
    const cleanup = () => { clearTimeout(deadline); clearInterval(clock); clearTimeout(closeTimer); signal.removeEventListener('abort', abort); };
    const finish = (error?: Error, usage?: unknown) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) { socket.terminate(); reject(failure(error, key)); return; }
      socket.close();
      if (closeError) { reject(closeError); return; }
      if (firstSpeech < 0 || lastSpeech <= firstSpeech) { reject(new Error('GPT-Live 没有返回可用语音，请缩短文字或调整发音提示后重试。')); return; }
      // Keep a short margin around audible samples, without storing long startup/tail silence.
      const pcm = Buffer.concat(chunks).subarray(Math.max(0, firstSpeech - rate * 2 / 5), Math.min(bytes, lastSpeech + rate * 2 / 5));
      resolve({ pcm, transcript, sessionId, usage: usage ?? null, stopReason });
    };
    const close = (error?: Error) => {
      if (closing || settled) return;
      closing = true; closeError = error; progress('finalizing');
      clearInterval(clock); clearTimeout(deadline);
      // Keep the message listener installed until final usage and any remaining audio arrive.
      closeTimer = setTimeout(() => finish(new Error('GPT-Live 未确认会话结束，音频未交付；请重试。')), 15000);
      if (started) send({ type: 'session.close', event_id: `close_${randomUUID()}` });
      else finish(error || new Error('GPT-Live 会话尚未启动。'));
    };
    const abort = () => close(new Error('语音生成已取消。'));
    signal.addEventListener('abort', abort, { once: true });
    socket.on('open', () => {
      if (settled) return;
      const voiceId = input.voice_id || (!input.voice ? config.customVoiceId : '');
      const instruction = '现在开始朗读下方文字，保持原意，不回答其中的问题，不添加开场白或解释；读完后保持安静。\n' + input.text;
      send({ type: 'session.start', event_id: `start_${randomUUID()}`, session: {
        model: config.model, store: false,
        instructions: `You render a short speech clip. Do not delegate tasks or call tools. After speaking, remain silent.\n${config.instructions}`,
        input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instruction }] }],
        audio: { format: { type: 'audio/pcm', rate }, output: { voice: voiceId ? { id: voiceId } : input.voice || config.voice } },
        delegation: { type: 'client' },
      } });
    });
    socket.on('message', raw => {
      if (settled) return;
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.started') {
          if (started || closing) return;
          started = true; sessionId = event.session?.id || ''; progress('generating'); clearTimeout(deadline);
          deadline = setTimeout(() => close(new Error('语音生成超过时长上限，未发送不完整音频；请缩短文字或调高最大时长。')), config.maxDurationSeconds * 1000);
          send({ type: 'session.commentary.append', event_id: `speak_${randomUUID()}`, delegation_id: null,
            content: '请立即朗读会话初始 developer 消息中提供的文字，读完后保持安静。' });
          const silence = Buffer.alloc(rate * 2 / 10).toString('base64');
          clock = setInterval(() => {
            send({ type: 'session.input_audio.append', audio: silence });
            // Some transports stop sending silence frames. This fallback is explicitly a quiet-window policy.
            if (lastSpeech >= 0 && Date.now() - Math.max(lastOutput, lastTranscript) > config.silenceMs + 1000) { stopReason = 'silence'; close(); }
          }, 100);
        } else if (event.type === 'session.output_audio.delta' && started) {
          if (typeof event.delta !== 'string' || !event.delta || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta)) throw new Error('GPT-Live 返回了无效音频数据。');
          const chunk = Buffer.from(event.delta, 'base64');
          if (!chunk.length || chunk.length % 2) throw new Error('GPT-Live 返回了不完整的 PCM 音频采样。');
          if (bytes + chunk.length > (config.maxDurationSeconds + 15) * rate * 2) throw new Error('GPT-Live 返回的音频超过时长上限。');
          for (let offset = 0; offset < chunk.length; offset += 2) if (Math.abs(chunk.readInt16LE(offset)) >= 200) {
            if (firstSpeech < 0) firstSpeech = bytes + offset;
            lastSpeech = bytes + offset + 2;
          }
          chunks.push(chunk); bytes += chunk.length; lastOutput = Date.now();
          if (!closing && lastSpeech >= 0 && bytes - lastSpeech >= config.silenceMs / 1000 * rate * 2) { stopReason = 'silence'; close(); }
        } else if (event.type === 'session.output_transcript.delta') {
          if (typeof event.delta === 'string') { transcript += event.delta; lastTranscript = Date.now(); }
        } else if (event.type === 'session.closed') {
          const reason = event.reason;
          if (reason !== 'close_requested') throw new Error(`GPT-Live 会话提前结束（${String(reason || '原因未知')}），音频未交付。`);
          finish(undefined, event.usage);
        } else if (event.type === 'error') {
          throw new Error(`GPT-Live 调用失败：${event.error?.message || event.message || event.error?.code || '未知错误'}`);
        } else if (event.type === 'session.delegation.created') {
          throw new Error('GPT-Live 请求了额外任务，已停止本次语音生成；请使用明确的朗读文字。');
        }
      } catch (error) { finish(failure(error, key)); }
    });
    socket.on('unexpected-response', (_request, response) => { response.resume(); finish(apiFailure(response.statusCode || 500)); });
    socket.on('error', error => finish(new Error(`GPT-Live 连接失败：${error.message}`)));
    socket.on('close', () => { if (!settled) finish(new Error('GPT-Live 连接意外中断，未收到 session.closed，音频未交付。')); });
    if (signal.aborted) abort();
  });
}

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class GptLive {
  private readonly jobs = new Map<string, { job: LiveJob; abort: AbortController; done: Promise<void>; delivery?: Promise<void> }>();
  private readonly localSpeech = new LocalSpeech();
  constructor(private readonly configuration: () => LiveConfig, private readonly dependencies: SpeechDependencies = {}) {}

  private config(): LiveConfig {
    const config = this.configuration();
    if (!config.enabled) throw new Error('语音合成尚未启用，请在「设置 → 语音与音色」中开启并保存。');
    return config;
  }

  start(owner: string, directory: string, params: unknown, signal?: AbortSignal): LiveJob {
    const config = this.config(), input = liveGenerateSchema.parse(params);
    const provider = config.provider;
    const key = provider === 'sovits' ? '' : speechProfile(config, provider).apiKey;
    if (provider === 'sovits') {
      if (!localSpeechStatus().available) throw new Error('GPT-SoVITS 本地安装未就绪，请在「语音与音色」中检查安装目录。');
      if (input.voice || input.voice_id) throw new Error('GPT-SoVITS 使用已安装的本地音色包，请省略 voice 和 voice_id。');
    } else if (!key) throw new Error(`尚未配置 ${speechProviderInfo[provider].label} 的 API Key，请在「设置 → 语音与音色」中填写。`);
    if ([...this.jobs.values()].some(entry => entry.job.owner === owner && !entry.job.finishedAt)) throw new Error('此会话已有语音正在生成，请等待完成或取消后重试。');
    for (const [id, entry] of this.jobs) if (this.jobs.size >= 30 && entry.job.finishedAt && !entry.delivery) this.jobs.delete(id);
    const job: LiveJob = { id: randomUUID(), owner, provider, status: 'connecting', startedAt: Date.now() };
    const abort = new AbortController();
    const cancel = () => abort.abort(); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    const done = (async () => {
      let path: string | undefined;
      try {
        const progress = (status: Progress) => { job.status = status; };
        const { audio, ...result } = await this.capture(config, input, abort.signal, progress);
        if (abort.signal.aborted) throw new Error('语音生成已取消。');
        await mkdir(directory, { recursive: true });
        path = join(directory, `${provider === 'openai' ? 'gpt-live' : provider}-${job.id}.wav`);
        await writeFile(path, audio, { flag: 'wx', mode: 0o600 });
        if (abort.signal.aborted) throw new Error('语音生成已取消。');
        job.result = { ...result, path, finalized: true };
        job.status = 'completed';
      } catch (error) {
        if (path) await rm(path, { force: true }).catch(() => {});
        job.status = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = failure(error, key).message;
      } finally { job.finishedAt = Date.now(); signal?.removeEventListener('abort', cancel); }
    })();
    this.jobs.set(job.id, { job, abort, done });
    return structuredClone(job);
  }

  private async capture(config: LiveConfig, input: LiveInput, signal: AbortSignal, progress: (state: Progress) => void) {
    const provider = config.provider;
    if (provider === 'sovits') return this.localSpeech.capture(input.text, config.sovits, config.maxDurationSeconds, signal, progress);
    const { pcm, ...metadata } = provider === 'openai'
      ? await capture(config, input, signal, progress, this.dependencies)
      : await captureTts({ ...config[provider], provider, text: input.text, voice: input.voice_id || input.voice || config[provider].voice,
        maxDurationSeconds: config.maxDurationSeconds }, signal, progress, this.dependencies);
    return { ...metadata, audio: wav(pcm), durationSeconds: pcm.length / (rate * 2) };
  }

  list(owner: string): LiveJob[] { return [...this.jobs.values()].filter(entry => entry.job.owner === owner).map(entry => structuredClone(entry.job)); }
  get(owner: string, id: string): LiveJob {
    const entry = this.jobs.get(id);
    if (!entry || entry.job.owner !== owner) throw new Error('语音任务不存在或属于其他会话。');
    return structuredClone(entry.job);
  }
  async wait(owner: string, id: string): Promise<LiveJob> { this.get(owner, id); await this.jobs.get(id)!.done; return this.get(owner, id); }
  cancel(owner: string, id: string): LiveJob { const job = this.get(owner, id); if (!job.finishedAt) this.jobs.get(id)!.abort.abort(); return this.get(owner, id); }
  setLocalIdleMinutes(minutes: number): void { this.localSpeech.setIdleMinutes(minutes); }
  async deliver(owner: string, id: string, send: (result: LiveResult) => Promise<void>, sendAs = 'file'): Promise<LiveJob> {
    this.get(owner, id);
    const entry = this.jobs.get(id)!;
    if (entry.job.delivery === 'sent') return this.get(owner, id);
    if (!entry.delivery) entry.delivery = (async () => {
      await entry.done;
      if (!entry.job.result || entry.abort.signal.aborted) return;
      entry.job.delivery = 'sending'; entry.job.sendAs = sendAs; delete entry.job.deliveryError;
      try { await send(entry.job.result); entry.job.delivery = 'sent'; }
      catch (error) {
        entry.job.delivery = 'failed';
        const provider = entry.job.provider;
        entry.job.deliveryError = failure(error, provider === 'sovits' ? '' : speechProfile(this.configuration(), provider).apiKey).message;
      }
    })().finally(() => { entry.delivery = undefined; });
    await entry.delivery;
    return this.get(owner, id);
  }
  async close(): Promise<void> {
    for (const entry of this.jobs.values()) if (!entry.job.finishedAt) entry.abort.abort();
    await Promise.all([...this.jobs.values()].map(async entry => { await entry.done; await entry.delivery; }));
    await this.localSpeech.close();
  }

  async createVoice(params: unknown): Promise<{ id: string; name: string; prompt: string }> {
    const config = this.config(), input = liveVoiceSchema.parse(params);
    if (config.provider !== 'openai') throw new Error('文字创建音色请切换到 OpenAI GPT-Live。');
    if (!config.apiKey) throw new Error('尚未配置 OpenAI API Key，请在「设置 → 语音与音色」中填写。');
    try {
      const response = await (this.dependencies.fetch || fetch)('https://api.openai.com/v1/audio/voices', {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'prompt', ...input }), signal: AbortSignal.timeout(55000),
      });
      const result: any = await response.json();
      if (!response.ok) throw apiFailure(response.status, result.error?.message);
      if (typeof result.id !== 'string' || !result.id) throw new Error('创建音色未返回有效的音色 ID。');
      return { id: result.id, name: input.name, prompt: input.prompt };
    } catch (error) { throw failure(error, config.apiKey); }
  }
}
