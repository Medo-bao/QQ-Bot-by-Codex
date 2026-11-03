import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';

/** Local-only protocol peer: never reaches OpenAI and never sends real QQ messages. */
export async function liveFixture() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests = [];
  let mode = 'success';
  const pcm = Buffer.alloc(4800); for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(offset % 4 ? -2000 : 2000, offset);
  const tail = Buffer.alloc(48, 4000 & 255); for (let offset = 0; offset < tail.length; offset += 2) tail.writeInt16LE(4000, offset);
  server.on('connection', (socket, request) => {
    const connectionMode = mode;
    requests.push({ authorization: request.headers.authorization, events: [] });
    const record = requests.at(-1);
    const send = value => socket.send(JSON.stringify(value));
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); record.events.push(event);
      if (event.type === 'session.start') {
        if (connectionMode === 'error') { send({ type: 'error', error: { message: 'invalid credential fixture-api-secret' } }); return; }
        send({ type: 'session.started', session: { id: `live_fixture_${requests.length}`, model: 'gpt-live-1' } });
      } else if (event.type === 'session.commentary.append' && ['success', 'filtered'].includes(connectionMode)) {
        send({ type: 'session.output_transcript.delta', delta: '你好，' });
        send({ type: 'session.output_transcript.delta', delta: '语音接口已接入。' });
        send({ type: 'session.output_audio.delta', delta: pcm.toString('base64') });
        send({ type: 'session.output_audio.delta', delta: Buffer.alloc(48000).toString('base64') });
      } else if (event.type === 'session.close') {
        if (connectionMode === 'disconnect') { socket.close(); return; }
        if (connectionMode === 'success') send({ type: 'session.output_audio.delta', delta: tail.toString('base64') });
        send({ type: 'session.closed', reason: connectionMode === 'filtered' ? 'content' : 'close_requested', usage: { seconds: 1.1 } });
      } else if (connectionMode === 'disconnect' && event.type === 'session.commentary.append') socket.close();
    });
  });
  return {
    requests, setMode(value) { mode = value; },
    socket(url, key) { if (url !== 'wss://api.openai.com/v1/live/sessions') throw new Error('Unexpected API URL'); return new WebSocket(`ws://127.0.0.1:${server.address().port}`, { headers: { Authorization: `Bearer ${key}` } }); },
    async close() { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); },
  };
}
