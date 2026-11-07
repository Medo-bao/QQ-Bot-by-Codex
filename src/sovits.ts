import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sovitsParameters, type SovitsSettings } from './sovits-settings.ts';

const runtimeEntry = ['packages', 'sovits-runtime', 'src', 'index.js'];
const startupBudgetMs = 240_000;
type Runtime = {
  engine: { idleUnloadMs: number; touch(): void };
  renderPreview(text: string, options: {
    signal: AbortSignal;
    maxDurationMs: number;
    maxChars: number;
    params: Pick<SovitsSettings, 'temperature' | 'topK' | 'topP' | 'speedFactor'>;
    onReady: () => void;
  }): Promise<{ wav: Buffer; durationMs: number }>;
  stop(): Promise<unknown>;
};

export function localSpeechStatus() {
  // Only the daemon environment can change where executable code is loaded from.
  const configured = process.env.QQBOT_SOVITS_ROOT?.trim() || (process.platform === 'win32' ? 'E:/DSH/gpt-sovits' : '');
  const directory = configured ? resolve(configured) : '';
  if (!directory || !existsSync(join(directory, ...runtimeEntry)) || !existsSync(join(directory, 'runtime', 'venv', 'Scripts', 'python.exe'))) {
    return { directory, available: false, voice: '' };
  }
  try {
    const pack = JSON.parse(readFileSync(join(directory, 'runtime', 'voices', 'firefly', 'voice.json'), 'utf8'));
    return { directory, available: true, voice: typeof pack?.name === 'string' ? pack.name : '本地音色包' };
  } catch {
    return { directory, available: false, voice: '' };
  }
}

export class LocalSpeech {
  private runtime?: Promise<Runtime>;
  private idleUnloadMs = sovitsParameters.idleMinutes.value * 60_000;

  setIdleMinutes(minutes: number): void {
    const idleUnloadMs = minutes * 60_000;
    if (this.idleUnloadMs === idleUnloadMs) return;
    this.idleUnloadMs = idleUnloadMs;
    void this.runtime?.then(runtime => {
      runtime.engine.idleUnloadMs = this.idleUnloadMs;
      runtime.engine.touch();
    }, () => {});
  }

  async capture(text: string, settings: SovitsSettings, maxDurationSeconds: number, signal: AbortSignal, progress: (state: 'generating' | 'finalizing') => void) {
    const installation = localSpeechStatus();
    if (!installation.available) {
      throw new Error('GPT-SoVITS 本地安装未就绪，请检查项目目录、Python 环境和音色包。');
    }
    this.setIdleMinutes(settings.idleMinutes);
    const directory = installation.directory;
    this.runtime ??= import(pathToFileURL(join(directory, ...runtimeEntry)).href)
      .then((module): Runtime => module.createRuntime({
        assetRoot: join(directory, 'assets'), installDir: join(directory, 'runtime'), idleUnloadMs: this.idleUnloadMs,
      }))
      .catch((error: unknown) => {
        this.runtime = undefined;
        throw new Error('无法加载 GPT-SoVITS，请检查本地项目依赖。', { cause: error });
      });
    const runtime = await this.runtime;
    const maxDurationMs = maxDurationSeconds * 1000;
    const timeout = AbortSignal.timeout(startupBudgetMs + maxDurationMs);
    const request = AbortSignal.any([signal, timeout]);
    try {
      request.throwIfAborted();
      const { temperature, topK, topP, speedFactor, maxChars } = settings;
      const result = await runtime.renderPreview(text, { signal: request, maxDurationMs, maxChars,
        params: { temperature, topK, topP, speedFactor }, onReady: () => progress('generating') });
      request.throwIfAborted();
      if (!Buffer.isBuffer(result.wav) || !Number.isFinite(result.durationMs) || result.durationMs <= 0) {
        throw new Error('本地引擎未返回完整音频。');
      }
      if (result.durationMs > maxDurationMs) throw new Error('返回的音频超过时长上限。');
      progress('finalizing');
      return { audio: result.wav, durationSeconds: result.durationMs / 1000, transcript: '', sessionId: '', usage: null, stopReason: 'server' as const };
    } catch (error) {
      if (signal.aborted) throw new Error('语音生成已取消。');
      if (timeout.aborted) throw new Error('本地语音生成超时，请缩短文字或检查引擎状态。');
      if ((error as { code?: string })?.code === 'audio-too-long') throw new Error('返回的音频超过时长上限，请缩短文字。');
      throw error;
    }
  }

  async close(): Promise<void> {
    const runtime = await this.runtime?.catch(() => undefined);
    await runtime?.stop();
  }
}
