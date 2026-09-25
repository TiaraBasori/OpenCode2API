# OpenCode2API

<p align="center">
  <img src="https://img.shields.io/badge/version-1.5.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/Node.js-18+-orange" alt="Node">
</p>

简体中文 | [English](./README.en.md)

把本地 [OpenCode](https://opencode.ai) 运行时转换为 OpenAI 兼容 API 网关，在任何 OpenAI 客户端中使用免费模型（GPT、Kimi、GLM、MiniMax 等）。

## ✨ 功能特性

- **OpenAI 兼容** — `/v1/models`、`/v1/chat/completions`、`/v1/responses`，完整 SSE 流式输出
- **推理控制** — 支持 `reasoning_effort` 与 `reasoning: {"effort": "high"}`
- **会话续接** — Responses API 支持 `previous_response_id`，30 分钟 TTL，到期自动清理上游会话
- **外部工具桥接** — 客户端传入 `tools`，代理返回标准 `tool_calls` / `function_call`，不触发 OpenCode 内置工具
- **内置工具 allowlist** — 请求未带 `tools` 时，仅放行 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 声明的内置工具
- **可观测性** — `/health/details` 结构化诊断，`/metrics` Prometheus 指标
- **Docker 部署** — 一键启动，自动拉起 OpenCode 后端

## 🚀 快速开始

### Docker（推荐）

```bash
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env        # 编辑 .env，必填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d
curl http://127.0.0.1:10000/health
```

> 默认 Compose 配置不挂载宿主机项目目录，避免覆盖镜像内已安装的 `node_modules`。需要源码热更新时，请单独使用开发用的 Compose 覆盖文件。

### Node.js（本地开发）

```bash
# 安装 OpenCode CLI
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash

git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
npm install
cp config.json.example config.json
npm start
```

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

### Responses API（流式 + 推理）

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "用一句话打招呼",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### 外部工具

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "帮我获取 https://example.com 的标题"}],
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

模型决定调用工具时，非流式响应返回 `message.tool_calls`，流式响应返回 `delta.tool_calls`。

## ⚙️ 配置

| 环境变量 | 默认值 | 说明 |
|:--------|:-------|:-----|
| `API_KEY` | (空) | 代理的 Bearer 认证密钥 |
| `OPENCODE_SERVER_PASSWORD` | (空) | OpenCode 后端密码 |
| `OPENCODE_PROXY_PORT` / `PORT` | `10000` | 代理端口 |
| `OPENCODE_SERVER_PORT` | `10001` | 后端端口（未显式配置 `OPENCODE_SERVER_URL` 时生效） |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | 后端地址 |
| `OPENCODE_DISABLE_TOOLS` | `true` | 禁用 OpenCode 内置工具 |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | (空) | 请求未带 `tools` 时放行的内置工具，逗号分隔 |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | `standard` 或 `plugin-inject` |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `OPENCODE_USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |
| `OPENCODE_PROXY_DEBUG` | `false` | 调试日志 |

> 📄 完整配置见 [配置详解](./docs/configuration.md)

推荐生产配置：

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

## 🔌 API 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/health` | 健康检查 |
| `GET` | `/health/details` | 结构化诊断（可配置开关/鉴权） |
| `GET` | `/metrics` | Prometheus 指标（可配置开关/鉴权） |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/chat/completions` | Chat Completions |
| `POST` | `/v1/responses` | Responses API |

模型名称写法：`opencode/big-pickle`、`gpt5-nano`（自动解析为 `gpt-5-nano`）、`opencode/gpt5-nano`。

> 📖 详见 [API 参考](./docs/api-reference.md)

## 🔧 故障排查

- **请求卡住但 `/v1/models` 正常** — 设 `OPENCODE_USE_ISOLATED_HOME=false` 复用本地登录态
- **模型找不到** — `curl http://127.0.0.1:10000/v1/models` 确认模型 ID
- **没有推理输出** — 用 `stream: true` 的 Responses API，并传 `reasoning.effort`

> 📖 更多见 [故障排查](./docs/troubleshooting.md)

## 📚 文档

| 文档 | 说明 |
|:-----|:-----|
| [快速开始](./docs/getting-started.md) | 安装与首次运行 |
| [配置详解](./docs/configuration.md) | 全部环境变量与 config.json |
| [API 参考](./docs/api-reference.md) | 端点、参数与错误码 |
| [Docker 部署](./docs/docker.md) | 部署与运维 |
| [故障排查](./docs/troubleshooting.md) | 常见问题 |
| [开发指南](./docs/development.md) | 本地开发与测试 |

## 📄 许可证

MIT · 详见 [LICENSE](./LICENSE.md)

## 🙏 致谢

- [dxxzst/opencode-to-openai](https://github.com/dxxzst/opencode-to-openai)
- [lucasliet/opencode-openai-proxy](https://github.com/lucasliet/opencode-openai-proxy)
