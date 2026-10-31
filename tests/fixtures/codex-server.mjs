import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, toNamespacedPath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dynamicTools as fixtureTools } from '../../dist/index.js';

const directory = process.argv[3];
const turns = new Map();
const loaded = new Map();
const compactTimers = new Map();
const historyPath = join(directory, 'thread-history.json');
const histories = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {};
const saveHistory = () => writeFileSync(historyPath, JSON.stringify(histories));
const waiting = new Map();
let sequence = 1000;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const result = (id, value) => send({ id, result: value });
const trace = (value) => appendFileSync(join(directory, 'protocol.jsonl'), JSON.stringify(value) + '\n');
trace({ launch: process.argv.slice(2) });
const ask = (method, params) => new Promise((resolve) => { const id = ++sequence; waiting.set(id, resolve); send({ id, method, params }); });
const rollout = threadId => join(process.env.CODEX_HOME, 'sessions', threadId + '.jsonl');
function usage(threadId, turnId) {
  const controlPath = join(directory, 'context-usage.json');
  const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
  const used = control.usedTokens ?? 1280;
  const window = 'windowTokens' in control ? control.windowTokens : loaded.get(threadId)?.settings.config?.model_context_window ?? 100000;
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: {
    last: { inputTokens: used - 20, outputTokens: 20, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: used },
    total: { inputTokens: 999000000, outputTokens: 100000, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 999100000 }, modelContextWindow: window,
  } });
  mkdirSync(join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
  if (!existsSync(rollout(threadId))) writeFileSync(rollout(threadId), JSON.stringify({ type: 'session_meta', payload: {
    id: threadId, dynamic_tools: loaded.get(threadId)?.settings.dynamicTools || fixtureTools,
  } }) + '\n');
  appendFileSync(rollout(threadId), JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: {
    last_token_usage: { total_tokens: used }, total_token_usage: { total_tokens: 999100000 }, model_context_window: window,
  } } }) + '\n');
}

