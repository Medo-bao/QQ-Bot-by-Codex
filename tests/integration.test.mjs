import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ConfigStore, SessionStore, CodexClient, QQBridge, QQTransport, BotController, InteractionBroker, MediaStore, configSchema, callService, describeImage, dynamicTools,
  ReplyLimiter, replyPolicy, cacheMsgId, getCachedReplyIds, resolveReplyTarget } from '../dist/index.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const fixture = resolve('tests/fixtures/codex-server.mjs');
const temp = () => mkdtemp(join(tmpdir(), 'codex-qqbot-test-'));
process.env.CODEX_HOME = await temp();
process.env.QQBOT_DATA_DIR = await temp();
const requireTrace = (directory) => readFileSync(join(directory, 'protocol.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for fixture state'); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
const message = (text, scope = 'c2c', id = 'alice', senderId = 'alice') => ({ target: { scope, targetId: id, msgId: 'msg-' + Math.random(), ...(scope === 'group' ? { replyUserId: senderId } : {}) }, text, senderId, shouldAnswer: true, attachments: [] });
const currentText = turn => turn.params.input.find(input => input.type === 'text' && !['[QQ Bot 本轮文件目录]\n', '[QQ Bot 群聊上下文：', '[QQ Bot 引用上下文：'].some(prefix => input.text.startsWith(prefix)))?.text || '';
const groupContext = (turn) => JSON.parse(turn.params.input.find(input => input.type === 'text' && input.text.startsWith('[QQ Bot 群聊上下文：')).text.split('\n').slice(1).join('\n'));
const referenceContext = turn => JSON.parse(turn.params.input.find(input => input.type === 'text' && input.text.startsWith('[QQ Bot 引用上下文：')).text.split('\n').slice(1).join('\n')).reference;
class FakeQQ {
  messages = []; files = []; streams = []; failedSends = 0; failNextMarkdown = false; fileDelayMs = 0;
  async connect(onMessage, onInteraction) { this.onMessage = onMessage; this.onInteraction = onInteraction; }
  close() { this.closed = true; }
  async sendMarkdown(target, text, opts) { if (this.failNextMarkdown) { this.failNextMarkdown = false; this.failedSends++; throw new Error('fixture QQ delivery unavailable'); } const receipt = { id: 'sent-' + this.messages.length, ext_info: { ref_idx: 'sent-ref-' + this.messages.length } }; this.messages.push({ target, text, opts, receipt }); return receipt; }
  async sendFile(target, path, fileName, sendAs = 'auto') { if (this.fileDelayMs) await new Promise(resolve => setTimeout(resolve, this.fileDelayMs)); const receipt = { id: 'file-' + this.files.length, ext_info: { ref_idx: 'file-ref-' + this.files.length } }; this.files.push({ target, path, fileName, sendAs, receipt }); return { upload: { file_info: 'fixture-media' }, message: receipt }; }
  openStream(target) { const receipt = { id: 'stream-' + this.streams.length, ext_info: { ref_idx: 'stream-ref-' + this.streams.length } }; const stream = { target, receipt, updates: [], completeCount: 0, async update(text) { this.updates.push(text); }, async complete() { this.completeCount++; return receipt; } }; this.streams.push(stream); return stream; }
}

test('Persisted QQ tools refresh complete indexes without replacing history or unrelated tools', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = await temp(); const sessions = join(directory, 'sessions'); await mkdir(sessions);
  const threadId = '11111111-2222-4333-8444-555555555555', path = join(sessions, 'legacy.jsonl');
  const previous = structuredClone(dynamicTools[0]); previous.description = 'Legacy file sender'; delete previous.inputSchema.properties.send_as;
  const unrelated = { type: 'function', name: 'unrelated_tool', description: 'Preserved', inputSchema: { type: 'object' } };
  const history = Buffer.from(JSON.stringify({ ordinal: 1, type: 'response_item', payload: { text: '保留群聊上下文和文件路径 %20.png' } }) + '\n');
  const checkpoint = { ordinal: 2, type: 'compacted', payload: { message: 'Preserved summary', resume_metadata: {
    dynamic_tools: { thread_id: threadId, tools: [previous, ...dynamicTools.slice(1), unrelated] } } } };
  const original = Buffer.concat([Buffer.from(JSON.stringify({ ordinal: 0, type: 'session_meta', payload: { id: threadId, history_mode: 'paginated', dynamic_tools: [...dynamicTools, unrelated] } }) + '\n'), history, Buffer.from(JSON.stringify(checkpoint) + '\n')]);
  await writeFile(path, original);
  const state = new DatabaseSync(join(directory, 'state_5.sqlite'));
  state.exec('CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER, name TEXT, description TEXT, input_schema TEXT, PRIMARY KEY(thread_id,position))');
  const insert = state.prepare('INSERT INTO thread_dynamic_tools VALUES (?, ?, ?, ?, ?)');
  for (const [position, tool] of dynamicTools.entries()) insert.run(threadId, position, tool.name, tool.description, JSON.stringify(tool.inputSchema));
  insert.run(threadId, 3, unrelated.name, unrelated.description, JSON.stringify(unrelated.inputSchema));
  const client = new CodexClient(configSchema.parse({ cwd: directory }), quiet); client.runtimeHome = directory;
  let loaded = false;
  client.call = async method => method === 'thread/read' ? { thread: { id: threadId, path } } : { data: loaded ? [threadId] : [] };
  try {
    assert.equal(await client.refreshThreadTools(threadId, dynamicTools), true);
    const updated = await readFile(path);
    assert.ok(updated.subarray(0, original.length).equals(original), 'chat records, compaction state and their byte offsets are preserved');
    const event = JSON.parse(updated.subarray(original.length).toString());
    assert.equal(event.ordinal, 3);
    assert.equal(event.type, 'dynamic_tools_updated');
    assert.equal(event.payload.thread_id, threadId);
    assert.deepEqual(event.payload.tools, [...dynamicTools, unrelated]);
    assert.deepEqual(JSON.parse(state.prepare('SELECT input_schema FROM thread_dynamic_tools WHERE name=?').get(previous.name).input_schema).properties.send_as.enum, ['auto', 'file', 'voice']);
    assert.deepEqual(state.prepare('SELECT description FROM thread_dynamic_tools WHERE name=?').get(unrelated.name).description, unrelated.description);
    for (const tool of dynamicTools) {
      const row = state.prepare('SELECT description,input_schema FROM thread_dynamic_tools WHERE name=?').get(tool.name);
      assert.equal(row.description, tool.description);
      assert.deepEqual(JSON.parse(row.input_schema), tool.inputSchema);
    }
    state.prepare('DELETE FROM thread_dynamic_tools WHERE name=?').run(dynamicTools[1].name);
    loaded = true;
    await assert.rejects(client.refreshThreadTools(threadId, dynamicTools), /重启/, 'partial indexes are not changed while the thread is loaded');
    loaded = false;
    assert.equal(await client.refreshThreadTools(threadId, dynamicTools), true, 'complete metadata still repairs a partial SQL index');
    assert.ok((await readFile(path)).equals(updated), 'index-only repair leaves the entire rollout untouched');
    assert.ok(state.prepare('SELECT name FROM thread_dynamic_tools WHERE name=?').get(dynamicTools[1].name));
    loaded = true;
    assert.equal(await client.refreshThreadTools(threadId, dynamicTools), false, 'current schemas do not reload an active cache');
    await assert.rejects(client.refreshThreadTools(threadId, [{ ...dynamicTools[0], description: 'A later revision' }, ...dynamicTools.slice(1)]), /重启/);
    assert.ok((await readFile(path)).equals(updated), 'loaded threads are never rewritten');
  } finally { state.close(); }
});

