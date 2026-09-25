# ⚙️ 配置详解

配置优先级：**环境变量 > config.json > 默认值**。

环境变量统一使用 `OPENCODE_` 前缀；config.json 使用对应的短名（见下表）。

## 🔧 环境变量

### 服务与认证

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PORT` / `PORT` | `PORT` | `10000` | 代理监听端口 |
| `BIND_HOST` | `BIND_HOST` | `0.0.0.0` | 监听地址 |
| `OPENCODE_SERVER_PORT` | - | `10001` | 后端端口，仅用于生成默认 `OPENCODE_SERVER_URL` |
| `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址 |
| `OPENCODE_SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | (空) | 后端认证密码 |
| `API_KEY` | `API_KEY` | (空) | 代理的 Bearer 认证密钥，未配置则不鉴权 |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `MANAGE_BACKEND` | `false` | 由代理自动拉起并管理 OpenCode 后端进程（Docker 内由 entrypoint 管理，无需开启） |
| `OPENCODE_PATH` | `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | `ZEN_API_KEY` | (空) | Zen API Key 透传 |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |

### 工具控制

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` | `DISABLE_TOOLS` | `true` | 禁用 OpenCode 内置工具 |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 外部工具桥接模式，当前仅支持 `proxy-bridge` |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 同名工具冲突隔离策略，当前仅支持 `namespace` |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `INTERNAL_ALLOWED_TOOLS` | (空) | 请求未带 `tools` 时放行的内置工具，逗号分隔 |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `INTERNAL_WEB_FETCH_ENABLED` | `false` | 旧开关：未显式配置 allowlist 时，启用后默认放行 `web_fetch` |
| `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` | `INTERNAL_TOOL_METRICS_ENABLED` | `true` | 输出 allowlist 模式的调试/指标日志 |
| `OPENCODE_TOOL_DISCOVERY_FIXTURE` | `INTERNAL_TOOL_DISCOVERY_FIXTURE` | (空) | 测试/调试用固定后端工具 ID 列表，逗号分隔 |

### 提示词与会话

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PROMPT_MODE` | `PROMPT_MODE` | `standard` | `standard` 或 `plugin-inject` |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔（毫秒） |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `CLEANUP_MAX_AGE_MS` | `86400000` | 会话最大保留时间（毫秒） |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `REQUEST_TIMEOUT_MS` | `180000` | 请求超时（毫秒） |

### 诊断与调试

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_HEALTH_DETAILS_ENABLED` | `HEALTH_DETAILS_ENABLED` | `true` | 是否暴露 `/health/details` |
| `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` | `HEALTH_DETAILS_REQUIRE_AUTH` | `true` | `/health/details` 是否要求 Bearer 认证 |
| `OPENCODE_METRICS_ENABLED` | `METRICS_ENABLED` | `false` | 是否暴露 `/metrics` |
| `OPENCODE_METRICS_REQUIRE_AUTH` | `METRICS_REQUIRE_AUTH` | `true` | `/metrics` 是否要求 Bearer 认证 |
| `OPENCODE_PROXY_DEBUG` | `DEBUG` | `false` | 调试日志 |
| `OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS` | - | `30000` | 流式响应首个 delta 的超时 |
| `OPENCODE2API_EVENT_IDLE_TIMEOUT_MS` | - | `8000` | 流式响应的空闲超时 |

## 📄 config.json 示例

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "EXTERNAL_TOOLS_MODE": "proxy-bridge",
    "EXTERNAL_TOOLS_CONFLICT_POLICY": "namespace",
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "INTERNAL_TOOL_METRICS_ENABLED": true,
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "AUTO_CLEANUP_CONVERSATIONS": false,
    "CLEANUP_INTERVAL_MS": 43200000,
    "CLEANUP_MAX_AGE_MS": 86400000,
    "REQUEST_TIMEOUT_MS": 180000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_PATH": "opencode"
}
```

## 🛠️ 工具控制详解

### 外部工具桥接

- 客户端传入的 `tools` 不会注册为 OpenCode 内置工具，由代理虚拟化后交给模型使用。
- 模型输出会被整理为 OpenAI 兼容的 `tool_calls` / `function_call` 返回给客户端。
- 同名冲突通过内部命名空间隔离（如 `external__web_fetch`），命名空间名是内部实现细节，不属于公开 API。
- 一旦请求显式传入 `tools`，OpenCode 内置工具在该请求中保持禁用。

### 内置工具 allowlist

- 请求 **未传入** `tools` 时，代理进入 internal allowlist 模式，只允许 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 声明的内置工具。
- 代理会读取后端工具列表，通过精确匹配或 `.<tool>` / `/<tool>` 后缀匹配解析最终可用工具。
- allowlist 在后端一个都匹配不到时，自动回退为「全部内置工具禁用」的安全模式。
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` 是兼容旧配置的快捷方式：未显式配置 allowlist 时视为 `web_fetch`。
- `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true` 时输出模式选择、工具发现、命中结果和降级原因的日志，不记录工具返回内容。

### 请求级 allowlist 覆盖

请求未传入 `tools` 时，可在请求体中传 `opencode.internal_allowed_tools` 覆盖服务端默认 allowlist。出于安全隔离，覆盖**只能缩小（求交集），不能扩大**：

```json
{
  "model": "opencode/kimi-k2.5",
  "messages": [{"role": "user", "content": "Fetch this URL"}],
  "opencode": {
    "internal_allowed_tools": ["web_fetch"]
  }
}
```

## 📊 健康诊断与指标

- `/health` 始终是轻量健康检查。
- `/health/details` 返回结构化诊断 JSON（`OPENCODE_HEALTH_DETAILS_ENABLED=false` 时返回 404，`OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true` 时要求认证）：

```json
{
  "status": "ok",
  "proxy": true,
  "internal_tools": {
    "config": {
      "allowed_tools": ["web_fetch"],
      "metrics_enabled": true,
      "discovery_fixture": []
    },
    "metrics": {
      "externalBridgeRequests": 12,
      "internalAllowlistRequests": 8,
      "disabledRequests": 21,
      "discoveryFailures": 1,
      "fallbackToDisabled": 2
    },
    "cache": {
      "tool_ids_cached": true,
      "tool_id_count": 1,
      "age_ms": 12000
    }
  }
}
```

- `/metrics` 返回 Prometheus 文本格式（`OPENCODE_METRICS_ENABLED=false` 时返回 404）：

```text
opencode_internal_tool_mode_requests_total{mode="external_bridge"}
opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}
opencode_internal_tool_mode_requests_total{mode="disabled"}
opencode_internal_tool_discovery_failures_total
opencode_internal_tool_fallback_disabled_total
opencode_internal_tool_cache_ids
```

## 🎯 Prompt Mode

| 模式 | 说明 |
|:-----|:-----|
| `standard`（默认） | 标准模式，完整处理提示词 |
| `plugin-inject` | 插件注入模式，减小模型侧提示词大小，通常与 `OMIT_SYSTEM_PROMPT=true` 配合使用 |

## ⭐ 推荐配置

### Docker 生产环境

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### 本地开发

```env
OPENCODE_DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
