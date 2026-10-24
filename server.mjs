// Chat Web 服务器：dsh 聊天界面 + /dsh-api 桥接 + 对话模型执行。
// 纯聊天：没有 CLI 子代理、没有任务板；每个会话就是一条线程，回复由 lib/provider.mjs
// 直连 OpenAI 兼容接口（chat.config.json）逐字流出。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chats } from './core/chats.mjs';
import { Runner } from './core/runner.mjs';
import { createBridge } from './bridge/dsh-bridge.mjs';
import { loadChatConfig, healthView } from './lib/models.mjs';
import { UiState } from './lib/uistate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DSH = path.join(ROOT, 'dsh-web');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json' };
const PLUGINS = (() => { try { return JSON.parse(fs.readFileSync(path.join(DSH, 'plugins', 'map.json'), 'utf8')); } catch { return {}; } })();
// 首页是 dsh 界面（dsh-web/ 为 deepseek-harness 的本地构建），注入标题与传输脚本；
// AR_STREAM_PORT 告诉前端把常驻会话流指到独立端口：dsh 一开就是 5 条长流，混在主端口会占满
// 浏览器对单域名的 6 连接上限，普通接口请求会永远排队，页面就会"加载不出来"
const STREAM_PORT = Number(process.env.PORT || 2299) + 1;
const INDEX = (() => {
  try {
    return fs.readFileSync(path.join(DSH, 'index.html'), 'utf8')
      .replace('<title>DSH Local Build</title>', '<title>Chat Web · 对话模型</title>')
      .replace('</head>', `<script>window.AR_STREAM_PORT=${STREAM_PORT}</script><script src="/chat-transport.js" defer></script></head>`);
  } catch {
    return null;
  }
})();
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) { let value = ''; for await (const c of req) { value += c; if (value.length > 5e7) throw new Error('请求内容过长'); } return value; }
function file(res, root, name) {
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); fs.createReadStream(full).pipe(res);
}

export function createApp({ dataDir = process.env.CHAT_WEB_DATA_DIR || path.join(ROOT, 'data') } = {}) {
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const chats = new Chats(dataDir);
  const runner = new Runner(chats, { baseDir: ROOT, config: loadChatConfig });
  runner.recover();
  const uiState = new UiState(dataDir);
  const bridge = createBridge({ chats, runner, chatConfig: loadChatConfig, dataDir, uiState });
  const server = http.createServer(handler);
  return { server, handler, chats, runner, bridge };
  async function handler(req, res) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      // 流端口与主端口是不同源：预检放行；流应答带 CORS，但只放行同主机名的页面（防任意网站跨站读取）
      const originHost = (() => { try { return new URL(req.headers.origin || 'x://x').hostname; } catch { return null; } })();
      const cors = originHost && originHost === (req.headers.host || '').split(':')[0]
        ? { 'Access-Control-Allow-Origin': req.headers.origin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST', Vary: 'Origin' }
        : {};
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (parts[0] === 'dsh-api' || parts[0] === 'dsh-api-stream') {
        const endpoint = parts.slice(1).join('/');
        if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
        const raw = await body(req);
        let payload;
        try { payload = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: { code: 'router/bad-json', message: 'invalid JSON', details: {} } }); }
        if (parts[0] === 'dsh-api') {
          try { return json(res, 200, bridge.unary(endpoint, payload)); }
          catch (e) { return json(res, 200, { ok: false, error: { code: 'router/request-failed', message: e.message, details: {} } }); }
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...cors });
        let closed = false;
        const send = frame => { if (!closed) { try { res.write(JSON.stringify(frame) + '\n'); } catch {} } };
        let cleanup = () => {};
        try { cleanup = bridge.stream(endpoint, payload, send); }
        catch (e) { send({ type: 'error', error: { code: 'router/stream-failed', message: e.message } }); res.end(); }
        res.on('close', () => { closed = true; cleanup(); });
        return;
      }
      if (u.pathname === '/api/health') {
        const cfg = loadChatConfig();
        return json(res, 200, {
          ready: true, default: cfg.default, systemPrompt: !!cfg.systemPrompt,
          models: healthView(cfg),
          chats: chats.list().length, running: chats.list().filter(c => c.busy).length
        });
      }
      if (u.pathname === '/api/workspace') {
        if (req.method === 'GET') return json(res, 200, { repo: uiState.workspaceRepo || path.join(dataDir, 'workspace'), title: uiState.workspaceTitle });
        if (req.method === 'PATCH') {
          const input = String((JSON.parse((await body(req)) || '{}')).repo || '');
          let repo;
          try { repo = fs.realpathSync(path.resolve(input)); } catch { throw new Error(`目录不存在：${input}`); }
          if (!fs.statSync(repo).isDirectory()) throw new Error('工作目录必须是文件夹');
          uiState.setWorkspaceRepo(repo);
          return json(res, 200, { repo });
        }
      }
      if (u.pathname === '/api/session/uploadFileBinary' && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 5e7) throw new Error('请求内容过长'); chunks.push(c); }
        const meta = bridge.unary('fileUploads/upload', { request: { data: Buffer.concat(chunks).toString('base64'), name: u.searchParams.get('name') || 'file' } });
        if (!meta.ok) throw new Error(meta.error.message);
        return json(res, 200, { ok: true, value: { receiptId: meta.value.receiptId, file: meta.value.file } });
      }
      if (parts[0] === 'api') return json(res, 404, { error: '接口不存在' });
      if (['/', '/index.html'].includes(u.pathname)) {
        if (!INDEX) { res.writeHead(500); return res.end('dsh-web build missing'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); return res.end(INDEX);
      }
      if (u.pathname === '/chat-transport.js') return file(res, path.join(ROOT, 'public'), 'chat-transport.js');
      if (parts[0] === 'plugins') {
        const key = PLUGINS[u.pathname.slice(1) + u.search] || PLUGINS[u.pathname.slice('/plugins/'.length) + u.search];
        return key ? file(res, path.join(DSH, 'plugins'), key) : json(res, 404, { error: '插件资源不存在' });
      }
      if (parts[0] === 'assets' || /favicon|manifest/.test(u.pathname)) return file(res, path.join(DSH, 'dist'), u.pathname.slice(1));
      return file(res, path.join(DSH, 'dist'), parts.join('/'));
    } catch (e) { if (res.headersSent) return res.end(); json(res, e.code === 'ENOENT' ? 404 : 400, { error: e.message }); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, handler } = createApp(); const port = Number(process.env.PORT || 2299);
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.error(`端口 ${port} 已被占用（可能已有一个 Chat Web 在跑）。换端口：PORT=2299 node server.mjs`); process.exit(1); }
    throw e;
  });
  server.listen(port, '127.0.0.1', () => console.log(`Chat Web: http://127.0.0.1:${server.address().port}`));
  // 常驻会话流单独一个端口：流各占一条连接且永不结束，混在主端口会把浏览器同域 6 连接占满，
  // 页面的普通请求就永远排队。独立端口有自己的连接池；起不来时前端自动回退同源（回到旧行为）
  const streams = http.createServer(handler);
  streams.on('error', e => console.error(`会话流端口 ${port + 1} 不可用（${e.message}），前端将回退同源流`));
  streams.listen(port + 1, '127.0.0.1', () => console.log(`Chat Web 会话流: http://127.0.0.1:${streams.address().port}`));
}
