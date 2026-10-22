# OpenCode2API

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-22.23.4+-orange" alt="Node">
</p>

> **Language:** [English](./README.md) | [简体中文](./README.zh-CN.md)
>
> 📖 [Docs](./docs/README.md) | 🚀 [Quick Start](#quick-start) | 🐛 [Issues](https://github.com/samson910022/OpenCode2API/issues)

Turn a local [OpenCode](https://opencode.ai) runtime into an OpenAI-, Anthropic-, and Gemini-compatible API gateway. Use free models (Big Pickle, Ling, MiMo, Muse Spark, Nemotron) from any OpenAI, Anthropic, or Gemini client — the free lineup rotates, so query `/v1/models` for the live list.

---

## ✨ Features

| Feature | Description |
|:-----|:-----|
| 🟢 **OpenAI compatible** | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| 🟣 **Anthropic compatible** | `/v1/messages` (`tool_use` / `thinking` / SSE) |
| 🔁 **Gemini compatible (thin)** | `POST /v1beta/interactions` (alias `POST /v1/interactions`) |
| 🌐 **Server-side web search** | `web_search` with `web_search_call` + `url_citation` |
| 🔑 **Multi-key auth** | `API_KEY` + `OPENCODE_API_KEYS` merge; `Bearer` or `x-api-key`; empty skips auth |
| 🔀 **Fallback proxy** | free-limit 429-only `OPENCODE_UPSTREAM_PROXIES` rotation |
| 📡 **Streaming** | SSE for Chat, Responses, Messages, Interactions |
| 🧠 **Reasoning control** | `reasoning_effort` / `reasoning: {"effort": "high"}` |
| 🐳 **Docker deploy** | One-command with auto backend |
| 🛡️ **Tool safety** | Disabled by default |
| 🔧 **External tool bridge** | Client `tools` as `tool_calls` / `function_call`, isolated built-ins |
| 🌐 **Built-in passthrough** | Opt-in `web_fetch` only when no `tools` |

---

## 🚀 Quick Start

### Docker deploy (recommended)

```bash
# 1. Clone and configure
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
cp .env.example .env

# 2. Edit .env and set your config
# Required: API_KEY, OPENCODE_SERVER_PASSWORD

# 3. Start
docker compose up -d

# 4. Test
curl http://127.0.0.1:10000/health
```

> No host mount by default (keeps container `node_modules` intact); Docker is production, local Node is dev — see [Docker](./docs/docker.md) and [Getting Started](./docs/getting-started.md).

### Node.js (local dev)

```bash
# 1. Install the OpenCode CLI
npm install -g opencode-ai
# Linux/macOS: curl -fsSL https://opencode.ai/install | bash

# 2. Clone and run
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
npm install
cp config.json.example config.json
npm run build
npm start
```

> 📖 Full guide: [Development](./docs/development.md) · 🚀 [Getting Started](./docs/getting-started.md)

---

## 💡 Usage Examples

### Chat Completions

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Responses API (with reasoning)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "Say hi in one sentence",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

> More examples: [API Reference](./docs/api-reference.md)

---

## ⚙️ Configuration

- Base: `API_KEY`, `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SERVER_URL`, `OPENCODE_PROXY_PORT` (`PORT`).
- Tool safety: `DISABLE_TOOLS=true` default; external `tools` bridged/isolated, built-ins disabled unless allowlisted.
- Observability: `/health/details` and `/metrics` with configurable exposure/auth.
- Timeout & retry: `OPENCODE_PROXY_REQUEST_TIMEOUT_MS`, `OPENCODE_PROXY_RETRY_MAX_RETRIES`; `OPENCODE_UPSTREAM_PROXIES` only on free-limit 429.

> 📄 Full reference: [Configuration](./docs/configuration.md)

---

## 🔌 API Reference

### Endpoints

| Method | Path | Description |
|:-----|:-----|:-----|
| `GET` | `/health` | Health check |
| `GET` | `/health/details` | Structured diagnostics (configurable exposure/auth) |
| `GET` | `/metrics` | Prometheus metrics (configurable exposure/auth) |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat Completions API |
| `POST` | `/v1/responses` | Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API (`max_tokens` required, supports `x-api-key`) |
| `POST` | `/v1beta/interactions` | Gemini-compatible thin layer (text + `google_search` grounding, `previous_interaction_id`, `store`, SSE without `[DONE]`) |
| `POST` | `/v1/interactions` | Alias of `/v1beta/interactions` |

### Protocol fidelity

Use each client's native endpoint; cross-protocol conversion is best-effort — see [Architecture](./docs/architecture.md) and [Troubleshooting](./docs/troubleshooting.md).

### Model name formats

Formats: `opencode/big-pickle`, `gpt5-nano` (auto-resolved) and `opencode/gpt5-nano` — see [API Reference](./docs/api-reference.md).

---

## 🔧 Troubleshooting

Hangs: try `OPENCODE_USE_ISOLATED_HOME=false`. Missing model: check `/v1/models`. No reasoning: use Responses API with `stream: true` + `reasoning.effort`.

> 📖 Full guide: [Troubleshooting](./docs/troubleshooting.md)

---

## 🔨 Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm run dev         # tsx watch index.ts
npm start           # node dist/index.js
npm test -- --runInBand
docker compose up -d --build  # Docker dev
```

> 📖 Full guide: [Development](./docs/development.md) · 🤝 [CONTRIBUTING](./CONTRIBUTING.md)

---

## 📄 License

MIT · See [LICENSE](./LICENSE.md)

---

## 🙏 Acknowledgments

Maintained at [samson910022/OpenCode2API](https://github.com/samson910022/OpenCode2API), forked from [TiaraBasori/opencode2api](https://github.com/TiaraBasori/opencode2api)
and inspired by [dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai) and [lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy).
Upstream code remains under its original MIT license; see [LICENSE](./LICENSE.md).
