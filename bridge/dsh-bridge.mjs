// Chat Web → dsh Web UI 桥接。
// 把 data/chats/<id>/threads/main.jsonl 里的线程条目合成为 dsh 的 SessionEvent v4 事件流,
// 并按 dsh 客户端的首屏 RPC 清单应答 unary 端点、按 journal 帧协议提供流端点。
// 数据形状依据（与 Agent Router 的 web/dsh-bridge.mjs 同源，宿主从 Router 运行换成聊天执行器）:
//   packages/core/session/src/types.ts        (SessionEventMap / SESSION_FORMAT_VERSION=4)
//   packages/api/session-controller/src/types.ts (SessionSummary / SessionPage / SessionFollowFrame)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { UiState } from '../lib/uistate.mjs';
import { Attachments } from '../lib/attachments.mjs';
import { PROVIDER_ID, modelCatalog, modelLabel, resolveModel } from '../lib/models.mjs';

const FORMAT_VERSION = 4;

// 设置命名空间：客户端经 settings/describe 读取、settings/mutate|update 写入。
// - ui-settings-general：预置 welcomeNoticeVersion，让"预览版说明"弹窗视为已确认
// - ui-settings：developerTools 默认关（纯聊天没有工具调用与代码差异，编码视图没有内容可显示）
// - ui-chat：会话视图偏好（transcriptView/performanceUsage），给 onboarding 写入兜底
const NAMESPACES = {
  'ui-settings-general': {
    schema: { uid: 2, refs: { '1': { type: 'string', meta: { volatile: true } }, '2': { type: 'object', meta: { default: {} }, dict: { welcomeNoticeVersion: 1 } } } },
    value: { welcomeNoticeVersion: '2026-09-28.1' },
  },
  'ui-settings': {
    schema: { uid: 3, refs: { '1': { type: 'boolean', meta: { default: false } }, '3': { type: 'object', meta: { default: {} }, dict: { enabled: 1 } } } },
    value: { enabled: false },
  },
  'ui-chat': {
    schema: { uid: 4, refs: { '1': { type: 'string', meta: { default: 'standard' } }, '2': { type: 'string', meta: { default: 'compact' } }, '4': { type: 'object', meta: { default: {} }, dict: { transcriptView: 1, performanceUsage: 2 } } } },
    value: { transcriptView: 'standard', performanceUsage: 'compact' },
  },
};
const revisions = { 'ui-settings-general': 1, 'ui-settings': 1, 'ui-chat': 1 };
let unknownUid = 10;
function ensureNamespace(ns) {
  if (!NAMESPACES[ns]) {
    const uid = ++unknownUid;
    NAMESPACES[ns] = { schema: { uid, refs: { [String(uid)]: { type: 'object', meta: { default: {} }, dict: {} } } }, value: {} };
    revisions[ns] = 1;
  }
  return NAMESPACES[ns];
}
function setPath(obj, p, v) {
  let t = obj;
  for (let i = 0; i < p.length - 1; i++) {
    if (typeof t[p[i]] !== 'object' || t[p[i]] === null) t[p[i]] = {};
    t = t[p[i]];
  }
  if (v === undefined) delete t[p[p.length - 1]];
  else t[p[p.length - 1]] = v;
}
const settingsView = ns => {
  const store = ensureNamespace(ns);
  return { autoGenerate: false, ns, schema: store.schema, value: JSON.parse(JSON.stringify(store.value)), applies: 'live', secrets: [], revision: revisions[ns] };
};
function settingsMutate(ns, ops) {
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!Array.isArray(op?.path) || !op.path.length) continue;
    if (op.op === 'set') setPath(ensureNamespace(ns).value, op.path, op.value);
    else if (op.op === 'unset') setPath(ensureNamespace(ns).value, op.path, undefined);
  }
  revisions[ns] += 1;
  return ok(settingsView(ns));
}
function settingsUpdate(ns, patch) {
  Object.assign(ensureNamespace(ns).value, patch ?? {});
  revisions[ns] += 1;
  return ok(settingsView(ns));
}
function settingsReplace(ns, section) {
  Object.assign(ensureNamespace(ns).value, section ?? {});
  revisions[ns] += 1;
  return ok(settingsView(ns));
}

// ---------- 线程条目 → SessionEvent v4 合成 ----------

function ok(value) { return { ok: true, value }; }
function fail(code, message) { return { ok: false, error: { code, message, details: {} } }; }

function userMessage(id, text, rpcId, blocks = []) {
  return { id, role: 'user', source: { kind: 'user', ...(rpcId ? { rpcId } : {}) }, content: [{ type: 'text', text: String(text ?? '') }, ...blocks] };
}

/** 非用户输入（source.kind 不是 user）在 dsh 里显示为注入上下文，kind 即标签 */
function contextMessage(id, label, text) {
  return { id, role: 'user', source: { kind: label }, content: [{ type: 'text', text: String(text ?? '') }] };
}

function assistantMessage(id, text, model) {
  return {
    id, role: 'assistant',
    source: { kind: 'model', provider: PROVIDER_ID, model: model || 'chat' },
    content: [{ type: 'text', text: String(text ?? '') }],
  };
}

// ModelUsageSummary（result 条目里的聚合口径）→ dsh TokenUsage（assistant/message 的 usage 字段）
export const TOKEN_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
export function toTokenUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const out = {};
  for (const f of TOKEN_USAGE_FIELDS) {
    const v = Math.round(Number(u[f]));
    if (Number.isFinite(v) && v > 0) out[f] = v;
  }
  return out.inputTokens !== undefined || out.outputTokens !== undefined ? out : undefined;
}

function toolResultMessage(id, callId, text, isError) {
  return {
    id, role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: String(text ?? '') }],
  };
}

