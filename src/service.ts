import { spawn } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, dataDirectory } from './config.ts';
import { BotController } from './controller.ts';
import { SetupPage } from './setup-page.ts';
import type { Logger, ReplyTarget } from './types.ts';

interface ServiceRequest { method: string; params?: Record<string, any>; }

export function serviceAddress(directory: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-qqbot-${Buffer.from(resolve(directory).toLowerCase()).toString('base64url')}`
    : join(directory, 'control.sock');
}

export function callService(method: string, params: Record<string, unknown> = {}, directory = dataDirectory()): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(serviceAddress(directory));
    socket.setEncoding('utf8');
    socket.setTimeout(65000, () => socket.destroy(new Error('QQ 后台服务响应超时。')));
    let buffer = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ method, params })}\n`));
    socket.on('data', (data) => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
        if (response.error) reject(new Error(response.error)); else resolve(response.result);
      } catch (error) { reject(error); }
    });
    socket.on('end', () => { if (!buffer.includes('\n')) reject(new Error('QQ 后台服务已关闭连接。')); });
  });
}

export async function ensureService(directory = dataDirectory()): Promise<void> {
  try { await callService('status', {}, directory); return; }
  catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  new ConfigStore(directory);
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const environment = { ...process.env, QQBOT_DATA_DIR: directory };
  // ShellExecute (Start-Process) detaches from Windows shim job objects such as Volta's.
  // Node's detached flag alone does not escape those jobs.
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @(${quote(`"${cli}"`)}, 'daemon') -WindowStyle Hidden`],
      { windowsHide: true, stdio: 'ignore', env: environment })
    : spawn(process.execPath, [cli, 'daemon'], { detached: true, windowsHide: true, stdio: 'ignore', env: environment });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  child.unref();
  for (let i = 0; i < 80; i++) {
    if (spawnError) throw spawnError;
    try { await callService('status', {}, directory); return; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`QQ 后台服务未能启动，请检查 ${join(directory, 'runtime.log')}`);
}

export async function startService(logger: Logger, directory = dataDirectory()): Promise<void> {
  const controller = new BotController(new ConfigStore(directory), logger);
  const page = new SetupPage(controller, () => shutdown());
  const address = serviceAddress(directory);
  if (process.platform !== 'win32' && existsSync(address)) {
    try { await callService('status', {}, directory); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') unlinkSync(address); else throw error; }
  }
  let mutation = Promise.resolve();
  let closing = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', (error) => logger.warn(error.message));
    let buffer = ''; let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      handled = true;
      const respond = async () => {
        try {
          const request: ServiceRequest = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          const params = request.params || {};
          let result: unknown;
          switch (request.method) {
            case 'setup': result = { url: await page.open(), ...controller.status() }; break;
            case 'send': result = await controller.send(target(params), String(params.text)); break;
            case 'sendFile': result = await controller.sendFile(target(params), String(params.file_path), params.send_as); break;
            case 'shutdown': result = { stopped: true }; break;
            default: result = await controller.invoke(request.method, params);
          }
          socket.end(`${JSON.stringify({ result })}\n`);
          if (request.method === 'shutdown') void shutdown();
        } catch (error) { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); }
      };
      let request: ServiceRequest;
      try { request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); } catch { void respond(); return; }
      if (['status', 'setup', 'models', 'browser'].includes(request.method) || request.method === 'desktop' && ['list', 'read', 'jobs'].includes(request.params?.action) ||
        request.method === 'session' && request.params?.action === 'desktop' && ['list', 'read', 'jobs'].includes(request.params.operation)) void respond();
      else { mutation = mutation.then(respond); }
    });
  });
  async function shutdown() {
    if (closing) return;
    closing = true;
    await controller.dispose();
    await page.close();
    for (const socket of sockets) socket.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, () => resolve()); });
  } catch (error) {
    // Several MCP clients can launch a daemon before the first one starts listening.
    // The listener owns the service; the losing process can simply reuse it and exit.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    await callService('status', {}, directory);
    return;
  }
  if (process.platform !== 'win32') chmodSync(address, 0o600);
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  logger.info(`QQ 后台服务已启动 (pid=${process.pid})`);
}

function target(params: Record<string, any>): ReplyTarget {
  if ((params.scope !== 'c2c' && params.scope !== 'group') || typeof params.target_id !== 'string' || !params.target_id) throw new Error('需要 scope=c2c|group 与 target_id。');
  return { scope: params.scope, targetId: params.target_id };
}
