import assert from 'node:assert/strict';
import { CodexClient, configSchema } from '../dist/index.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';

const logger = { info() {}, warn: (value) => console.error(value), error: (value) => console.error(value), debug() {} };
const config = configSchema.parse({ cwd: process.cwd(), sandbox: 'read-only' });
const client = new CodexClient(config, logger);
client.requestHandler = async (message) => {
  if (message.method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
  if (message.method?.endsWith('/requestApproval')) return { decision: 'decline' };
  throw new Error(`Unexpected request during smoke check: ${message.method}`);
};
let threadId;
let output = '';
let done;
let fail;
const finished = new Promise((resolve, reject) => { done = resolve; fail = reject; });
void finished.catch(() => {});
client.onNotification((message) => {
  if (message.params?.threadId !== threadId) return;
  if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') output += message.params.item.text;
  if (message.method === 'turn/completed') {
    if (message.params.turn.status === 'completed') done(); else fail(new Error(JSON.stringify(message.params.turn.error)));
  }
});
let timer;
try {
  const directory = await mkdtemp(join(tmpdir(), 'qqbot-codex-vision-'));
  const imagePath = join(directory, 'fixture.png');
  await QRCode.toFile(imagePath, 'QQBOT_CODEX_OK', { width: 256, margin: 2 });
  await client.start();
  const models = await client.call('model/list', {});
  assert.ok(models.data.length, 'Codex should expose available models');
  const { thread } = await client.call('thread/start', { cwd: process.cwd(), ephemeral: true,
    approvalPolicy: 'never', sandbox: 'read-only',
    dynamicTools: [{ type: 'function', name: 'qqbot_fixture', description: 'Smoke check marker; do not call.', inputSchema: { type: 'object', properties: {} } }],
    developerInstructions: 'This is a local protocol smoke check. Follow only the user message; do not inspect files or use tools.' });
  threadId = thread.id;
  timer = setTimeout(() => fail(new Error('Real Codex turn timed out after 120s')), 120000);
  await client.call('turn/start', { threadId, input: [
    { type: 'text', text: 'Describe the supplied image in one short sentence. Begin with QQBOT_CODEX_OK and identify what kind of symbol is shown. Do not use any tools.' },
    { type: 'localImage', path: imagePath },
  ] });
  await finished;
  assert.match(output, /QQBOT_CODEX_OK/);
  assert.match(output, /QR|二维|code/i);
  console.log(JSON.stringify({ protocol: 'ok', imageInput: 'ok', models: models.data.length, reply: output, threadEphemeral: true }, null, 2));
} finally { clearTimeout(timer); await client.close(); }
