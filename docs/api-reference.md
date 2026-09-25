# 🔌 API 参考

Base URL：`http://127.0.0.1:10000`。配置了 `API_KEY` 时，`/v1/*` 请求需携带 `Authorization: Bearer <API_KEY>`。

## 📡 端点

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/health` | 健康检查 |
| `GET` | `/health/details` | 结构化诊断（开关/鉴权可配置） |
| `GET` | `/metrics` | Prometheus 指标（开关/鉴权可配置） |
| `GET` | `/v1/models` | 模型列表 |
| `POST` | `/v1/chat/completions` | Chat Completions |
| `POST` | `/v1/responses` | Responses API |

### GET /v1/models

```json
{
  "object": "list",
  "data": [
    {
      "id": "opencode/big-pickle",
      "object": "model",
      "created": 1704067200,
      "owned_by": "opencode"
    }
  ]
}
```

## 💬 Chat Completions

```http
POST /v1/chat/completions
```

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `messages` | array | ✅ | 消息数组 |
| `tools` | array | - | 外部工具定义，OpenAI 兼容 function tools 结构 |
| `tool_choice` | string/object | - | 工具选择策略，按代理桥接语义处理 |
| `stream` | boolean | - | 是否流式输出 |
| `temperature` | number | - | 温度 (0-2) |
| `top_p` | number | - | 核采样 (0-1) |
| `max_tokens` | number | - | 最大 token 数 |
| `reasoning_effort` | string | - | 推理强度 |

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

## 🧠 Responses API

```http
POST /v1/responses
```

| 参数 | 类型 | 必填 | 说明 |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | 模型 ID |
| `input` / `prompt` / `messages` | string/array | ✅* | 至少提供其中之一 |
| `previous_response_id` | string | - | 上一次响应的 ID，用于继续会话 |
| `tools` | array | - | 外部工具定义 |
| `stream` | boolean | - | 是否流式输出 |
| `reasoning_effort` | string | - | 推理强度 |

> \* `input`、`prompt`、`messages` 至少提供其一。

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

### 会话续接（previous_response_id）

把上一次响应返回的 ID 作为 `previous_response_id` 传入，即可继续同一会话，无需重发完整历史：

```json
{
  "model": "opencode/big-pickle",
  "input": "继续刚才的话题",
  "previous_response_id": "resp_abc123"
}
```

- 会话状态保留 30 分钟，过期后自动清理上游会话。
- ID 无效或过期返回 400 `Invalid or expired previous_response_id`。

## 🔧 工具调用

- 请求传入 `tools` 时走外部工具桥接：非流式返回标准 `message.tool_calls`（Responses API 在 `response.output` 中返回 `type: "function_call"` 项）；流式返回 `delta.tool_calls` 及 function_call 生命周期事件（`response.output_item.added`、`response.function_call_arguments.delta` / `done`、`response.output_item.done`）。
- 请求未传入 `tools` 时走内置工具 allowlist 模式，详见 [配置详解](./configuration.md)。
- 代理内部使用命名空间隔离同名工具，内部名称不会出现在公开 API 响应中。

### 两段式工具调用建议

agent 客户端（OpenClaw、Claude Code 等）建议把「调工具」和「答问题」拆成两跳，比混在一条消息里更稳定：

```text
# 第一跳：只要求产出工具调用
Call weather_lookup for Tokyo now. Do not answer directly.

# 收到 tool_calls / function_call 并执行后，回灌工具结果，再发第二跳
Great, now answer the original request using the tool result.
```

## 🧭 推理强度

| 输入值 | 映射结果 |
|:-------|:---------|
| `minimal` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

## ⚠️ 错误响应

### 401 Unauthorized

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

### 404 Not Found

```json
{
  "error": {
    "message": "Model not found",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

### 500 Internal Server Error

```json
{
  "error": {
    "message": "Internal server error",
    "type": "server_error",
    "code": "internal_error"
  }
}
```
