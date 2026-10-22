# OpenCode2API

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-22.23.4+-orange" alt="Node">
</p>

> **语言：** [English](./README.md) | [简体中文](./README.zh-CN.md)
>
> 📖 [文档](./docs/README.zh-CN.md) | 🚀 [快速开始](#快速开始) | 🐛 [Issues](https://github.com/samson910022/OpenCode2API/issues)

将本地 [OpenCode](https://opencode.ai) 运行时转换为 OpenAI、Anthropic 与 Gemini 兼容 API 网关。在任何 OpenAI、Anthropic 或 Gemini 客户端中使用免费模型（Big Pickle、Ling、MiMo、Muse Spark、Nemotron）——免费阵容会轮换，以 `/v1/models` 实时列表为准。

---

## ✨ 功能特性

| 特性 | 说明 |
|:-----|:-----|
| 🟢 **OpenAI 兼容** | `/v1/models`, `/v1/chat/completions`, `/v1/responses` |
| 🟣 **Anthropic 兼容** | `/v1/messages`（`tool_use` / `thinking` / SSE） |
| 🔁 **Gemini 兼容（薄层）** | `POST /v1beta/interactions`（别名 `POST /v1/interactions`） |
| 🌐 **服务端联网搜索** | `web_search`，返回 `web_search_call` + `url_citation` |
| 🔑 **多 Key 认证** | `API_KEY` 与 `OPENCODE_API_KEYS` 合并；`Bearer` 或 `x-api-key`；为空免认证 |
| 🔀 **免费限流 fallback 代理** | 仅免费限流 429 时轮换 `OPENCODE_UPSTREAM_PROXIES` |
| 📡 **流式输出** | Chat、Responses、Messages、Interactions 全支持 SSE |
| 🧠 **推理控制** | `reasoning_effort` / `reasoning: {"effort": "high"}` |
| 🐳 **Docker 部署** | 一键部署，自动启动后端 |
| 🛡️ **工具安全** | 默认禁用工具调用 |
| 🔧 **外部工具桥接** | 外部 `tools` 桥接为 `tool_calls` / `function_call`，隔离内置工具 |
| 🌐 **内置 web_fetch 透传** | 无 `tools` 且显式开启时，仅放行内置 `web_fetch` |

---

## 🚀 快速开始

### Docker 部署 (推荐)

```bash
# 1. 克隆并配置
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
cp .env.example .env

# 2. 编辑 .env 设置你的配置
# 必填: API_KEY, OPENCODE_SERVER_PASSWORD

# 3. 启动
docker compose up -d

# 4. 测试
curl http://127.0.0.1:10000/health
```

> 默认不挂载宿主机目录以避免覆盖容器内 `node_modules`；Docker 面向生产、本地 Node 面向开发——详见 [Docker 部署](./docs/docker.md) 与 [快速开始](./docs/getting-started.md)。

### Node.js (本地开发)

```bash
# 1. 安装 OpenCode CLI
npm install -g opencode-ai
# Linux/macOS: curl -fsSL https://opencode.ai/install | bash

# 2. 克隆并运行
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
npm install
cp config.json.example config.json
npm run build
npm start
```

> 📖 完整指南：[开发指南](./docs/development.md) · 🚀 [快速开始](./docs/getting-started.md)

---

## 💡 使用示例

### Chat Completions

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "你好!"}],
    "stream": false
  }'
```

### Responses API (带推理)

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/muse-spark-1.3-contributor-free",
    "input": "用一句话打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

> 更多示例：[API 参考](./docs/api-reference.md)

---

## ⚙️ 配置

- 基础：`API_KEY`、`OPENCODE_SERVER_PASSWORD`、`OPENCODE_SERVER_URL`、`OPENCODE_PROXY_PORT`（`PORT`）。
- 工具安全：默认 `DISABLE_TOOLS=true`；外部 `tools` 经桥接隔离，内置工具默认禁用，按需 allowlist 放行。
- 可观测性：`/health/details` 与 `/metrics` 均可配置开关与鉴权。
- 超时与重试：`OPENCODE_PROXY_REQUEST_TIMEOUT_MS`、`OPENCODE_PROXY_RETRY_MAX_RETRIES`；仅免费限流 429 时启用 `OPENCODE_UPSTREAM_PROXIES`。

> 📄 完整配置参考：[配置详解](./docs/configuration.md)

---

## 🔌 API 参考

### 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/health` | 健康检查 |
| `GET` | `/health/details` | 结构化诊断接口（可配置开关/鉴权） |
| `GET` | `/metrics` | Prometheus 指标接口（可配置开关/鉴权） |
| `GET` | `/v1/models` | 获取可用模型列表 |
| `POST` | `/v1/chat/completions` | Chat Completions API |
| `POST` | `/v1/responses` | Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API（`max_tokens` 必填，支持 `x-api-key`） |
| `POST` | `/v1beta/interactions` | Gemini 兼容薄层（文本 + `google_search` 联网、`previous_interaction_id`、`store`、SSE 无 `[DONE]`） |
| `POST` | `/v1/interactions` | `/v1beta/interactions` 的别名 |

### 协议保真度

请使用与客户端原生对应的端点，跨协议转换为 best-effort（详见 [架构](./docs/architecture.md) 与 [故障排查](./docs/troubleshooting.md)）。

### 模型名称格式

支持 `opencode/big-pickle`、`gpt5-nano`（自动解析）与 `opencode/gpt5-nano`；详见 [API 参考文档](./docs/api-reference.md)。

---

## 🔧 故障排查

卡住：试 `OPENCODE_USE_ISOLATED_HOME=false`。模型缺失：检查 `/v1/models`。无推理：用 `stream: true` + `reasoning.effort` 的 Responses API。

> 📖 完整指南：[故障排查](./docs/troubleshooting.md)

---

## 🔨 开发

```bash
npm run typecheck  # 类型检查
npm run build  # 构建到 dist/
npm run dev  # 本地开发
npm start  # node dist/index.js
npm test -- --runInBand  # 测试
docker compose up -d --build  # Docker 开发
```

> 📖 完整指南：[开发指南](./docs/development.md) · 🤝 [CONTRIBUTING](./CONTRIBUTING.md)

---

## 📄 许可证

MIT · 详见 [LICENSE](./LICENSE.md)

---

## 🙏 致谢

本项目由 [samson910022/OpenCode2API](https://github.com/samson910022/OpenCode2API) 独立维护，复刻（Fork）自 [TiaraBasori/opencode2api](https://github.com/TiaraBasori/opencode2api)，并受 [dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai) 与 [lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy) 启发。上游代码保留其原始 MIT 许可；详见 [LICENSE](./LICENSE.md)。
