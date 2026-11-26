import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { CodexClient } from './codex-client.ts';
import type { BotConfig } from './config.ts';
import type { Logger } from './types.ts';

const pythonDirectory = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python');
export const bundledImagePython = process.platform === 'win32' ? join(pythonDirectory, 'python.exe') : join(pythonDirectory, 'bin', 'python3');
const runFile = promisify(execFile);
const compressPng = `import sys, warnings
from PIL import Image
warnings.simplefilter("error", Image.DecompressionBombWarning)
with Image.open(sys.argv[1], formats=["PNG"]) as image:
    if image.is_animated:
        sys.exit(1)
    image.save(sys.stdout.buffer, format="PNG", compress_level=6)
`;

async function visionInput(path: string, limit: number, signal: AbortSignal) {
  const { size } = await stat(path);
  if (size <= limit) return { type: 'localImage', path };
  if (extname(path).toLowerCase() === '.png' && existsSync(bundledImagePython)) {
    try {
      const { stdout } = await runFile(bundledImagePython, ['-I', '-c', compressPng, path], {
        encoding: 'buffer', maxBuffer: limit, windowsHide: true, signal,
      });
      return { type: 'image', url: 'data:image/png;base64,' + stdout.toString('base64') };
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error(`图片为 ${size} 字节，超过视觉输入上限 ${limit} 字节。请另存较小的预览图，再用副本路径重试。`);
}

export async function describeImage(config: BotConfig, logger: Logger, path: string, prompt?: string, signal?: AbortSignal): Promise<string> {
  if (!config.vision.enabled) throw new Error('视觉理解已关闭。');
  const client = new CodexClient(config, logger);
  let threadId: string | undefined;
  let output = '';
  let done!: () => void;
  let fail!: (error: Error) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  void complete.catch(() => {});
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ||= client.close();
  const processing = new AbortController();
  const cancel = (reason: string) => {
    const error = new Error(reason);
    processing.abort(error); fail(error);
    void dispose().catch((error) => logger.warn(String(error)));
  };
  const aborted = () => cancel('图片分析已取消。');
  signal?.addEventListener('abort', aborted, { once: true });
  client.requestHandler = async (message) => {
    if (message.method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (message.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (message.method?.endsWith('/requestApproval')) return { decision: 'decline' };
    throw new Error('视觉理解会话不执行外部操作。');
  };
  client.onExit(fail);
  client.onNotification((message) => {
    if (!message.params || message.params.threadId !== threadId) return;
    if (message.method === 'item/completed' && message.params.item?.type === 'agentMessage' && message.params.item.phase !== 'commentary') output += message.params.item.text;
    if (message.method === 'turn/completed') {
      if (message.params.turn.status === 'completed') done();
      else fail(new Error(message.params.turn.error?.message || '视觉理解未完成。'));
    }
  });
  const timer = setTimeout(() => cancel('视觉理解超时。'), config.vision.timeoutMs);
  try {
    if (signal?.aborted) throw new Error('图片分析已取消。');
    const input = await visionInput(path, config.vision.maxBytes, processing.signal);
    processing.signal.throwIfAborted();
    await client.start();
    const { config: nativeConfig } = await client.call('config/read', { includeLayers: false });
    const disabledMcpServers = Object.fromEntries(Object.keys(nativeConfig?.mcp_servers ?? {})
      .map((name) => [`mcp_servers.${name}.enabled`, false]));
    const result = await client.call('thread/start', { cwd: config.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      ...((config.vision.model || config.model) ? { model: config.vision.model || config.model } : {}),
      ...((config.vision.provider || config.modelProvider) ? { modelProvider: config.vision.provider || config.modelProvider } : {}),
      config: { ...disabledMcpServers, 'features.apps': false, 'features.plugins': false, web_search: 'disabled' },
      developerInstructions: 'Answer directly from the supplied image. Do not use tools or inspect unrelated files.' });
    threadId = result.thread.id;
    const { data: models } = await client.call('model/list', { includeHidden: true });
    const model = result.model || config.vision.model || config.model;
    const selected = models.find((entry: any) => model ? entry.model === model : entry.isDefault);
    const effort = selected?.supportedReasoningEfforts?.some((entry: any) => entry.reasoningEffort === 'low')
      ? 'low' : selected?.defaultReasoningEffort;
    await client.call('turn/start', { threadId, ...(effort ? { effort } : {}),
      input: [{ type: 'text', text: prompt || config.vision.defaultPrompt }, input] });
    await complete;
    if (!output.trim()) throw new Error('视觉理解未返回图片描述。');
    return output.slice(0, config.vision.maxOutputChars);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); await dispose(); }
}
