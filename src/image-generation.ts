import { readFileSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { EnvHttpProxyAgent } from 'undici';
import { z } from 'zod';
import { imageExtension } from './image-format.ts';
import type { Logger } from './types.ts';

export const imageGenerationModels = ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare',
  'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'] as const;

export const imageGenerationConfigSchema = z.object({
  mode: z.enum(['codex', 'api']).default('codex'),
  model: z.enum(imageGenerationModels).default(imageGenerationModels[0]),
  keyFile: z.string().trim().refine((value) => !value || isAbsolute(value), 'OpenAI 密钥文件必须使用绝对路径。').default(''),
});
type ImageGenerationConfig = z.infer<typeof imageGenerationConfigSchema>;

export const imageSizes = ['1024x1024', '1536x1024', '1024x1536'] as const;
export const imagePromptLimit = 32_000;
export const imageGenerationInput = z.object({
  prompt: z.string().trim().min(1).max(imagePromptLimit),
  size: z.enum(imageSizes).optional(),
  reference_image_path: z.string().trim().min(1).optional(),
});

export function imageApiCredential(keyFile: string): { key?: string; source: 'file' | 'environment' | 'missing' } {
  if (keyFile) {
    try {
      const key = parseEnv(readFileSync(keyFile, 'utf8')).OPENAI_API_KEY?.trim();
      if (key) return { key, source: 'file' };
    } catch { /* The status view reports an unreadable or missing credential. */ }
  } else {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (key) return { key, source: 'environment' };
  }
  return { source: 'missing' };
}

const referenceTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
let imageProxyAgent: EnvHttpProxyAgent | undefined;

const connectFailureCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

function transportCodes(error: unknown): string[] {
  const cause = error instanceof Error && !('code' in error) ? error.cause ?? error : error;
  const failures: unknown[] = cause instanceof AggregateError && cause.errors.length ? [...cause.errors] : [cause];
  if (cause instanceof AggregateError && 'code' in cause) failures.push(cause);
  return failures.map(failure => {
    const code = (failure as NodeJS.ErrnoException | null)?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : '';
  });
}

function codeDetail(codes: string[]): string {
  const known = [...new Set(codes.filter(Boolean))];
  return known.length ? `（${known.join('、')}）` : '';
}

export async function generateOpenAIImage(config: ImageGenerationConfig, input: z.infer<typeof imageGenerationInput>,
  directory: string, signal: AbortSignal, logger: Logger): Promise<string> {
  const { key } = imageApiCredential(config.keyFile);
  if (!key) throw new Error('未找到 OpenAI API 密钥，请在「图片与文件」中检查密钥来源。');

  const fields = { model: config.model, prompt: input.prompt, output_format: 'png', ...(input.size ? { size: input.size } : {}) };
  const reference = input.reference_image_path;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  let body: string | FormData;
  if (reference) {
    if ((await stat(reference)).size > 50_000_000) throw new Error('参考图片超过 50 MB。');
    const bytes = await readFile(reference);
    const extension = imageExtension(bytes);
    const mime = extension && referenceTypes[extension];
    if (!mime) throw new Error('参考图片须为 PNG、JPEG 或 WebP。');
    body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.set(name, value);
    body.set('image[]', new Blob([bytes], { type: mime }), `reference${extension}`);
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(fields);
  }

  const timeout = AbortSignal.timeout(300_000);
  const requestSignal = AbortSignal.any([signal, timeout]);
  const requestError = (message: string) => new Error(signal.aborted ? '图片生成已取消。'
    : timeout.aborted ? '等待 OpenAI 图片结果超时，无法确认是否已生成。' : message);
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
    || process.env.all_proxy || process.env.ALL_PROXY;
  const url = `https://api.openai.com/v1/images/${reference ? 'edits' : 'generations'}`;
  let dispatcher: EnvHttpProxyAgent | undefined;
  try { if (proxy) dispatcher = imageProxyAgent ??= new EnvHttpProxyAgent({ httpsProxy: proxy }); }
  catch (error) { throw requestError(`无法使用 QQ Bot 后台的图片接口代理配置${codeDetail(transportCodes(error))}。`); }
  const options = { method: 'POST', headers, body, signal: requestSignal, redirect: 'error' as const, dispatcher };
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, options);
      break;
    } catch (error) {
      const codes = transportCodes(error);
      const beforeConnect = codes.every(code => connectFailureCodes.has(code));
      const detail = codeDetail(codes);
      // A lost response can belong to an accepted, billable generation. Only reconnect before submission.
      if (attempt === 0 && beforeConnect && !requestSignal.aborted) {
        logger.warn(`OpenAI 图片接口连接失败${detail}，正在重连一次。`);
        continue;
      }
      throw requestError(beforeConnect ? `无法连接 OpenAI 图片接口${detail}，请检查后台网络或代理。`
        : `未收到 OpenAI 图片接口的响应${detail}，无法确认请求是否已受理。`);
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const hint = response.status === 401 ? '请检查 OpenAI API 密钥。'
      : response.status === 403 || response.status === 404 ? `请检查当前项目能否使用 ${config.model}。`
        : response.status === 429 ? '请检查项目额度或稍后重试。' : '请检查绘图描述、参考图和模型设置。';
    throw requestError(`OpenAI 图片请求失败（HTTP ${response.status}）。${hint}`);
  }
  const result = await response.json().catch(error => {
    throw requestError(`OpenAI 已响应，但未能读取图片结果${codeDetail(transportCodes(error))}。`);
  }) as
    { data?: Array<{ b64_json?: unknown }> } | null;
  const encoded = result?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string') throw new Error('OpenAI 未返回图片。');
  const bytes = Buffer.from(encoded, 'base64');
  if (imageExtension(bytes) !== '.png') throw new Error('OpenAI 返回的图片格式无效。');
  if (requestSignal.aborted) throw requestError('图片生成已取消。');
  const path = join(directory, `openai-${randomUUID()}.png`);
  await writeFile(path, bytes, { flag: 'wx' });
  return path;
}
