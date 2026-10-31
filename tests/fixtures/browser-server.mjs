import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.argv[2];
const server = new McpServer({ name: 'browser-fixture', version: '1.0.0' });
server.registerTool('js', { inputSchema: { code: z.string(), title: z.string().optional(), timeout_ms: z.number().optional() } }, ({ code }, extra) => {
  const meta = JSON.parse(extra._meta['x-codex-turn-metadata']);
  const state = JSON.parse(readFileSync(join(directory, 'browser-state.json'), 'utf8'));
  appendFileSync(join(directory, 'browser-calls.jsonl'), JSON.stringify({ code, meta, identity: JSON.parse(process.env.BROWSER_USE_ACCESS_EXECUTOR_ID) }) + '\n');
  if (state.error) return { isError: true, content: [{ type: 'text', text: state.error }] };
  let value;
  if (code.includes('listTabs')) value = state.tabs ?? [{ id: 'existing-tab', url: 'https://x.com/existing' }];
  else if (code.includes('domSnapshot')) value = { url: state.url || 'https://x.com/existing', snapshot: state.snapshot };
  return { content: [{ type: 'text', text: value ? JSON.stringify(value) : 'Browser documentation or operation completed.' }] };
});
await server.connect(new StdioServerTransport());
