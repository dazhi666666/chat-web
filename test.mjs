// Chat Web 测试：node --test test.mjs
// 覆盖：配置加载、provider（SSE/鉴权/ reasoning）、会话存储、runner（回合/排队/中止/系统提示词）、
// dsh 桥（unary 全链路、selectModel、session/follow 流式帧）、HTTP 服务器冒烟。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(60); }
  throw new Error(`timeout waiting for ${what}`);
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-web-test-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const ENV_KEYS = ['CHAT_WEB_CONFIG'];
function withConfig(t, obj) {
  const file = path.join(tmp(t), 'chat.config.json');
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.CHAT_WEB_CONFIG = file;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  return file;
}

/** OpenAI 兼容 /chat/completions mock：SSE 分片 + 可控延迟/失败/reasoning，记录请求体 */
function startMock(t, { chunks = ['你', '好', '！'], gap = 25, reasoning = '', fail = null } = {}) {
  const state = { requests: [], options: { chunks, gap, reasoning, fail } };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    state.requests.push(JSON.parse(body || '{}'));
    const o = state.options;
    if (o.fail) {
      res.writeHead(o.fail.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: o.fail.message || 'mock failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = v => res.write(`data: ${JSON.stringify(v)}\n\n`);
    if (o.reasoning) send({ choices: [{ delta: { reasoning_content: o.reasoning } }] });
    for (const c of o.chunks) { send({ choices: [{ delta: { content: c } }] }); await sleep(o.gap); }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => server.close(r)));
      resolve({ state, url: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

const configFor = (mock, extra = {}) => ({
  default: 'mock',
  systemPrompt: '你是测试助手。',
  models: { mock: { label: 'Mock', baseUrl: mock.url, model: 'mock-model', apiKey: 'k-mock', contextWindow: 32000 }, ...extra.models },
  ...extra
});

// ---------- lib/models ----------

test('models: 配置加载、默认值与校验', async t => {
  const mock = await startMock(t);
  withConfig(t, configFor(mock));
  const { loadChatConfig, modelCatalog, resolveModel } = await import('./lib/models.mjs');
  const cfg = loadChatConfig();
  assert.equal(cfg.default, 'mock');
  assert.equal(cfg.systemPrompt, '你是测试助手。');
  assert.equal(cfg.models.mock.baseUrl, mock.url);
  const catalog = modelCatalog(cfg);
  assert.equal(catalog.groups[0].models[0].id, 'mock');
  assert.equal(catalog.default.model, 'mock');
  assert.equal(resolveModel(cfg, 'mock').model, 'mock-model');
  assert.throws(() => resolveModel(cfg, 'nope'), /未知模型/);
});

test('models: 坏配置报错（缺 models / 未知字段 / 缺 baseUrl）', async t => {
  const { loadChatConfig } = await import('./lib/models.mjs');
  withConfig(t, { models: {} });
  assert.throws(() => loadChatConfig(), /models/);
  withConfig(t, { models: { a: { baseUrl: 'http://x', model: 'm', bogus: 1 } } });
  assert.throws(() => loadChatConfig(), /未知字段/);
  withConfig(t, { models: { a: { label: 'A' } } });
  assert.throws(() => loadChatConfig(), /baseUrl/);
});

// ---------- lib/provider ----------

test('provider: SSE 流式增量与 reasoning 捕获', async t => {
  const mock = await startMock(t, { chunks: ['a', 'b', 'c'], gap: 10, reasoning: '想一想' });
  const { createProvider } = await import('./lib/provider.mjs');
  const p = await createProvider({ baseUrl: mock.url, model: 'm', apiKey: 'k' });
  const deltas = [];
  const res = await p.complete([{ role: 'user', content: 'hi' }], { onDelta: d => deltas.push(d) });
  assert.equal(res.text, 'abc');
  assert.equal(res.reasoning, '想一想');
  assert.deepEqual(deltas, ['a', 'b', 'c']);
});

test('provider: 缺 API key 与 HTTP 错误', async t => {
  const mock = await startMock(t);
  const { createProvider } = await import('./lib/provider.mjs');
  const p = await createProvider({ baseUrl: mock.url, model: 'm', apiKeyEnv: 'CHAT_WEB_TEST_MISSING_KEY' });
  await assert.rejects(() => p.complete([{ role: 'user', content: 'x' }]), /API key missing/);
  const bad = await startMock(t, { fail: { status: 401, message: 'bad key' } });
  const p2 = await createProvider({ baseUrl: bad.url, model: 'm', apiKey: 'k' });
  await assert.rejects(() => p2.complete([{ role: 'user', content: 'x' }]), /HTTP 401/);
});

// ---------- core/chats ----------

test('chats: 会话落盘、条目 seq、busy、列表', async t => {
  const dir = tmp(t);
  const { Chats } = await import('./core/chats.mjs');
  const chats = new Chats(dir);
  const s = chats.create('sess-1');
  assert.equal(s.chatId, null);
  const chatId = chats.ensureChat('sess-1', 'mock');
  assert.match(chatId, /^c-\d+-[0-9a-z]{6}$/);
  chats.appendEntry(chatId, 'system', { text: 'sys' });
  const e1 = chats.appendEntry(chatId, 'user', { text: '你好' });
  const e2 = chats.appendEntry(chatId, 'user', { text: '再来' });
  assert.equal(e2.seq, e1.seq + 1);
  assert.equal(chats.readEntries(chatId).length, 3);
  chats.setBusy(chatId, true);
  assert.equal(chats.busy(chatId), true);
  chats.setBusy(chatId, false);
  // 草稿会话与聊天会话都出现在列表里
  chats.create('draft-x');
  assert.equal(chats.list().length, 1);
  chats.setModel('sess-1', 'other');
  assert.equal(chats.chat(chatId).model, 'other');
  // 无 id 的 create 兜底为 draft 随机 id
  const anon = chats.create();
  assert.match(anon.id, /^draft-/);
});

// ---------- core/runner ----------

test('runner: 一个回合（历史、流文件、用量、busy 复位）', async t => {
  const mock = await startMock(t, { chunks: ['回', '复', '啦'], gap: 15 });
  withConfig(t, configFor(mock));
  const { loadChatConfig } = await import('./lib/models.mjs');
  const { Chats } = await import('./core/chats.mjs');
  const { Runner } = await import('./core/runner.mjs');
  const dir = tmp(t);
  const chats = new Chats(dir);
  const runner = new Runner(chats, { config: loadChatConfig });
  runner.recover();
  const chatId = chats.ensureChat('s-run');
  chats.appendEntry(chatId, 'system', { text: '你是测试助手。' });
  const r = runner.submit(chatId, '打个招呼');
  assert.ok(r.accepted);
  await waitFor(() => chats.readEntries(chatId).at(-1)?.kind === 'result', 8000, 'result entry');
  const kinds = chats.readEntries(chatId).map(e => e.kind);
  assert.deepEqual(kinds, ['system', 'user', 'assistant', 'result']);
  const result = chats.readEntries(chatId).at(-1);
  assert.equal(result.data.text, '回复啦');
  assert.equal(result.data.isError, false);
  assert.ok(result.data.usage.outputTokens > 0);
  assert.ok(result.data.usage.inputTokens > 0);
  assert.equal(chats.busy(chatId), false);
  // 流文件：增量 + done 收尾
  const stream = fs.readFileSync(chats.streamPath(chatId), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(stream.at(-1).done, 1);
  assert.equal(stream.filter(f => f.text).map(f => f.text).join(''), '回复啦');
  // 发给模型的请求：system + user
  const req = mock.state.requests.at(-1);
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[0].content, '你是测试助手。');
  assert.equal(req.messages.at(-1).content, '打个招呼');
});

test('runner: 系统提示词在 ensureChat 时快照', async t => {
  const mock = await startMock(t, { chunks: ['ok'], gap: 5 });
  withConfig(t, configFor(mock));
  const { loadChatConfig } = await import('./lib/models.mjs');
  const { Chats } = await import('./core/chats.mjs');
  const { Runner } = await import('./core/runner.mjs');
  const chats = new Chats(tmp(t));
  const runner = new Runner(chats, { config: loadChatConfig });
  const chatId = chats.ensureChat('s-sys');
  chats.appendEntry(chatId, 'system', { text: '你是测试助手。' }); // 桥在首条消息前写入
  runner.submit(chatId, 'hi');
  await waitFor(() => chats.readEntries(chatId).at(-1)?.kind === 'result', 8000, 'result');
  assert.equal(mock.state.requests.at(-1).messages[0].content, '你是测试助手。');
});

test('runner: 忙时排队，回合结束自动续跑', async t => {
  const mock = await startMock(t, { chunks: ['1234567890'.split('')].flat(), gap: 40 });
  withConfig(t, configFor(mock));
  const { loadChatConfig } = await import('./lib/models.mjs');
  const { Chats } = await import('./core/chats.mjs');
  const { Runner } = await import('./core/runner.mjs');
  const chats = new Chats(tmp(t));
  const runner = new Runner(chats, { config: loadChatConfig });
  const chatId = chats.ensureChat('s-q');
  runner.submit(chatId, '第一条');
  await waitFor(() => runner.busy(chatId), 4000, 'busy');
  const r2 = runner.submit(chatId, '第二条');
  assert.ok(r2.queued);
  const queued = chats.readEntries(chatId).find(e => e.kind === 'user' && e.data.queued);
  assert.ok(queued, 'queued entry written');
  await waitFor(() => chats.readEntries(chatId).filter(e => e.kind === 'result').length === 2, 12000, 'two results');
  // 第二回合的历史包含第一条的问答与第二条消息
  const req2 = mock.state.requests.at(-1);
  const roles = req2.messages.map(m => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
  assert.equal(req2.messages.at(-1).content, '第二条');
  assert.equal(req2.messages[2].content, mock.state.options.chunks.join(''));
  assert.equal(chats.busy(chatId), false);
});

test('runner: 中止当前回复', async t => {
  const mock = await startMock(t, { chunks: ['慢', '速', '回', '复'], gap: 300 });
  withConfig(t, configFor(mock));
  const { loadChatConfig } = await import('./lib/models.mjs');
  const { Chats } = await import('./core/chats.mjs');
  const { Runner } = await import('./core/runner.mjs');
  const chats = new Chats(tmp(t));
  const runner = new Runner(chats, { config: loadChatConfig });
  const chatId = chats.ensureChat('s-abort');
  runner.submit(chatId, '慢慢说');
  await waitFor(() => runner.busy(chatId), 4000, 'busy');
  assert.ok(runner.abort(chatId));
  await waitFor(() => !runner.busy(chatId), 8000, 'not busy');
  const entries = chats.readEntries(chatId);
  const result = entries.at(-1);
  assert.equal(result.kind, 'result');
  assert.equal(result.data.isError, true);
  // 不自动续跑排队消息（本测没有排队消息，只验证回合终止）
  assert.ok(['user', 'assistant'].includes(entries.at(-2).kind));
});

test('runner: 模型失败落错误 result，不崩进程', async t => {
  const mock = await startMock(t, { fail: { status: 500, message: 'boom' } });
  withConfig(t, configFor(mock));
  const { loadChatConfig } = await import('./lib/models.mjs');
  const { Chats } = await import('./core/chats.mjs');
  const { Runner } = await import('./core/runner.mjs');
  const chats = new Chats(tmp(t));
  const runner = new Runner(chats, { config: loadChatConfig });
  const chatId = chats.ensureChat('s-fail');
  runner.submit(chatId, '会失败吗');
  await waitFor(() => chats.readEntries(chatId).at(-1)?.kind === 'result', 8000, 'result');
  const result = chats.readEntries(chatId).at(-1).data;
  assert.equal(result.isError, true);
  assert.match(result.text, /boom/);
});

// ---------- bridge ----------

function setup(t, mockOptions = {}) {
  return startMock(t, mockOptions).then(async mock => {
    withConfig(t, configFor(mock));
    const { loadChatConfig } = await import('./lib/models.mjs');
    const { Chats } = await import('./core/chats.mjs');
    const { Runner } = await import('./core/runner.mjs');
    const { createBridge } = await import('./bridge/dsh-bridge.mjs');
    const dir = tmp(t);
    const chats = new Chats(dir);
    const runner = new Runner(chats, { config: loadChatConfig });
    runner.recover();
    const bridge = createBridge({ chats, runner, chatConfig: loadChatConfig, dataDir: dir });
    return { mock, chats, runner, bridge, dir };
  });
}
const rpc = (bridge, endpoint, request) => bridge.unary(endpoint, { args: { request } });

test('bridge: 会话全链路（创建→选模型→提问→page/projections/modelCatalog）', async t => {
  const { mock, chats, bridge } = await setup(t, { chunks: ['你', '好'], gap: 20 });
  const { sessionId } = rpc(bridge, 'session/create', {}).value;
  assert.ok(sessionId);
  // 模型目录与选择
  const catalog = rpc(bridge, 'session/modelCatalog', { sessionId }).value;
  assert.equal(catalog.groups[0].models[0].id, 'mock');
  const sel = rpc(bridge, 'session/selectModel', { sessionId, provider: 'chat-web', model: 'mock' }).value;
  assert.equal(sel.selected.model, 'mock');
  assert.throws(() => rpc(bridge, 'session/selectModel', { sessionId, provider: 'chat-web', model: 'nope' }), /未知模型/);
  // 提问（requestId 供乐观气泡回收）
  const requestId = crypto.randomUUID();
  rpc(bridge, 'session/prompt', { sessionId, requestId, content: [{ type: 'text', text: '打个招呼' }] });
  await waitFor(() => {
    const events = rpc(bridge, 'session/page', { sessionId, address: { sessionId } }).value.records.map(r => r.event);
    return events.some(e => e.type === 'turn/end');
  }, 8000, 'turn end in page');
  const events = rpc(bridge, 'session/page', { sessionId, address: { sessionId } }).value.records.map(r => r.event);
  const userMsg = events.find(e => e.type === 'user/message' && e.data.source?.kind === 'user');
  const assistant = events.filter(e => e.type === 'assistant/message').at(-1);
  assert.equal(userMsg.data.source.rpcId, requestId, '乐观气泡回收 id');
  assert.equal(assistant.data.message.content.at(-1).text, '你好');
  assert.equal(assistant.data.message.source.model, 'Mock');
  // 会话列表与投影
  const list = rpc(bridge, 'session/list', {}).value.items;
  assert.ok(list.find(i => i.sessionId === sessionId && !i.blank));
  const proj = rpc(bridge, 'session/projections', { sessionId }).value.values;
  assert.equal(proj.modelSelection.lastUsed.model, 'mock');
  assert.ok(proj.tokenUsage.outputTokens > 0);
  // 侧栏标题 = 首条用户消息
  assert.match(list.find(i => i.sessionId === sessionId).title, /打个招呼/);
  assert.ok(mock.state.requests.at(-1).model);
});

test('bridge: prompt 落系统提示词条目；第二回合带历史', async t => {
  const { mock, chats, bridge } = await setup(t, { chunks: ['A'], gap: 10 });
  const { sessionId } = rpc(bridge, 'session/create', {}).value;
  rpc(bridge, 'session/prompt', { sessionId, content: [{ type: 'text', text: '第一问' }] });
  await waitFor(() => chats.readEntries(chats.resolve(sessionId).chatId).at(-1)?.kind === 'result', 8000, 'result 1');
  rpc(bridge, 'session/prompt', { sessionId, content: [{ type: 'text', text: '第二问' }] });
  await waitFor(() => chats.readEntries(chats.resolve(sessionId).chatId).filter(e => e.kind === 'result').length === 2, 8000, 'result 2');
  const req = mock.state.requests.at(-1);
  assert.equal(req.messages[0].content, '你是测试助手。'); // chat.config.json 的 systemPrompt
  assert.deepEqual(req.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
});

test('bridge: session/follow 流式帧（snapshot → start → chunks → end → step/end）', async t => {
  const { chats, bridge } = await setup(t, { chunks: ['流', '式', '输', '出'], gap: 120 });
  const { sessionId } = rpc(bridge, 'session/create', {}).value;
  const frames = [];
  const cleanup = bridge.stream('session/follow', { args: { request: { address: { sessionId } } } }, f => frames.push(f));
  try {
    rpc(bridge, 'session/prompt', { sessionId, content: [{ type: 'text', text: '流式测试' }] });
    await waitFor(() => frames.some(f => f.type === 'assistant-stream' && f.frame?.type === 'end'), 12000, 'assistant-stream end');
    const snap = frames.find(f => f.type === 'snapshot');
    assert.ok(snap, 'snapshot frame first');
    assert.equal(snap.header.version, 4);
    const starts = frames.filter(f => f.type === 'assistant-stream' && f.frame.type === 'start');
    const chunks = frames.filter(f => f.type === 'assistant-stream' && f.frame.type === 'chunk');
    const end = frames.find(f => f.type === 'assistant-stream' && f.frame.type === 'end');
    assert.ok(starts.length >= 1, 'start frame');
    assert.ok(chunks.length >= 2, 'multiple chunk frames');
    assert.deepEqual(chunks.map(f => f.frame.chunk.text).join(''), '流式输出');
    // revision 严格递增
    const revs = frames.filter(f => f.type === 'assistant-stream').map(f => f.frame.revision);
    assert.deepEqual(revs, revs.map((_, i) => i + 1));
    // end 结算到含正文的 assistant/message 事件，且先于该 step 的 step/end
    const events = frames.filter(f => f.type === 'event').map(f => f.event);
    const settled = events.find(e => e.seq === end.frame.outcome.seq);
    assert.equal(settled.type, 'assistant/message');
    const stepEnd = events.find(e => e.type === 'step/end' && e.data.step === settled.data.step);
    const endIdx = frames.findIndex(f => f.type === 'assistant-stream' && f.frame.type === 'end');
    const stepEndIdx = frames.findIndex(f => f.type === 'event' && f.event === stepEnd);
    assert.ok(stepEndIdx > endIdx, 'step/end after end frame');
  } finally { cleanup(); }
});

test('bridge: 忙时 prompt 的排队注记在回合结束后消失', async t => {
  const { chats, bridge } = await setup(t, { chunks: ['x', 'y', 'z'], gap: 150 });
  const { sessionId } = rpc(bridge, 'session/create', {}).value;
  rpc(bridge, 'session/prompt', { sessionId, content: [{ type: 'text', text: 'first' }] });
  await waitFor(() => chats.busy(chats.resolve(sessionId).chatId), 4000, 'busy');
  rpc(bridge, 'session/prompt', { sessionId, content: [{ type: 'text', text: 'second' }] });
  const eventsDuring = rpc(bridge, 'session/page', { sessionId, address: { sessionId } }).value.records.map(r => r.event);
  const queuedMsg = eventsDuring.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').map(e => e.data.content[0].text).at(-1);
  assert.match(queuedMsg, /已排队/);
  await waitFor(() => chats.readEntries(chats.resolve(sessionId).chatId).filter(e => e.kind === 'result').length === 2, 12000, 'two results');
  const eventsAfter = rpc(bridge, 'session/page', { sessionId, address: { sessionId } }).value.records.map(r => r.event);
  const allUserTexts = eventsAfter.filter(e => e.type === 'user/message' && e.data.source?.kind === 'user').map(e => e.data.content[0].text);
  assert.equal(allUserTexts.filter(t => /已排队/.test(t)).length, 0, 'queued note gone');
  assert.ok(allUserTexts.includes('second'));
});

// ---------- server (HTTP) ----------

test('server: HTTP 冒烟（INDEX 注入、health、dsh-api 全链路、静态资源）', async t => {
  const mock = await startMock(t, { chunks: ['网', '页', '通'], gap: 15 });
  withConfig(t, configFor(mock));
  const { createApp } = await import('./server.mjs');
  const { server, chats } = createApp({ dataDir: tmp(t) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 首页注入
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>Chat Web · 对话模型<\/title>/);
  assert.match(html, /window\.AR_STREAM_PORT=\d+/);
  assert.match(html, /\/chat-transport\.js/);
  // health
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.ready, true);
  assert.equal(health.models.mock.ready, true);
  // dsh-api 全链路
  const post = (p, obj) => fetch(base + p, { method: 'POST', body: JSON.stringify(obj) }).then(r => r.json());
  const created = await post('/dsh-api/session/create', {});
  const sessionId = created.value.sessionId;
  await post('/dsh-api/session/prompt', { args: { request: { sessionId, content: [{ type: 'text', text: '网页对话' }] } } });
  await waitFor(() => chats.readEntries(chats.resolve(sessionId).chatId).at(-1)?.kind === 'result', 8000, 'result');
  const page = await post('/dsh-api/session/page', { args: { request: { sessionId, address: { sessionId } } } });
  const texts = page.value.records.map(r => r.event).filter(e => e.type === 'assistant/message').map(e => e.data.message.content.at(-1).text);
  assert.equal(texts.at(-1), '网页通');
  // 静态资源（dsh 前端与 transport 脚本）
  const transport = await fetch(base + '/chat-transport.js');
  assert.equal(transport.status, 200);
  assert.match(await transport.text(), /__DSH_TRANSPORT__/);
  const asset = await fetch(base + '/favicon.svg');
  assert.equal(asset.status, 200);
  // dsh-api-stream 的 $events ready 帧（常驻流：读到首帧即断开）
  const streamRes = await fetch(base + '/dsh-api-stream/$events', { method: 'POST', body: '{}' });
  const reader = streamRes.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  const firstLine = Buffer.from(value).toString().split('\n')[0];
  assert.match(firstLine, /"type":"ready"/);
  // 未知接口 404
  assert.equal((await fetch(base + '/api/nope')).status, 404);
});