test('QQ → real JSONL child process: isolation, streaming, approvals, questions, file delivery, cancel and resume', { timeout: 30000 }, async t => {
  const directory = await temp();
  let quoteDownloads = 0, quoteMediaExpired = false, contextDownloads = 0, contextMediaExpired = false;
  let releaseContextDownload, contextDownloadStarted = false;
  const quoteHttp = createServer((request, response) => {
    if (request.url.startsWith('/context-')) {
      contextDownloads++;
      if (contextMediaExpired || request.url === '/context-expired.png') { response.writeHead(410); response.end(); return; }
      const send = () => { response.setHeader('content-type', request.url.endsWith('.txt') ? 'text/plain' : 'image/png'); response.end(Buffer.from('ordinary context file')); };
      if (request.url === '/context-slow.png') { contextDownloadStarted = true; releaseContextDownload = send; } else send();
      return;
    }
    quoteDownloads++;
    if (quoteMediaExpired || request.url === '/expired.png') { response.writeHead(410); response.end(); }
    else { response.setHeader('content-type', 'image/png'); response.end(Buffer.from('quoted-image-fixture')); }
  });
  await new Promise(resolve => quoteHttp.listen(0, '127.0.0.1', resolve));
  t.after(async () => { quoteHttp.closeAllConnections(); await new Promise(resolve => quoteHttp.close(resolve)); });
  const quoteBase = `http://127.0.0.1:${quoteHttp.address().port}`;
  const fullQuote = '引用完整正文-' + '完整资料'.repeat(180) + '-引用末尾';
  const quoteImage = { content_type: 'image/png', filename: 'quoted.png', size: 20, url: quoteBase + '/quoted.png' };
  const contextImage = { content_type: 'image/png', filename: 'context-picture.png', size: 21, url: quoteBase + '/context-picture.png' };
  const passiveContextImage = { ...message('普通图片', 'group', 'team', 'alice'), attachments: [contextImage], shouldAnswer: false };
  await writeFile(join(directory, 'report.txt'), 'requested report');
  await writeFile(join(directory, 'report.png'), 'image-fixture');
  await writeFile(join(directory, 'sessions.json'), JSON.stringify({ 'fixture-app:c2c:alice': { threadId: 'legacy-personal-thread' } }));
  const config = configSchema.parse({ appId: 'fixture-app', appSecret: 'do-not-return', cwd: directory, codexCommand: fixture, codexArgs: [directory],
    directPrompt: 'default-private-role', groupPrompt: 'default-group-role',
    access: { c2cMode: 'allowlist', c2cAllow: ['alice', 'bob'], groupMode: 'allowlist', groupAllow: ['team'] },
    presets: { coding: { name: 'Coding', model: 'fixture-model', prompt: 'preset-fixture-prompt', skills: ['fixture-skill'] } } });
  const qq = new FakeQQ();
  const client = new CodexClient(config, quiet);
  const warnings = [];
  const bridge = new QQBridge(config, directory, qq, client, { ...quiet, warn: text => warnings.push(text) });
  await client.start();
  const legacyImages = client.generatedImageDirectory('legacy-personal-thread');
  await mkdir(legacyImages, { recursive: true });
  const legacyImage = join(legacyImages, 'old-image.png'); await writeFile(legacyImage, 'existing generated image');
  await bridge.start();
  try {
    assert.ok((await realpath(legacyImage)).startsWith(bridge.storage.paths(message('').target).files), 'existing generated images migrate while their original paths remain usable');
    assert.equal(await readFile(legacyImage, 'utf8'), 'existing generated image');
    await bridge.handleMessage(message('unauthorized', 'c2c', 'mallory', 'mallory'));
    assert.equal(bridge.status().sessions.length, 1, 'only the pre-existing session is present');
    assert.ok(!bridge.status().sessions.some((session) => session.peerId === 'mallory'));
    await bridge.handleMessage(message('hello'));
    let first = bridge.status().sessions[0].threadId;
    assert.notEqual(first, 'legacy-personal-thread');
    assert.equal(bridge.status().sessions[0].previousThreadId, 'legacy-personal-thread');
    assert.equal(qq.streams[0].updates.at(-1), 'Codex fixture reply: hello');
    assert.equal(qq.streams[0].completeCount, 1);
    assert.equal(qq.messages.length, 0, 'streamed reply must not be duplicated as static');
    assert.equal(requireTrace(directory).find(item => item.method === 'thread/start').params.modelProvider, 'qqbot-openai-http', 'the default OpenAI connection skips repeated WebSocket handshakes');
    assert.ok(requireTrace(directory).find(item => item.launch).launch.some(arg => arg.includes('supports_websockets=false')));
    assert.ok(requireTrace(directory).find(item => item.launch).launch.includes('notify=[]'), 'QQ replies do not invoke desktop notification commands');
    await client.call('thread/start', { modelProvider: 'fixture', ephemeral: true });
    assert.equal(requireTrace(directory).filter(item => item.method === 'thread/start').at(-1).params.modelProvider, 'fixture', 'custom provider selection is preserved');
    bridge.submitLocal('c2c', 'alice', 'continue from desktop');
    await waitFor(() => !bridge.status().sessions.find((item) => item.peerId === 'alice').queued);
    assert.equal(bridge.status().sessions.find((item) => item.peerId === 'alice').threadId, first, 'the desktop continues the same QQ AI thread');
    assert.ok(qq.streams.some((stream) => stream.updates.some((text) => text.includes('continue from desktop'))), 'desktop AI replies are also sent to QQ');
    assert.equal(bridge.status().sessions.find((item) => item.peerId === 'alice').settings.preset, '', 'new session settings inherit the global preset');
    const task = bridge.handleMessage(message('approve-question-file', 'group', 'team'));
    await waitFor(() => bridge.broker.list().length === 1);
    const queuedInput = message('queued group question', 'group', 'team', 'bob');
    const queuedTask = bridge.handleMessage(queuedInput);
    await bridge.handleMessage({ ...message('future passive group message', 'group', 'team', 'bob'), shouldAnswer: false });
    let pending = bridge.broker.list()[0];
    const data = qq.messages.at(-1).opts.keyboard.content.rows[0].buttons[0].action.data;
    assert.equal(bridge.handleInteraction({ target: pending.target, senderId: 'mallory', data }), false);
    assert.equal(bridge.handleInteraction({ target: pending.target, senderId: 'alice', data }), true);
    assert.equal(bridge.handleInteraction({ target: pending.target, senderId: 'alice', data }), false, 'stale approval must be rejected');
    await waitFor(() => bridge.broker.list().length === 1 && bridge.broker.list()[0].token !== pending.token);
    pending = bridge.broker.list()[0];
    await bridge.handleMessage({ ...message(`/answer ${pending.token} 2`, 'group', 'team'), shouldAnswer: false });
    await task;
    await queuedTask;
    const queuedTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('queued group question'));
    assert.ok(!groupContext(queuedTurn).messages.some(item => item.text.includes('future passive group message')), 'queued requests do not receive user messages that arrived later');
    assert.ok(groupContext(queuedTurn).messages.some(item => item.role === 'assistant'), 'the previous task reply is available when the queued task begins');
    assert.ok(queuedTurn.params.input[0].text.startsWith('[QQ Bot 群聊上下文：'), 'received group history is read before the current question');
    assert.equal(groupContext(queuedTurn).currentMessageId, queuedInput.contextId);
    assert.equal(qq.files.length, 1);
    assert.equal(qq.files[0].target.targetId, 'team');
    assert.notEqual(bridge.status().sessions.find((item) => item.scope === 'group').threadId, first);
    await bridge.manageSession('c2c', 'alice', 'configure', { prompt: 'alice-exclusive-role', model: 'fixture-model', effort: 'high' });
    await bridge.handleMessage(message('personal role'));
    assert.equal(bridge.status().sessions.find((item) => item.scope === 'group').prompt, null);
    assert.notEqual(bridge.status().sessions.find((item) => item.peerId === 'alice').threadId, first);
    first = bridge.status().sessions.find((item) => item.peerId === 'alice').threadId;
    await bridge.manageSession('group', 'team', 'configure', { prompt: 'group-exclusive-role' });
    await bridge.handleMessage(message('group role', 'group', 'team'));
    const groupThread = bridge.status().sessions.find((item) => item.scope === 'group').threadId;
    await bridge.handleMessage({ ...message('member A question', 'group', 'team', 'alice'), senderName: '同名成员' });
    await bridge.handleMessage({ ...message('member B question', 'group', 'team', 'bob'), senderName: '同名成员' });
    assert.equal(bridge.status().sessions.find((item) => item.scope === 'group').threadId, groupThread, 'group members share one AI context');
    assert.equal(qq.messages.at(-1).target.replyUserId, 'bob');
    const memberInputs = requireTrace(directory).filter((item) => item.method === 'turn/start' && item.params.threadId === groupThread);
    assert.ok(memberInputs.some((item) => item.params.input.some((input) => input.text?.includes('"senderId":"alice"') && input.text.includes('member A question'))));
    assert.ok(memberInputs.some((item) => item.params.input.some((input) => input.text?.includes('"senderId":"bob"') && input.text.includes('member B question'))));
    const longHistory = '完整群历史-' + '长消息内容'.repeat(80) + '-末尾线索';
    const passive = { ...message(longHistory, 'group', 'team', 'alice'), senderName: 'Alice', shouldAnswer: false };
    await bridge.handleMessage(passive); await bridge.handleMessage(passive);
    await bridge.handleMessage({ ...message('第二位成员补充资料', 'group', 'team', 'bob'), senderName: 'Bob', shouldAnswer: false });
    const repliesBeforeHistory = qq.messages.length;
    await bridge.handleMessage(message('回顾前面的完整信息', 'group', 'team', 'bob'));
    assert.equal(qq.messages.length, repliesBeforeHistory + 1, 'passive group context is recorded without triggering replies');
    const historyTurn = requireTrace(directory).filter(item => item.method === 'turn/start' && item.params.threadId === groupThread).at(-1);
    const recentGroup = groupContext(historyTurn).messages;
    assert.equal(recentGroup.filter(item => item.text === longHistory).length, 1, 'gateway redelivery does not duplicate group context');
    assert.equal(recentGroup.find(item => item.text === longHistory).senderId, 'alice');
    assert.ok(recentGroup.some(item => item.senderId === 'bob' && item.text === '第二位成员补充资料'));
    assert.ok(recentGroup.some(item => item.text.endsWith('-末尾线索')), 'messages longer than 200 characters keep their complete text');
    const passiveReplies = qq.messages.length;
    await bridge.handleMessage(passiveContextImage);
    assert.equal(qq.messages.length, passiveReplies, 'receiving an ordinary group attachment never starts a reply');
    await bridge.handleMessage(message('read ordinary previous image without quoting', 'group', 'team', 'bob'));
    const ordinaryTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('read ordinary previous image'));
    const ordinaryFile = groupContext(ordinaryTurn).messages.find(item => item.id === passiveContextImage.contextId).files[0];
    assert.equal(await readFile(ordinaryFile.path, 'utf8'), 'ordinary context file');
    assert.ok(ordinaryTurn.params.input.some(item => item.type === 'localImage' && item.path === ordinaryFile.path), 'unquoted recent pictures reach model image input');
    assert.equal(contextDownloads, 1);
    await bridge.handleMessage(passiveContextImage);
    assert.equal(contextDownloads, 1, 'gateway redelivery reuses the local ordinary attachment');
    await rm(ordinaryFile.path);
    await bridge.handleMessage(message('recover ordinary previous image', 'group', 'team', 'bob'));
    const recoveredTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('recover ordinary previous image'));
    const recoveredFile = groupContext(recoveredTurn).messages.find(item => item.id === passiveContextImage.contextId).files[0];
    assert.notEqual(recoveredFile.path, ordinaryFile.path);
    assert.equal(await readFile(recoveredFile.path, 'utf8'), 'ordinary context file');
    assert.equal(contextDownloads, 2, 'a missing cached file is restored from its recorded QQ attachment');
    await bridge.handleMessage({ ...message('普通文档', 'group', 'team', 'alice'), attachments: [{ ...contextImage, content_type: 'text/plain', filename: 'context-note.txt', url: quoteBase + '/context-note.txt' }], shouldAnswer: false });
    await bridge.handleMessage(message('read previous ordinary document', 'group', 'team', 'bob'));
    const documentTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('read previous ordinary document'));
    const documentFile = groupContext(documentTurn).messages.find(item => item.files?.some(file => file.name === 'context-note.txt')).files[0];
    assert.equal(await readFile(documentFile.path, 'utf8'), 'ordinary context file');
    assert.ok(!documentTurn.params.input.some(item => item.type === 'localImage'), 'a document does not silently select an older picture');
    const delayed = bridge.handleMessage({ ...message('正在接收的普通图片', 'group', 'team', 'alice'), attachments: [{ ...contextImage, filename: 'context-slow.png', url: quoteBase + '/context-slow.png' }], shouldAnswer: false });
    await waitFor(() => contextDownloadStarted);
    const followup = bridge.handleMessage(message('read image while its download is pending', 'group', 'team', 'bob'));
    assert.ok(!requireTrace(directory).some(item => item.method === 'turn/start' && currentText(item).includes('while its download is pending')));
    releaseContextDownload(); await Promise.all([delayed, followup]);
    const delayedTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('while its download is pending'));
    assert.ok(delayedTurn.params.input.some(item => item.type === 'localImage' && item.path.includes('context-slow.png')));
    await bridge.handleMessage({ ...message('过期的普通附件', 'group', 'team', 'alice'), attachments: [{ ...contextImage, filename: 'context-expired.png', url: quoteBase + '/context-expired.png' }], shouldAnswer: false });
    await bridge.handleMessage(message('check unavailable ordinary attachment', 'group', 'team', 'bob'));
    const unavailableTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('unavailable ordinary attachment'));
    const unavailableFile = groupContext(unavailableTurn).messages.find(item => item.files?.some(file => file.name === 'context-expired.png')).files[0];
    assert.equal(unavailableFile.path, undefined); assert.match(unavailableFile.unavailable, /410/);
    assert.ok(!unavailableTurn.params.input.some(item => item.type === 'localImage'), 'an expired latest picture is not replaced by an unrelated earlier image');
    await bridge.handleMessage({ ...message('current ordinary image', 'group', 'team'), attachments: [contextImage] });
    const currentImage = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('current ordinary image'));
    assert.equal(currentImage.params.input.filter(item => item.type === 'localImage').length, 1, 'current non-quoted images are sent as image inputs');
    config.media.enabled = false;
    await bridge.handleMessage(message('ordinary media disabled', 'group', 'team'));
    const disabledOrdinary = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('ordinary media disabled'));
    assert.ok(!disabledOrdinary.params.input.some(item => item.type === 'localImage'), 'disabled media is not reintroduced through group context');
    config.media.enabled = true;
    await bridge.handleMessage({ ...message(fullQuote, 'group', 'team', 'alice'), senderName: '原发言人', messageIndex: 'original-ref==', attachments: [quoteImage], shouldAnswer: false });
    await bridge.handleMessage({ ...message('read quoted context', 'group', 'team', 'bob'), reference: { key: 'original-ref==', text: fullQuote.slice(0, 80) } });
    const quoteTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('read quoted context'));
    const quoted = referenceContext(quoteTurn);
    assert.equal(quoted.text, fullQuote); assert.equal(quoted.senderId, 'alice'); assert.equal(quoted.senderName, '原发言人');
    assert.equal(quoted.source, 'archive'); assert.equal(quoteDownloads, 1);
    assert.equal(quoteTurn.params.input.filter(item => item.type === 'localImage').length, 1, 'quoted images reach the actual model input');
    assert.equal(await readFile(quoted.files[0].path, 'utf8'), 'quoted-image-fixture');
    assert.equal(qq.messages.at(-1).target.replyUserId, 'bob', 'a quoted sender never replaces the current reply recipient');
    const botReply = qq.messages.at(-1);
    await bridge.handleMessage({ ...message('quote bot reply', 'group', 'team', 'alice'), reference: { key: botReply.receipt.ext_info.ref_idx } });
    const replyContext = referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('quote bot reply')));
    assert.equal(replyContext.text, botReply.text); assert.equal(replyContext.isBot, true);
    await bridge.handleMessage({ ...message('quote private stream'), reference: { key: qq.streams[0].receipt.ext_info.ref_idx } });
    assert.equal(referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item) === 'quote private stream')).text, 'Codex fixture reply: hello');
    await bridge.handleMessage({ ...message('isolated quoted lookup'), reference: { key: 'original-ref==' } });
    const isolated = referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item) === 'isolated quoted lookup'));
    assert.equal(isolated.source, 'missing'); assert.equal(isolated.text, undefined, 'a reference key cannot read another conversation');
    await bridge.handleMessage({ ...message('same current and quoted image', 'group', 'team'), attachments: [quoteImage], reference: { key: 'original-ref==' } });
    const sameImage = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('same current and quoted image'));
    assert.equal(quoteDownloads, 2, 'the current attachment is downloaded once and reused for its quote');
    assert.equal(sameImage.params.input.filter(item => item.type === 'localImage').length, 1);
    await bridge.handleMessage({ ...message('nested quoted context', 'group', 'team', 'bob'), reference: {
      key: 'forwarded-context', text: '转发的对话资料', references: [{ key: 'original-ref==', text: '较短预览' }, { key: '', text: '第二条转发消息', senderId: 'bob' }],
    } });
    const nested = referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('nested quoted context')));
    assert.equal(nested.references[0].text, fullQuote); assert.equal(nested.references[1].senderId, 'bob');
    config.media.enabled = false;
    await bridge.handleMessage({ ...message('quoted media disabled', 'group', 'team'), reference: { key: 'original-ref==' } });
    const mediaDisabledTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('quoted media disabled'));
    assert.ok(!mediaDisabledTurn.params.input.some(item => item.type === 'localImage'));
    assert.match(referenceContext(mediaDisabledTurn).note, /附件接收已关闭/);
    config.media.enabled = true;
    await bridge.handleMessage({ ...message('reference with expired attachment', 'group', 'team'), reference: {
      key: 'expired-ref', text: '引用正文仍然可读', attachments: [{ ...quoteImage, url: quoteBase + '/expired.png' }],
    } });
    const expired = referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('reference with expired attachment')));
    assert.equal(expired.text, '引用正文仍然可读'); assert.match(expired.unavailable[0].reason, /410/);
    assert.equal(bridge.status().sessions.find(item => item.peerId === 'team').lastError, undefined, 'expired quoted media does not fail the current question');
    await bridge.handleMessage({ ...message('', 'group', 'team', 'bob'), envelope: '<from>\nuser: Bob\nscope: group(team)\n</from>', reference: { key: 'original-ref==' } });
    assert.ok(requireTrace(directory).some(item => item.method === 'turn/start' && currentText(item).includes('请查看引用消息。') && referenceContext(item).text === fullQuote), 'quote-only requests are not discarded');
    quoteMediaExpired = true;
    const beforeGeneratedFiles = qq.files.length;
    qq.fileDelayMs = 15;
    await bridge.handleMessage(message('send-generated-image'));
    const generated = requireTrace(directory).find((item) => item.generatedImage)?.generatedImage;
    assert.equal(generated.delivery.success, true, 'the current thread generated-image folder is allowed by the actual dynamic tool');
    assert.equal(generated.repeated.success, true);
    assert.equal(generated.vision.success, true, 'image analysis resolves the same local file references as file delivery');
    assert.equal(generated.denied.success, false);
    assert.ok(warnings.some(text => text.includes('QQ tool failed: qqbot_send_file') && text.includes('文件不在工作目录')), 'failure logs preserve the actual dynamic-tool error');
    assert.equal(qq.files.length, beforeGeneratedFiles + 1, 'the dynamic tool, sandbox alias and final Markdown link deliver the same image once');
    const deliveredImage = qq.files.at(-1);
    await bridge.handleMessage({ ...message('quote delivered bot image'), reference: { key: deliveredImage.receipt.ext_info.ref_idx } });
    const imageReplyTurn = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item) === 'quote delivered bot image');
    assert.equal(referenceContext(imageReplyTurn).isBot, true);
    assert.ok(imageReplyTurn.params.input.some(item => item.type === 'localImage' && item.path === deliveredImage.path), 'outgoing file receipts restore the original bot image');
    assert.equal(qq.messages.some(item => item.text.includes('工具执行失败：qqbot_send_file')), false, 'tool diagnostics obey the disabled QQ synchronization setting');
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: 'read-only', approvalPolicy: 'never', networkAccess: 'disabled', webSearch: 'cached' });
    await bridge.handleMessage(message('permission settings'));
    const permissionResume = requireTrace(directory).filter(item => item.method === 'thread/resume').at(-1).params;
    assert.equal(permissionResume.sandbox, 'read-only'); assert.equal(permissionResume.approvalPolicy, 'never');
    assert.equal(permissionResume.config.web_search, 'cached'); assert.equal(permissionResume.config['sandbox_workspace_write.network_access'], false);
    assert.equal(bridge.status().sessions.find(item => item.scope === 'group').settings.sandbox, '');
    const approvalsBeforeFull = qq.messages.filter(item => item.text.includes('Codex 请求确认')).length;
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: 'danger-full-access' });
    const fullRun = bridge.handleMessage(message('permission-policy-probe full'));
    await waitFor(() => bridge.broker.list().length || requireTrace(directory).some(item => item.permissionPolicyProbe));
    assert.equal(bridge.broker.list().length, 0, 'full access does not ask the QQ user for approval');
    await fullRun;
    const fullProbe = requireTrace(directory).filter(item => item.permissionPolicyProbe).at(-1).permissionPolicyProbe;
    assert.equal(fullProbe.command.decision, 'accept'); assert.equal(fullProbe.file.decision, 'accept');
    assert.equal(fullProbe.permissions.permissions.network.enabled, true); assert.equal(fullProbe.permissions.scope, 'session');
    const fullResume = requireTrace(directory).filter(item => item.method === 'thread/resume').at(-1).params;
    assert.equal(fullResume.sandbox, 'danger-full-access'); assert.equal(fullResume.approvalPolicy, 'never');
    assert.equal(fullResume.config['sandbox_workspace_write.network_access'], true);
    assert.equal(qq.messages.filter(item => item.text.includes('Codex 请求确认')).length, approvalsBeforeFull);
    const clarify = bridge.handleMessage(message('local-question'));
    await waitFor(() => bridge.broker.list().length === 1);
    bridge.submitLocal('c2c', 'alice', 'CSV'); await clarify;
    assert.ok(requireTrace(directory).some(item => item.localQuestion?.answers.choice.answers[0] === 'CSV'), 'full access retains ordinary clarification questions');
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: 'read-only', approvalPolicy: 'never', networkAccess: 'disabled' });
    await bridge.handleMessage(message('permission-policy-probe restricted'));
    const restrictedProbe = requireTrace(directory).filter(item => item.permissionPolicyProbe).at(-1).permissionPolicyProbe;
    assert.equal(restrictedProbe.command.decision, 'decline'); assert.equal(restrictedProbe.file.decision, 'decline');
    assert.deepEqual(restrictedProbe.permissions.permissions, {}, 'never does not grant permissions outside a restricted sandbox');
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', networkAccess: 'disabled' });
    await bridge.handleMessage(message('automatic reviewer settings'));
    assert.equal(requireTrace(directory).filter(item => item.method === 'thread/resume').at(-1).params.config.approvals_reviewer, 'auto_review');
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: '', approvalPolicy: '', approvalsReviewer: '', networkAccess: '', webSearch: '' });
    qq.failNextMarkdown = true; const beforeFailure = qq.messages.length;
    await bridge.handleMessage(message('transport-failure', 'group', 'team'));
    assert.equal(qq.failedSends, 1); assert.equal(qq.messages.length, beforeFailure, 'delivery failure is not recursively sent to the unavailable QQ channel');
    assert.match(bridge.status().sessions.find(item => item.scope === 'group').lastError, /QQ 消息发送失败/);
    assert.equal(qq.files.at(-1).path, await realpath(generated.file));
    const privatePaths = bridge.status().sessions.find((item) => item.peerId === 'alice').storage;
    assert.ok(qq.files.at(-1).path.startsWith(privatePaths.files), 'generated images physically live in the conversation archive');
    const archived = JSON.parse(await readFile(join(privatePaths.history, first + '.json'), 'utf8'));
    assert.ok(archived.messages.some(item => item.text === 'personal role'));
    assert.ok((await readFile(join(privatePaths.history, first + '.md'), 'utf8')).includes('personal role'));
    assert.ok(!JSON.stringify(archived.messages).includes('[QQ Bot 本轮文件目录]'));
    const otherRoot = client.generatedImageDirectory(groupThread);
    await mkdir(otherRoot, { recursive: true }); const otherImage = join(otherRoot, 'other.png'); await writeFile(otherImage, 'unrelated group image');
    await assert.rejects(bridge.sendFile(message('').target, otherImage), /工作目录|其他 QQ 会话/, 'another conversation generated folder is not implicitly allowed even when archives are inside the workspace');
    const protocol = (await readFile(join(directory, 'protocol.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(protocol.find((item) => item.launch).launch.includes('plugins.codex-qqbot@qqbot-local.enabled=false'));
    assert.ok(protocol.some((item) => item.question?.answers.choice.answers[0] === 'CSV'));
    assert.ok(protocol.some((item) => Number.isInteger(item.clock?.currentTimeAt)));
    assert.ok(protocol.some((item) => item.vision?.success && item.vision.contentItems[0].text.includes('vision-fixture')));
    const starts = protocol.filter((item) => ['thread/start', 'thread/resume'].includes(item.method));
    const personal = starts.find((item) => item.params.developerInstructions.includes('alice-exclusive-role'));
    const group = starts.find((item) => item.params.developerInstructions.includes('group-exclusive-role'));
    assert.ok(personal && group);
    assert.doesNotMatch(personal.params.developerInstructions, /default-private-role|group-exclusive-role/);
    assert.doesNotMatch(group.params.developerInstructions, /default-group-role|alice-exclusive-role/);
    for (const { params } of starts) {
      assert.match(params.baseInstructions, /You are QQ Bot/);
      assert.equal(params.config.project_doc_max_bytes, 0);
      assert.equal(params.config['memories.use_memories'], false);
      assert.equal(params.config.personality, 'none');
      assert.equal(params.config.developer_instructions, params.developerInstructions);
      if (params.sandbox === 'workspace-write') assert.ok(params.config['sandbox_workspace_write.writable_roots'].some(root => root.includes('files')), 'the conversation output folder is writable without changing the task workspace');
    }
    const beforeExternalFiles = qq.files.length;
    await bridge.handleMessage(message('send-external-file restricted'));
    assert.equal(requireTrace(directory).filter(item => item.externalFile).at(-1).externalFile.delivery.success, false, 'restricted sessions cannot import files outside their send roots');
    assert.equal(qq.files.length, beforeExternalFiles);
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: 'danger-full-access' });
    await bridge.handleMessage(message('send-external-file full'));
    const external = requireTrace(directory).filter(item => item.externalFile).at(-1).externalFile;
    assert.equal(external.delivery.success, true); assert.equal(external.repeated.success, true);
    assert.equal(qq.files.length, beforeExternalFiles + 1, 'the staged file, URL alias and final link are delivered once');
    const imported = qq.files.at(-1);
    assert.equal(imported.fileName, 'external-song.mp3');
    assert.equal(imported.sendAs, 'file', 'the dynamic file-mode option reaches the transport');
    assert.ok(imported.path.startsWith(privatePaths.files));
    assert.notEqual(imported.path, external.file);
    assert.equal(await readFile(imported.path, 'utf8'), await readFile(external.file, 'utf8'));
    const fileStore = new ConfigStore(directory); fileStore.update(config);
    const fileViewer = new BotController(fileStore, quiet); fileViewer.bridge = bridge;
    const importedHistory = await fileViewer.conversation('c2c', 'alice');
    assert.ok(importedHistory.messages.flatMap(item => item.files || []).some(file => file.path === imported.path && !file.image), 'history records the staged file path rather than its external source');
    assert.equal(config.sendFile.restrictPaths, true, 'full access does not disable the send-root setting');
    await bridge.handleMessage(message('send-external-file voice'));
    assert.equal(qq.files.length, beforeExternalFiles + 2, 'a final link does not resend an explicitly delivered voice message as a file');
    assert.equal(qq.files.at(-1).sendAs, 'voice');
    await assert.rejects(bridge.sendFile(message('').target, otherImage), /其他 QQ 会话/, 'full access still isolates other conversations');
    await bridge.manageSession('c2c', 'alice', 'configure', { sandbox: '', approvalPolicy: '', approvalsReviewer: '', networkAccess: '' });
    const beforeFileImage = qq.files.length;
    const fileImageRun = bridge.handleMessage(message('send-generated-image file hold-file-card'));
    await waitFor(() => bridge.broker.list().some(item => item.text.includes('确认文件卡片')));
    assert.equal(qq.files.length, beforeFileImage + 1, 'parallel aliases and the final link deliver one original image file');
    assert.equal(qq.files.at(-1).sendAs, 'file');
    const imageHistory = await fileViewer.conversation('c2c', 'alice');
    assert.ok(imageHistory.activeTurnId, 'the attachment is checked while its turn is still active');
    assert.equal(imageHistory.messages.flatMap(item => item.files || []).filter(file => file.name === 'fixture100%.png').at(-1).image, false, 'an image sent as a file stays a file card during live updates');
    bridge.submitLocal('c2c', 'alice', '继续'); await fileImageRun;
    config.sendFile.maxFiles = 1;
    const beforeParallel = qq.files.length;
    await bridge.handleMessage(message('send-parallel-files'));
    const parallel = requireTrace(directory).find(item => item.parallelFiles).parallelFiles;
    assert.equal(parallel[0].success, true); assert.equal(parallel[1].success, true);
    assert.equal(parallel[2].success, false); assert.match(parallel[2].contentItems[0].text, /数量上限/);
    assert.equal(qq.files.length, beforeParallel + 1, 'parallel distinct files cannot exceed the per-turn quota');
    config.sendFile.maxFiles = 4; qq.fileDelayMs = 0;
    const hanging = bridge.handleMessage(message('hang'));
    await waitFor(() => bridge.status().sessions.find((item) => item.threadId === first)?.busy);
    await bridge.manageSession('c2c', 'alice', 'rename', { name: '我的工作助手' });
    assert.equal(bridge.status().sessions.find((item) => item.threadId === first).name, '我的工作助手');
    assert.equal(bridge.status().sessions.find((item) => item.threadId === first).busy, true, 'rename does not interrupt an active task');
    await assert.rejects(bridge.manageSession('c2c', 'alice', 'configure', { prompt: 'must-not-save' }), /等待/);
    await bridge.handleMessage(message('/stop'));
    await hanging;
    assert.equal(bridge.status().sessions.find((item) => item.threadId === first).busy, false);
    await bridge.handleMessage(message('/model fixture-model'));
    await bridge.handleMessage(message('/effort high'));
    await bridge.handleMessage(message('/compact'));
    assert.ok(qq.messages.some((item) => item.text === '会话压缩完成。'));
    await bridge.handleMessage(message('/preset coding'));
    await bridge.handleMessage(message('/new'));
    await bridge.handleMessage(message('preset task'));
    const updated = (await readFile(join(directory, 'protocol.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(updated.some((item) => item.method === 'thread/start' && item.params.developerInstructions.includes('alice-exclusive-role') && !item.params.developerInstructions.includes('preset-fixture-prompt')));
    assert.ok(updated.some((item) => item.method === 'turn/start' && item.params.input.some((input) => input.type === 'skill' && input.name === 'fixture-skill')));
    await bridge.manageSession('c2c', 'alice', 'configure', { prompt: null });
    await bridge.handleMessage(message('default role'));
    assert.ok(requireTrace(directory).some((item) => item.method === 'thread/start' && item.params.developerInstructions.includes('preset-fixture-prompt') && item.params.developerInstructions.includes('default-private-role')));
    await bridge.manageSession('c2c', 'alice', 'configure', { prompt: 'alice-exclusive-role' });
    await bridge.handleMessage(message('restore private role'));
    const viewerStore = new ConfigStore(directory); viewerStore.update(config);
    const viewer = new BotController(viewerStore, quiet); viewer.bridge = bridge;
    const preview = bridge.handleMessage(message('reasoning-ui-probe'));
    await waitFor(() => bridge.broker.list().some(item => item.text.includes('公开摘要预览')));
    const live = await viewer.conversation('c2c', 'alice');
    const liveReasoning = live.activities.find(item => item.kind === 'reasoning');
    assert.equal(liveReasoning.detail, '**整理需求**\n\n先检查会话输入。\n\n**核对进度**\n\n保留公开摘要与执行顺序。');
    assert.equal(liveReasoning.status, 'running');
    const comment = live.messages.find(item => item.phase === 'commentary' && item.text.includes('已确认需求'));
    const command = live.activities.find(item => item.id.startsWith('stream-command-'));
    assert.equal(command.detail, 'Get-Date\nfixture working\n', 'command output is available before the tool completes');
    assert.equal(live.activities.find(item => item.kind === 'plan').detail, '1. 核对摘要\n2. 整理结果');
    assert.ok(liveReasoning.order < comment.order && comment.order < command.order, 'live activity and progress retain native item order');
    assert.doesNotMatch(JSON.stringify(live), /must-not-display/, 'raw reasoning and stale-turn deltas are excluded from the conversation API');
    assert.equal(requireTrace(directory).filter(item => item.method === 'turn/start').at(-1).params.summary, 'auto');
    bridge.submitLocal('c2c', 'alice', '继续'); await preview;
    const completed = await viewer.conversation('c2c', 'alice');
    const summary = completed.activities.find(item => item.id === liveReasoning.id);
    assert.equal(summary.status, 'completed');
    assert.equal(summary.detail, '**核对完成**\n\n已检查会话输入，确认执行结果。\n\n**整理结果**\n\n将公开摘要与最终答复分开显示。', 'completed summary replaces streamed partial text without duplication');
    assert.equal(completed.activities.find(item => item.id === command.id).detail, 'Get-Date\nfixture working\nfixture done\n');
    assert.doesNotMatch(JSON.stringify(completed), /must-not-display/);
    assert.ok(qq.messages.every(item => !item.text.includes('核对完成')) && qq.streams.every(item => item.updates.every(text => !text.includes('核对完成'))), 'reasoning summaries remain in the local UI rather than becoming QQ replies');
  } finally { await bridge.close(); }
  const oldSessions = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
  oldSessions['fixture-app:group:history-team'] = { ...oldSessions['fixture-app:group:team'], threadId: 'existing-group-thread' };
  await writeFile(join(directory, 'sessions.json'), JSON.stringify(oldSessions));
  const oldHistory = JSON.parse(await readFile(join(directory, 'thread-history.json'), 'utf8'));
  const seedText = '旧群聊完整资料-' + '历史正文'.repeat(80) + '-旧资料末尾';
  const originalGroupInput = currentText(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('member A question')));
  oldHistory['existing-group-thread'] = [{ id: 'existing-group-turn', status: 'completed', items: [
    { id: 'existing-group-user', type: 'userMessage', content: [{ type: 'text', text: originalGroupInput.replace('member A question', seedText) }] },
    { id: 'existing-group-answer', type: 'agentMessage', phase: 'final_answer', text: '旧群聊中的机器人答复' },
  ] }];
  await writeFile(join(directory, 'thread-history.json'), JSON.stringify(oldHistory));
  config.access.groupAllow.push('history-team');
  const second = new QQBridge(config, directory, new FakeQQ(), new CodexClient(config, quiet), quiet);
  await second.start();
  try {
    await second.handleMessage(message('continue existing group', 'group', 'history-team'));
    const backfilled = groupContext(requireTrace(directory).filter(item => item.method === 'turn/start' && currentText(item).includes('continue existing group')).at(-1));
    assert.ok(backfilled.messages.some(item => item.text === seedText && item.senderId === 'alice'), 'existing native group history is backfilled with complete text and sender identity');
    assert.ok(backfilled.messages.some(item => item.role === 'assistant' && item.text === '旧群聊中的机器人答复'));
    assert.equal(second.status().sessions.find(item => item.peerId === 'history-team').threadId, 'existing-group-thread', 'backfill preserves the existing AI thread');
    await second.handleMessage(message('restart group recall', 'group', 'team', 'bob'));
    const resumedGroup = groupContext(requireTrace(directory).filter(item => item.method === 'turn/start' && currentText(item).includes('restart group recall')).at(-1));
    assert.ok(resumedGroup.messages.some(item => item.text.includes('reference with expired attachment')), 'group context survives a background restart');
    const beforeRestartQuote = quoteDownloads;
    await second.handleMessage({ ...message('quote after restart', 'group', 'team', 'bob'), reference: { key: 'original-ref==' } });
    const restoredQuote = referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('quote after restart')));
    assert.equal(restoredQuote.text, fullQuote); assert.equal(restoredQuote.source, 'archive');
    assert.equal(restoredQuote.files.length, 1); assert.equal(quoteDownloads, beforeRestartQuote, 'persisted files survive expired remote URLs');
    await appendFile(join(second.storage.paths(message('', 'group', 'team').target).directory, 'group-messages.jsonl'), JSON.stringify({
      type: 'message', id: 'qq:legacy-quote-id', role: 'user', senderId: 'alice', senderName: 'Alice', text: '旧群存档里的引用原文',
    }) + '\n');
    await second.handleMessage({ ...message('quote legacy archive', 'group', 'team'), reference: { key: 'legacy-quote-id' } });
    const legacyQuote = referenceContext(requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('quote legacy archive')));
    assert.equal(legacyQuote.text, '旧群存档里的引用原文'); assert.equal(legacyQuote.senderId, 'alice');
    contextMediaExpired = true;
    const beforeOrdinaryRedelivery = contextDownloads;
    await second.handleMessage(passiveContextImage);
    await second.handleMessage(message('ordinary media after restart', 'group', 'team', 'bob'));
    const restartMedia = requireTrace(directory).find(item => item.method === 'turn/start' && currentText(item).includes('ordinary media after restart'));
    assert.ok(restartMedia);
    const restartState = JSON.parse(await readFile(join(second.storage.paths(passiveContextImage.target).directory, 'context.json'), 'utf8'));
    const restartFile = restartState.entries.find(item => item.id === passiveContextImage.contextId).files[0];
    assert.equal(await readFile(restartFile.path, 'utf8'), 'ordinary context file');
    assert.equal(contextDownloads, beforeOrdinaryRedelivery, 'a restarted process retains cached files when the ordinary message is redelivered with an expired URL');
    await second.handleMessage(message('resume'));
    assert.equal(second.status().sessions.find((item) => item.peerId === 'alice').name, '我的工作助手', 'the name survives service restart and new contexts');
    assert.equal(second.status().sessions.find((item) => item.peerId === 'alice').storage.directory, join(directory, 'storage', 'bot-fixture-app', 'private', 'peer-alice'), 'renaming and resetting context keep the storage directory');
    assert.equal(second.status().sessions.find((item) => item.peerId === 'alice').prompt, 'alice-exclusive-role');
    assert.equal(second.status().sessions[0].threadId, JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'))['fixture-app:c2c:alice'].threadId);
    const protocol = (await readFile(join(directory, 'protocol.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(protocol.some((item) => item.method === 'thread/resume'));
    assert.ok(protocol.some((item) => item.method === 'turn/start' && item.params.effort === 'high'));
    const privateResume = protocol.filter(item => item.method === 'turn/start' && currentText(item) === 'resume').at(-1);
    assert.ok(!privateResume.params.input.some(input => input.text?.startsWith('[QQ Bot 群聊上下文：')), 'private chats never receive group context');
    await second.handleMessage(message('/new', 'group', 'team'));
    await second.handleMessage(message('fresh group context', 'group', 'team'));
    const resetGroup = groupContext(requireTrace(directory).filter(item => item.method === 'turn/start' && currentText(item).includes('fresh group context')).at(-1));
    assert.deepEqual(resetGroup.messages, [], 'an explicit group reset does not silently restore old context');
  } finally { await second.close(); }
  const cancel = new AbortController();
  const analysis = describeImage(config, quiet, join(directory, 'report.png'), 'hang', cancel.signal);
  const rejected = assert.rejects(analysis, /取消|exited|退出|Server/);
  await waitFor(() => {
    try { return requireTrace(directory).some((item) => item.method === 'turn/start' && item.params.input?.some((input) => input.text === 'hang') && item.params.input.some((input) => input.type === 'localImage')); }
    catch { return false; }
  });
  cancel.abort(); await rejected;
});

test('Active QQ tasks survive global settings saves, preserve queued messages and archive before shutdown', { timeout: 10000 }, async () => {
  const directory = await temp();
  const store = new ConfigStore(directory);
  const config = store.update({ appId: 'settings-fixture', appSecret: 'fixture-secret', cwd: directory, streaming: false,
    codexCommand: fixture, codexArgs: [directory], access: { c2cMode: 'open', groupMode: 'open' } });
  const warnings = [], errors = [];
  const logger = { ...quiet, warn: text => warnings.push(text), error: text => errors.push(text) };
  const qq = new FakeQQ();
  const client = new CodexClient(config, logger);
  const bridge = new QQBridge(config, directory, qq, client, logger);
  const controller = new BotController(store, logger);
  await bridge.start();
  // Use the real controller and native JSONL child with a local QQ transport.
  controller.bridge = bridge; controller.connected = true;
  try {
    const first = bridge.handleMessage(message('local-question settings-save', 'group', 'team'));
    await waitFor(() => bridge.status().pending.length === 1);
    const before = bridge.status().sessions[0];
    const second = bridge.handleMessage(message('queued settings message', 'group', 'team', 'bob'));
    await waitFor(() => bridge.status().sessions[0].queued === 2);
    const state = await controller.configure({ ...store.publicConfig(), model: 'fixture-model', sandbox: 'danger-full-access' });
    assert.equal(state.sessions[0].threadId, before.threadId);
    assert.equal(state.sessions[0].busy, true);
    assert.equal(state.sessions[0].queued, 2);
    assert.equal(state.pending.length, 1, 'an ordinary clarification remains answerable after changing permissions');
    assert.equal(state.config.approvalPolicy, 'never');
    assert.equal(qq.closed, undefined, 'saving permissions must not disconnect QQ');
    await assert.rejects(controller.configure({ requireMention: false }), /等待当前任务/);
    assert.equal(store.read().requireMention, true, 'a connection change is rejected before writing the configuration');
    await controller.configure({ ...store.publicConfig() });
    const pending = bridge.status().pending[0];
    await bridge.handleMessage(message(`/answer ${pending.token} 1`, 'group', 'team'));
    await Promise.all([first, second]);
    assert.equal(qq.messages.filter(item => item.text.startsWith('Codex fixture reply:')).length, 2);
    const trace = requireTrace(directory);
    assert.equal(trace.filter(item => item.launch).length, 1, 'the running Codex child is retained');
    assert.equal(trace.filter(item => item.method === 'turn/interrupt').length, 0);
    const resumed = trace.filter(item => item.method === 'thread/resume').at(-1);
    assert.equal(resumed.params.threadId, before.threadId);
    assert.equal(resumed.params.model, 'fixture-model');
    assert.equal(resumed.params.sandbox, 'danger-full-access');
    assert.equal(resumed.params.approvalPolicy, 'never');
    assert.equal(resumed.params.excludeTurns, true, 'conversation history uses its existing paginated read path');
    const effective = trace.filter(item => item.effectiveTurn).map(item => item.effectiveTurn);
    assert.equal(effective[0].sandbox, 'workspace-write', 'a settings save leaves the active turn on its original execution scope');
    assert.equal(effective[1].model, 'fixture-model');
    assert.equal(effective[1].sandbox, 'danger-full-access', 'the queued turn uses the new configuration rather than a subscribed cached thread');
    assert.equal(effective[1].approvalPolicy, 'never');
    assert.ok(!trace.some(item => item.ignoredResumeOverrides), 'the next turn is not a rejoin with ignored configuration changes');
    await controller.configure({ sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    const approvalTask = bridge.handleMessage(message('permission-policy-probe pending approval', 'group', 'team'));
    await waitFor(() => bridge.status().pending.some(item => item.kind === 'approval'));
    await controller.configure({ sandbox: 'danger-full-access' });
    await approvalTask;
    assert.equal(bridge.status().pending.length, 0, 'full access resolves existing approval requests');
    const approved = requireTrace(directory).filter(item => item.permissionPolicyProbe).at(-1).permissionPolicyProbe;
    assert.equal(approved.command.decision, 'accept'); assert.equal(approved.file.decision, 'accept');
    assert.equal(approved.permissions.scope, 'session');
    const fileBytes = Buffer.alloc(700000, 0x41);
    const upload = { scope: 'group', target_id: 'team', action: 'upload', upload_id: '11111111-1111-4111-8111-111111111111', file_name: '我的附件.txt', file_size: fileBytes.length };
    let uploaded;
    for (let offset = 0; offset < fileBytes.length; offset += 256 * 1024) {
      uploaded = await controller.invoke('session', { ...upload, offset, data: fileBytes.subarray(offset, offset + 256 * 1024).toString('base64') });
      assert.equal(uploaded.received, Math.min(offset + 256 * 1024, fileBytes.length));
      if (offset === 0) await assert.rejects(controller.invoke('session', { ...upload, offset: 1, data: 'QQ==' }), /上传位置不一致/);
    }
    assert.deepEqual(await readFile(uploaded.file_path), fileBytes);
    assert.ok(uploaded.file_path.includes(join('files', 'direct')));
    assert.ok(uploaded.file_path.endsWith('我的附件.txt'));
    await assert.rejects(controller.invoke('session', { ...upload, target_id: 'unknown', offset: 0, data: 'QQ==' }), /已有的 QQ 会话/);
    await assert.rejects(controller.invoke('session', { ...upload, file_size: 0, offset: 0, data: 'QQ==' }), /非空/);
    await assert.rejects(controller.invoke('session', { ...upload, file_size: 30 * 1024 * 1024, offset: 0, data: 'QQ==' }), /不超过/);
    await assert.rejects(controller.invoke('session', { ...upload, offset: 0, data: Buffer.alloc(300000).toString('base64') }), /无效的文件分片/);
    const turnsBeforeFile = requireTrace(directory).filter(item => item.method === 'turn/start').length;
    assert.equal((await controller.invoke('session', { scope: 'group', target_id: 'team', action: 'sendFile', file_path: uploaded.file_path })).sent, true);
    assert.equal(qq.files.at(-1).fileName, '我的附件.txt');
    assert.equal(requireTrace(directory).filter(item => item.method === 'turn/start').length, turnsBeforeFile, 'direct files do not start an AI turn');
    await assert.rejects(controller.invoke('session', { scope: 'c2c', target_id: 'alice', action: 'sendFile', file_path: uploaded.file_path }), /其他 QQ 会话/);
    const shutdownTask = bridge.handleMessage(message('hang shutdown task', 'group', 'team'));
    await waitFor(() => bridge.status().sessions[0].busy);
    await controller.stop();
    await shutdownTask;
    const archive = JSON.parse(await readFile(join(before.storage.history, before.threadId + '.json'), 'utf8'));
    assert.ok(archive.messages.some(item => item.text === 'hang shutdown task'));
    assert.deepEqual(warnings, [], 'shutdown finishes archives while the Codex connection is still writable');
    assert.deepEqual(errors, [], 'an explicit shutdown is not reported as message processing failure');
    await assert.rejects(client.call('thread/turns/list', { threadId: before.threadId }), /未启动或已关闭/);
  } finally { await controller.dispose(); }
});

test('Context reset and compaction report progress, retain settings and recover after failure or cancellation', { timeout: 10000 }, async () => {
  const directory = await temp();
  const store = new ConfigStore(directory);
  const config = store.update({ appId: 'context-fixture', appSecret: 'fixture-secret', cwd: directory, streaming: false,
    codexCommand: fixture, codexArgs: [directory], access: { c2cMode: 'open', groupMode: 'open' }, autoCompact: false, autoCompactThreshold: 10 });
  assert.equal('autoCompact' in config, false, 'retired plugin controls cannot disable native automatic compaction');
  assert.equal('autoCompactThreshold' in JSON.parse(await readFile(store.path, 'utf8')), false);
  const qq = new FakeQQ();
  const bridge = new QQBridge(config, directory, qq, new CodexClient(config, quiet), quiet);
  const controller = new BotController(store, quiet);
  await bridge.start(); controller.bridge = bridge; controller.connected = true;
  const current = () => bridge.status().sessions.find(item => item.peerId === 'team');
  const group = text => message(text, 'group', 'team');
  const control = value => writeFile(join(directory, 'compaction.json'), JSON.stringify(value));
  const waitOperation = async () => { await waitFor(() => current().contextOperation?.status !== 'running'); return current().contextOperation; };
  try {
    await bridge.handleMessage(group('original group history'));
    await bridge.manageSession('group', 'team', 'rename', { name: '群聊名称' });
    await bridge.manageSession('group', 'team', 'configure', { prompt: 'exclusive-role', model: 'fixture-model', sandbox: 'danger-full-access' });
    await bridge.handleMessage(group('history with saved settings'));
    const before = current();
    await control({ delayMs: 80 });
    const accepted = await controller.session('group', 'team', 'compact');
    assert.equal(accepted.sessions.find(item => item.peerId === 'team').contextOperation.status, 'running');
    await assert.rejects(bridge.manageSession('group', 'team', 'compact'), /正在进行/);
    const queued = bridge.handleMessage(group('message queued during compaction'));
    await queued;
    assert.equal((await waitOperation()).status, 'completed');
    assert.equal(current().threadId, before.threadId);
    assert.ok(qq.messages.some(item => item.text.includes('message queued during compaction')));
    await control({ status: 'failed' });
    await controller.session('group', 'team', 'compact');
    assert.equal((await waitOperation()).status, 'failed');
    assert.match(current().contextOperation.message, /fixture compaction failed/);
    await bridge.handleMessage(group('message after failed compaction'));
    assert.ok(qq.messages.at(-1).text.includes('message after failed compaction'), 'a failed compaction must not poison the message queue');
    await control({ status: 'hang' });
    await controller.session('group', 'team', 'compact');
    await waitFor(() => current().busy);
    await controller.session('group', 'team', 'stop');
    assert.equal(current().contextOperation.status, 'cancelled');
    await bridge.handleMessage(group('message after cancelled compaction'));
    assert.ok(qq.messages.at(-1).text.includes('message after cancelled compaction'));
    config.processingTimeoutMs = 60;
    await controller.session('group', 'team', 'compact');
    assert.equal((await waitOperation()).status, 'failed');
    assert.match(current().contextOperation.message, /压缩超时/);
    config.processingTimeoutMs = 1800000;
    await control({ resetDelayMs: 60 });
    const hanging = bridge.handleMessage(group('hang old context'));
    await waitFor(() => current().busy);
    const discarded = bridge.handleMessage(group('discard queued old context'));
    const resetting = await controller.session('group', 'team', 'reset');
    assert.equal(resetting.sessions.find(item => item.peerId === 'team').contextOperation.status, 'running');
    await bridge.handleMessage({ ...group('passive message after reset request'), shouldAnswer: false });
    const after = bridge.handleMessage(group('new message after reset request'));
    await Promise.all([hanging, discarded, after]);
    assert.equal((await waitOperation()).status, 'completed');
    assert.notEqual(current().threadId, before.threadId);
    assert.equal(current().previousThreadId, before.threadId);
    assert.deepEqual(current().settings, before.settings);
    assert.equal(current().name, '群聊名称');
    const turn = requireTrace(directory).filter(item => item.method === 'turn/start').at(-1);
    assert.ok(currentText(turn).includes('new message after reset request'));
    assert.deepEqual(groupContext(turn).messages.map(item => item.text), ['passive message after reset request']);
    assert.ok(!requireTrace(directory).some(item => item.method === 'turn/start' && currentText(item).includes('discard queued old context')));
    const archived = JSON.parse(await readFile(join(before.storage.history, before.threadId + '.json'), 'utf8'));
    assert.ok(archived.messages.some(item => item.text === 'history with saved settings'));
    const empty = await controller.session('c2c', 'empty-peer', 'compact');
    assert.equal(empty.sessions.find(item => item.peerId === 'empty-peer').threadId, undefined);
    await waitFor(() => bridge.status().sessions.find(item => item.peerId === 'empty-peer').contextOperation.status === 'completed');
    const usageControl = value => writeFile(join(directory, 'context-usage.json'), JSON.stringify(value));
    await assert.rejects(bridge.manageSession('group', 'team', 'configure', { autoCompact: false }));
    await assert.rejects(bridge.manageSession('group', 'team', 'configure', { autoCompactThreshold: 70 }));
    await usageControl({ usedTokens: 90000, windowTokens: 100000 });
    await bridge.handleMessage(group('fill context to ninety percent'));
    assert.equal(current().contextUsage.usedTokens, 90000, 'context uses the last request, not cumulative billed tokens');
    assert.equal(current().contextUsage.windowTokens, 100000);
    const originalThread = current().threadId;
    const compactCount = () => requireTrace(directory).filter(item => item.method === 'thread/compact/start').length;
    const beforeAuto = compactCount();
    await bridge.handleMessage(group('high usage alone must not trigger plugin compaction'));
    assert.equal(compactCount(), beforeAuto, 'Codex decides whether and when automatic compaction runs');
    await control({ delayMs: 60 }); await usageControl({ usedTokens: 2000, windowTokens: 100000 });
    const automatic = bridge.handleMessage(group('native-auto-compact during the reply'));
    await waitFor(() => current().contextOperation?.automatic && current().contextOperation.status === 'running');
    await automatic;
    assert.equal(compactCount(), beforeAuto, 'native progress events never cause a second manual compaction request');
    assert.equal(current().threadId, originalThread);
    assert.equal(current().contextOperation.status, 'completed');
    assert.equal(current().contextUsage.usedTokens, 2000);
    assert.equal(current().contextUsage.stale, undefined, 'the next model response supplies a new measurement');
    assert.deepEqual(current().contextSettings, { contextWindow: 0 });
    assert.equal('autoCompact' in current().settings, false);
    await control({ status: 'failed' }); await usageControl({ usedTokens: 3000, windowTokens: 100000 });
    await bridge.handleMessage(group('native-auto-compact failed in Codex'));
    assert.equal(current().contextOperation.status, 'failed');
    assert.match(current().contextOperation.message, /fixture native compaction failed/);
    await bridge.handleMessage(group('continue after failed native compaction'));
    assert.ok(qq.messages.at(-1).text.includes('continue after failed native compaction'));
    await control({ status: 'hang' });
    const nativePending = bridge.handleMessage(group('native-auto-compact interrupted by user'));
    await waitFor(() => current().contextOperation?.automatic && current().contextOperation.status === 'running');
    await controller.session('group', 'team', 'stop'); await nativePending;
    assert.equal(current().contextOperation.status, 'cancelled');
    await bridge.handleMessage(group('continue after cancelled native compaction'));
    assert.ok(qq.messages.at(-1).text.includes('continue after cancelled native compaction'));
    assert.equal(compactCount(), beforeAuto);
    const selectedThread = current().threadId;
    const nextContextConfig = { ...config, contextWindow: 128000 };
    assert.equal(bridge.requiresRestart(nextContextConfig), false, 'global context length applies without reconnecting QQ');
    store.update({ contextWindow: 128000 }); bridge.applyThreadSettings(nextContextConfig);
    const lastResume = () => requireTrace(directory).filter(item => item.method === 'thread/resume' && item.params.threadId === selectedThread).at(-1).params;
    await usageControl({ usedTokens: 3000 });
    await bridge.handleMessage(group('inherit the global context length'));
    assert.equal(lastResume().config.model_context_window, 128000);
    for (const key of ['model_auto_compact_token_limit', 'model_post_turn_compact_threshold_percent', 'async_compaction_threshold_percent']) {
      assert.equal(key in lastResume().config, false, 'native compaction policy inherits Codex configuration');
    }
    assert.equal(current().contextUsage.windowTokens, 128000);
    await bridge.manageSession('group', 'team', 'configure', { contextWindow: 64000 });
    assert.equal(current().contextUsage.stale, true, 'old capacity statistics are stale until the next response');
    await bridge.handleMessage(group('use an independent context length'));
    assert.equal(lastResume().config.model_context_window, 64000);
    assert.equal(current().contextUsage.windowTokens, 64000);
    await bridge.handleMessage(message('another group inherits globally', 'group', 'other-team'));
    const otherThread = bridge.status().sessions.find(item => item.peerId === 'other-team').threadId;
    assert.equal(requireTrace(directory).filter(item => item.method === 'thread/start').at(-1).params.config.model_context_window, 128000);
    store.update({ contextWindow: 256000 }); bridge.applyThreadSettings({ ...config, contextWindow: 256000 });
    assert.equal(current().contextSettings.contextWindow, 64000, 'a session override survives global changes');
    await bridge.handleMessage(message('updated inherited context length', 'group', 'other-team'));
    assert.equal(requireTrace(directory).filter(item => item.method === 'thread/resume' && item.params.threadId === otherThread).at(-1).params.config.model_context_window, 256000);
    await bridge.manageSession('group', 'team', 'configure', { contextWindow: 0 });
    await bridge.handleMessage(group('explicit model default despite a global override'));
    assert.equal('model_context_window' in lastResume().config, false);
    assert.equal(current().contextUsage.windowTokens, 100000);
    await bridge.manageSession('group', 'team', 'configure', { contextWindow: null });
    await bridge.handleMessage(group('restore global context inheritance'));
    assert.equal(lastResume().config.model_context_window, 256000);
    assert.equal(current().threadId, selectedThread, 'context length changes preserve the conversation');
    await assert.rejects(bridge.manageSession('group', 'team', 'configure', { contextWindow: -1 }));
    await assert.rejects(bridge.manageSession('group', 'team', 'configure', { contextWindow: 1.5 }));
    assert.throws(() => store.update({ contextWindow: -1 }));
    store.update({ contextWindow: 0 }); bridge.applyThreadSettings({ ...config, contextWindow: 0 });
    await usageControl({ usedTokens: 3000, windowTokens: 100000 });
    await bridge.handleMessage(group('continue with model defaults and retained context'));
    const saved = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'));
    assert.equal(saved['context-fixture:group:team'].contextWindow, null);
    assert.equal(saved['context-fixture:group:team'].contextUsage.usedTokens, 3000);
    await controller.stop();
    delete saved['context-fixture:group:team'].contextUsage;
    saved['context-fixture:group:team'].autoCompact = false;
    saved['context-fixture:group:team'].autoCompactThreshold = 10;
    await writeFile(join(directory, 'sessions.json'), JSON.stringify(saved));
    const migrated = new SessionStore(directory).get('context-fixture:group:team');
    assert.equal('autoCompact' in migrated, false);
    assert.equal('autoCompactThreshold' in migrated, false);
    assert.equal(migrated.threadId, selectedThread, 'retiring plugin compaction settings keeps the same native thread');
    assert.equal(migrated.prompt, 'exclusive-role');
    assert.equal('autoCompact' in JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'))['context-fixture:group:team'], false);
    const restored = new QQBridge(config, directory, new FakeQQ(), new CodexClient(config, quiet), quiet);
    try {
      await restored.start();
      assert.equal(restored.status().sessions.find(item => item.peerId === 'team').contextUsage.usedTokens, 3000, 'existing native rollout usage can be restored without a new model call');
    } finally { await restored.close(); }
  } finally { await controller.dispose(); }
});

test('Pending QQ interactions are scoped to the request owner, peer and lifetime', { timeout: 5000 }, async () => {
  const qq = new FakeQQ();
  const broker = new InteractionBroker(qq, 30);
  const target = message('').target;
  const answer = broker.ask({ requestId: 1, threadId: 'thread-a', target, senderId: 'alice', text: 'Confirm command', options: ['Allow', 'Deny'] });
  const data = qq.messages.at(-1).opts.keyboard.content.rows[0].buttons[0].action.data;
  assert.equal(broker.interaction({ target: { scope: 'group', targetId: 'other' }, senderId: 'alice', data }), false);
  assert.equal(await answer, null, 'timeout grants nothing');
  assert.equal(broker.interaction({ target, senderId: 'alice', data }), false);
  const next = broker.ask({ requestId: 2, threadId: 'thread-a', target, senderId: 'alice', text: 'Which name?', options: [], freeText: true });
  assert.equal(broker.text(message('Custom answer')), true);
  assert.equal(await next, 'Custom answer');
  const multiple = broker.ask({ requestId: 3, threadId: 'thread-a', target, senderId: 'alice', text: 'Choose several', options: ['A', 'B', 'C'], multiple: true });
  assert.equal(broker.text(message('1,3')), true);
  assert.deepEqual(JSON.parse(await multiple), ['A', 'C']);
  const local = broker.ask({ requestId: 4, threadId: 'thread-a', target, senderId: 'qqbot-local-ui', text: 'Local approval', options: ['Allow', 'Deny'] });
  assert.equal(broker.localText({ scope: 'group', targetId: 'other' }, '1'), false);
  assert.equal(broker.localText(target, '1'), true);
  assert.equal(await local, 'Allow');
  const question = broker.ask({ requestId: 5, threadId: 'thread-a', target, senderId: 'alice', text: 'Name?', options: [], freeText: true, kind: 'question' });
  const approval = broker.ask({ requestId: 6, threadId: 'thread-a', target, senderId: 'alice', text: 'Approval?', options: ['允许一次', '拒绝'], kind: 'approval' });
  broker.settleApprovals('thread-a', true);
  assert.equal(await approval, '允许一次');
  assert.equal(broker.list().length, 1, 'permission changes do not answer ordinary questions');
  assert.equal(broker.text(message('/preset coding')), false, 'preset commands are not consumed as a free-text answer');
  assert.equal(broker.text(message('/newspaper title')), true, 'only exact command names bypass the pending question');
  assert.equal(await question, '/newspaper title');
  broker.close();
});

test('Passive replies honor private/group windows and quotas without reviving expired message IDs', (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  for (const scope of ['c2c', 'group']) {
    const target = { scope, targetId: 'quota-' + scope, msgId: 'quota-message-' + scope };
    const limiter = new ReplyLimiter(replyPolicy[scope]);
    cacheMsgId(scope, target.targetId, target.msgId);
    const expected = scope === 'c2c' ? 4 : 5;
    for (let index = 0; index < expected; index++) assert.equal(resolveReplyTarget(target, limiter, false).msgId, target.msgId);
    assert.equal(resolveReplyTarget(target, limiter, false).msgId, undefined);
  }
  const start = now;
  const privateTarget = { scope: 'c2c', targetId: 'window-private', msgId: 'window-private-message' };
  const groupTarget = { scope: 'group', targetId: 'window-group', msgId: 'window-group-old' };
  const privateLimiter = new ReplyLimiter(replyPolicy.c2c);
  const groupLimiter = new ReplyLimiter(replyPolicy.group);
  cacheMsgId('c2c', privateTarget.targetId, privateTarget.msgId);
  cacheMsgId('group', groupTarget.targetId, groupTarget.msgId);
  now = start + 4 * 60_000;
  assert.equal(resolveReplyTarget(groupTarget, groupLimiter, false).msgId, groupTarget.msgId);
  cacheMsgId('group', groupTarget.targetId, 'window-group-new');
  now = start + 5 * 60_000;
  assert.equal(resolveReplyTarget(groupTarget, groupLimiter, false).msgId, 'window-group-new', 'explicit expired ID cannot bypass cache age');
  now = start + 9 * 60_000;
  for (let index = 0; index < 2; index++) assert.equal(resolveReplyTarget(groupTarget, groupLimiter, false).msgId, undefined);
  assert.equal(groupLimiter.checkLimit(groupTarget.msgId).allowed, false);
  assert.equal(groupLimiter.checkLimit(groupTarget.msgId).allowed, false, 'checking twice cannot resurrect an expired quota');
  now = start + 31 * 60_000;
  assert.equal(resolveReplyTarget(privateTarget, privateLimiter, false).msgId, privateTarget.msgId);
  cacheMsgId('c2c', privateTarget.targetId, privateTarget.msgId);
  now = start + 60 * 60_000;
  assert.deepEqual(getCachedReplyIds('c2c', privateTarget.targetId), [], 'redelivery does not extend the original 60-minute window');
  assert.equal(resolveReplyTarget(privateTarget, privateLimiter, false).msgId, undefined);
  assert.equal(resolveReplyTarget({ scope: 'c2c', targetId: 'unknown', msgId: 'unobserved-message' }, privateLimiter, false).msgId, undefined);
  const memberTarget = { scope: 'group', targetId: 'member-routing', msgId: 'alice-message', replyUserId: 'alice' };
  const memberLimiter = new ReplyLimiter({ ...replyPolicy.group, limit: 1 });
  cacheMsgId('group', memberTarget.targetId, 'alice-message', now, 'alice');
  cacheMsgId('group', memberTarget.targetId, 'bob-message', now, 'bob');
  assert.equal(resolveReplyTarget(memberTarget, memberLimiter, false).msgId, 'alice-message');
  assert.equal(resolveReplyTarget(memberTarget, memberLimiter, false).msgId, undefined, 'exhausted Alice replies must not be anchored to Bob messages');
});

test('Tencent SDK uses actual HTTP/WebSocket QQ frames; media inputs and outgoing files obey size/path limits', { timeout: 15000 }, async () => {
  const directory = await temp(); const outside = await temp();
  await writeFile(join(directory, 'output.txt'), 'allowed');
  await writeFile(join(outside, 'outside.txt'), 'denied');
  const config = configSchema.parse({ cwd: directory, media: { maxMB: 0.0001 } });
  const media = new MediaStore(directory, config);
  const requests = [];
  let base;
  const http = createServer(async (request, response) => {
    if (request.url === '/image' || request.url === '/large') { response.end(request.url === '/large' ? Buffer.alloc(500) : Buffer.from('image-data')); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, body: body ? JSON.parse(body) : {} });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/app/getAppAccessToken') response.end(JSON.stringify({ access_token: 'fixture-qq-token', expires_in: '7200' }));
    else if (request.url === '/gateway') response.end(JSON.stringify({ url: base.replace('http:', 'ws:') + '/ws' }));
    else if (request.url.endsWith('/files')) response.end(JSON.stringify({ file_uuid: 'fixture-file', file_info: 'fixture-file-info', ttl: 3600 }));
    else response.end(JSON.stringify({ id: 'response-' + requests.length, timestamp: new Date().toISOString() }));
  });
  const sockets = new WebSocketServer({ server: http });
  let gateway;
  let sequence = 0;
  sockets.on('connection', (socket) => {
    gateway = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw);
      if (frame.op === 2) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: 'READY', d: { session_id: 'qq-fixture-session', user: { id: 'bot' } } }));
      if (frame.op === 6) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: 'RESUMED', d: {} }));
      if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${http.address().port}`;
  const previousBase = process.env.QQBOT_BASE_URL;
  const previousToken = process.env.QQBOT_TOKEN_BASE_URL;
  delete process.env.QQBOT_BASE_URL;
  delete process.env.QQBOT_TOKEN_BASE_URL;
  const originalFetch = globalThis.fetch;
  const apiOrigins = new Set();
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== base) {
      apiOrigins.add(url.origin);
      return originalFetch(new URL(url.pathname + url.search, base), options);
    }
    return originalFetch(input, options);
  };
  const qq = new QQTransport(configSchema.parse({ cwd: directory, appId: 'fixture-app', appSecret: 'fixture-secret' }), quiet);
  let online = false, reconnects = 0;
  qq.onDisconnected = () => { online = false; };
  qq.onConnected = () => { online = true; reconnects++; };
  if (previousBase === undefined) delete process.env.QQBOT_BASE_URL; else process.env.QQBOT_BASE_URL = previousBase;
  if (previousToken === undefined) delete process.env.QQBOT_TOKEN_BASE_URL; else process.env.QQBOT_TOKEN_BASE_URL = previousToken;
  try {
    const messages = [];
    await qq.connect(async (message) => { messages.push(message); }, () => false);
    const event = (type, data) => gateway.send(JSON.stringify({ op: 0, s: ++sequence, t: type, d: { id: 'msg-' + sequence, timestamp: new Date().toISOString(), ...data } }));
    event('C2C_MESSAGE_CREATE', { author: { user_openid: 'alice' }, content: 'hi from QQ', attachments: [] });
    event('GROUP_MESSAGE_CREATE', { author: { member_openid: 'alice' }, group_openid: 'team', content: 'not mentioned', attachments: [] });
    event('GROUP_AT_MESSAGE_CREATE', { author: { member_openid: 'alice', username: 'Alice' }, group_openid: 'team', content: 'group mention event without markup', attachments: [] });
    event('GROUP_AT_MESSAGE_CREATE', { author: { member_openid: 'bob', username: 'Bob' }, group_openid: 'team', content: 'second group member', attachments: [] });
    await waitFor(() => messages.length === 4);
    assert.equal(messages[0].senderId, 'alice');
    assert.equal(messages[0].text, 'hi from QQ');
    assert.equal(messages[0].envelope, undefined, 'the SDK does not add a second, truncated copy of group history');
    assert.equal(messages[1].target.targetId, 'team');
    assert.equal(messages[1].shouldAnswer, false);
    assert.equal(messages[2].shouldAnswer, true, 'the official group AT event is accepted even without a literal mention tag');
    assert.equal(messages[2].target.scope, 'group');
    assert.equal(messages[2].senderName, 'Alice'); assert.equal(messages[3].senderName, 'Bob');
    await qq.sendMarkdown(messages[2].target, 'group SDK reply');
    await qq.sendMarkdown(messages[3].target, 'second group SDK reply');
    assert.ok(requests.some((request) => request.path === '/v2/groups/team/messages' && request.body.markdown?.content === '<qqbot-at-user id="alice" />\ngroup SDK reply' && request.body.msg_id === messages[2].target.msgId));
    assert.ok(requests.some((request) => request.path === '/v2/groups/team/messages' && request.body.markdown?.content === '<qqbot-at-user id="bob" />\nsecond group SDK reply' && request.body.msg_id === messages[3].target.msgId));
    await qq.sendMarkdown(messages[0].target, 'SDK reply');
    await qq.sendFile(messages[0].target, join(directory, 'output.txt'), 'output.txt');
    const stream = qq.openStream(messages[0].target);
    await stream.update('stream via SDK');
    await stream.complete();
    await qq.sendMarkdown(messages[0].target, 'fourth passive reply');
    await qq.sendMarkdown(messages[0].target, 'quota exhausted');
    assert.ok(requests.some((request) => request.path === '/v2/users/alice/messages' && request.body.markdown?.content === 'SDK reply'));
    assert.ok(requests.some((request) => request.path === '/v2/users/alice/files' && request.body.file_data === Buffer.from('allowed').toString('base64')));
    assert.ok(requests.some((request) => request.path === '/v2/users/alice/stream_messages'));
    assert.ok(requests.some((request) => request.body.markdown?.content === 'fourth passive reply' && request.body.msg_id === messages[0].target.msgId));
    assert.ok(requests.some((request) => request.body.markdown?.content === 'quota exhausted' && !request.body.msg_id));
    assert.throws(() => qq.openStream(messages[0].target), /过期或达到次数上限/);
    event('C2C_MESSAGE_CREATE', { author: { user_openid: 'alice' }, content: '解释引用', message_type: 103,
      message_scene: { ext: ['msg_idx=current-ref==', 'ref_msg_idx=quoted-ref==', 'auth_token=must-not-enter-context'] },
      msg_elements: [{ msg_idx: 'wrong-ref', content: 'unrelated preview' }, { msg_idx: 'quoted-ref==', author: { user_openid: 'bob', username: 'Bob' },
        content: '引用正文'.repeat(100), attachments: [{ content_type: 'image/png', filename: 'quote.png', url: base + '/image' }],
        msg_elements: [{ msg_idx: 'nested-ref', author: { user_openid: 'alice', username: 'Alice' }, content: '更早的被引用消息' }],
      }] });
    event('GROUP_AT_MESSAGE_CREATE', { author: { member_openid: 'bob', username: 'Bob' }, group_openid: 'team', content: '', message_type: 103,
      message_scene: { ext: ['ref_msg_idx=forwarded-ref', 'msg_idx=current-group-ref'] },
      msg_elements: [{ content: '转发记录', msg_elements: [{ msg_idx: 'record-1', author: { member_openid: 'alice', username: 'Alice' }, content: '第一条记录' },
        { msg_idx: 'record-2', author: { member_openid: 'bob', username: 'Bob' }, ark_data: { prompt: '卡片内容', fields: { title: '文档标题', jump_url: 'https://example.com/doc' } } }] }],
    });
    await waitFor(() => messages.length === 6);
    assert.equal(messages[4].messageIndex, 'current-ref==');
    assert.equal(messages[4].reference.key, 'quoted-ref==', 'explicit ref_msg_idx wins over an unrelated first element');
    assert.equal(messages[4].reference.text, '引用正文'.repeat(100));
    assert.equal(messages[4].reference.senderId, 'bob'); assert.equal(messages[4].reference.senderName, 'Bob');
    assert.equal(messages[4].reference.attachments[0].filename, 'quote.png');
    assert.equal(messages[4].reference.references[0].text, '更早的被引用消息');
    assert.ok(!JSON.stringify(messages[4].reference).includes('must-not-enter-context'));
    assert.equal(messages[5].shouldAnswer, true); assert.equal(messages[5].text, '');
    assert.equal(messages[5].reference.references.length, 2);
    assert.match(messages[5].reference.references[1].text, /文档标题/);
    assert.deepEqual([...apiOrigins], ['https://api.bot.qq.com'], 'authentication and API traffic use the official unified domain');
    const inputs = await media.inputs([{ content_type: 'image/png', filename: 'capture.png', size: 10, url: base + '/image' }]);
    assert.equal(inputs[0].type, 'localImage');
    assert.equal(await readFile(inputs[0].path, 'utf8'), 'image-data');
    await assert.rejects(media.inputs([{ content_type: 'application/octet-stream', filename: 'big', size: 0, url: base + '/large' }]), /大小上限/);
    assert.equal(await media.allowedFile(join(directory, 'output.txt')), join(directory, 'output.txt'));
    await assert.rejects(media.allowedFile(join(outside, 'outside.txt')), /工作目录/);
    assert.equal(online, true);
    gateway.close(1001, 'fixture reconnect');
    await waitFor(() => !online);
    await waitFor(() => online && reconnects === 2);
    event('C2C_MESSAGE_CREATE', { author: { user_openid: 'alice' }, content: 'message after reconnect', attachments: [] });
    await waitFor(() => messages.length === 7);
    assert.equal(messages.at(-1).text, 'message after reconnect');
    const song = join(directory, '原始音频.MP3'); await writeFile(song, 'mp3-fixture');
    const picture = join(directory, 'preview.png'); await writeFile(picture, 'picture-fixture');
    const nativeVoice = join(directory, 'native.silk'); await writeFile(nativeVoice, 'voice-fixture');
    const uploads = () => requests.filter(request => request.path.endsWith('/files'));
    const beforeAudio = uploads().length;
    for (const target of [messages[0].target, messages[2].target]) {
      await qq.sendFile(target, song, '原始音频.MP3');
      await qq.sendFile(target, song, '原始音频.MP3', 'file');
      await qq.sendFile(target, song, '原始音频.MP3', 'voice');
      await qq.sendFile(target, picture, 'preview.png', 'file');
      await qq.sendFile(target, picture, 'preview.png');
      await qq.sendFile(target, nativeVoice, 'native.silk');
    }
    const audioUploads = uploads().slice(beforeAudio);
    assert.deepEqual(audioUploads.map(request => request.body.file_type), [4, 3, 4, 1, 3, 4, 3, 4, 1, 3], 'private and group delivery distinguish files from voice and image messages; auto/file reuse the same MP3 upload');
    assert.ok(audioUploads.filter(request => request.body.file_type === 4 && request.body.file_data === Buffer.from('mp3-fixture').toString('base64')).every(request => request.body.file_name === '原始音频.MP3'), 'MP3 file delivery preserves the filename and original bytes');
    assert.throws(() => qq.sendFile(messages[0].target, song, '原始音频.MP3', 'invalid'), /auto|file|voice/);
    assert.equal(uploads().length, beforeAudio + 10, 'invalid modes never issue a QQ upload');
  } finally {
    qq.close();
    globalThis.fetch = originalFetch;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  }
});

test('Actual MCP stdio discovery and shared service setup page preserve credentials and serve only local authenticated requests', { timeout: 30000 }, async () => {
  const directory = await temp();
  const store = new ConfigStore(directory);
  assert.equal(store.read().autoStart, true);
  const manifest = JSON.parse(await readFile('mcp.json', 'utf8'));
  assert.deepEqual(Object.keys(manifest.mcpServers), ['qqbot'], 'retain the existing tool namespace');
  store.update({ autoStart: false, appId: 'saved-app', appSecret: 'super-secret-fixture', cwd: directory, codexCommand: fixture, codexArgs: [directory] });
  const desktopAuthPath = join(process.env.CODEX_HOME, 'auth.json');
  const botAuthPath = join(directory, 'codex-home', 'auth.json');
  const login = (account, refresh, token) => ({ auth_mode: 'chatgpt', tokens: { account_id: account, access_token: token, refresh_token: 'fixture-refresh' }, last_refresh: refresh });
  const oldLogin = login('fixture-account', '2026-10-27T00:00:00Z', 'old-desktop-token');
  const desktopLogin = login('fixture-account', '2026-10-28T00:00:00Z', 'fresh-desktop-token');
  await mkdir(join(directory, 'codex-home'), { recursive: true });
  await writeFile(desktopAuthPath, JSON.stringify(desktopLogin));
  await writeFile(botAuthPath, JSON.stringify(oldLogin));
  const desktopConfigPath = join(process.env.CODEX_HOME, 'config.toml');
  const desktopConfig = `model = "fixture-model"\ndisable_response_storage = true\nnotify = ["fixture-desktop-notify"]\ndeveloper_instructions = '''\n[features]\nrmcp_client = true\n'''\n[features]\nrmcp_client = true\nmemories = true\n[model_providers.fixture]\nname = "Fixture provider"\n`;
  await writeFile(desktopConfigPath, desktopConfig);
  await writeFile(join(directory, 'sessions.json'), JSON.stringify({ 'saved-app:c2c:alice': { threadId: 'history-thread', prompt: 'old-private-role' }, 'saved-app:group:team': { prompt: 'group-role' } }));
  await writeFile(join(directory, 'thread-history.json'), JSON.stringify({ 'history-thread': Array.from({ length: 31 }, (_, index) => ({
    id: 'history-turn-' + index, status: 'completed', items: [
      { id: 'history-user-' + index, type: 'userMessage', content: [{ type: 'text', text: `<from>\nuser: Alice\n</from>\n\n<message>\nhistory question ${index}\n</message>` }] },
      { id: 'history-secret-' + index, type: 'reasoning', text: 'must-not-display' },
      { id: 'history-summary-' + index, type: 'reasoning', summary: ['**历史公开摘要**\n\n核对问题 ' + index], content: ['must-not-display-raw'] },
      { id: 'history-agent-' + index, type: 'agentMessage', text: 'history answer ' + index, phase: 'final_answer' },
    ],
  })) }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp'], env: { ...process.env, QQBOT_DATA_DIR: directory }, stderr: 'pipe' });
  const client = new Client({ name: 'qqbot-integration-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'codex-qqbot');
    assert.equal(client.getServerVersion().title, 'QQ Bot');
    assert.equal(client.getServerVersion().version, '0.0.4');
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(tools.sort(), ['qqbot_configure', 'qqbot_models', 'qqbot_send_file', 'qqbot_send_message', 'qqbot_setup', 'qqbot_start', 'qqbot_status', 'qqbot_stop', 'qqbot_ui'].sort());
    const details = (await client.listTools()).tools;
    assert.ok(details.every(tool => tool.title?.includes('QQ Bot')), 'all user-facing tool names use QQ Bot');
    const entry = details.find((tool) => tool.name === 'qqbot_setup');
    assert.equal(entry.title, 'QQ Bot');
    assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.deepEqual(details.find((tool) => tool.name === 'qqbot_ui')._meta.ui.visibility, ['app']);
    const resource = await client.readResource({ uri: entry._meta.ui.resourceUri });
    assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.contents[0].text, /模型与预设/);
    const status = await client.callTool({ name: 'qqbot_status', arguments: {} });
    assert.ok(!JSON.stringify(status).includes('super-secret-fixture'));
    const setup = await client.callTool({ name: 'qqbot_setup', arguments: {} });
    assert.equal(setup.isError, undefined, JSON.stringify(setup));
    const state = JSON.parse(setup.content[0].text);
    assert.equal(state.running, false, 'disabled auto-start keeps a bound bot offline');
    const page = await fetch(state.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /QQ Bot/);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const base = new URL(state.url).origin;
    assert.equal((await fetch(base + '/api/status')).status, 403);
    const authenticated = await fetch(base + '/api/status', { headers: { cookie } });
    assert.equal(authenticated.status, 200);
    assert.ok(!(await authenticated.text()).includes('super-secret-fixture'));
    const sessionSaved = await client.callTool({ name: 'qqbot_ui', arguments: { action: 'session', payload: {
      scope: 'c2c', target_id: 'alice', action: 'configure', settings: { prompt: 'new-private-role', model: 'fixture-model' },
    } } });
    assert.ok(!sessionSaved.isError, JSON.stringify(sessionSaved));
    assert.equal(sessionSaved.structuredContent.sessions.find((item) => item.peerId === 'alice').prompt, 'new-private-role');
    assert.equal(sessionSaved.structuredContent.sessions.find((item) => item.peerId === 'team').prompt, 'group-role');
    const renamed = await client.callTool({ name: 'qqbot_ui', arguments: { action: 'session', payload: { scope: 'c2c', target_id: 'alice', action: 'rename', name: '  工作助手  ' } } });
    assert.ok(!renamed.isError, JSON.stringify(renamed));
    assert.equal(renamed.structuredContent.sessions.find((item) => item.peerId === 'alice').name, '工作助手');
    const savedAlias = JSON.parse(await readFile(join(directory, 'sessions.json'), 'utf8'))['saved-app:c2c:alice'];
    assert.equal(savedAlias.name, '工作助手'); assert.equal(savedAlias.threadId, 'history-thread'); assert.equal(savedAlias.prompt, 'new-private-role');
    const history = await client.callTool({ name: 'qqbot_ui', arguments: { action: 'session', payload: { scope: 'c2c', target_id: 'alice', action: 'history' } } });
    assert.ok(!history.isError, JSON.stringify(history));
    assert.equal(history.structuredContent.messages.length, 60);
    assert.equal(history.structuredContent.messages[0].text, 'history question 1');
    assert.ok(!JSON.stringify(history.structuredContent.messages).includes('must-not-display'));
    assert.equal(history.structuredContent.activities.filter(item => item.kind === 'reasoning').length, 30);
    assert.ok(history.structuredContent.activities.some(item => item.detail.includes('历史公开摘要')));
    assert.doesNotMatch(JSON.stringify(history.structuredContent), /must-not-display/, 'historical reasoning only exposes public summary fields');
    const older = await client.callTool({ name: 'qqbot_ui', arguments: { action: 'session', payload: { scope: 'c2c', target_id: 'alice', action: 'history', cursor: history.structuredContent.nextCursor } } });
    assert.equal(older.structuredContent.messages[0].text, 'history question 0');
    const otherHistory = await client.callTool({ name: 'qqbot_ui', arguments: { action: 'session', payload: { scope: 'group', target_id: 'team', action: 'history' } } });
    assert.deepEqual(otherHistory.structuredContent.messages, []);
    const rejected = await fetch(base + '/api/configure', { method: 'POST', headers: { cookie, origin: 'https://unrelated.example' }, body: '{}' });
    assert.equal(rejected.status, 403);
    const saved = await client.callTool({ name: 'qqbot_configure', arguments: { changes: { directPrompt: 'x'.repeat(6000), access: { c2cAllow: ['alice'] } } } });
    assert.ok(!saved.isError, JSON.stringify(saved));
    assert.equal(store.read().appSecret, 'super-secret-fixture');
    assert.equal(store.read().directPrompt.length, 6000);
    assert.equal((await callService('status', {}, directory)).config.access.c2cAllow[0], 'alice');
    const models = await client.callTool({ name: 'qqbot_models', arguments: {} });
    assert.equal(JSON.parse(models.content[0].text).data[0].model, 'fixture-model');
    const runtimeConfig = await readFile(join(directory, 'codex-home', 'config.toml'), 'utf8');
    assert.equal(runtimeConfig, desktopConfig.replace('disable_response_storage = true\n', '').replace('[features]\nrmcp_client = true\nmemories', '[features]\nmemories'), 'only removed settings are excluded; instruction text, providers and tools retain their configuration');
    assert.equal(await readFile(desktopConfigPath, 'utf8'), desktopConfig, 'the desktop configuration stays unchanged');
    assert.deepEqual(JSON.parse(await readFile(botAuthPath, 'utf8')), desktopLogin, 'a refreshed desktop login replaces the stale same-account copy');
    const newerBotLogin = login('fixture-account', '2026-10-29T00:00:00Z', 'newer-bot-token');
    await writeFile(botAuthPath, JSON.stringify(newerBotLogin));
    await client.callTool({ name: 'qqbot_models', arguments: {} });
    assert.deepEqual(JSON.parse(await readFile(botAuthPath, 'utf8')), newerBotLogin, 'newer bot credentials are retained');
    await writeFile(desktopAuthPath, JSON.stringify(login('different-account', '2026-10-30T00:00:00Z', 'different-account-token')));
    await client.callTool({ name: 'qqbot_models', arguments: {} });
    assert.deepEqual(JSON.parse(await readFile(botAuthPath, 'utf8')), newerBotLogin, 'an independently selected bot account is retained');
    const catalog = await client.callTool({ name: 'qqbot_ui', arguments: { action: 'catalog' } });
    assert.ok(catalog.structuredContent.providers.some((provider) => provider.id === 'fixture'));
    const shutdown = () => callService('shutdown', {}, directory).catch(error => {
      if (!error.message.includes('已关闭连接')) throw error;
    });
    await shutdown();
    await client.close();
    // A fresh MCP initialization must connect without any qqbot_start call.
    const startupClients = [];
    const requests = [];
    let gatewayBase;
    let connections = 0;
    const http = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push(request.url);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/app/getAppAccessToken') response.end(JSON.stringify({ access_token: 'startup-fixture-token', expires_in: '7200' }));
      else if (request.url === '/gateway') response.end(JSON.stringify({ url: gatewayBase.replace('http:', 'ws:') + '/ws' }));
      else { response.statusCode = 404; response.end('{}'); }
    });
    const sockets = new WebSocketServer({ server: http });
    sockets.on('connection', socket => {
      connections++;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }));
      socket.on('message', raw => {
        const frame = JSON.parse(raw);
        if (frame.op === 2) socket.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'startup-fixture', user: { id: 'bot' } } }));
        if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
      });
    });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    gatewayBase = `http://127.0.0.1:${http.address().port}`;
    const connect = async (child = false) => {
      const peer = new Client({ name: 'startup-fixture', version: '1.0.0' });
      startupClients.push(peer);
      await peer.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'mcp'],
        env: { ...process.env, QQBOT_DATA_DIR: directory, QQBOT_BASE_URL: gatewayBase, QQBOT_TOKEN_BASE_URL: gatewayBase, QQBOT_BRIDGE_CHILD: child ? '1' : '0' }, stderr: 'pipe' }));
      return peer;
    };
    const waitForState = async (predicate) => {
      const deadline = Date.now() + 10000;
      while (true) {
        const state = await callService('status', {}, directory).catch(error => {
          if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return undefined;
          if (error.message.includes('已关闭连接')) return null;
          throw error;
        });
        if (predicate(state)) return state;
        if (Date.now() > deadline) throw new Error('Timed out waiting for auto-start state');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    try {
      await waitForState(state => state === undefined);
      store.update({ autoStart: true });
      const startupLogOffset = (await readFile(join(directory, 'runtime.log'), 'utf8')).length;
      const [primary, secondary] = await Promise.all([connect(), connect()]);
      const online = await waitForState(state => state?.connected);
      assert.equal(online.config.autoStart, true);
      assert.equal(connections, 1);
      const shared = await secondary.callTool({ name: 'qqbot_status', arguments: {} });
      assert.equal(shared.structuredContent.connected, true);
      assert.equal(connections, 1, 'multiple MCP instances reuse the live QQ connection');
      await promisify(execFile)(process.execPath, [resolve('dist/cli.js'), 'daemon'], {
        env: { ...process.env, QQBOT_DATA_DIR: directory }, windowsHide: true, timeout: 5000,
      });
      const startupLog = (await readFile(join(directory, 'runtime.log'), 'utf8')).slice(startupLogOffset);
      assert.doesNotMatch(startupLog, /EADDRINUSE|自动启动失败/, 'concurrent daemon launch is a successful reuse, not an error');
      assert.equal(startupLog.match(/QQ 后台服务已启动/g)?.length, 1);
      assert.match(startupLog, /^\d{4}-\d{2}-\d{2}T\S+ \[INFO\] \[qqbot\] QQ 后台服务已启动/m, 'runtime diagnostics include a timestamp and severity');
      await new Promise(resolve => setTimeout(resolve, 100));
      await primary.callTool({ name: 'qqbot_stop', arguments: {} });
      const stopped = await secondary.callTool({ name: 'qqbot_status', arguments: {} });
      assert.equal(stopped.structuredContent.running, false, 'status refresh does not restart a manually stopped bot');
      await shutdown();
      await waitForState(state => state === undefined);
      const child = await connect(true);
      assert.deepEqual((await child.listTools()).tools.map(tool => tool.name), ['qqbot_status']);
      const dormant = await child.callTool({ name: 'qqbot_status', arguments: {} });
      assert.equal(dormant.structuredContent.running, false);
      await assert.rejects(callService('status', {}, directory), error => ['ENOENT', 'ECONNREFUSED'].includes(error.code));
      store.update({ appId: '', appSecret: '' });
      const unbound = await connect();
      const unboundStatus = await unbound.callTool({ name: 'qqbot_status', arguments: {} });
      assert.equal(unboundStatus.structuredContent.config.credentialsConfigured, false);
      await assert.rejects(callService('status', {}, directory), error => ['ENOENT', 'ECONNREFUSED'].includes(error.code));
      assert.equal(connections, 1, 'child and unbound instances never connect');
      assert.ok(!requests.some(path => /messages|files/.test(path)), 'startup sends no QQ messages or files');
    } finally {
      for (const peer of startupClients) await peer.close();
      await callService('shutdown', {}, directory).catch(() => {});
      for (const socket of sockets.clients) socket.terminate();
      await new Promise(resolve => sockets.close(resolve));
      http.closeAllConnections();
      await new Promise(resolve => http.close(resolve));
    }
  } finally {
    await client.close();
    await callService('shutdown', {}, directory).catch(() => {});
  }
});
