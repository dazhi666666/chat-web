# Chat Web

<div align="right"><b>中文</b> · <a href="README.md">English</a></div>

**网页纯聊天模型工作台**：dsh（deepseek-harness）聊天界面 + 任意 OpenAI 兼容的对话模型。在浏览器里开多路会话、逐字流式、切换模型、传附件、查历史——背后就是普通的 `/chat/completions`，没有 CLI 子代理、没有任务板、没有调度器。

从 Agent Router 提取：原项目里「网页 + 纯聊天模型」这一块（dsh 聊天界面、对话模型接入、用量与流式展示）独立成本项目；多 agent 协作部分已拆到 [Agent Router MCP](../Agent-Router-MCP)。

```
浏览器（dsh 聊天界面，dsh-web/ 为 deepseek-harness 本地构建）
   │ /dsh-api、/dsh-api-stream（NDJSON 流）
   ▼
Chat Web 服务器（server.mjs，零依赖，Node ≥ 20）
   ├─ bridge/dsh-bridge.mjs   dsh SessionEvent v4 协议桥：线程条目 ↔ 事件流
   ├─ core/runner.mjs         聊天执行器：历史组装 → 流式调用 → 线程落盘；排队与中止
   ├─ core/chats.mjs          会话存储：data/chats/<id>/threads/main.jsonl
   └─ lib/provider.mjs        OpenAI 兼容客户端（SSE、代理、自定义模块）
        │ POST /chat/completions
        ▼
   DeepSeek / Kimi / Qwen / OpenRouter / Ollama / vLLM …
```

## 快速开始

```sh
cd D:\Chat-Web
node server.mjs          # 默认 http://127.0.0.1:2299（会话流在 2300）
```

首次启动前编辑 `chat.config.json`，至少配置一个对话模型：

```json
{
  "default": "deepseek",
  "systemPrompt": "",
  "models": {
    "deepseek": {
      "label": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "contextWindow": 128000
    }
  }
}
```

打开 `http://127.0.0.1:2299`，右下角模型选择器选模型，直接对话。回复逐字流出；思考型模型（如 deepseek-reasoner）的思考过程折叠显示在正文上方。

### 每个模型的配置字段

| 字段 | 说明 |
|---|---|
| `label` | 选择器里显示的名字（默认用 `model`） |
| `baseUrl` / `model` | OpenAI 兼容接口地址 + 模型名（必填） |
| `apiKey` / `apiKeyEnv` | 密钥内联或从环境变量读（二选一）；`noAuth: true` 免鉴权（本地推理服务） |
| `headers` / `params` | 额外请求头 / 额外请求参数（合并进请求体） |
| `proxy` | HTTP 代理（如 `http://127.0.0.1:10808`），支持 CONNECT 隧道 |
| `contextWindow` | 上下文窗口 token 数（默认 128000），用于界面上的上下文压力显示 |
| `timeoutSec` | 单次请求超时（默认 600） |
| `module` | 高级：指向一个 JS 文件，默认导出 `{ complete(messages, { signal, onDelta }) → { text, reasoning? } }` 或返回它的工厂 |

`systemPrompt` 是新会话的默认系统提示词（建会话时快照，之后改配置不影响已有会话）；留空则不发送系统消息。

### 界面能力（dsh 原生）

- **多会话**：侧栏新建/切换/搜索/改名/置顶/归档；标题取首条消息。
- **逐字流式**：回复边生成边显示；中途刷新页面能续显进行中的回答。
- **插话与排队**：回复进行中继续发消息会排队，当前回复结束后自动接着回答（界面显示排队注记）。
- **停止**：进行中的回复可随时停止，已流出的部分保留。
- **附件**：图片直接粘贴/上传（会话里预览）；文件以「已保存到磁盘路径」注记进对话。
- **用量**：每次回复显示估算 token（字符数/4，各家流式接口的 usage 口径不一致，仅作参考），以及上下文压力。
- **模型切换**：每个会话独立的模型选择器；`@文件引用` 以工作区目录为根。

## 配置参考

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `2299` | 主端口（会话流固定 +1） |
| `CHAT_WEB_CONFIG` | `./chat.config.json` | 模型配置文件路径（每回合重读，改完即生效） |
| `CHAT_WEB_DATA_DIR` | `./data` | 数据目录 |

## 数据布局

```
data/
├── sessions.json                     # dsh 会话 id → 聊天目录
├── ui-state.json                     # 改名/置顶/归档/工作区标题
├── attachments/                      # 上传的图片与文件
├── workspace/                        # 工作区目录（@文件引用 的根，可改）
└── chats/<chatId>/
    ├── chat.json                     # 模型选择、条目流水号
    ├── status.json                   # 回答中标记
    └── threads/main.jsonl            # 对话线程（system/user/assistant/thought/result 条目）
        main.stream.jsonl             # 逐字流（每回合重写）
```

与 Agent Router 的关系：

| | Agent Router | Agent Router MCP | Chat Web |
|---|---|---|---|
| 形态 | 主代理派发式多 agent 协作 | 任意 agent 软件经 MCP 平等互联 | 网页与纯聊天模型对话 |
| 执行者 | 本机 CLI（claude/zcode/codex…） | 宿主 agent 软件自己 | 无 agent——直连对话模型 |
| 界面 | dsh 聊天 + 任务板 | 简单监视页 | dsh 聊天 |

## 测试

```sh
npm test        # node --test test.mjs：配置/provider/存储/执行器/协议桥/HTTP 全链路
```

## 已知限制

- token 用量是估算值（chars/4），不是计费口径。
- 回复进行中排队的消息在内存队列标记；进程重启后未送达的排队消息会在下一次对话时随新消息一起送出。
- 会话不支持分叉（dsh 的 fork 返回不可用）。
- 纯文本对话：图片只做预览与存档，不会作为视觉输入发给模型（文字注记路径）。
