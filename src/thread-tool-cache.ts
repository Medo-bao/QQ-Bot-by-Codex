import { readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, toNamespacedPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CodexClient } from './codex-client.ts';

export interface ThreadToolSpec {
  type: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** App Server restores dynamic tools from both rollout metadata and its state index. */
export async function refreshThreadTool(client: Pick<CodexClient, 'call'>, home: string, threadId: string, tool: ThreadToolSpec): Promise<boolean> {
  const result = await client.call('thread/read', { threadId, includeTurns: false });
  if (typeof result.thread?.path !== 'string') return false;
  const root = await realpath(join(home, 'sessions'));
  const path = await realpath(result.thread.path);
  const rel = relative(toNamespacedPath(root), toNamespacedPath(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('会话工具更新目标不在 QQ Bot 会话目录内。');
  const original = await readFile(path);
  const newline = original.indexOf(10);
  const metadata = JSON.parse(original.subarray(0, newline < 0 ? original.length : newline).toString('utf8'));
  if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId) throw new Error('会话工具更新目标与当前会话不匹配。');
  const tools: ThreadToolSpec[] = metadata.payload.dynamic_tools || [];
  const current = tools.find(item => item.name === tool.name);
  const sameSpec = (value: any) => value && isDeepStrictEqual(
    { name: value.name, description: value.description, inputSchema: value.inputSchema },
    { name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  const state = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(b)![0]) - Number(/\d+/.exec(a)![0]))[0];
  const database = state ? new (await import('node:sqlite')).DatabaseSync(join(home, state)) : undefined;
  try {
    database?.exec('PRAGMA busy_timeout = 5000');
    const row = database?.prepare('SELECT name, description, input_schema FROM thread_dynamic_tools WHERE thread_id = ? AND name = ?').get(threadId, tool.name);
    const indexed = row ? { name: row.name, description: row.description, inputSchema: JSON.parse(String(row.input_schema)) } : undefined;
    if (sameSpec(current) && (!database || sameSpec(indexed))) return false;
    const loaded = await client.call('thread/loaded/list');
    if (loaded.data?.includes(threadId)) throw new Error('当前会话仍加载着旧工具定义，请重启 QQ Bot 后台后重试；会话上下文会保留。');
    metadata.payload.dynamic_tools = current ? tools.map(item => item.name === tool.name ? tool : item) : [...tools, tool];
    const updated = Buffer.concat([Buffer.from(JSON.stringify(metadata) + '\n'), newline < 0 ? Buffer.alloc(0) : original.subarray(newline + 1)]);
    const temporary = `${path}.${randomUUID()}.tools.tmp`;
    let replaced = false, transaction = false;
    try {
      await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' });
      if (database) { database.exec('BEGIN IMMEDIATE'); transaction = true; }
      if (database) {
        if (row) database.prepare('UPDATE thread_dynamic_tools SET description = ?, input_schema = ? WHERE thread_id = ? AND name = ?')
          .run(tool.description, JSON.stringify(tool.inputSchema), threadId, tool.name);
        else {
          const next = database.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS position FROM thread_dynamic_tools WHERE thread_id = ?').get(threadId)!;
          database.prepare('INSERT INTO thread_dynamic_tools (thread_id, position, name, description, input_schema) VALUES (?, ?, ?, ?, ?)')
            .run(threadId, next.position!, tool.name, tool.description, JSON.stringify(tool.inputSchema));
        }
      }
      renameSync(temporary, path); replaced = true;
      if (database) { database.exec('COMMIT'); transaction = false; }
    } catch (error) {
      if (transaction) database!.exec('ROLLBACK');
      if (replaced) { writeFileSync(temporary, original, { mode: 0o600 }); renameSync(temporary, path); }
      throw error;
    } finally { await rm(temporary, { force: true }); }
    return true;
  } finally { database?.close(); }
}