async function execute(threadId, turnId, input) {
  const common = { threadId, turnId };
  const text = input.filter((item) => item.type === 'text' && !item.text.startsWith('[QQ Bot 本轮文件目录]\n') && !item.text.startsWith('[QQ Bot 群聊上下文：') && !item.text.startsWith('[QQ Bot 引用上下文：')).map((item) => item.text).join('\n');
  const clock = await ask('currentTime/read', {});
  trace({ clock });
  if (text.includes('native-auto-compact')) {
    const turn = histories[threadId].find(item => item.id === turnId);
    const item = { id: 'native-compact-' + turnId, type: 'contextCompaction' };
    turn.items.push(item); saveHistory();
    notify('item/started', { ...common, item });
    const controlPath = join(directory, 'compaction.json');
    const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
    if (control.status === 'hang') return;
    await new Promise(resolve => setTimeout(resolve, control.delayMs ?? 60));
    if (turns.get(threadId) !== turnId) return;
    if (control.status === 'failed') throw new Error('fixture native compaction failed');
    if (existsSync(rollout(threadId))) appendFileSync(rollout(threadId), JSON.stringify({ type: 'compacted', timestamp: new Date().toISOString(), payload: {} }) + '\n');
    notify('item/completed', { ...common, item });
  }
  if (text.includes('hang')) return;
  if (text.includes('long-command-failure')) {
    const item = { id: 'failed-command-' + turnId, type: 'commandExecution', command: 'fixture-command', status: 'completed', exitCode: 1,
      aggregatedOutput: 'PASS: preceding output\n'.repeat(400) + 'FINAL FAILURE: preserved error at the end' };
    histories[threadId].find(item => item.id === turnId).items.push(item); saveHistory();
    notify('item/completed', { ...common, item });
  }
  let generatedFile;
  if (text.includes('browser-login-check')) {
    const browser = await ask('item/tool/call', { ...common, callId: 'browser-login', tool: 'qqbot_browser', arguments: { url: 'https://x.com/' } });
    trace({ browserLogin: browser });
    const item = { id: 'browser-' + turnId, type: 'dynamicToolCall', tool: 'qqbot_browser', status: browser.success ? 'completed' : 'failed', ...browser };
    histories[threadId].find(turn => turn.id === turnId).items.push(item); saveHistory();
    notify('item/completed', { ...common, item });
  }
  if (text.includes('send-parallel-files')) {
    const folder = join(process.env.CODEX_HOME, 'generated_images', threadId); mkdirSync(folder, { recursive: true });
    const first = join(folder, 'first.txt'), second = join(folder, 'second.txt');
    writeFileSync(first, 'first file'); writeFileSync(second, 'second file');
    const deliveries = await Promise.all([first, pathToFileURL(first).href, second].map((file, index) => ask('item/tool/call', {
      ...common, callId: 'parallel-' + index, tool: 'qqbot_send_file', arguments: { file_path: file, send_as: 'file' },
    })));
    trace({ parallelFiles: deliveries });
  }
  if (text.includes('send-external-file')) {
    const file = join(process.env.CODEX_HOME, 'external-song.mp3');
    writeFileSync(file, 'original audio file');
    const mode = text.includes(' voice') ? 'voice' : 'file';
    const delivery = await ask('item/tool/call', { ...common, callId: 'external-file', tool: 'qqbot_send_file', arguments: { file_path: file, send_as: mode } });
    const repeated = await ask('item/tool/call', { ...common, callId: 'external-file-again', tool: 'qqbot_send_file', arguments: { file_path: pathToFileURL(file).href, ...(mode === 'voice' ? { send_as: mode } : {}) } });
    const item = { id: 'external-file-' + turnId, type: 'dynamicToolCall', tool: 'qqbot_send_file', arguments: { file_path: file, send_as: mode }, status: delivery.success ? 'completed' : 'failed', ...delivery };
    histories[threadId].find(turn => turn.id === turnId).items.push(item);
    notify('item/completed', { ...common, item });
    trace({ externalFile: { file, delivery, repeated } });
    if (delivery.success) generatedFile = file;
  }
  if (text.includes('send-generated-image')) {
    const folder = join(process.env.CODEX_HOME, 'generated_images', threadId); mkdirSync(folder, { recursive: true });
    const file = join(folder, 'fixture100%.png'); generatedFile = file;
    writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=', 'base64'));
    const mode = /\bfile\b/.test(text) ? 'file' : 'auto';
    const [delivery, repeated] = await Promise.all([
      ask('item/tool/call', { ...common, callId: 'generated-image', tool: 'qqbot_send_file', arguments: { file_path: pathToFileURL(file).href, send_as: mode } }),
      ask('item/tool/call', { ...common, callId: 'same-image', tool: 'qqbot_send_file', arguments: { file_path: 'sandbox:' + file, send_as: mode } }),
    ]);
    const item = { id: 'generated-image-' + turnId, type: 'dynamicToolCall', tool: 'qqbot_send_file', arguments: { file_path: pathToFileURL(file).href, send_as: mode }, status: delivery.success ? 'completed' : 'failed', ...delivery };
    if (text.includes('file-card-probe')) histories[threadId].find(turn => turn.id === turnId).items.push({ id: 'image-source-' + turnId, type: 'imageGeneration', savedPath: file });
    histories[threadId].find(turn => turn.id === turnId).items.push(item);
    notify('item/completed', { ...common, item });
    let vision, denied;
    if (!text.includes('file-card-probe')) {
      vision = await ask('item/tool/call', { ...common, callId: 'generated-image-vision', tool: 'qqbot_describe_image', arguments: { file_path: 'sandbox:' + file, prompt: 'vision-generated-fixture' } });
      const outside = join(process.env.CODEX_HOME, 'outside.png'); writeFileSync(outside, 'not a permitted file');
      denied = await ask('item/tool/call', { ...common, callId: 'outside-image', tool: 'qqbot_send_file', arguments: { file_path: outside } });
      notify('item/completed', { ...common, item: { id: 'outside-image', type: 'dynamicToolCall', tool: 'qqbot_send_file', status: 'failed', ...denied } });
    }
    trace({ generatedImage: { file, delivery, repeated, vision, denied } });
    if (!delivery.success) throw new Error('generated image delivery failed');
  }
  if (text.includes('local-question')) {
    const question = await ask('item/tool/requestUserInput', { ...common, itemId: 'local-question', questions: [{ id: 'choice', question: '选择导出格式', isOther: true, isSecret: false,
      options: [{ label: 'Markdown', description: '文本报告' }, { label: 'CSV', description: '数据表格' }] }] });
    trace({ localQuestion: question });
  }
  if (text.includes('permission-policy-probe')) {
    const command = await ask('item/commandExecution/requestApproval', { ...common, itemId: 'permission-command', command: 'echo fixture permission' });
    const file = await ask('item/fileChange/requestApproval', { ...common, itemId: 'permission-file', reason: 'fixture file access' });
    const permissions = await ask('item/permissions/requestApproval', { ...common, itemId: 'permission-grant', cwd: directory,
      permissions: { network: { enabled: true }, fileSystem: { read: [directory], write: [directory] } } });
    trace({ permissionPolicyProbe: { command, file, permissions } });
  }
  if (text.includes('approve-question-file')) {
    const approval = await ask('item/commandExecution/requestApproval', { ...common, itemId: 'cmd', command: 'echo fixture', reason: 'fixture command' });
    trace({ approval });
    if (approval.decision !== 'accept') throw new Error('approval was not accepted');
    const question = await ask('item/tool/requestUserInput', { ...common, itemId: 'question', questions: [{ id: 'choice', question: 'Choose output format', isOther: true, isSecret: false,
      options: [{ label: 'Markdown', description: 'Text report' }, { label: 'CSV', description: 'Table' }] }] });
    trace({ question });
    const file = await ask('item/tool/call', { ...common, callId: 'file', tool: 'qqbot_send_file', namespace: null, arguments: { file_path: join(directory, 'report.txt') } });
    trace({ file });
    if (!file.success) throw new Error('file send failed');
    const vision = await ask('item/tool/call', { ...common, callId: 'vision', tool: 'qqbot_describe_image', namespace: null,
      arguments: { file_path: join(directory, 'report.png'), prompt: 'vision-fixture' } });
    trace({ vision });
    if (!vision.success) throw new Error('vision call failed');
  }
  if (text.includes('reasoning-ui-probe')) {
    const current = histories[threadId].find(item => item.id === turnId);
    const reasoning = { id: 'reasoning-' + turnId, type: 'reasoning', summary: [], content: ['must-not-display-raw'] };
    current.items.push(reasoning); saveHistory();
    notify('item/started', { ...common, item: reasoning });
    notify('item/reasoning/summaryPartAdded', { ...common, itemId: reasoning.id, summaryIndex: 0 });
    notify('item/reasoning/summaryTextDelta', { ...common, itemId: reasoning.id, summaryIndex: 0, delta: '**整理需求**\n\n先检查' });
    notify('item/reasoning/summaryTextDelta', { ...common, itemId: reasoning.id, summaryIndex: 0, delta: '会话输入。' });
    notify('item/reasoning/summaryPartAdded', { ...common, itemId: reasoning.id, summaryIndex: 1 });
    notify('item/reasoning/summaryTextDelta', { ...common, itemId: reasoning.id, summaryIndex: 1, delta: '**核对进度**\n\n保留公开摘要与执行顺序。' });
    notify('item/reasoning/summaryPartAdded', { ...common, itemId: reasoning.id, summaryIndex: 1 });
    notify('item/reasoning/summaryTextDelta', { ...common, turnId: 'old-' + turnId, itemId: reasoning.id, summaryIndex: 0, delta: 'must-not-display-stale-turn' });
    notify('item/reasoning/textDelta', { ...common, itemId: reasoning.id, contentIndex: 0, delta: 'must-not-display-raw' });
    const comment = { id: 'progress-' + turnId, type: 'agentMessage', phase: 'commentary', text: '已确认需求，正在核对执行结果。' };
    current.items.push(comment); notify('item/completed', { ...common, item: comment });
    const command = { id: 'stream-command-' + turnId, type: 'commandExecution', command: 'Get-Date', status: 'inProgress', aggregatedOutput: '' };
    current.items.push(command); notify('item/started', { ...common, item: command });
    notify('item/commandExecution/outputDelta', { ...common, itemId: command.id, delta: 'fixture ' });
    notify('item/commandExecution/outputDelta', { ...common, itemId: command.id, delta: 'working\n' });
    const plan = { id: 'plan-' + turnId, type: 'plan', text: '' };
    current.items.push(plan); notify('item/started', { ...common, item: plan });
    notify('item/plan/delta', { ...common, itemId: plan.id, delta: '1. 核对摘要\n' });
    notify('item/plan/delta', { ...common, itemId: plan.id, delta: '2. 整理结果' });
    saveHistory();
    await ask('item/tool/requestUserInput', { ...common, itemId: 'reasoning-preview', questions: [{ id: 'continue', question: '公开摘要预览完成后继续', isOther: false, isSecret: false,
      options: [{ label: '继续', description: '完成这轮演示' }] }] });
    reasoning.summary = ['**核对完成**\n\n已检查会话输入，确认执行结果。', '**整理结果**\n\n将公开摘要与最终答复分开显示。'];
    command.aggregatedOutput = 'fixture working\nfixture done\n'; command.status = 'completed'; command.exitCode = 0;
    plan.text = '1. 核对摘要：完成\n2. 整理结果：完成';
    notify('item/completed', { ...common, item: reasoning });
    notify('item/completed', { ...common, item: command });
    notify('item/completed', { ...common, item: plan });
    saveHistory();
  }
  const itemId = 'answer-' + turnId;
  if (process.env.QQBOT_FIXTURE_UI === '1') {
    const activity = { id: 'activity-' + turnId, type: 'agentMessage', phase: 'commentary', text: '我会先整理已有信息，再给出具体建议。' };
    const command = { id: 'command-' + turnId, type: 'commandExecution', command: 'Get-Date', status: 'completed', aggregatedOutput: '2026-10-29', exitCode: 0 };
    histories[threadId].find(item => item.id === turnId).items.push(activity, command);
    notify('item/completed', { ...common, item: activity }); notify('item/completed', { ...common, item: command });
    if (text.includes('优先级')) {
      const folder = join(process.env.CODEX_HOME, 'generated_images', threadId); mkdirSync(folder, { recursive: true });
      const path = join(folder, 'ui-preview.png'); writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvWQAAAAASUVORK5CYII=', 'base64'));
      const image = { id: 'image-' + turnId, type: 'imageGeneration', status: 'completed', savedPath: path };
      histories[threadId].find(item => item.id === turnId).items.push(image); notify('item/completed', { ...common, item: image });
    }
  }
  const answer = generatedFile ? `Generated image: ![preview](<${generatedFile}>)` : process.env.QQBOT_FIXTURE_UI === '1'
    ? text.includes('优先级') ? '可以，先按 **紧急程度** 和预计耗时安排优先级。\n\n工作资料会放在 `E:\\QQ\\storage`。\n\n| 事项 | 安排 |\n| --- | --- |\n| 今天需要完成 | 优先处理 |\n| 可以延后 | 稍后安排 |\n\n```js\nconst status = "ready";\n```\n\n- 先确认必须完成的工作\n- 再留出休息时间' : text.includes('render-safety-check') ? '<img src=x onerror="window.__qqInjected=true"><script>window.__qqInjected=true</script>' : '可以。我会先整理今天的安排，再标出需要你确认的事项。'
    : 'Codex fixture reply: ' + text.slice(0, 200);
  const turn = histories[threadId]?.find((item) => item.id === turnId);
  if (turn) { turn.items.push({ type: 'agentMessage', id: itemId, phase: 'final_answer', text: answer }); turn.status = 'completed'; saveHistory(); }
  notify('item/started', { ...common, item: { type: 'agentMessage', id: itemId, phase: 'final_answer', text: '' } });
  notify('item/agentMessage/delta', { ...common, itemId, delta: answer.slice(0, 10) });
  notify('item/agentMessage/delta', { ...common, itemId, delta: answer.slice(10) });
  notify('item/completed', { ...common, item: { type: 'agentMessage', id: itemId, phase: 'final_answer', text: answer } });
  if (text.includes('hold-file-card')) {
    if (turn) { turn.status = 'inProgress'; saveHistory(); }
    await ask('item/tool/requestUserInput', { ...common, itemId: 'hold-file-card', questions: [{ id: 'files', question: '确认文件卡片', isOther: true, options: [] }] });
    if (turn) { turn.status = 'completed'; saveHistory(); }
  }
  turns.delete(threadId);
  usage(threadId, turnId);
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) { trace({ response: message }); waiting.get(message.id)?.(message.result); waiting.delete(message.id); return; }
  trace(message);
  const params = message.params || {};
  switch (message.method) {
    case 'initialize': result(message.id, { userAgent: 'fixture' }); break;
    case 'initialized': break;
    case 'config/read': result(message.id, { config: { plugins: { 'codex-qqbot@qqbot-local': { enabled: true } }, model_providers: { fixture: { name: 'Fixture provider' } } } }); break;
    case 'account/read': result(message.id, { account: { type: 'chatgpt' } }); break;
    case 'model/list': result(message.id, { data: [{ id: 'fixture-model', model: 'fixture-model', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null }); break;
    case 'skills/list': result(message.id, { data: [{ cwd: directory, skills: [{ name: 'fixture-skill', description: 'Fixture skill', path: join(directory, 'SKILL.md'), enabled: true }] }] }); break;
    case 'thread/start': {
      const id = 'thread_' + randomUUID(); histories[id] = []; loaded.set(id, { subscribed: true, settings: params }); saveHistory(); result(message.id, { thread: { id } }); break;
    }
    case 'thread/resume': {
      // Native Codex retains unsubscribed idle threads during a grace period.
      // Resuming a subscribed thread rejoins its existing configuration.
      if (!loaded.get(params.threadId)?.subscribed) loaded.set(params.threadId, { subscribed: true, settings: params });
      else trace({ ignoredResumeOverrides: params.threadId });
      result(message.id, { thread: { id: params.threadId } }); break;
    }
    case 'thread/read': result(message.id, { thread: { id: params.threadId, ...(existsSync(rollout(params.threadId)) ? { path: toNamespacedPath(rollout(params.threadId)) } : {}) } }); break;
    case 'thread/loaded/list': result(message.id, { data: [...loaded.keys()], nextCursor: null }); break;
    case 'thread/turns/list': {
      const all = [...(histories[params.threadId] || [])].reverse();
      const start = Number(params.cursor || 0); const limit = params.limit || 30;
      result(message.id, { data: all.slice(start, start + limit), nextCursor: start + limit < all.length ? String(start + limit) : null, backwardsCursor: null }); break;
    }
    case 'thread/unsubscribe': {
      const controlPath = join(directory, 'compaction.json');
      const delay = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')).resetDelayMs || 0 : 0;
      const complete = () => {
        const thread = loaded.get(params.threadId);
        const status = thread ? thread.subscribed ? 'unsubscribed' : 'notSubscribed' : 'notLoaded';
        if (thread) thread.subscribed = false;
        result(message.id, { status });
      };
      if (delay) setTimeout(complete, delay); else complete();
      break;
    }
    case 'thread/compact/start': {
      const id = 'compact_' + randomUUID();
      const controlPath = join(directory, 'compaction.json');
      const control = existsSync(controlPath) ? JSON.parse(readFileSync(controlPath, 'utf8')) : {};
      turns.set(params.threadId, id);
      const turn = { id, status: 'inProgress', items: [{ id: 'item-' + id, type: 'contextCompaction' }] };
      (histories[params.threadId] ||= []).push(turn); saveHistory();
      notify('turn/started', { threadId: params.threadId, turn: { id, status: 'inProgress', items: [] } });
      notify('item/started', { threadId: params.threadId, turnId: id, item: turn.items[0] });
      result(message.id, {});
      if (control.status !== 'hang') compactTimers.set(params.threadId, setTimeout(() => {
        if (turns.get(params.threadId) !== id) return;
        turn.status = control.status || 'completed';
        if (turn.status === 'failed') turn.error = { message: 'fixture compaction failed' };
        if (turn.status === 'completed' && existsSync(rollout(params.threadId))) appendFileSync(rollout(params.threadId), JSON.stringify({ type: 'compacted', timestamp: new Date().toISOString(), payload: {} }) + '\n');
        saveHistory();
        notify('item/completed', { threadId: params.threadId, turnId: id, item: turn.items[0] });
        notify('turn/completed', { threadId: params.threadId, turn });
        turns.delete(params.threadId); compactTimers.delete(params.threadId);
      }, control.delayMs ?? 25));
      break;
    }
    case 'turn/start': {
      const settings = loaded.get(params.threadId)?.settings || {};
      trace({ effectiveTurn: { threadId: params.threadId, model: params.model || settings.model || 'fixture-default',
        sandbox: settings.sandbox, approvalPolicy: settings.approvalPolicy,
        networkAccess: settings.config?.['sandbox_workspace_write.network_access'], webSearch: settings.config?.web_search } });
      const turnId = 'turn_' + randomUUID(); turns.set(params.threadId, turnId);
      (histories[params.threadId] ||= []).push({ id: turnId, status: 'inProgress', items: [{ id: 'user-' + turnId, type: 'userMessage', content: params.input }] }); saveHistory();
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
      result(message.id, { turn: { id: turnId, status: 'inProgress', items: [] } });
      void execute(params.threadId, turnId, params.input).catch((error) => notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'failed', error: { message: error.message }, items: [] } }));
      break;
    }
    case 'turn/interrupt': {
      clearTimeout(compactTimers.get(params.threadId)); compactTimers.delete(params.threadId);
      const turn = histories[params.threadId]?.find(item => item.id === params.turnId);
      if (turn) { turn.status = 'interrupted'; saveHistory(); }
      result(message.id, {});
      notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] } });
      turns.delete(params.threadId); break;
    }
    default: send({ id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
});
