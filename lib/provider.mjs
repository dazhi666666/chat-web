// 聊天模型 provider：任何 OpenAI 兼容的 /chat/completions 端点（DeepSeek、Kimi、Qwen、OpenRouter、
// Ollama、vLLM …），可选 HTTP 代理。自定义接入用 { module } 指向一个 JS 文件，默认导出
// provider 对象或 (config) => provider 工厂。
//
// provider 形状：{ label?, complete(messages, { signal, onDelta }) → Promise<{ text, reasoning? }> }
// messages 是 OpenAI 风格的 [{ role: 'system'|'user'|'assistant', content: string }]；
// onDelta(text) 在每个正文增量到达时回调（仅流式），供逐字上屏。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {object} cfg  { module } | { baseUrl, model, apiKey?, apiKeyEnv?, headers?, params?, proxy?, timeoutSec? }
 * @param {{ baseDir?: string }} opts  相对 module 路径以 baseDir 为根解析
 */
export async function createProvider(cfg, { baseDir = process.cwd() } = {}) {
  if (!cfg) throw new Error('no chat model configured');
  if (cfg.module) {
    const mod = await import(pathToFileURL(path.resolve(baseDir, cfg.module)).href);
    const exp = mod.default ?? mod;
    return typeof exp === 'function' ? await exp(cfg) : exp;
  }
  return openAiProvider(cfg);
}

/** 不发请求的前提下判断配置是否可用（健康检查用） */
export function providerReady(cfg) {
  if (!cfg) return false;
  if (cfg.module) return true;
  return !!(cfg.baseUrl && cfg.model && (cfg.apiKey || (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) || cfg.noAuth));
}

export function openAiProvider(cfg) {
  const { baseUrl, model, headers = {}, params = {}, proxy = null, timeoutSec = 600 } = cfg;
  if (!baseUrl || !model) throw new Error('chat model config needs baseUrl and model');
  return {
    label: cfg.label || model,
    async complete(messages, { signal, onDelta } = {}) {
      const apiKey = cfg.apiKey || (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : null);
      if (!apiKey && !cfg.noAuth) throw new Error(`API key missing: set ${cfg.apiKeyEnv || 'apiKey'}`);
      const url = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`);
      const body = JSON.stringify({ model, messages, ...params, stream: true });
      const res = await request(url, {
        method: 'POST', proxy, signal, timeoutMs: timeoutSec * 1000, body,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers }
      });
      if (res.statusCode >= 400) {
        const raw = await readAll(res);
        let msg = raw;
        try { const j = JSON.parse(raw); msg = j.error?.message || j.message || raw; } catch {}
        throw new Error(`HTTP ${res.statusCode}: ${String(msg).slice(0, 500)}`);
      }
      return readCompletion(res, onDelta);
    }
  };
}

/** 累积一条流式（SSE）或普通 JSON 的补全；onDelta 逐段回调正文增量 */
async function readCompletion(res, onDelta) {
  let text = '', reasoning = '', buf = '', plain = '';
  const isSse = /event-stream/.test(res.headers['content-type'] || '');
  for await (const chunk of res) {
    if (!isSse) { plain += chunk; continue; }
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
      const d = ev.choices?.[0]?.delta || {};
      if (d.content) { text += d.content; onDelta?.(d.content); }
      if (d.reasoning_content) reasoning += d.reasoning_content;
      else if (d.reasoning) reasoning += d.reasoning;
    }
  }
  if (!isSse) {
    const j = JSON.parse(plain);
    const m = j.choices?.[0]?.message || {};
    text = m.content || '';
    reasoning = m.reasoning_content || m.reasoning || '';
    onDelta?.(text);
  }
  return { text, reasoning };
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let s = '';
    stream.setEncoding('utf8');
    stream.on('data', d => { s += d; });
    stream.on('end', () => resolve(s));
    stream.on('error', reject);
  });
}

/** http(s) 请求，可选 HTTP CONNECT 代理与整体超时（不用 undici 的空闲限制） */
async function request(url, { method, headers, body, proxy, timeoutMs, signal }) {
  const secure = url.protocol === 'https:';
  const port = Number(url.port) || (secure ? 443 : 80);
  const opts = { method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, host: url.hostname, port, path: url.pathname + url.search };
  if (proxy) {
    const p = new URL(proxy);
    const auth = p.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}` } : {};
    if (secure) {
      const socket = await connectTunnel(p, url.hostname, port, auth);
      opts.createConnection = () => tls.connect({ socket, servername: url.hostname });
      opts.agent = false;
    } else {
      Object.assign(opts, { host: p.hostname, port: Number(p.port) || 80, path: url.href, headers: { ...opts.headers, ...auth } });
    }
  }
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(opts, res => { res.setEncoding('utf8'); resolve(res); });
    const timer = setTimeout(() => req.destroy(new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    timer.unref?.();
    const abort = () => req.destroy(new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    req.on('error', reject);
    req.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
    req.end(body);
  });
}

function connectTunnel(p, host, port, auth) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: Number(p.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers: { Host: `${host}:${port}`, ...auth } });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else { socket.destroy(); reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`)); }
    });
    req.once('error', reject);
    req.end();
  });
}
