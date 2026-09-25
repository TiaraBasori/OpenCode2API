# OpenCode2API

<p align="center">
  <img src="https://img.shields.io/badge/version-1.5.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-18+-orange" alt="Node">
</p>

English | [简体中文](./README.md)

Turns a local [OpenCode](https://opencode.ai) runtime into an OpenAI-compatible API gateway, so any OpenAI client can use free models (GPT, Kimi, GLM, MiniMax, and more).

## ✨ Features

- **OpenAI compatible** — `/v1/models`, `/v1/chat/completions`, `/v1/responses` with full SSE streaming
- **Reasoning control** — supports `reasoning_effort` and `reasoning: {"effort": "high"}`
- **Session chaining** — Responses API accepts `previous_response_id` (30-minute TTL; upstream sessions are cleaned up on expiry)
- **External tool bridge** — client-supplied `tools` are virtualized by the proxy, which returns standard `tool_calls` / `function_call` without touching OpenCode built-in tools
- **Built-in tool allowlist** — when a request carries no `tools`, only built-in tools listed in `OPENCODE_INTERNAL_ALLOWED_TOOLS` are allowed
- **Observability** — `/health/details` structured diagnostics, `/metrics` Prometheus endpoint
- **Docker deployment** — one command starts the full stack, including the OpenCode backend

## 🚀 Quick Start

### Docker (recommended)

```bash
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env        # Edit .env; API_KEY and OPENCODE_SERVER_PASSWORD are required
docker compose up -d
curl http://127.0.0.1:10000/health
```

> The default Compose file does not mount the host project directory, which would shadow the `node_modules` baked into the image. For hot-reloading local source, use a separate development Compose override file.

### Node.js (local development)

```bash
# Install the OpenCode CLI
npm install -g opencode-ai
# or curl -fsSL https://opencode.ai/install | bash

git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
npm install
cp config.json.example config.json
npm start
```

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

### Responses API (streaming + reasoning)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "Say hi in one sentence.",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### External tools

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "Fetch https://example.com and tell me the title"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "web_fetch",
        "description": "Fetch a URL and return its content summary",
        "parameters": {
          "type": "object",
          "properties": {"url": {"type": "string"}},
          "required": ["url"]
        }
      }
    }]
  }'
```

When the model decides to call a tool, non-streaming responses return `message.tool_calls` and streaming responses return `delta.tool_calls`.

## ⚙️ Configuration

| Environment variable | Default | Description |
|:---------------------|:--------|:------------|
| `API_KEY` | (empty) | Bearer token required by the proxy |
| `OPENCODE_SERVER_PASSWORD` | (empty) | OpenCode backend password |
| `OPENCODE_PROXY_PORT` / `PORT` | `10000` | Proxy port |
| `OPENCODE_SERVER_PORT` | `10001` | Backend port (used only when `OPENCODE_SERVER_URL` is not set) |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | Backend URL |
| `OPENCODE_DISABLE_TOOLS` | `true` | Disable OpenCode built-in tools |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | (empty) | Comma-separated built-in tools allowed when a request has no `tools` |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | `standard` or `plugin-inject` |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | Ignore the incoming system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | Automatically clean up session storage |
| `OPENCODE_USE_ISOLATED_HOME` | `false` | Run OpenCode with an isolated config directory |
| `OPENCODE_PROXY_DEBUG` | `false` | Debug logging |

> 📄 Full reference: [Configuration](./docs/configuration.md)

Recommended production settings:

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

## 🔌 API Endpoints

| Method | Path | Description |
|:-------|:-----|:------------|
| `GET` | `/health` | Health check |
| `GET` | `/health/details` | Structured diagnostics (toggle/auth configurable) |
| `GET` | `/metrics` | Prometheus metrics (toggle/auth configurable) |
| `GET` | `/v1/models` | List models |
| `POST` | `/v1/chat/completions` | Chat Completions |
| `POST` | `/v1/responses` | Responses API |

Model naming: `opencode/big-pickle`, `gpt5-nano` (resolved to `gpt-5-nano`), or `opencode/gpt5-nano`.

> 📖 See the [API Reference](./docs/api-reference.md)

## 🔧 Troubleshooting

- **Requests hang but `/v1/models` works** — set `OPENCODE_USE_ISOLATED_HOME=false` to reuse your local OpenCode login
- **Model not found** — check `curl http://127.0.0.1:10000/v1/models` for exact model IDs
- **No reasoning output** — use the Responses API with `stream: true` and send `reasoning.effort`

> 📖 More: [Troubleshooting](./docs/troubleshooting.md)

## 📚 Documentation

| Document | Description |
|:---------|:------------|
| [Getting Started](./docs/getting-started.md) | Installation and first run |
| [Configuration](./docs/configuration.md) | All environment variables and config.json |
| [API Reference](./docs/api-reference.md) | Endpoints, parameters, and errors |
| [Docker Deployment](./docs/docker.md) | Deployment and operations |
| [Troubleshooting](./docs/troubleshooting.md) | Common issues |
| [Development](./docs/development.md) | Local development and testing |

## 📄 License

MIT · see [LICENSE](./LICENSE.md)

## 🙏 Acknowledgements

- [dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai)
- [lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy)
