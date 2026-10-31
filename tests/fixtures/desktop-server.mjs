import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function desktopFixture(directory, options = {}) {
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\qqbot-desktop-test-${randomUUID()}` : join(directory, 'desktop.sock');
  const owner = 'desktop-control-owner';
  const threads = new Map([
    [owner, { id: owner, kind: 'codex', title: '控制会话', cwd: directory, hostId: 'local', turns: [{ id: 'control-turn', status: 'completed', items: [] }] }],
    ['desktop-alpha', { id: 'desktop-alpha', kind: 'codex', title: '原有项目会话', cwd: join(directory, 'Project Alpha'), hostId: 'local',
      turns: [{ id: 'old-alpha', status: 'completed', items: [{ type: 'agentMessage', id: 'old-answer', phase: 'final_answer', text: '旧结果，不能作为新任务的结果回传。' }] }] }],
    ['desktop-beta', { id: 'desktop-beta', kind: 'codex', title: '忙碌的原会话', cwd: join(directory, 'Project Beta'), hostId: 'local', turns: [{ id: 'old-beta', status: 'inProgress', items: [] }] }],
  ]);
  const calls = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0); if (buffer.length < length + 4) return;
        const request = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
        calls.push(request); let result;
        if (request.method === 'tools/list') result = { tools: ['list_threads', 'list_projects', 'read_thread', 'send_message_to_thread', 'wait_threads'].map(name => ({ name, namespace: 'codex_app' })) };
        else {
          const p = request.params; const args = p.arguments;
          if (p.threadId !== owner || (['wait_threads', 'send_message_to_thread'].includes(p.tool) && p.turnId !== 'control-turn')) throw new Error('Incorrect source conversation context');
          let content;
          if (p.tool === 'list_threads') content = { threads: [...threads.values()].map(({ turns, ...thread }) => ({ ...thread, status: turns[0]?.status === 'inProgress' ? 'active' : 'idle' })), nextCursor: null };
          else if (p.tool === 'read_thread') {
            if (args.turnLimit > 10) throw new Error('Native turnLimit must be at most 10');
            const thread = threads.get(args.threadId); const { turns, ...info } = thread;
            content = { thread: { ...info, status: { type: turns[0]?.status === 'inProgress' ? 'active' : 'idle', activeFlags: thread.activeFlags || [] } },
              turns: turns.slice(0, args.turnLimit).map(turn => ({ ...turn, items: turn.items.filter(item => item.type !== 'userMessage') })),
              page: { hasMore: false, nextCursor: null } };
          }
          else if (p.tool === 'send_message_to_thread') {
            const thread = threads.get(args.threadId);
            options.beforeDispatch?.(thread, args);
            thread.turns.unshift({ id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: randomUUID(), content: [{ type: 'text', text: args.prompt }] }] });
            if (options.acknowledge !== false) thread.turns[0].items.push({ type: 'agentMessage', phase: 'commentary', text: args.prompt.split('\n')[0] + '\n正在执行任务。' });
            content = { accepted: true, threadId: args.threadId };
          } else if (p.tool === 'wait_threads') throw new Error('Native wait_threads requires an active caller; this fixture caller has completed');
          else throw new Error('Unexpected desktop operation');
          result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(content) }] };
        }
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
        socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), payload]));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipePath, resolve); });
  return { pipePath, owner, threads, calls,
    finish(id, text = '新的任务结果已完成。') { const turn = threads.get(id).turns[0]; turn.status = 'completed';
      const prompt = turn.items.find(item => item.type === 'userMessage')?.content[0]?.text;
      turn.items.push({ type: 'agentMessage', id: randomUUID(), phase: 'final_answer', text: options.acknowledge !== false && prompt ? prompt.split('\n')[0] + '\n' + text : text }); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
