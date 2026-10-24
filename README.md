# Chat Web

<div align="right"><b>English</b> · <a href="README.zh-CN.md">中文</a></div>

**A web workbench for pure chat models**: the dsh (deepseek-harness) chat UI + any OpenAI-compatible chat model. Multi-session chat with token-level streaming, model switching, attachments, and history — backed by a plain `/chat/completions` call. No CLI subagents, no task board, no scheduler.

Extracted from Agent Router: the "web page + pure chat models" part (dsh chat UI, chat-model integration, usage & streaming display) is now this standalone project; the multi-agent collaboration core moved to [Agent Router MCP](../Agent-Router-MCP).

```
Browser (dsh chat UI; dsh-web/ is a local deepseek-harness build)
   │ /dsh-api, /dsh-api-stream (NDJSON streams)
   ▼
Chat Web server (server.mjs, zero dependencies, Node ≥ 20)
   ├─ bridge/dsh-bridge.mjs   dsh SessionEvent v4 bridge: thread entries ↔ event stream
   ├─ core/runner.mjs         chat runner: history assembly → streamed call → thread log; queue & abort
   ├─ core/chats.mjs          session store: data/chats/<id>/threads/main.jsonl
   └─ lib/provider.mjs        OpenAI-compatible client (SSE, proxy, custom modules)
        │ POST /chat/completions
        ▼
   DeepSeek / Kimi / Qwen / OpenRouter / Ollama / vLLM …
```

## Quick start

```sh
cd D:\Chat-Web
node server.mjs          # default http://127.0.0.1:2299 (stream port 2300)
```

Edit `chat.config.json` before the first start — at least one chat model:

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

Open `http://127.0.0.1:2299`, pick a model in the picker, and chat. Replies stream token by token; reasoning models (e.g. deepseek-reasoner) show their thinking as a collapsible block above the answer.

### Per-model fields

| Field | Meaning |
|---|---|
| `label` | Display name in the picker (defaults to `model`) |
| `baseUrl` / `model` | OpenAI-compatible endpoint + model name (required) |
| `apiKey` / `apiKeyEnv` | Inline key or env var; `noAuth: true` for local inference servers |
| `headers` / `params` | Extra request headers / extra body parameters |
| `proxy` | HTTP proxy (e.g. `http://127.0.0.1:10808`), CONNECT tunnel supported |
| `contextWindow` | Context window in tokens (default 128000), drives the context-pressure display |
| `timeoutSec` | Per-request timeout (default 600) |
| `module` | Advanced: path to a JS file default-exporting `{ complete(messages, { signal, onDelta }) → { text, reasoning? } }` or a factory returning it |

`systemPrompt` is the default system prompt for new sessions (snapshotted at creation; later config edits don't affect existing sessions). Leave it empty to send no system message.

### UI capabilities (native dsh)

- **Multiple sessions**: create/switch/search/rename/pin/archive in the sidebar; titles come from the first message.
- **Token streaming**: replies appear as they are generated; refreshing mid-reply re-attaches the in-flight answer.
- **Steering & queueing**: messages sent while a reply is in flight are queued and answered automatically when the current reply finishes (with a queue note in the UI).
- **Stop**: an in-flight reply can be stopped anytime; what already streamed out is kept.
- **Attachments**: paste/upload images (previewed in-session); files become "saved to disk path" notes in the conversation.
- **Usage**: estimated tokens per reply (chars/4 — streaming usage reporting differs across providers, so this is indicative), plus context pressure.
- **Model switching**: a per-session model picker; `@file` references resolve against the workspace directory.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `2299` | Main port (stream port is +1) |
| `CHAT_WEB_CONFIG` | `./chat.config.json` | Model config file (re-read every turn — edits apply immediately) |
| `CHAT_WEB_DATA_DIR` | `./data` | Data directory |

## Data layout

```
data/
├── sessions.json                     # dsh session id → chat dir
├── ui-state.json                     # renames/pins/archives/workspace title
├── attachments/                      # uploaded images & files
├── workspace/                        # workspace dir (root for @file references, changeable)
└── chats/<chatId>/
    ├── chat.json                     # model selection, entry sequence
    ├── status.json                   # "replying" marker
    └── threads/main.jsonl            # conversation thread (system/user/assistant/thought/result entries)
        main.stream.jsonl             # token stream (rewritten each turn)
```

Relationship to Agent Router:

| | Agent Router | Agent Router MCP | Chat Web |
|---|---|---|---|
| Shape | main-agent dispatches to CLI subagents | any agent software joins as equals via MCP | web page ↔ pure chat models |
| Executor | local CLIs (claude/zcode/codex…) | the host agent software itself | none — direct model calls |
| UI | dsh chat + task board | simple monitor page | dsh chat |

## Tests

```sh
npm test        # node --test test.mjs: config/provider/store/runner/protocol bridge/HTTP end-to-end
```

## Known limitations

- Token usage is estimated (chars/4), not a billing figure.
- Queued messages are marked in memory; after a process restart they are delivered together with your next message.
- Session fork is not supported (dsh's fork returns unavailable).
- Text-only conversations: images are previewed and archived but not sent as visual input (a path note is added to the text).
