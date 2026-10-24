// 模型配置：chat.config.json 是唯一的模型来源。
//   { "default": "deepseek", "systemPrompt": "", "models": { "<名字>": { label, baseUrl, model, apiKey?, apiKeyEnv?, proxy?, contextWindow?, … } } }
// 每个模型的字段与 Agent Router 的 llm 段同形，直接喂给 lib/provider.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerReady } from './provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROVIDER_ID = 'chat-web';
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function configFile() {
  return process.env.CHAT_WEB_CONFIG || path.join(ROOT, 'chat.config.json');
}

const KNOWN_FIELDS = ['label', 'baseUrl', 'model', 'apiKey', 'apiKeyEnv', 'noAuth', 'headers', 'params', 'proxy', 'timeoutSec', 'contextWindow', 'module'];

/** 读取并校验 chat.config.json；坏配置直接抛错（启动失败好过运行时 500） */
export function loadChatConfig() {
  const file = configFile();
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`缺少配置文件 ${file}：至少配置一个对话模型`);
    throw new Error(`配置文件 ${file} 不是合法 JSON：${e.message}`);
  }
  if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models) || !Object.keys(raw.models).length)
    throw new Error('chat.config.json 需要 "models" 段：{ 模型名: 配置 }');
  const models = {};
  for (const [name, m] of Object.entries(raw.models)) {
    if (!NAME_RE.test(name)) throw new Error(`模型名 "${name}" 只能用字母数字、- 和 _`);
    if (!m || typeof m !== 'object') throw new Error(`模型 ${name} 的配置必须是对象`);
    const unknown = Object.keys(m).filter(k => !KNOWN_FIELDS.includes(k));
    if (unknown.length) throw new Error(`模型 ${name} 有未知字段：${unknown.join('、')}`);
    if (!m.module && !(m.baseUrl && m.model)) throw new Error(`模型 ${name} 需要 baseUrl + model（或 module）`);
    if (m.contextWindow !== undefined && (!Number.isFinite(m.contextWindow) || m.contextWindow < 1024)) throw new Error(`模型 ${name} 的 contextWindow 必须是不小于 1024 的数字`);
    models[name] = m;
  }
  const def = raw.default && models[raw.default] ? raw.default : Object.keys(models)[0];
  return { file, models, default: def, systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '' };
}

export function modelLabel(cfg, name) { return cfg.models[name]?.label || cfg.models[name]?.model || name; }

/** dsh 前端模型选择器的目录（session/modelCatalog 的应答形状） */
export function modelCatalog(cfg) {
  return {
    default: { provider: PROVIDER_ID, model: cfg.default },
    routableProviders: [PROVIDER_ID],
    groups: [{
      id: PROVIDER_ID,
      name: '对话模型',
      models: Object.entries(cfg.models).map(([name, m]) => ({
        id: name,
        name: modelLabel(cfg, name),
        ...(m.contextWindow ? { description: `上下文窗口约 ${Math.round(m.contextWindow / 1000)}k tokens` } : {})
      }))
    }],
    failures: []
  };
}

/** 会话选用的模型 → provider 配置；名字无效时抛错（selectModel / 回合开始都会走到） */
export function resolveModel(cfg, name) {
  const m = cfg.models[name];
  if (!m) throw new Error(`未知模型 "${name}"，可用：${Object.keys(cfg.models).join(', ')}`);
  return m;
}

/** 健康检查：配置形状是否可用（API key 在环境变量里就算就绪，不实际发请求） */
export function healthView(cfg) {
  return Object.fromEntries(Object.entries(cfg.models).map(([name, m]) => [name, {
    label: modelLabel(cfg, name),
    model: m.model || (m.module ? 'custom module' : null),
    ready: providerReady(m),
    apiKeyEnv: m.apiKeyEnv || null
  }]));
}