// 流文件里仍在进行的最后一段尝试（最近一条 done 之后）。用于两类场景：
//  ① 会话中途打开/刷新：snapshot 里带上 activeAttempt，进行中的回答能直接续显；
//  ② 流式过程中用户插话：客户端只能靠 rebaseline 重新锚定，baseline 必须包含已产出的增量。
export function readLiveAttempt(streamPath, turn, step, startedAfterSeq) {
  let lines;
  try { lines = fs.readFileSync(streamPath, 'utf8').split('\n'); } catch { return null; }
  const total = lines.length - 1;
  let start = 0;
  for (let i = 0; i < total; i++) if (/"done"\s*:/.test(lines[i])) start = i + 1;
  const stream = [];
  let id = null;
  for (let i = start; i < total; i++) {
    let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (!rec.id || rec.done) continue;
    if (!id) id = rec.id;
    if (rec.id !== id || typeof rec.text !== 'string' || !rec.text) continue;
    stream.push({ type: 'chunk', time: Number(rec.t) || Date.now(), chunk: { type: 'text-delta', index: 0, text: rec.text } });
  }
  if (!id) return null;
  return { attemptId: id, startedAfterSeq, turn, step, nextIndex: stream.length, stream, lines: total };
}

/**
 * 整个线程 → 完整 SessionEvent 日志。
 * 每条 assistant 消息独占一个 step（消息后立即 step/end）：assistant 流式协议要求
 * 上一消息的 step/end 到位后才能开始下一条的流式 attempt，否则客户端判定协议违规。
 * seq 从 0 开始：dsh 游标协议是「cursor=最后一条事件的 seq，空日志为 -1」。
 * take(entry) 命中 prompt 回显时给用户消息带 rpcId（见 createBridge.pendingEcho）；
 * state 可选，回填合成结束时的 turn/step/stepOpen，供流式 attempt 定位下一消息的落点。
 */
export function synthesizeSessionEvents(entries, take = null, state = null, model = null) {
  if (state) Object.assign(state, { turn: 1, step: 1, open: false });
  if (!entries.length) return [];
  const events = [];
  const assistantTexts = new Set();
  // 预扫描：① 每条 result 的 usage 挂到它之前同回合最后一条 assistant 条目（客户端按回合内
  // 求和，挂两条会翻倍）；② queued user 条目在其后不再有 result 时仍算排队中（加注记）
  const usageForAssistant = new Map(); // assistant 条目下标 -> usage
  const stillQueued = new Map();       // 仍在排队的 user 条目下标 -> 'queue'
  {
    let lastAssistant = -1;
    const resultIndexes = [];
    entries.forEach((e, i) => {
      if (e.kind === 'assistant') lastAssistant = i;
      else if (e.kind === 'result') {
        if (lastAssistant >= 0 && e.data?.usage) usageForAssistant.set(lastAssistant, e.data.usage);
        resultIndexes.push(i);
        lastAssistant = -1; // usage 只归本回合，不跨 result 认领
      } else if (e.kind === 'user' && e.data?.queued) stillQueued.set(i, 'queue');
    });
    for (const i of [...stillQueued.keys()]) if (resultIndexes.some(r => r > i)) stillQueued.delete(i);
  }
  let seq = -1;
  let step = 1, open = true;
  // 思考（thought）与它后面的正文同属一次模型尝试：合并成同一条 assistant/message 的
  // reasoning 块。拆成两条会让客户端在流式期间把思考消息扣在 pending 里无法结算，
  // 下一次 start 帧就会触发 rebaseline（表现即运行中内容顺序错乱/闪烁）
  let pendingThought = null;
  const time0 = Date.parse(entries[0].ts) || Date.now();
  const push = (type, data, extra) => { seq += 1; events.push({ type, seq, time: time0, data, ...extra }); };
  const openStep = () => { if (!open) { push('step/start', { turn: 1, step }); open = true; } };
  const closeStep = () => { if (open) { push('step/end', { turn: 1, step }); open = false; step += 1; } };
  push('turn/start', { turn: 1 });
  push('step/start', { turn: 1, step });
  entries.forEach((e, entryIndex) => {
    const d = e.data || {};
    const time = Date.parse(e.ts) || time0;
    const emit = (type, data, extra) => { seq += 1; events.push({ type, seq, time, data, ...extra }); };
    if (e.kind === 'thought') {
      const t = String(d.text ?? '');
      pendingThought = pendingThought ? `${pendingThought}\n\n${t}` : t;
      return;
    }
    if (e.kind === 'assistant') {
      const text = String(d.text ?? '');
      assistantTexts.add(text);
      openStep();
      const content = pendingThought ? [{ type: 'reasoning', text: pendingThought }, { type: 'text', text }] : [{ type: 'text', text }];
      pendingThought = null;
      const usage = toTokenUsage(usageForAssistant.get(entryIndex));
      emit('assistant/message', { turn: 1, step, message: { ...assistantMessage(`m${seq}`, '', model), content }, stream: [], ...(usage ? { usage } : {}) }, { surfaceOp: 'append' });
      closeStep();
      return;
    }
    if (e.kind === 'result') {
      const text = String(d.text || '');
      if (!text || !assistantTexts.has(text)) {
        openStep();
        const content = pendingThought ? [{ type: 'reasoning', text: pendingThought }, { type: 'text', text }] : [{ type: 'text', text }];
        pendingThought = null;
        const usage = toTokenUsage(d.usage);
        emit('assistant/message', { turn: 1, step, message: { ...assistantMessage(`m${seq}`, '', model), content }, stream: [], ...(usage ? { usage } : {}) }, { surfaceOp: 'append' });
      } else if (pendingThought) {
        // 思考没有等到正文就遇到回合结束：单独下发一条 reasoning 消息，避免丢失
        openStep();
        emit('assistant/message', { turn: 1, step, message: { ...assistantMessage(`m${seq}`, '', model), content: [{ type: 'reasoning', text: pendingThought }] }, stream: [] }, { surfaceOp: 'append' });
        pendingThought = null;
      }
      closeStep();
      emit('turn/end', { turn: 1, reason: d.isError ? { kind: 'error', error: { message: text.slice(0, 200) || '会话失败', code: 'UNKNOWN' } } : { kind: 'completed' } });
      return;
    }
    openStep();
    if (e.kind === 'system') {
      emit('user/message', contextMessage(`m${seq}`, '系统提示词', d.text), { surfaceOp: 'append' });
    } else if (e.kind === 'user') {
      // take 命中的那条带上 prompt 的 requestId（客户端凭它回收乐观气泡，缺了同一条消息会渲染两遍）
      // 和消息里图片附件的引用块；仍在排队的消息加注记，送达后合成即恢复原文
      const tag = take?.(e);
      const mode = stillQueued.get(entryIndex);
      const note = mode === 'queue' ? '\n\n_(已排队，当前回复结束后送达)_' : '';
      emit('user/message', userMessage(`m${seq}`, String(d.text ?? '') + note, tag?.requestId, tag?.blocks), { surfaceOp: 'append' });
    } else if (e.kind === 'tool_use') {
      emit('tool/call', { turn: 1, step, callId: String(d.id || `call-${seq}`), name: String(d.name || 'tool'), arguments: JSON.stringify(d.input ?? d.raw ?? {}) });
    } else if (e.kind === 'tool_result') {
      emit('tool/result', { turn: 1, step, message: toolResultMessage(`m${seq}`, String(d.id || ''), String(d.text || '').slice(0, 20000), d.isError === true) }, { surfaceOp: 'append' });
    }
  });
  if (state) Object.assign(state, { turn: 1, step, open });
  return events;
}

