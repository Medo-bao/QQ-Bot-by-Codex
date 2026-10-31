#!/usr/bin/env node
import { ConfigStore, dataDirectory } from './config.ts';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { startMcp } from './mcp.ts';
import { callService, ensureService, startService } from './service.ts';
import type { Logger } from './types.ts';
import { downloadFile } from './media.ts';

async function main(): Promise<void> {
  const [command = 'help', argument] = process.argv.slice(2);
  if (command === 'download') {
    const directory = process.argv[4]; const maxMB = Number(process.argv[5] || 20);
    if (!argument || !directory || !Number.isFinite(maxMB) || maxMB <= 0 || maxMB > 200) throw new Error('用法：download <HTTP(S) URL> <绝对输出目录> [上限 MB]');
    process.stdout.write(JSON.stringify({ file_path: await downloadFile(argument, directory, maxMB) }) + '\n'); return;
  }
  if (command === 'mcp') {
    // The connector may log while binding: reserve stdout exclusively for MCP JSON-RPC.
    console.log = (...args: unknown[]) => console.error(...args);
    await startMcp(); return;
  }
  if (command === 'daemon') {
    const directory = dataDirectory(); new ConfigStore(directory);
    const log = createWriteStream(join(directory, 'runtime.log'), { flags: 'a', mode: 0o600 });
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) console[method] = (...args: unknown[]) => {
      const message = format(...args);
      // Node emits runtime warnings through console.error, including a separate trace hint.
      const warning = method === 'error' && /^(?:\(node:\d+\) (?:\[[^\]]+\] )?\w*Warning:|\(Use `node --trace-(?:warnings|deprecation))/.test(message);
      const prefix = `${new Date().toISOString()} [${method === 'log' ? 'INFO' : warning ? 'WARN' : method.toUpperCase()}] `;
      log.write(`${prefix}${message.replace(/\r?\n/g, `\n${prefix}`)}\n`);
    };
    const logger: Logger = {
      info: message => console.info(`[qqbot] ${message}`),
      warn: message => console.warn(`[qqbot] ${message}`),
      error: message => console.error(`[qqbot] ${message}`),
      debug: message => { if (process.env.QQBOT_DEBUG === '1') console.debug(`[qqbot] ${message}`); },
    };
    await startService(logger, directory); return;
  }
  if (command === 'config') {
    const store = new ConfigStore();
    if (argument) {
      const patch = JSON.parse(argument);
      try { await callService('configure', patch); }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) store.update(patch);
        else throw error;
      }
    }
    process.stdout.write(`${JSON.stringify(store.publicConfig(), null, 2)}\n`); return;
  }
  if (command === 'status') {
    try { process.stdout.write(`${JSON.stringify(await callService('status'), null, 2)}\n`); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      process.stdout.write(`${JSON.stringify({ running: false, connected: false, config: new ConfigStore().publicConfig() }, null, 2)}\n`);
    }
    return;
  }
  if (['setup', 'start', 'stop', 'models', 'shutdown'].includes(command)) {
    if (command !== 'shutdown' && command !== 'stop') await ensureService();
    process.stdout.write(`${JSON.stringify(await callService(command), null, 2)}\n`); return;
  }
  process.stdout.write('QQ Bot 0.0.4\n\nnode dist/cli.js setup     本地扫码绑定与设置页\nnode dist/cli.js start     启动 QQ → Codex\nnode dist/cli.js status    查看状态\nnode dist/cli.js models    查看 Codex 模型\nnode dist/cli.js stop      停止 QQ 连接\nnode dist/cli.js shutdown  退出共享后台进程\nnode dist/cli.js mcp       Codex 插件 MCP 入口\n');
}

main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
