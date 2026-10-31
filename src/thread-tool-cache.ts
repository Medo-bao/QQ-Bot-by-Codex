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

/** Cold resume prefers the latest owned catalog update or compaction snapshot. */
export async function refreshThreadTools(client: Pick<CodexClient, 'call'>, home: string, threadId: string, tools: readonly ThreadToolSpec[], options: { created?: boolean } = {}): Promise<boolean> {
  const result = await client.call('thread/read', { threadId, includeTurns: false });
  let path = '', lines: string[] = [], original: Buffer = Buffer.alloc(0);
  let stored: readonly ThreadToolSpec[] = tools;
  if (options.created) {
    if (result.thread?.id !== threadId) throw new Error('新会话工具初始化目标与当前会话不匹配。');
    // thread/start already installed this exact catalog. Its rollout writer may still be creating the file.
    // Populate only the derived index; do not read or rewrite a not-yet-persisted rollout.
  } else {
    if (typeof result.thread?.path !== 'string') return false;
    const root = await realpath(join(home, 'sessions'));
    path = await realpath(result.thread.path);
    const rel = relative(toNamespacedPath(root), toNamespacedPath(path));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('会话工具更新目标不在 QQ Bot 会话目录内。');
    original = await readFile(path);
    const newline = original.indexOf(10);
    const metadata = JSON.parse(original.subarray(0, newline < 0 ? original.length : newline).toString('utf8'));
    if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId) throw new Error('会话工具更新目标与当前会话不匹配。');
    lines = original.toString('utf8').trimEnd().split('\n');
    stored = metadata.payload.dynamic_tools || [];
    for (const line of lines.slice(1)) {
      if (!line.includes('compacted') && !line.includes('dynamic_tools_updated')) continue;
      let item: any; try { item = JSON.parse(line); } catch { continue; }
      const snapshot = item.type === 'compacted' ? item.payload?.resume_metadata?.dynamic_tools
        : item.type === 'dynamic_tools_updated' ? item.payload : undefined;
      if (snapshot?.thread_id === threadId && Array.isArray(snapshot.tools)) stored = snapshot.tools;
    }
  }
  const sameSpec = (value: any, tool: ThreadToolSpec) => value && isDeepStrictEqual(
    { name: value.name, description: value.description, inputSchema: value.inputSchema },
    { name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  const state = (await readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(b)![0]) - Number(/\d+/.exec(a)![0]))[0];
  const database = state ? new (await import('node:sqlite')).DatabaseSync(join(home, state)) : undefined;
  try {
    database?.exec('PRAGMA busy_timeout = 5000');
    // Native creation also defers the parent SQL row until the first turn is persisted.
    // The in-memory catalog is already usable; leave its optional index for turn completion.
    if (options.created && database && !database.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)) return false;
    const rows = database?.prepare('SELECT position, name, description, input_schema FROM thread_dynamic_tools WHERE thread_id = ?').all(threadId) || [];
    const indexed = new Map(rows.map(row => [String(row.name), { name: row.name, description: row.description, inputSchema: JSON.parse(String(row.input_schema)) }]));
    const catalogChanged = tools.some(tool => !sameSpec(stored.find(item => item.name === tool.name), tool));
    const indexChanges = tools.filter(tool => !sameSpec(indexed.get(tool.name), tool));
    if (!catalogChanged && (!database || !indexChanges.length)) return false;
    if (catalogChanged) {
      const loaded = await client.call('thread/loaded/list');
      if (loaded.data?.includes(threadId)) throw new Error('当前会话仍加载着旧工具定义，请重启 QQ Bot 后台后重试；会话上下文会保留。');
    }
    const temporary = catalogChanged ? `${path}.${randomUUID()}.tools.tmp` : undefined;
    let replaced = false, transaction = false;
    try {
      if (temporary) {
        const updatedTools = stored.map(item => tools.find(tool => tool.name === item.name) || item);
        updatedTools.push(...tools.filter(tool => !stored.some(item => item.name === tool.name)));
        const ordinal = JSON.parse(lines.at(-1)!).ordinal;
        const event = { timestamp: new Date().toISOString(), ...(typeof ordinal === 'number' ? { ordinal: ordinal + 1 } : {}),
          type: 'dynamic_tools_updated', payload: { thread_id: threadId, tools: updatedTools } };
        // Append a native catalog event: keep checkpoint contents and indexed byte offsets intact.
        const updated = Buffer.concat([original, Buffer.from((original.at(-1) === 10 ? '' : '\n') + JSON.stringify(event) + '\n')]);
        await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' });
      }
      if (database) { database.exec('BEGIN IMMEDIATE'); transaction = true; }
      if (database) {
        let nextPosition = Math.max(-1, ...rows.map(row => Number(row.position))) + 1;
        for (const tool of indexChanges) {
          if (indexed.has(tool.name)) database.prepare('UPDATE thread_dynamic_tools SET description = ?, input_schema = ? WHERE thread_id = ? AND name = ?')
            .run(tool.description, JSON.stringify(tool.inputSchema), threadId, tool.name);
          else database.prepare('INSERT INTO thread_dynamic_tools (thread_id, position, name, description, input_schema) VALUES (?, ?, ?, ?, ?)')
            .run(threadId, nextPosition++, tool.name, tool.description, JSON.stringify(tool.inputSchema));
        }
      }
      if (temporary) { renameSync(temporary, path); replaced = true; }
      if (database) { database.exec('COMMIT'); transaction = false; }
    } catch (error) {
      if (transaction) database!.exec('ROLLBACK');
      if (replaced) { writeFileSync(temporary!, original, { mode: 0o600 }); renameSync(temporary!, path); }
      throw error;
    } finally { if (temporary) await rm(temporary, { force: true }); }
    return true;
  } finally { database?.close(); }
}