/** Chat-aware bridge. 会话 id 即聊天线程；首条消息时才落聊天目录。 */
export function createBridge({ chats, runner, chatConfig, dataDir, uiState: sharedUiState }) {
  const uiState = sharedUiState ?? new UiState(dataDir);
  const attachments = new Attachments(dataDir);
  const workspaceDir = () => {
    const dir = uiState.workspaceRepo || path.join(dataDir, 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  // prompt 的 requestId → 目标用户消息应带的 rpcId 与附件引用块。dsh 客户端发出消息时先渲染乐观气泡，
  // 凭日志消息上的 source.rpcId 匹配后回收；不回填这个 id，同一条消息就会渲染两遍。
  // plainUsers 是 prompt 时线程里已有的“普通用户消息”（排除系统条目）条数，
  // 目标 = 之后出现的第一条普通用户消息（目标消息与它的文本一致）。
  const pendingEcho = new Map(); // sessionId -> { requestId, plainUsers, blocks, targetSeq }
  const isPlainUser = e => e.kind === 'user';
  const echoTagger = id => {
    const pending = pendingEcho.get(id);
    if (!pending) return null;
    let seen = 0;
    return e => {
      if (!isPlainUser(e)) return null;
      // 命中后记住目标条目：流式插话会触发 rebaseline，snapshot 会重合成整段线程，
      // 若只在首次命中时带 rpcId，重启后乐观气泡就回收不了（同一条消息渲染两遍）
      if (pending.targetSeq !== undefined) return e.seq === pending.targetSeq ? pending : null;
      if (seen++ === pending.plainUsers) { pending.targetSeq = e.seq; return pending; }
      return null;
    };
  };
  // prompt 内容块：图片内联 base64 → 存成附件（日志里以 attachment 引用块下发，正文加路径注记）；
  // 文件回执 → 「已保存到磁盘路径」注记（聊天模型只收文本，路径注记让它知道有附件）
  const materialize = parts => {
    const notes = [], blocks = [];
    for (const c of Array.isArray(parts) ? parts : []) {
      if (c?.type === 'image' && typeof c.data === 'string' && c.data) {
        const meta = attachments.save(Buffer.from(c.data, 'base64'), c.name || 'image.png');
        blocks.push({ type: 'image', attachment: { attachmentId: meta.attachmentId, mediaType: meta.mediaType, bytes: meta.bytes, width: meta.width, height: meta.height, ...(c.name ? { name: c.name } : {}) } });
        notes.push(`[图片] ${meta.name} 已保存到：${meta.file}`);
      } else if (c?.type === 'file' && c.receiptId) {
        const meta = attachments.byReceipt(c.receiptId);
        if (meta) notes.push(`[附件] ${meta.name} 已保存到：${meta.file}`);
      }
    }
    return { notes, blocks };
  };
  // 负载形如 { args: { request } } / { args: [...] } / 直接对象
  const unpack = p => {
    const a = p?.args ?? p ?? {};
    if (Array.isArray(a)) return a[0] ?? {};
    return a.request ?? a;
  };
  const addressId = p => p.sessionId || p.address?.sessionId || p.address?.childSessionId || p.childSessionId;
  const sessionOf = id => {
    const s = id ? chats.resolve(id) : null;
    if (!s) throw new Error('会话不存在，请新建会话');
    return s;
  };
  const chatIdOf = id => sessionOf(id).chatId;
  const entriesOf = id => {
    const chatId = chatIdOf(id);
    return chatId ? chats.readEntries(chatId) : [];
  };
  const modelOf = id => {
    const chatId = chatIdOf(id);
    const cfg = chatConfig();
    if (chatId) { try { return chats.chat(chatId).model || cfg.default; } catch {} }
    return chats.resolve(id)?.model || cfg.default;
  };
  const titleOf = id => {
    const t = uiState.title(id);
    if (t) return t;
    const first = entriesOf(id).find(e => e.kind === 'user');
    const text = String(first?.data?.text || '').replace(/\s+/g, ' ').trim();
    return text ? `${text.slice(0, 60)}${text.length > 60 ? '…' : ''}` : null;
  };
  const all = () => {
    const items = [];
    for (const chat of chats.list()) {
      const sessionId = Object.keys(chats.items).find(k => chats.items[k].chatId === chat.chatId);
      if (!sessionId) continue;
      items.push({
        sessionId,
        title: uiState.title(sessionId) || chat.preview || null,
        updatedAt: chat.mtime,
        running: chat.busy,
        blank: false, cwd: workspaceDir(), agentAvailable: true
      });
    }
    for (const s of Object.values(chats.items)) {
      if (s.chatId) continue;
      items.push({ sessionId: s.id, ...(uiState.title(s.id) ? { title: uiState.title(s.id) } : {}), updatedAt: s.createdAt, running: false, blank: true, cwd: workspaceDir(), agentAvailable: true });
    }
    return items;
  };
  // ---- 用量投影：线程 result 条目的 usage 聚合 ----
  // tokenUsage：累计四桶（dsh TokenUsageProjection，桶之间互斥）；contextPressure：
  // 末回合 provider 上报的输入侧规模。usage 是估算值（chars/4），参考显示不是计费口径。
  // mtime 记忆化：control 流每 1.5s 轮询全部会话，避免每拍整文件重读重解析。
  const usageMemo = new Map(); // chatId -> { mtime, value }
  const usageProjectionOf = id => {
    const chatId = chatIdOf(id);
    if (!chatId) return null;
    const threadFile = chats.threadPath(chatId);
    let mtime = 0;
    try { mtime = fs.statSync(threadFile).mtimeMs; } catch { return null; }
    const hit = usageMemo.get(chatId);
    if (hit && hit.mtime === mtime) return hit.value;
    const agg = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let last = null;
    for (const e of chats.readEntries(chatId)) {
      const u = e.kind === 'result' ? toTokenUsage(e.data?.usage) : null;
      if (!u) continue;
      last = u;
      agg.uncachedInputTokens += Math.max(0, (u.inputTokens || 0) - (u.cacheReadTokens || 0) - (u.cacheWriteTokens || 0));
      agg.outputTokens += u.outputTokens || 0;
      agg.cacheReadTokens += u.cacheReadTokens || 0;
      agg.cacheWriteTokens += u.cacheWriteTokens || 0;
    }
    const value = {};
    if (last) {
      value.tokenUsage = agg;
      const pressure = (last.inputTokens || 0) || ((last.cacheReadTokens || 0) + (last.cacheWriteTokens || 0));
      if (pressure) value.contextPressure = { pressureTokens: pressure };
    }
    usageMemo.set(chatId, { mtime, value });
    return value;
  };
  const modelSelectionValues = id => ({
    modelSelection: {
      lastUsed: { provider: PROVIDER_ID, model: modelOf(id) },
      pending: { provider: PROVIDER_ID, model: modelOf(id) },
    }
  });
  const projectionValues = id => {
    const values = { ...modelSelectionValues(id), ...(id && chats.resolve(id)?.chatId ? usageProjectionOf(id) || {} : {}) };
    return values;
  };
  const context = id => {
    const s = sessionOf(id);
    const chatId = s.chatId;
    const running = chatId ? chats.busy(chatId) : false;
    return {
      sessionId: id, chatId: chatId || null, settings: { repo: workspaceDir(), model: modelOf(id) }, run: null, managerSessionId: id,
      capabilities: { configure: false, send: true, stop: running, models: true, mcp: false }
    };
  };
  // 会话路径安全：文件引用都以工作区目录为根
  const safePath = (repo, rel) => {
    const full = path.resolve(repo, String(rel || ''));
    if (full !== repo && !full.startsWith(repo + path.sep)) throw new Error('路径越界');
    return full;
  };
  const workspaceView = () => ({
    workspaceId: 'chat-web', path: workspaceDir(), title: uiState.workspaceTitle,
    sessionIds: all().map(i => i.sessionId).filter(sid => !uiState.archived.includes(sid)),
    createdAt: '2026-01-01T00:00:00Z', updatedAt: new Date().toISOString(),
  });
  // 本地部署没有账号体系：恒为未登录（客户端只显示菜单项，不弹横幅）
  const ACCOUNT_VIEW = { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null };
  const unary = (endpoint, raw) => {
    const p = unpack(raw), id = addressId(p);
    // 代理作用域（agent-scoped）端点按位置传参：(agent, ...) —— descriptor 的 parameters 是位置参数
    const pos = Array.isArray(raw?.args) ? raw.args : null;
    const posArg = (i, name) => (pos ? pos[i] : p?.[name]);
    if (endpoint === 'health') return ok({ ready: true });
    if (endpoint === 'session/create') return ok({ sessionId: chats.create(id).id });
    if (endpoint === 'session/list') return ok({ items: all() });
    if (endpoint === 'session/page') {
      const sid = id;
      const cfg = chatConfig();
      const events = synthesizeSessionEvents(entriesOf(sid), echoTagger(sid), null, modelLabel(cfg, modelOf(sid)))
        .filter(e => e.seq <= (p.throughSeq ?? Infinity) && e.seq < (p.beforeSeq ?? Infinity));
      return ok({ records: events.map(event => ({ type: 'event', event })), hasMore: false });
    }
    if (endpoint === 'session/search') {
      const query = String(p.query || '').trim().toLowerCase();
      if (!query) return ok({ items: [], hasMore: false });
      return ok({
        items: all().flatMap(item => {
          const text = titleOf(item.sessionId) || '';
          const hit = entriesOf(item.sessionId).map(e => String(e.data?.text || '')).find(t => t.toLowerCase().includes(query));
          return hit || text.toLowerCase().includes(query) ? [{ sessionId: item.sessionId, snippet: (hit || text).slice(0, 160) }] : [];
        }).slice(0, 50), hasMore: false
      });
    }
    if (endpoint === 'session/prompt') {
      // 空白会话的 prompt 可能不带 sessionId：隐式建一个
      const sid = id || chats.create().id;
      const s = sessionOf(sid);
      const parts = Array.isArray(p.content) ? p.content : [];
      const { notes, blocks } = materialize(parts);
      const text = [parts.filter(c => c.type === 'text').map(c => c.text).join('\n').trim(), ...notes].filter(Boolean).join('\n\n');
      if (!text) throw new Error('消息不能为空');
      const cfg = chatConfig();
      const chatId = chats.ensureChat(sid);
      if (!chats.readEntries(chatId).length && cfg.systemPrompt) chats.appendEntry(chatId, 'system', { text: cfg.systemPrompt });
      const plainUsers = entriesOf(sid).filter(isPlainUser).length;
      const result = runner.submit(chatId, text);
      if (p.requestId) pendingEcho.set(sid, { requestId: p.requestId, plainUsers, blocks });
      return ok({ accepted: true, ...(result.queued ? { delivery: 'queued' } : {}) });
    }
    if (endpoint === 'session/projections') return ok({ asOfSeq: -1, values: projectionValues(id) });
    if (endpoint === 'session/selectModel') {
      const cfg = chatConfig();
      const name = String(p.model || '');
      resolveModel(cfg, name); // 未知模型直接抛错
      chats.setModel(id, name);
      return ok({ selected: { provider: PROVIDER_ID, model: name } });
    }
    if (endpoint === 'session/cancel') {
      const chatId = chatIdOf(id);
      if (!chatId || !runner.abort(chatId)) throw new Error('当前没有进行中的回复');
      return ok({ accepted: true });
    }

    // ---- 设置：通用命名空间存储（describe/mutate/update/replace） ----
    if (endpoint === 'settings/describe') return ok({ writable: true, hasDocument: false, namespaces: Object.keys(NAMESPACES).map(settingsView) });
    if (endpoint === 'settings/mutate') return settingsMutate(p.ns ?? 'ui-settings-general', p.ops);
    if (endpoint === 'settings/update') return settingsUpdate(p.ns, p.patch);
    if (endpoint === 'settings/replace') return settingsReplace(p.ns, p.section);
    if (endpoint === 'settings/openSettingsDocument') return ok({ opened: true });

    // ---- 会话管理 ----
    if (endpoint === 'session/rename') { uiState.rename(id, p.title); return ok({ title: p.title, seq: 0 }); }
    if (endpoint === 'session/fork') return fail('session/fork-unavailable', '暂不支持分叉');
    if (endpoint === 'session/updateQueue') return ok({ accepted: true });
    if (endpoint === 'session/attachment') {
      const hit = attachments.get(p.attachmentId);
      if (!hit) return fail('session/attachment-not-found', '附件不存在或已清理');
      return ok({ attachment: { attachmentId: hit.meta.attachmentId, mediaType: hit.meta.mediaType, bytes: hit.meta.bytes, width: hit.meta.width, height: hit.meta.height, name: hit.meta.name }, data: hit.buf.toString('base64') });
    }
    if (endpoint === 'session/initializeDefaultModel') return ok(undefined);
    // 模型选择器的目录：chat.config.json 里的全部对话模型
    if (endpoint === 'session/modelCatalog') return ok(modelCatalog(chatConfig()));
    if (endpoint === 'sessionFeedback/record') return ok({ ok: true, value: { recorded: true } });
    if (endpoint === 'sessionReferenceResolver/candidates') {
      const query = String(posArg(1, 'query') || '').trim().toLowerCase();
      const items = all().filter(i => !query || String(i.title || '').toLowerCase().includes(query))
        .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.title ? 1 : 0) - (a.title ? 1 : 0))
        .slice(0, 8)
        .map(i => ({ mention: String(i.title || `会话 ${i.sessionId.slice(0, 8)}`), sessionId: i.sessionId, label: String(i.title || '未命名会话'), sameWorkspace: true, createdAt: i.updatedAt }));
      return ok(items);
    }
    if (endpoint === 'fileReferences/list') {
      const query = String(posArg(1, 'query') || '').trim().toLowerCase();
      const out = [];
      const walk = (dir, rel, depth) => {
        if (out.length >= 20 || depth > 2) return;
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of names) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (!query || e.name.toLowerCase().includes(query)) out.push({ path: r, kind: e.isDirectory() ? 'directory' : 'file' });
          if (e.isDirectory()) walk(path.join(dir, e.name), r, depth + 1);
        }
      };
      walk(workspaceDir(), '', 0);
      return ok(out.slice(0, 20));
    }
    // 桌面打开能力：Windows 下用资源管理器打开/定位，其余平台如实报告不可用
    if (endpoint === 'session/canOpenWorkspacePath') return ok(process.platform === 'win32');
    if (endpoint === 'session/workspacePathApplications') return ok([]);
    if (endpoint === 'session/openWorkspacePath') {
      if (process.platform !== 'win32') return fail('host/unavailable', '仅支持 Windows 桌面');
      const full = safePath(workspaceDir(), p.path);
      if (p.action === 'reveal') spawn('explorer', [`/select,${full}`], { detached: true, windowsHide: true }).unref();
      else spawn('cmd', ['/c', 'start', '', full], { detached: true, windowsHide: true }).unref();
      return ok({ opened: true });
    }

    // ---- 工作区组织（单工作区模型：归档/置顶/改名落 ui-state） ----
    if (endpoint === 'workspace/pinSession') { uiState.pin(p.sessionId); return ok({ pinnedSessionIds: [...uiState.pinned] }); }
    if (endpoint === 'workspace/unpinSession') { uiState.unpin(p.sessionId); return ok({ pinnedSessionIds: [...uiState.pinned] }); }
    if (endpoint === 'workspace/archiveSession') {
      const chatId = chats.resolve(p.sessionId)?.chatId;
      if (chatId && chats.busy(chatId) && !p.stopActivity) return fail('workspace/session-active', '会话仍在回复中，请先停止');
      if (chatId && chats.busy(chatId)) { try { runner.abort(chatId); } catch {} }
      uiState.archive(p.sessionId);
      return ok({ archivedSessionIds: [...uiState.archived] });
    }
    if (endpoint === 'workspace/unarchiveSession') { uiState.unarchive(p.sessionId); return ok({ archivedSessionIds: [...uiState.archived] }); }
    if (endpoint === 'workspace/rename') { uiState.renameWorkspace(p.title); return ok({ workspace: workspaceView() }); }
    if (endpoint === 'workspace/delete') { uiState.deleteWorkspace(); return ok({ deleted: true }); }
    if (endpoint === 'workspace/create') { uiState.restoreWorkspace(); return ok({ workspace: workspaceView(), created: false }); }
    if (endpoint === 'workspace/insertBefore') return ok({ workspaceIds: ['chat-web'] });
    if (endpoint === 'workspace/insertSessionBefore') return ok({ workspace: workspaceView() });

    // ---- 工作区文件浏览（@文件引用 的根目录） ----
    if (endpoint === 'workspaceFiles/list') {
      const dir = safePath(workspaceDir(), posArg(1, 'path'));
      if (!fs.statSync(dir).isDirectory()) throw new Error('不是文件夹');
      const names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.'));
      const list = names.slice(0, 500).map(e => {
        let size;
        if (e.isFile()) { try { size = fs.statSync(path.join(dir, e.name)).size; } catch {} }
        return { name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other', ...(size !== undefined ? { size } : {}) };
      });
      return ok({ path: String(posArg(1, 'path') || ''), entries: list, truncated: names.length > 500 });
    }
    if (endpoint === 'workspaceFiles/read') {
      // offset 是 1 起始的行号（客户端下一页 = offset + lines），limit 不传时一次最多 2000 行
      const full = safePath(workspaceDir(), posArg(1, 'path'));
      const opts = posArg(2, 'options') || {};
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      const offset = Math.max(1, Number(opts.offset) || 1);
      const slice = lines.slice(offset - 1, offset - 1 + 2000);
      return ok({ offset, text: slice.join('\n'), lines: slice.length, eof: offset - 1 + slice.length >= lines.length, absolutePath: full, version: String(fs.statSync(full).mtimeMs), bytes: Buffer.byteLength(text) });
    }
    if (endpoint === 'workspaceFiles/stat') {
      const full = safePath(workspaceDir(), posArg(1, 'path'));
      const st = fs.statSync(full);
      return ok({ absolutePath: full, version: String(st.mtimeMs), ...(st.isFile() ? { bytes: st.size } : {}) });
    }

    // ---- 其余端点：映射或优雅降级（空清单/无操作），避免客户端报"未实现" ----
    if (endpoint === 'fileUploads/upload') {
      const meta = attachments.save(Buffer.from(String(p.data || ''), 'base64'), p.name || 'file');
      return ok({ receiptId: meta.receiptId, file: { attachmentId: meta.attachmentId, name: meta.name, bytes: meta.bytes } });
    }
    if (endpoint === 'commands/list') return ok([]);
    if (endpoint === 'skills/list') return ok({ skills: [] });
    if (endpoint === 'schedule/list') return ok([]);
    if (endpoint.startsWith('goals/')) return ok(undefined);
    if (endpoint === 'terminal/shells') return ok([]);
    if (endpoint === 'terminal/list') return ok([]);
    if (endpoint === 'terminal/environment') return ok({ cwd: workspaceDir(), maxInputBytes: 131072, maxCols: 500, maxRows: 200, scrollback: 5000 });
    if (endpoint === 'llm/listProviders' || endpoint === 'llm/listConfigurableProviders' || endpoint === 'llm/discoverModels') return ok([]);
    if (endpoint === 'credentials/set' || endpoint === 'credentials/unset') return ok(undefined);
    if (endpoint === 'permissionPresets/catalog') return ok({ options: [], defaultOptions: [], defaultPreset: '' });
    if (endpoint === 'pluginManager/listPlugins') return ok([]);
    if (endpoint === 'pluginInventory/list') return ok({ entries: [] });
    if (endpoint === 'productAnalytics/enabled') return ok(false);
    if (endpoint === 'productAnalytics/report') return ok(undefined);
    if (endpoint === 'directoryPicker/pick') return ok(null);
    if (endpoint === 'agentPresets/select') return ok(undefined);
    if (endpoint === 'agentPresets/list') return ok({ presets: [] });
    if (endpoint === 'dynamicCordisRunner/syncInspectManifest') return ok(null);
    if (endpoint === 'dynamicCordisRunner/inventory') return ok([]);
    if (endpoint === 'credentials/describe') return ok({});
    if (endpoint === 'account/getProfile') return ok(null);
    if (endpoint === 'account/getBalance') return ok(null);
    if (endpoint === 'account/getUnnotifiedBonuses') return ok(null);
    if (endpoint === 'account/ackBonusNotified') return ok(true);
    if (endpoint === 'account/getState' || endpoint === 'account/startSignIn' || endpoint === 'account/signOut' || endpoint === 'account/cancelSignIn') return ok(ACCOUNT_VIEW);
    if (endpoint === 'account/hasRunningAccountTasks') return ok(false);
    return fail('gateway/not-implemented', `Chat Web 桥未实现端点 ${endpoint}`);
  };
  const stream = (endpoint, raw, send) => {
    const p = unpack(raw); let timer, streamTimer;
    const cleanup = () => { clearInterval(timer); clearInterval(streamTimer); };
    const pos = Array.isArray(raw?.args) ? raw.args : null;
    const posArg = (i, name) => (pos ? pos[i] : p?.[name]);
    if (endpoint === '$events') {
      // ready 帧建立 connection generation；键必须恰为 type/clientId/host
      send({ type: 'ready', clientId: 'chat-web-client', host: { home: dataDir } });
      return cleanup;
    }
    if (endpoint === 'job/list') {
      send({ type: 'rows', jobs: [] });
      return cleanup;
    }
    if (endpoint === 'productAnalytics/watchPolicy') {
      send(false); // 遥测恒关
      return cleanup;
    }
    if (endpoint === 'workspaceFiles/changes') {
      // 单文件变更监听（文档预览用）：mtime 即 version，删除则报 absent
      const full = path.resolve(workspaceDir(), String(posArg(1, 'path') || ''));
      send({ kind: 'ready' });
      let version = null;
      streamTimer = setInterval(() => {
        try {
          const v = String(fs.statSync(full).mtimeMs);
          if (version === null) { version = v; return; }
          if (v !== version) { version = v; send({ kind: 'change', change: { absolutePath: full, version: v } }); }
        } catch {
          if (version !== null) { version = null; send({ kind: 'change', change: { absolutePath: full, absent: true } }); }
        }
      }, 1500);
      return cleanup;
    }
    if (endpoint === 'workspace/follow') {
      // 单一「Chat Web」工作区：首帧 baseline，之后会话增减用 upsert（dsh 只在重连时接受 baseline）
      let previous = '';
      const push = () => {
        const ids = all().map(s => s.sessionId).filter(sid => !uiState.archived.includes(sid)), signature = JSON.stringify([ids, uiState.workspaceTitle, uiState.archived, uiState.pinned, workspaceDir()]);
        if (signature === previous) return;
        const workspace = { workspaceId: 'chat-web', path: workspaceDir(), title: uiState.workspaceTitle, sessionIds: ids, createdAt: '2026-01-01T00:00:00Z', updatedAt: new Date().toISOString() };
        const value = { items: uiState.data.workspaceDeleted ? [] : [workspace], archivedSessionIds: [...uiState.archived], pinnedSessionIds: [...uiState.pinned] };
        send(previous ? { type: 'upsert', workspace } : { type: 'baseline', value });
        previous = signature;
      };
      push(); timer = setInterval(push, 1500); return cleanup;
    }
    if (endpoint === 'session/control') {
      const projections = {}, last = new Map();
      for (const item of all()) {
        const values = projectionValues(item.sessionId);
        projections[item.sessionId] = { asOfSeq: -1, values };
        for (const key of ['tokenUsage', 'contextPressure']) {
          if (values[key] !== undefined) last.set(`${item.sessionId}:${key}`, JSON.stringify(values[key]));
        }
        last.set(`${item.sessionId}:modelSelection`, JSON.stringify(values.modelSelection));
      }
      send({ type: 'baseline', value: { projections } });
      let seq = 0;
      timer = setInterval(() => {
        try {
          for (const item of all()) {
            const values = projectionValues(item.sessionId);
            for (const key of ['tokenUsage', 'contextPressure', 'modelSelection']) {
              const value = values[key];
              if (value === undefined) continue;
              const signature = JSON.stringify(value);
              if (last.get(`${item.sessionId}:${key}`) === signature) continue;
              last.set(`${item.sessionId}:${key}`, signature);
              send({ type: 'projection', sessionId: item.sessionId, key, value, seq: ++seq });
            }
          }
        } catch {}
      }, 1500);
      return cleanup;
    }
    if (endpoint === 'session/follow') {
      const id = addressId(p);
      sessionOf(id); // 会话必须存在（空白会话也行：先回空快照，首条消息后内容跟上）
      const state = {};
      const take = echoTagger(id);
      const cfg = chatConfig();
      const initial = synthesizeSessionEvents(entriesOf(id), take, state, modelLabel(cfg, modelOf(id)));
      // dsh 协议：cursor 是最后一条事件的 seq（空日志为 -1），不是事件条数
      const head = initial.length ? initial[initial.length - 1].seq : -1;
      // 聊天目录可能晚于 follow 打开（新会话先开面板再发首条消息），所以每次泵都重新解析流文件路径
      const streamPathFor = () => {
        const chatId = chats.resolve(id)?.chatId;
        return chatId ? chats.streamPath(chatId) : null;
      };
      // 中途打开/重连：把仍在进行的尝试随 snapshot 下发（activeAttempt），
      // 客户端据此在 durable 事件之后重建流式行；不重建的话它只会等新 chunk，已经流出的文字要等回合结束才出现
      const streamPath0 = streamPathFor();
      const live = streamPath0 ? readLiveAttempt(streamPath0, state.turn, state.step, head) : null;
      const activeAttempt = live ? { attemptId: live.attemptId, startedAfterSeq: live.startedAfterSeq, turn: live.turn, step: live.step, nextIndex: live.nextIndex, stream: live.stream } : null;
      send({ type: 'snapshot', header: sessionHeader(id, chats.resolve(id)?.createdAt || initial[0]?.time || Date.now()), cursor: head, records: initial.map(event => ({ type: 'event', event })), hasMore: false, projections: { asOfSeq: head, values: projectionValues(id) }, assistantStream: activeAttempt ? { revision: 0, activeAttempt } : { revision: 0 } });
      // —— 逐字流式：跟随 runner 写的 main.stream.jsonl（text_delta 增量），
      //    以 assistant-stream 帧下发。协议约束（客户端强校验，违者断流）：
      //    revision 与 chunk.index 逐帧严格 +1；日志 assistant/message 事件先到，
      //    end 帧用其 seq 结算，且必须赶在该消息的 step/end 之前（否则保留态卡死）
      let rev = 0, streamLines = live ? live.lines : null;
      let count = initial.length;
      let attempt = live ? { id: live.attemptId, startedAfterSeq: live.startedAfterSeq, turn: live.turn, step: live.step, nextIndex: live.nextIndex, pendingEnd: false } : null;
      // 扣住的 step/end：协议要求 end 帧先于它（客户端靠 step/end 退休流式残留），
      // end 帧发不出的批次里先扣住，结算后补发
      let deferredStepEnd = null;
      const asFrame = f => { rev += 1; send({ type: 'assistant-stream', frame: { revision: rev, ...f } }); };
      const pumpStream = () => {
        const streamPath = streamPathFor();
        if (!streamPath) return;
        let lines;
        try { lines = fs.readFileSync(streamPath, 'utf8').split('\n'); } catch { return; }
        const total = lines.length - 1;
        if (streamLines === null) {
          // 首次跟随：跳过已完成（有 done 行）的 attempt，只跟随尾部仍在进行的
          let skip = 0;
          for (let i = 0; i < total; i++) if (/"done"\s*:/.test(lines[i])) skip = i + 1;
          streamLines = skip;
        } else if (total < streamLines) {
          streamLines = 0; // runner 每回合截断重写
        }
        for (let i = streamLines; i < total; i++) {
          streamLines = i + 1;
          let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
          if (!rec.id) continue;
          if (!attempt || attempt.id !== rec.id) {
            attempt = { id: rec.id, startedAfterSeq: count - 1, turn: state.turn, step: state.step, nextIndex: 0, pendingEnd: false };
            asFrame({ type: 'start', attemptId: attempt.id, startedAfterSeq: attempt.startedAfterSeq, turn: attempt.turn, step: attempt.step });
          }
          if (rec.done) { attempt.pendingEnd = true; continue; }
          if (typeof rec.text === 'string' && rec.text) {
            asFrame({ type: 'chunk', attemptId: attempt.id, index: attempt.nextIndex++, time: Number(rec.t) || Date.now(), chunk: { type: 'text-delta', index: 0, text: rec.text } });
          }
        }
      };
      const journalPoll = () => {
        try {
          const events = synthesizeSessionEvents(entriesOf(id), echoTagger(id), state, modelLabel(cfg, modelOf(id)));
          const fresh = events.slice(count);
          count = events.length;
          let settleSeq = -1, settled = false, endSent = false;
          if (attempt?.pendingEnd) {
            // 结算目标是含正文块的 assistant/message（思考已并入同一条消息的 reasoning 块）
            const m = events.find(e => e.type === 'assistant/message' && e.seq > attempt.startedAfterSeq && e.data.turn === attempt.turn && e.data.step === attempt.step && e.data.message?.content?.some?.(b => b?.type === 'text'));
            if (m) { settleSeq = m.seq; settled = true; }
          }
          const sendEnd = () => {
            asFrame({ type: 'end', attemptId: attempt.id, index: attempt.nextIndex, outcome: { kind: 'completed', seq: settleSeq, eventType: 'assistant/message' } });
            attempt = null; endSent = true;
            if (deferredStepEnd) { send({ type: 'event', event: deferredStepEnd }); deferredStepEnd = null; }
          };
          for (const event of fresh) {
            // 该消息的 step/end 必须排在 end 帧之后；end 帧发不出的批次里先扣住
            if (event.type === 'step/end' && attempt && !endSent && event.data.turn === attempt.turn && event.data.step === attempt.step) {
              deferredStepEnd = event;
              continue;
            }
            send({ type: 'event', event });
            if (settled && !endSent && event.seq === settleSeq) sendEnd();
          }
          if (settled && !endSent) sendEnd();
          // 用户在一段回答的流式过程中插话：客户端把 assistant 行钉在首个增量处，不会因后到的
          // user/message 重排，后续增量会继续长在用户消息上方。dsh 没有"重排"帧，只能触发一次
          // rebaseline：客户端重启 follow，新 snapshot 的 activeAttempt 会把已流出的文字整体落到
          // durable 游标之后（即用户消息下方），后续 chunk 再接着续。
          if (attempt && !attempt.pendingEnd && fresh.some(e => e.type === 'user/message' && e.data.source?.kind === 'user')) {
            asFrame({ type: 'start', attemptId: attempt.id, startedAfterSeq: attempt.startedAfterSeq, turn: attempt.turn, step: attempt.step });
          }
        } catch (e) { send({ type: 'error', error: { code: 'chat/read-failed', message: e.message } }); }
      };
      timer = setInterval(journalPoll, 1000);
      streamTimer = setInterval(() => { try { pumpStream(); } catch {} }, 250);
      return cleanup;
    }
    // 未知流:保持打开但不发数据,客户端按业务超时自行降级
    return cleanup;
  };
  return { unary, stream, context, all };
}

function sessionHeader(sessionId, createdAt) {
  return { version: FORMAT_VERSION, id: sessionId, createdAt, isSeeded: false };
}
