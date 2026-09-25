# 🔌 API Reference

Base URL: `http://127.0.0.1:10000`. When `API_KEY` is set, `/v1/*` requests need `Authorization: Bearer <API_KEY>`.

## 📡 Endpoints

| Method | Path | Description |
|:-----|:-----|:-----|
| `GET` | `/health` | Health check |
| `GET` | `/health/details` | Structured diagnostics (toggleable/auth-gated) |
| `GET` | `/metrics` | Prometheus metrics (toggleable/auth-gated) |
| `GET` | `/v1/models` | List models |
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

| Param | Type | Required | Description |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | Model ID |
| `messages` | array | ✅ | Message array |
| `tools` | array | - | External tool definitions, OpenAI-compatible function tools |
| `tool_choice` | string/object | - | Tool choice policy, handled per proxy bridge semantics |
| `stream` | boolean | - | Stream output |
| `temperature` | number | - | Temperature (0-2) |
| `top_p` | number | - | Nucleus sampling (0-1) |
| `max_tokens` | number | - | Max tokens |
| `reasoning_effort` | string | - | Reasoning effort |

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

## 🧠 Responses API

```http
POST /v1/responses
```

| Param | Type | Required | Description |
|:-----|:-----|:-----|:-----|
| `model` | string | ✅ | Model ID |
| `input` / `prompt` / `messages` | string/array | ✅* | At least one is required |
| `previous_response_id` | string | - | Previous response ID, to continue a session |
| `tools` | array | - | External tool definitions |
| `stream` | boolean | - | Stream output |
| `reasoning_effort` | string | - | Reasoning effort |

> \* At least one of `input`, `prompt`, `messages`.

```bash
curl -N -X POST http://127.0.0.1:10000/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt5-nano",
    "input": "Say hello in one sentence",
    "reasoning": {"effort": "high"},
    "stream": true
  }'
```

### Session Resume (previous_response_id)

Pass the previous response ID as `previous_response_id` to continue the same session, no need to resend full history:

```json
{
  "model": "opencode/big-pickle",
  "input": "Continue the last topic",
  "previous_response_id": "resp_abc123"
}
```

- Session state is kept for 30 minutes. Expired upstream sessions are cleaned up automatically.
- Invalid or expired IDs return 400 `Invalid or expired previous_response_id`.

## 🔧 Tool Calls

- Requests with `tools` use the external tool bridge: non-streaming returns standard `message.tool_calls` (Responses API returns `type: "function_call"` items in `response.output`); streaming returns `delta.tool_calls` plus function_call lifecycle events (`response.output_item.added`, `response.function_call_arguments.delta` / `done`, `response.output_item.done`).
- Requests without `tools` use the built-in tool allowlist mode, see [Configuration](./configuration.md).
- The proxy uses namespace isolation for same-name tools internally. Internal names never appear in public API responses.

### Two-step Tool Call Pattern

Agent clients (OpenClaw, Claude Code, etc.) should split "call tools" and "answer" into two hops. It is more stable than mixing both in one message:

```text
# Hop 1: only ask for tool calls
Call weather_lookup for Tokyo now. Do not answer directly.

# After receiving tool_calls / function_call and running them, feed results back, then hop 2
Great, now answer the original request using the tool result.
```

## 🧭 Reasoning Effort

| Input | Mapped to |
|:-------|:---------|
| `minimal` | `none` |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `high` |

## ⚠️ Error Responses

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
