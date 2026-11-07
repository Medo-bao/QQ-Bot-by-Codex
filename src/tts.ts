import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { speechProviderInfo, type TtsProvider } from './speech-providers.ts';
export type TtsOptions = {
  provider: TtsProvider;
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  region?: 'china' | 'international';
  workspaceId?: string;
  instructions?: string;
  maxDurationSeconds: number;
};
export type SpeechDependencies = { socket?: (url: string, key: string) => WebSocket; fetch?: typeof fetch };
export const speechSampleRate = 24000;

function httpError(status: number): Error {
  const hint = status === 401 || status === 403 ? '请检查 API Key、服务权限与接入地区。'
    : status === 429 ? '请检查额度或稍后重试。' : '请检查供应商服务状态。';
  return new Error(`请求失败（HTTP ${status}）。${hint}`);
}

async function* events(response: Response): AsyncGenerator<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw httpError(response.status);
  }
  if (!response.body) throw new Error('没有收到音频响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const isJson = response.headers.get('content-type')?.includes('application/json');
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 20 * 1024 * 1024) throw new Error('语音响应过大。');
      if (!isJson) {
        let boundary: number;
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          if (line.startsWith('data:') && line.slice(5).trim()) yield line.slice(5).trim();
        }
      }
      if (done) {
        if (isJson && pending.trim()) yield pending;
        else if (pending.startsWith('data:') && pending.slice(5).trim()) yield pending.slice(5).trim();
        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function decodeAudio(value: unknown, encoding: 'base64' | 'hex'): Buffer {
  const valid = encoding === 'hex' ? /^[\da-f]+$/i : /^[A-Za-z0-9+/]+={0,2}$/;
  if (typeof value !== 'string' || !valid.test(value) || (encoding === 'hex' ? value.length % 2 : value.length % 4 === 1)) {
    throw new Error('供应商返回了无效音频数据。');
  }
  return Buffer.from(value, encoding);
}

async function captureHttp(
  options: TtsOptions, signal: AbortSignal, request: typeof fetch, ready: () => void, append: (chunk: Buffer) => void,
): Promise<{ sessionId: string; usage: unknown }> {
  const { provider, apiKey, model, voice, text } = options;
  const minimax = provider === 'minimax';
  const url = minimax
    ? `https://${options.region === 'international' ? 'api.minimax.io' : 'api.minimaxi.com'}/v1/t2a_v2`
    : 'https://api.xiaomimimo.com/v1/chat/completions';
  const body = minimax ? {
    model, text, stream: true, output_format: 'hex',
    stream_options: { exclude_aggregated_audio: true },
    voice_setting: { voice_id: voice },
    audio_setting: { sample_rate: speechSampleRate, format: 'pcm', channel: 1 },
  } : {
    model, stream: true, audio: { format: 'pcm16', voice },
    messages: [
      ...(options.instructions ? [{ role: 'user', content: options.instructions }] : []),
      { role: 'assistant', content: text },
    ],
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (minimax) headers.Authorization = `Bearer ${apiKey}`;
  else headers['api-key'] = apiKey;
  const response = await request(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
  if (response.ok) ready();
  let sessionId = '', usage: unknown = null, finished = false;
  for await (const line of events(response)) {
    if (line === '[DONE]') break;
    const event = JSON.parse(line);
    if (event.error || (event.base_resp?.status_code ?? 0) !== 0) {
      throw new Error(String(event.error?.message || event.base_resp?.status_msg || '供应商拒绝了语音请求。'));
    }
    if (minimax) {
      sessionId = event.trace_id || sessionId;
      usage = event.extra_info ?? usage;
      if (event.data?.audio) append(decodeAudio(event.data.audio, 'hex'));
      if (event.data?.status === 2) { finished = true; break; }
    } else {
      sessionId = event.id || sessionId;
      usage = event.usage ?? usage;
      const choice = event.choices?.[0];
      if (choice?.delta?.audio?.data) append(decodeAudio(choice.delta.audio.data, 'base64'));
      if (choice?.finish_reason) {
        if (choice.finish_reason !== 'stop') throw new Error(`合成提前结束（${choice.finish_reason}）。`);
        finished = true;
      }
    }
  }
  if (!finished) throw new Error('语音连接提前结束，未收到供应商的完成信号。');
  return { sessionId, usage };
}

function captureCosyVoice(
  options: TtsOptions, signal: AbortSignal, connect: SpeechDependencies['socket'],
  ready: () => void, append: (chunk: Buffer) => void,
): Promise<{ sessionId: string; usage: unknown }> {
  signal.throwIfAborted();
  const international = options.region === 'international';
  const host = options.workspaceId
    ? `${options.workspaceId}.${international ? 'ap-southeast-1' : 'cn-beijing'}.maas.aliyuncs.com`
    : international ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
  const url = `wss://${host}/api-ws/v1/inference`;
  return new Promise((resolve, reject) => {
    const socket = connect?.(url, options.apiKey) || new WebSocket(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` }, handshakeTimeout: 20000, maxPayload: 2 * 1024 * 1024,
    });
    const sessionId = randomUUID();
    let started = false, settled = false;
    const finish = (error?: unknown, usage: unknown = null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { socket.terminate(); reject(error); }
      else { socket.close(); resolve({ sessionId, usage }); }
    };
    const abort = () => finish(signal.reason);
    const send = (action: string, payload: object) => socket.send(JSON.stringify({
      header: { action, task_id: sessionId, streaming: 'duplex' }, payload,
    }), error => { if (error) finish(error); });
    signal.addEventListener('abort', abort, { once: true });
    socket.on('open', () => send('run-task', {
      task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: options.model, input: {},
      parameters: { text_type: 'PlainText', voice: options.voice, format: 'pcm', sample_rate: speechSampleRate },
    }));
    socket.on('message', (raw, binary) => {
      if (settled) return;
      try {
        const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (binary) { if (started) append(data); return; }
        const event = JSON.parse(data.toString('utf8'));
        const header = event.header;
        if (header?.task_id !== sessionId) throw new Error('百炼返回了不匹配的语音任务 ID。');
        if (header.event === 'task-failed') throw new Error(header.error_message || header.error_code || '语音任务失败。');
        if (header.event === 'task-started' && !started) {
          started = true; ready();
          send('continue-task', { input: { text: options.text } });
          send('finish-task', { input: {} });
        } else if (header.event === 'task-finished' && started) finish(undefined, event.payload?.usage ?? null);
      } catch (error) { finish(error); }
    });
    socket.on('unexpected-response', (_request, response) => { response.resume(); finish(httpError(response.statusCode || 500)); });
    socket.on('error', finish);
    socket.on('close', () => finish(new Error('语音连接提前结束，未收到百炼的完成信号。')));
    if (signal.aborted) abort();
  });
}

export async function captureTts(
  options: TtsOptions, signal: AbortSignal, progress: (state: 'generating' | 'finalizing') => void, dependencies: SpeechDependencies,
) {
  const timeout = AbortSignal.timeout(options.maxDurationSeconds * 1000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const chunks: Buffer[] = [];
  let length = 0;
  const append = (chunk: Buffer) => {
    length += chunk.length;
    if (length > options.maxDurationSeconds * speechSampleRate * 2) throw new Error('返回的音频超过时长上限。');
    chunks.push(chunk);
  };
  const ready = () => progress('generating');
  try {
    const metadata = options.provider === 'dashscope'
      ? await captureCosyVoice(options, requestSignal, dependencies.socket, ready, append)
      : await captureHttp(options, requestSignal, dependencies.fetch || fetch, ready, append);
    requestSignal.throwIfAborted();
    if (!length || length % 2) throw new Error('供应商没有返回完整的 PCM 音频。');
    progress('finalizing');
    return { ...metadata, pcm: Buffer.concat(chunks, length), transcript: '', stopReason: 'server' as const };
  } catch (error) {
    if (signal.aborted) throw new Error('语音生成已取消。');
    if (timeout.aborted) throw new Error('语音生成超时，请缩短文字或调高时长上限。');
    throw new Error(`${speechProviderInfo[options.provider].label}：${error instanceof Error ? error.message : String(error)}`);
  }
}
