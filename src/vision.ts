import { stat } from 'node:fs/promises';
import { CodexClient } from './codex-client.ts';
import type { BotConfig } from './config.ts';
import type { Logger } from './types.ts';

export async function describeImage(config: BotConfig, logger: Logger, path: string, prompt?: string, signal?: AbortSignal): Promise<string> {
  if (!config.vision.enabled) throw new Error('视觉理解已关闭。');
  if ((await stat(path)).size > config.vision.maxBytes) throw new Error('图片超过视觉输入大小上限。');
  const client = new CodexClient(config, logger);
  let threadId: string | undefined;
  let output = '';
  let done!: () => void;
  let fail!: (error: Error) => void;
  const complete = new Promise<void>((resolve, reject) => { done = resolve; fail = reject; });
  void complete.catch(() => {});
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ||= client.close();
  const cancel = (reason: string) => { fail(new Error(reason)); void dispose().catch((error) => logger.warn(String(error))); };
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
    await client.start();
    const result = await client.call('thread/start', { cwd: config.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      ...((config.vision.model || config.model) ? { model: config.vision.model || config.model } : {}),
      ...((config.vision.provider || config.modelProvider) ? { modelProvider: config.vision.provider || config.modelProvider } : {}),
      developerInstructions: 'Analyze the supplied image. Do not use tools or inspect unrelated files.' });
    threadId = result.thread.id;
    await client.call('turn/start', { threadId, input: [{ type: 'text', text: prompt || config.vision.defaultPrompt }, { type: 'localImage', path }] });
    await complete;
    return output.slice(0, config.vision.maxOutputChars);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', aborted); await dispose(); }
}
