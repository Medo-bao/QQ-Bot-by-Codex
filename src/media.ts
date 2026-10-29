import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { BotConfig } from './config.ts';
import type { RawAttachment } from './types.ts';

export type CodexInput = { type: 'text'; text: string } | { type: 'localImage'; path: string } | { type: 'skill'; name: string; path: string };

export async function downloadFile(address: string, directory: string, maxMB: number, filename?: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('输出目录必须是绝对路径。');
  const url = new URL(address); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('下载地址须为 HTTP(S)。');
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error(`下载失败 (HTTP ${response.status})`);
  const limit = maxMB * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('附件下载超过大小上限。');
  let label = filename || basename(url.pathname) || 'download';
  try { label = decodeURIComponent(label); } catch { /* Literal percent signs are valid names. */ }
  const extensions: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
  if (!extname(label)) label += extensions[response.headers.get('content-type')?.split(';')[0] || ''] || '';
  const name = basename(label).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}-${name}`); let bytes = 0;
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > limit ? new Error('附件下载超过大小上限。') : null, chunk); } });
  try { await pipeline(Readable.fromWeb(response.body as any), limiter, createWriteStream(path, { mode: 0o600 })); }
  catch (error) { await rm(path, { force: true }); throw error; }
  return path;
}

export class MediaStore {
  readonly directory: string;
  constructor(directory: string, private readonly config: BotConfig) {
    this.directory = join(directory, 'media');
  }

  async inputs(attachments: RawAttachment[], directory = this.directory, onDownload?: (path: string, attachment: RawAttachment) => void): Promise<CodexInput[]> {
    if (!this.config.media.enabled || attachments.length === 0) return [];
    await mkdir(directory, { recursive: true });
    const inputs: CodexInput[] = [];
    for (const attachment of attachments) {
      if (attachment.asr_refer_text) inputs.push({ type: 'text', text: `语音转录：${attachment.asr_refer_text}` });
      if (!attachment.url) continue;
      const limit = this.config.media.maxMB * 1024 * 1024;
      if (attachment.size > limit) throw new Error(`附件超过 ${this.config.media.maxMB} MB：${attachment.filename}`);
      const url = new URL(attachment.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('附件下载地址须为 HTTP(S)。');
      const name = basename(attachment.filename || `attachment${extname(url.pathname)}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const path = join(directory, `${randomUUID()}-${name}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw new Error(`附件下载失败 (HTTP ${response.status})`);
      if (Number(response.headers.get('content-length')) > limit) throw new Error('附件下载超过大小上限。');
      let bytes = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > limit ? new Error('附件下载超过大小上限。') : null, chunk);
      } });
      try { await pipeline(Readable.fromWeb(response.body as any), limiter, createWriteStream(path, { mode: 0o600 })); }
      catch (error) { await rm(path, { force: true }); throw error; }
      onDownload?.(path, attachment);
      if ((attachment.content_type || '').startsWith('image/') && this.config.vision.enabled && !this.config.vision.model && !this.config.vision.provider) inputs.push({ type: 'localImage', path });
      inputs.push({ type: 'text', text: `QQ 附件：${name} (${attachment.content_type || 'file'})\n本地路径：${path}` });
    }
    return inputs;
  }

  async uploadChunk(directory: string, input: { upload_id: string; file_name: string; file_size: number; offset: number; data: string }) {
    const limit = this.config.media.maxMB * 1024 * 1024;
    if (!/^[0-9a-f-]{36}$/i.test(input.upload_id || '') || typeof input.file_name !== 'string' || !input.file_name.trim()) throw new Error('无效的上传文件。');
    if (!Number.isSafeInteger(input.file_size) || input.file_size <= 0 || input.file_size > limit) throw new Error(`文件须非空且不超过 ${this.config.media.maxMB} MB。`);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || typeof input.data !== 'string' || input.data.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new Error('无效的文件分片。');
    const bytes = Buffer.from(input.data, 'base64');
    const received = input.offset + bytes.length;
    if (!bytes.length || bytes.length > 256 * 1024 || received > input.file_size) throw new Error('文件分片超过大小上限。');
    const name = basename(input.file_name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'file';
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.upload-${input.upload_id}`);
    const handle = await open(temporary, input.offset ? 'r+' : 'wx', 0o600);
    try {
      if ((await handle.stat()).size !== input.offset) throw new Error('文件上传位置不一致，请重新发送。');
      let written = 0;
      while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, input.offset + written)).bytesWritten;
    } finally { await handle.close(); }
    if (received === input.file_size) {
      const destination = join(directory, input.upload_id);
      await mkdir(destination, { recursive: true });
      const path = join(destination, name);
      await rename(temporary, path);
      return { received, file_path: path };
    }
    return { received };
  }

  async allowedFile(path: string, workspaceRoots: string[] = []): Promise<string> {
    path = /^file:/i.test(path) ? fileURLToPath(path) : path.replace(/^sandbox:/, '');
    if (!isAbsolute(path)) throw new Error('file_path 必须是绝对路径。');
    const actual = await realpath(path);
    if (!(await stat(actual)).isFile()) throw new Error('发送目标必须是普通文件。');
    if (this.config.sendFile.restrictPaths) {
      const roots = [this.config.cwd, this.directory, ...workspaceRoots, ...this.config.sendFile.extraRoots];
      let allowed = false;
      for (const root of roots) {
        let actualRoot: string;
        try { actualRoot = await realpath(resolve(root)); } catch { continue; }
        const rel = relative(actualRoot, actual);
        if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) { allowed = true; break; }
      }
      if (!allowed) throw new Error('文件不在工作目录、媒体目录或本会话允许的发送目录内。');
    }
    return actual;
  }

  async cleanup(directory = this.directory): Promise<void> {
    if (!this.config.media.ttlHours) return;
    let entries: string[];
    try { entries = await readdir(directory); } catch { return; }
    const cutoff = Date.now() - this.config.media.ttlHours * 3600000;
    for (const entry of entries) {
      const path = join(directory, entry);
      const info = await stat(path);
      if (info.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }
}
