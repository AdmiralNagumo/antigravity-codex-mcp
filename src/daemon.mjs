import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { CodexClient } from './codex.mjs';
import { Manager } from './manager.mjs';
import { dispatch } from './tools.mjs';

export async function startDaemon(config, client = new CodexClient(config)) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const manager = new Manager(config, client);
  await manager.load();
  const token = randomBytes(32).toString('hex');
  let stopping = false;
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      const expected = Buffer.from(`Bearer ${token}`);
      const received = Buffer.from(req.headers.authorization || '');
      // No CORS. Webviews use extension-host IPC; MCP Apps use host tools/call.
      if (req.headers.origin || received.length !== expected.length || !timingSafeEqual(received, expected)) { json(403, { error: 'Forbidden' }); return; }
      if (req.method === 'GET' && req.url === '/health') { json(200, { ok: true, version: '0.1.0' }); return; }
      if (req.method === 'GET' && req.url === '/config') { json(200, { roots: config.roots, command: config.command, commandArgs: config.commandArgs }); return; }
      if (req.method !== 'POST') { json(404, { error: 'Not found' }); return; }
      let body = '';
      let bytes = 0;
      req.setEncoding('utf8');
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) { json(413, { error: 'Request too large' }); return; }
        body += chunk;
      }
      if (req.url === '/shutdown') {
        json(200, { ok: true });
        setImmediate(() => close());
      } else if (req.url === '/api/tool') {
        const data = JSON.parse(body);
        const result = await dispatch(manager, data.name, data.arguments);
        json(200, result);
      } else json(404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) json(400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const runtime = { url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid, startedAt: new Date().toISOString() };
  const filename = path.join(config.stateDir, 'runtime.json');
  await fs.writeFile(filename + '.tmp', JSON.stringify(runtime), { mode: 0o600 });
  await fs.rename(filename + '.tmp', filename);
  async function close() {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeIdleConnections();
    await manager.close();
    try { if (JSON.parse(await fs.readFile(filename, 'utf8')).token === token) await fs.unlink(filename); } catch {}
  }
  return { server, runtime, manager, close };
}
