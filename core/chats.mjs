// 会话存储：dsh 会话 id → 聊天目录。
//   data/sessions.json  { <dsh会话id>: { id, createdAt, chatId|null, model|null } }
//   data/chats/<chatId>/chat.json          { id, model, createdAt, seq }   —— seq 是线程条目流水号
//   data/chats/<chatId>/threads/main.jsonl 线程条目（与 Agent Router 同格式）：
//       { seq, ts, kind: 'system'|'user'|'assistant'|'thought'|'result', data }
//   data/chats/<chatId>/threads/main.stream.jsonl  逐字流（每回合截断重写）：
//       { id, t, text } 增量 + 末行 { id, done: 1 }
//   data/chats/<chatId>/status.json        { busy: true|false }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, safeId, short } from '../lib/util.mjs';

const CHAT_ID_OK = /^c-\d{13}-[0-9a-z]{6}$/;

export class Chats {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'sessions.json');
    this.items = readJson(this.file, {});
    fs.mkdirSync(path.join(dataDir, 'chats'), { recursive: true });
  }
  save() { writeJson(this.file, this.items); }

  // ---- dsh 会话（先建草稿，首条消息时才落聊天目录） ----
  resolve(sessionId) { return sessionId && Object.hasOwn(this.items, sessionId) ? this.items[sessionId] : null; }
  create(sessionId) {
    if (sessionId && this.items[sessionId]) return this.items[sessionId];
    if (!sessionId || !safeId(sessionId)) sessionId = `draft-${crypto.randomUUID()}`;
    const item = { id: sessionId, createdAt: Date.now(), chatId: null, model: null };
    this.items[sessionId] = item;
    this.save();
    return item;
  }

  // ---- 聊天目录 ----
  dir(chatId) { return path.join(this.dataDir, 'chats', chatId); }
  threadPath(chatId) { return path.join(this.dir(chatId), 'threads', 'main.jsonl'); }
  streamPath(chatId) { return path.join(this.dir(chatId), 'threads', 'main.stream.jsonl'); }

  /** 首条消息时把会话落成聊天目录；model 为空则跟随全局默认 */
  ensureChat(sessionId, model = null) {
    const item = this.resolve(sessionId) || this.create(sessionId);
    if (item.chatId && CHAT_ID_OK.test(item.chatId) && fs.existsSync(this.chatFile(item.chatId))) return item.chatId;
    const chatId = `c-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    writeJson(this.chatFile(chatId), { id: chatId, model: model ?? item.model ?? null, createdAt: Date.now(), seq: 0 });
    fs.mkdirSync(path.join(this.dir(chatId), 'threads'), { recursive: true });
    fs.writeFileSync(this.threadPath(chatId), '');
    this.setBusy(chatId, false);
    item.chatId = chatId;
    this.save();
    return chatId;
  }
  chatFile(chatId) { return path.join(this.dir(chatId), 'chat.json'); }
  chat(chatId) {
    const meta = CHAT_ID_OK.test(String(chatId)) ? readJson(this.chatFile(chatId)) : null;
    if (!meta) throw new Error('会话还不存在');
    return meta;
  }
  patchChat(chatId, patch) {
    const meta = this.chat(chatId);
    writeJson(this.chatFile(chatId), { ...meta, ...patch });
    return { ...meta, ...patch };
  }
  /** 模型选择落在会话上；聊天目录已存在时同步写进去 */
  setModel(sessionId, model) {
    const item = this.resolve(sessionId);
    if (!item) throw new Error('会话不存在');
    item.model = model;
    if (item.chatId) this.patchChat(item.chatId, { model });
    this.save();
  }

  statusFile(chatId) { return path.join(this.dir(chatId), 'status.json'); }
  setBusy(chatId, busy) { writeJson(this.statusFile(chatId), { busy }); }
  busy(chatId) { return readJson(this.statusFile(chatId), {})?.busy === true; }

  // ---- 线程条目 ----
  readEntries(chatId) {
    try {
      return fs.readFileSync(this.threadPath(chatId), 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
  appendEntry(chatId, kind, data) {
    const meta = this.chat(chatId);
    const entry = { seq: (meta.seq || 0) + 1, ts: new Date().toISOString(), kind, data };
    fs.mkdirSync(path.dirname(this.threadPath(chatId)), { recursive: true });
    fs.appendFileSync(this.threadPath(chatId), JSON.stringify(entry) + '\n');
    this.patchChat(chatId, { seq: entry.seq });
    return entry;
  }
  /** 逐字流：每回合截断重写；delta 写 {id,t,text}，收尾写 {id,done:1} */
  resetStream(chatId) { fs.mkdirSync(path.dirname(this.streamPath(chatId)), { recursive: true }); fs.writeFileSync(this.streamPath(chatId), ''); }
  appendStream(chatId, frame) { fs.appendFileSync(this.streamPath(chatId), JSON.stringify(frame) + '\n'); }

  // ---- 列表（侧栏） ----
  list() {
    const out = [];
    try {
      for (const e of fs.readdirSync(path.join(this.dataDir, 'chats'), { withFileTypes: true })) {
        if (!e.isDirectory() || !CHAT_ID_OK.test(e.name)) continue;
        const meta = readJson(this.chatFile(e.name));
        if (!meta) continue;
        const first = this.readEntries(e.name).find(x => x.kind === 'user');
        out.push({
          chatId: e.name, model: meta.model || null, createdAt: meta.createdAt,
          busy: this.busy(e.name),
          mtime: (() => { try { return Math.round(fs.statSync(this.threadPath(e.name)).mtimeMs); } catch { return meta.createdAt; } })(),
          preview: first ? short(first.data?.text, 80) : ''
        });
      }
    } catch {}
    return out.sort((a, b) => b.mtime - a.mtime);
  }
}
