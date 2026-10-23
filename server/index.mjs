import { createServer as httpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PlannerStore } from './store.mjs';
import { PlannerError, object, onlyKeys } from './model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);
const MAX_BODY = 4 * 1024 * 1024;
function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); }
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new PlannerError('CONTENT_TYPE', '请使用 application/json', 415);
  if (Number(request.headers['content-length']) > MAX_BODY) { request.resume(); throw new PlannerError('BODY_TOO_LARGE', '请求超过 4 MiB 上限', 413); }
  return new Promise((resolveBody, reject) => {
    let chunks = []; let bytes = 0; let exceeded = false;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) {
        chunks = [];
        if (!exceeded) reject(new PlannerError('BODY_TOO_LARGE', '请求超过 4 MiB 上限', 413));
        exceeded = true; return;
      }
      if (!exceeded) chunks.push(chunk);
    });
    request.on('end', () => {
      if (exceeded) return;
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new PlannerError('INVALID_JSON', 'JSON 无效')); }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new PlannerError('REQUEST_ABORTED', '请求已中止')));
  });
}

export function createServer(options = {}) {
  const store = new PlannerStore({
    dataDir: options.dataDir ?? process.env.DAILY_PLANNER_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'DailyPlanner'),
    timezone: options.timezone ?? process.env.DAILY_PLANNER_TIMEZONE ?? 'Asia/Shanghai',
    ...(options.now ? { now: options.now } : {}),
  });
  const clients = new Set(); const instanceId = randomUUID();
  const server = httpServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address(); const port = typeof address === 'object' && address ? address.port : 43117;
      const host = `127.0.0.1:${port}`; const origin = `http://${host}`;
      if (request.headers.host !== host) throw new PlannerError('HOST_FORBIDDEN', '仅允许 127.0.0.1 本机访问', 403);
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new PlannerError('ORIGIN_FORBIDDEN', '请求来源不受信任', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new PlannerError('ORIGIN_FORBIDDEN', '拒绝跨站请求', 403);
      const pathname = new URL(request.url, origin).pathname;
      if (request.method === 'GET' && pathname === '/health') { json(response, 200, { ok: true, app: 'daily-planner', pid: process.pid, instanceId }); return; }
      if (request.method === 'GET' && pathname === '/api/state') { json(response, 200, store.state()); return; }
      if (request.method === 'GET' && pathname === '/api/export') {
        response.setHeader('Content-Disposition', 'attachment; filename="daily-planner.json"');
        const state = store.state(); json(response, 200, { schemaVersion: 1, timezone: state.timezone, tasks: state.tasks }); return;
      }
      if (request.method === 'GET' && pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        response.write(`event: change\ndata: ${JSON.stringify({ revision: store.revision() })}\n\n`);
        clients.add(response); request.on('close', () => clients.delete(response)); return;
      }
      if (request.method === 'POST' && pathname === '/api/operations') {
        if (request.headers['x-daily-planner'] !== '1') throw new PlannerError('REQUEST_HEADER', '缺少 X-Daily-Planner: 1', 403);
        const body = object(await readBody(request)); onlyKeys(body, ['operation', 'args', 'expectedRevision']);
        const result = store.operation(body.operation, body.args ?? {}, body.expectedRevision);
        json(response, 200, result);
        if (result.changeId) for (const client of clients) client.write(`event: change\ndata: ${JSON.stringify({ revision: result.revision, changeId: result.changeId })}\n\n`);
        return;
      }
      if (request.method === 'GET' && assets.has(pathname)) {
        const [name, mime] = assets.get(pathname);
        let content; try { content = readFileSync(join(root, 'web', name)); } catch { throw new PlannerError('ASSET_MISSING', '编辑页面资源缺失，请重新构建或安装', 503); }
        response.writeHead(200, { 'Content-Type': mime }); response.end(content); return;
      }
      if (pathname.startsWith('/api/') || pathname === '/health') throw new PlannerError('METHOD_OR_ROUTE', '接口或请求方法不存在', 404);
      throw new PlannerError('NOT_FOUND', '页面不存在', 404);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof PlannerError ? error.status : 500;
      if (status === 500) process.stderr.write(`[DailyPlanner] ${new Date().toISOString()} ${error.code ?? error.name}: ${error.message}\n`);
      json(response, status, { error: { code: error instanceof PlannerError ? error.code : 'INTERNAL', message: error instanceof PlannerError ? error.message : '本地服务错误，本次操作未保存' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.plannerStore = store;
  const close = server.close.bind(server);
  server.close = (...args) => { for (const client of clients) client.end(); clients.clear(); return close(...args); };
  server.on('close', () => store.close());
  return server;
}

export async function startServer(options = {}) {
  const port = options.port ?? Number(process.env.DAILY_PLANNER_PORT ?? 43117);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DAILY_PLANNER_PORT 必须为 1–65535');
  const server = createServer(options);
  try {
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  } catch (error) { server.plannerStore.close(); throw error; }
  return server;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const server = await startServer();
    process.stdout.write(`[DailyPlanner] http://127.0.0.1:${server.address().port} (${server.plannerStore.timezone})\n`);
    let stopping = false;
    const stop = () => {
      if (stopping) return; stopping = true;
      server.close(() => { process.exitCode = 0; });
      const deadline = setTimeout(() => { server.closeAllConnections(); }, 3000); deadline.unref();
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } catch (error) { process.stderr.write(`[DailyPlanner] ${error.message}\n`); process.exitCode = 1; }
}
