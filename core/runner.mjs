// 聊天回合执行器：一条用户消息 → 一次 /chat/completions 调用。
// 历史从线程条目组装（system 条目 = 系统提示词；user/assistant 交替）；回复逐字写入 stream.jsonl，
// 回合结束后落 assistant / thought / result 条目（bridge 据此合成 dsh 事件流）。
// 回合进行中再来的消息排队（user 条目带 queued 标记），回合结束后自动接着跑。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createProvider } from '../lib/provider.mjs';
import { resolveModel } from '../lib/models.mjs';

const TOKENS_PER_CHAR = 4; // 用量是估算值（chars/4）：OpenAI 兼容接口的 usage 字段各家的流式行为不一致

export class Runner {
  /**
   * @param {import('./chats.mjs').Chats} chats
   * @param {{ baseDir?: string, config: () => object }} opts  config() 每回合重读（改配置无需重启）
   */
  constructor(chats, { baseDir = process.cwd(), config } = {}) {
    this.chats = chats;
    this.baseDir = baseDir;
    this.config = config;
    this.running = new Map(); // chatId → { abort, attemptId }
  }

  busy(chatId) { return this.running.has(chatId); }

  /** 启动恢复：上次进程中断留下的 busy=true 状态没有对应的内存回合，清掉 */
  recover() {
    try {
      for (const c of this.chats.list()) if (c.busy && !this.running.has(c.chatId)) this.chats.setBusy(c.chatId, false);
    } catch {}
  }

  /**
   * 提交一条用户消息。忙时写入排队条目并返回 { queued: true }；
   * 空闲时写入普通条目并立即开跑，返回 { accepted: true }。
   */
  submit(chatId, text) {
    if (this.busy(chatId)) {
      this.chats.appendEntry(chatId, 'user', { text, queued: true });
      return { queued: true };
    }
    this.chats.appendEntry(chatId, 'user', { text });
    // 不 await：dsh 客户端靠 session/follow 跟踪进度，这里只负责把回合跑起来
    this.runTurn(chatId).catch(e => console.error('[runner] turn crashed:', e));
    return { accepted: true };
  }

  /** 中止当前回合；未在跑则无事发生 */
  abort(chatId) {
    const run = this.running.get(chatId);
    if (run) run.abort.abort(new Error('stopped by user'));
    return !!run;
  }

  async runTurn(chatId) {
    if (this.running.has(chatId)) return;
    this.claimQueued(chatId);
    const cfg = this.config();
    const meta = this.chats.chat(chatId);
    const modelName = meta.model || cfg.default;
    const mcfg = resolveModel(cfg, modelName);
    const system = this.systemPrompt(chatId, cfg);
    const { messages, inChars } = this.history(chatId, system);
    const contextWindow = Number(mcfg.contextWindow) || 128000;

    const abort = new AbortController();
    const attemptId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    const run = { abort, attemptId };
    this.running.set(chatId, run);
    this.chats.setBusy(chatId, true);
    this.chats.resetStream(chatId);
    const write = frame => { try { this.chats.appendStream(chatId, frame); } catch {} };
    let partial = '';
    const started = Date.now();
    try {
      const provider = await createProvider(mcfg, { baseDir: this.baseDir });
      const res = await provider.complete(messages, {
        signal: abort.signal,
        onDelta: t => { partial += t; write({ id: attemptId, t: Date.now(), text: t }); }
      });
      write({ id: attemptId, done: 1 });
      this.finish(chatId, res, { inChars, contextWindow, modelName, ms: Date.now() - started });
    } catch (e) {
      write({ id: attemptId, done: 1 });
      const stopped = abort.signal.aborted;
      run.failed = true;
      if (partial) this.chats.appendEntry(chatId, 'assistant', { text: partial });
      this.chats.appendEntry(chatId, 'result', {
        text: stopped ? (partial ? '（已停止）' : '已停止') : String(e.message || e),
        isError: true,
        ...(stopped ? {} : { error: String(e.message || e) })
      });
    } finally {
      this.running.delete(chatId);
      this.chats.setBusy(chatId, false);
    }
    // 排队的消息接着跑（上一回合结束后它们就是「普通」用户消息了）；失败或中止都不再自动续跑
    if (!run.failed && !abort.signal.aborted && this.hasPending(chatId)) await this.runTurn(chatId).catch(e => console.error('[runner] drain crashed:', e));
  }

  /**
   * 回合开始前认领排队条目：忙时提交的消息带 queued 标记、落在上一回合的 assistant/result
   * 之前（追加时回合还在跑），位置不后移会让历史顺序错乱。认领 = 移到线程末尾并清除标记
   * （标记一清，dsh 侧的「已排队」注记随之消失，消息进入正在回答的状态）。seq/ts 保持不变
   * （乐观气泡的回填锚点），整个文件原子重写。
   */
  claimQueued(chatId) {
    const entries = this.chats.readEntries(chatId);
    if (!entries.some(e => e.kind === 'user' && e.data?.queued)) return false;
    const claimed = [], rest = [];
    for (const e of entries) (e.kind === 'user' && e.data?.queued ? claimed : rest).push(e);
    const ordered = [...rest, ...claimed.map(e => ({ ...e, data: { ...e.data, queued: false } }))];
    const file = this.chats.threadPath(chatId);
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, ordered.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, file);
    return true;
  }

  finish(chatId, res, { inChars, contextWindow, modelName, ms }) {
    const est = n => Math.max(1, Math.ceil(n / TOKENS_PER_CHAR));
    const usage = {
      inputTokens: est(inChars),
      outputTokens: est((res.text || '').length + (res.reasoning || '').length),
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: (res.reasoning || '').length ? est(res.reasoning.length) : 0
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    if (res.reasoning) this.chats.appendEntry(chatId, 'thought', { text: res.reasoning });
    this.chats.appendEntry(chatId, 'assistant', { text: res.text || '' });
    this.chats.appendEntry(chatId, 'result', {
      text: res.text || '', isError: false, usage, ms,
      tokenCount: usage.totalTokens, contextWindow, model: modelName
    });
  }

  /** 系统提示词：建会话时快照的 system 条目优先；没有则用配置里的（也不落条目，改配置对新会话生效） */
  systemPrompt(chatId, cfg) {
    const entry = this.chats.readEntries(chatId).find(e => e.kind === 'system');
    return String(entry?.data?.text ?? cfg.systemPrompt ?? '').trim();
  }

  /** 线程条目 → OpenAI 消息数组；相邻同角色合并（claimQueued 已保证排队消息排在末尾） */
  history(chatId, system) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    for (const e of this.chats.readEntries(chatId)) {
      if (!['user', 'assistant'].includes(e.kind)) continue;
      const text = String(e.data?.text ?? '');
      if (!text) continue;
      const last = messages.at(-1);
      if (last?.role === e.kind) last.content += `\n\n${text}`;
      else messages.push({ role: e.kind, content: text });
    }
    const inChars = messages.reduce((n, m) => n + m.content.length, 0);
    return { messages, inChars };
  }

  /** 还有没待处理的用户消息：last result 之后的普通消息，或未认领的排队条目（queued 标记还在） */
  hasPending(chatId) {
    const entries = this.chats.readEntries(chatId);
    const lastResult = entries.map(e => e.kind).lastIndexOf('result');
    if (entries.slice(lastResult + 1).some(e => e.kind === 'user')) return true;
    return entries.some(e => e.kind === 'user' && e.data?.queued);
  }
}
