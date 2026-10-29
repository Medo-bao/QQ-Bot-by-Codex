import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { BotController } from './controller.ts';
import { uiDocument } from './ui-document.ts';

export class SetupPage {
  private server?: Server;
  private url?: string;
  private readonly token = randomUUID();
  constructor(private readonly controller: BotController, private readonly shutdown?: () => Promise<void>) {}

  async open(): Promise<string> {
    if (this.url) return this.url;
    const server = createServer(async (request, response) => {
      const address = server.address();
      if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) { response.writeHead(403).end(); return; }
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      const token = url.searchParams.get('token');
      const cookie = request.headers.cookie?.split(';').some((entry) => entry.trim() === `qqbot_setup=${this.token}`);
      if (token !== this.token && !cookie) { response.writeHead(403).end('Access denied'); return; }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      if (token === this.token) response.setHeader('Set-Cookie', `qqbot_setup=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
      if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(uiDocument('http')); return; }
      if (!url.pathname.startsWith('/api/')) { response.writeHead(404).end(); return; }
      const action = url.pathname.slice(5);
      try {
        let input: Record<string, unknown> = {};
        if (request.method === 'POST') {
          if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { response.writeHead(403).end(); return; }
          let body = '';
          for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 512 * 1024) throw new Error('请求超过 512 KB。'); }
          input = body ? JSON.parse(body) : {};
        } else if (request.method !== 'GET' || !['status', 'models', 'catalog', 'account', 'qr'].includes(action)) { response.writeHead(405).end(); return; }
        const result = action === 'shutdown' ? { stopped: true } : await this.controller.invoke(action, input);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        if (action === 'shutdown' && this.shutdown) setTimeout(() => { void this.shutdown!(); }, 50);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    this.server = server;
    const address = server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}/?token=${this.token}`;
    return this.url;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined; this.url = undefined;
  }
}
