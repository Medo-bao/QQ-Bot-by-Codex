import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { normalizePermissions } from './permissions.ts';

const accessMode = z.enum(['open', 'allowlist', 'disabled']);
const presetSchema = z.object({
  name: z.string().default(''),
  modelProvider: z.string().default(''),
  model: z.string().default(''),
  effort: z.string().default(''),
  cwd: z.string().default(''),
  prompt: z.string().default(''),
  skills: z.array(z.string()).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
});
export const configSchema = z.object({
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  autoStart: z.boolean().default(true),
  cwd: z.string().default(homedir()),
  storageDir: z.string().trim().refine((value) => !value || isAbsolute(value), '会话与资源目录必须是绝对路径。').default(''),
  codexCommand: z.string().default('codex'),
  codexArgs: z.array(z.string()).default([]),
  responsesTransport: z.enum(['http', 'auto']).default('http'),
  model: z.string().default(''),
  modelProvider: z.string().default(''),
  preset: z.string().default(''),
  presets: z.record(z.string(), presetSchema).default({}),
  effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).default('on-request'),
  approvalsReviewer: z.enum(['user', 'auto_review']).default('user'),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  networkAccess: z.boolean().default(true),
  webSearch: z.enum(['disabled', 'cached', 'indexed', 'live']).default('live'),
  requireMention: z.boolean().default(true),
  streaming: z.boolean().default(true),
  textChunkLimit: z.number().int().min(100).max(4500).default(4500),
  sessionIdleTimeout: z.number().int().min(1000).default(1800000),
  processingTimeoutMs: z.number().int().min(1000).default(1800000),
  askTimeoutMs: z.number().int().min(1000).default(300000),
  maxQueue: z.number().int().min(1).max(100).default(20),
  historyLimit: z.number().int().min(0).max(100).default(10),
  contextWindow: z.number().int().min(0).default(0),
  desktopControl: z.boolean().default(true),
  groupPrompt: z.string().default(''),
  directPrompt: z.string().default(''),
  showToolResults: z.boolean().default(false),
  debug: z.boolean().default(false),
  access: z.object({
    c2cMode: accessMode.default('allowlist'),
    c2cAllow: z.array(z.string()).default([]),
    groupMode: accessMode.default('disabled'),
    groupAllow: z.array(z.string()).default([]),
  }).prefault({}),
  media: z.object({
    enabled: z.boolean().default(true),
    maxMB: z.number().positive().max(200).default(20),
    ttlHours: z.number().min(0).default(24),
  }).prefault({}),
  vision: z.object({
    enabled: z.boolean().default(true),
    provider: z.string().default(''),
    model: z.string().default(''),
    defaultPrompt: z.string().default('Describe this image in detail.'),
    maxBytes: z.number().int().positive().default(10485760),
    maxOutputChars: z.number().int().positive().default(4096),
    timeoutMs: z.number().int().min(1000).default(120000),
  }).prefault({}),
  sendFile: z.object({
    restrictPaths: z.boolean().default(true),
    extraRoots: z.array(z.string()).default([]),
    sendPresentedFiles: z.boolean().default(true),
    maxFiles: z.number().int().min(1).max(20).default(4),
  }).prefault({}),
});
export type BotConfig = z.infer<typeof configSchema>;

export function dataDirectory(): string {
  return resolve(process.env.QQBOT_DATA_DIR ||
    join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'qqbot'));
}

/** JSON writes preserve unrelated values and replace the file only after a complete write. */
export function writeJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export class ConfigStore {
  readonly path: string;
  constructor(readonly directory = dataDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'config.json');
  }

  read(): BotConfig {
    const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
    return this.effective(raw);
  }

  private effective(raw: unknown): BotConfig {
    const config = normalizePermissions(configSchema.parse(raw));
    config.appId = process.env.QQBOT_APPID || config.appId;
    config.appSecret = process.env.QQBOT_SECRET || config.appSecret;
    config.cwd = resolve(process.env.QQBOT_CWD || config.cwd);
    config.codexCommand = process.env.QQBOT_CODEX_COMMAND || config.codexCommand;
    return config;
  }

  private merge(patch: Record<string, unknown>): Record<string, unknown> {
    const raw = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
    const merged = { ...raw, ...patch };
    delete merged.autoCompact;
    delete merged.autoCompactThreshold;
    for (const key of ['access', 'media', 'vision', 'sendFile']) {
      if (patch[key] && typeof patch[key] === 'object') merged[key] = { ...raw[key], ...patch[key] as object };
    }
    const config = normalizePermissions(configSchema.parse(merged));
    if (config.preset && !config.presets[config.preset]) throw new Error(`默认预设不存在：${config.preset}`);
    return { ...merged, ...config };
  }

  preview(patch: Record<string, unknown>): BotConfig {
    return this.effective(this.merge(patch));
  }

  update(patch: Record<string, unknown>): BotConfig {
    writeJson(this.path, this.merge(patch));
    return this.read();
  }

  publicConfig(): Omit<BotConfig, 'appSecret'> & { credentialsConfigured: boolean } {
    const { appSecret, ...config } = this.read();
    return { ...config, credentialsConfigured: Boolean(config.appId && appSecret) };
  }
}
