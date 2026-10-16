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
| `API_KEY` | `API_KEY` | (空) | 代理的 Bearer 认证密钥（管理端点也用它做管理员认证），未配置则不鉴权 |
| `OPENCODE_API_KEYS` | `API_KEYS` | (空) | 多用户 API key 列表：env 用逗号分隔的 `name:key` 字符串，config.json 用 `[{name, key}]` 数组。详见[多用户 API Keys](#-多用户-api-keys) |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `MANAGE_BACKEND` | `true` | 由代理拉起并管理 OpenCode 后端进程，后端会加载工具锁插件 |
| `OPENCODE_PATH` | `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | `ZEN_API_KEY` | (空) | Zen API Key，以 `OPENCODE_API_KEY` 传给代理拉起的后端，用于付费模型 |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录 |

### 工具控制

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` | `DISABLE_TOOLS` | `true` | 禁用 OpenCode 内置工具 |
| `OPENCODE_CHAT_SESSION_AFFINITY` | `CHAT_SESSION_AFFINITY` | `false` | 多轮对话复用同一后端会话（只追加新回合，命中上游提示缓存） |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `INTERNAL_ALLOWED_TOOLS` | (空) | 请求未带 `tools` 时放行的内置工具，逗号分隔（如 `web_fetch`） |

### 提示词与会话

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储 |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔（毫秒） |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `CLEANUP_MAX_AGE_MS` | `86400000` | 会话最大保留时间（毫秒） |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `REQUEST_TIMEOUT_MS` | `180000` | 请求超时（毫秒） |

### 诊断与调试

| 环境变量 | config.json | 默认值 | 说明 |
|:---------|:------------|:-------|:-----|
| `OPENCODE_HEALTH_DETAILS_ENABLED` | `HEALTH_DETAILS_ENABLED` | `true` | 是否暴露 `/health/details` |
| `OPENCODE_METRICS_ENABLED` | `METRICS_ENABLED` | `false` | 是否暴露 `/metrics` |
| `OPENCODE_PUBLIC_DIAGNOSTICS` | `PUBLIC_DIAGNOSTICS` | `false` | `true` 时 `/health/details`、`/metrics` 与 Web Panel 数据端点免认证（默认要求 Bearer） |
| `OPENCODE_WEB_PANEL_ENABLED` | `WEB_PANEL_ENABLED` | `false` | 在 `/panel` 提供内置 Web Panel |
| `OPENCODE_PROXY_DEBUG` | `DEBUG` | `false` | 调试日志 |
| `OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS` | - | `30000` | 流式响应首个 delta 的超时 |
| `OPENCODE2API_EVENT_IDLE_TIMEOUT_MS` | - | `8000` | 流式响应的空闲超时 |

## 📄 config.json 示例

```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "API_KEYS": [
        { "name": "alice", "key": "sk-alice-..." },
        { "key": "sk-bare-key-..." }
    ],
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "USE_ISOLATED_HOME": false,
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

### 工具锁插件

OpenCode 官方服务会拒绝工具列表被改动的请求（报错 `free tier can only be used from within OpenCode`），因此代理拉起后端时会自动加载 `plugin/opencode2api-tool-lock.js`：工具列表保持原样，工具策略写在会话标题里，由插件在执行时拦截。整个过程无需任何配置。

- 使用自行启动的后端（`MANAGE_BACKEND=false`）时，需要把该文件的绝对路径加入后端配置的 `plugin` 列表，否则代理退回按请求关闭工具，免费模型会被拒绝。

### 内置工具 allowlist

- 请求 **未传入** `tools` 时，代理进入 internal allowlist 模式，只允许 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 声明的内置工具。
- 工具名比较时忽略大小写和下划线，`web_fetch` 等同于 OpenCode 的 `webfetch`。
- 工具模式选择、工具发现和命中结果会输出到 DEBUG 日志（`OPENCODE_PROXY_DEBUG=true`），不记录工具返回内容。

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

## 👥 多用户 API Keys

除了单一 `API_KEY`，还可以配置一组**具名用户 key**（`API_KEYS`），实现多用户分发与按 key 用量统计。两者可以同时配置：

- 请求命中 `API_KEYS` 中任意一个 key → 认证通过，并记到该 key 名下；
- 未命中用户 key → 回落到 `API_KEY`（老部署零改动）；
- 两者都为空 → 不鉴权（现状不变）。

### 配置格式

环境变量 `OPENCODE_API_KEYS` 使用**逗号分隔的 `name:key`** 字符串（env 友好），`=` 也可作分隔符：

```env
OPENCODE_API_KEYS=alice:sk-alice-xxxx,bob:sk-bob-xxxx,sk-bare-key-xxxx
```

config.json 顶层使用 `API_KEYS` 数组，每项 `{name, key}`（`name` 可省略）：

```json
{
    "API_KEYS": [
        { "name": "alice", "key": "sk-alice-xxxx" },
        { "key": "sk-bare-key-xxxx" }
    ]
}
```

**name 语义**：

- 省略 name 的裸 key 自动命名为 `key-N`（N 为该 entry 在列表中的 1-based 位置）；
- name 是用量统计与 `/admin/keys` 的主键，必须唯一；key 值也必须唯一；
- 出现重复 name 或重复 key 时**启动直接报错退出**，避免带病运行。

### 认证行为

- 命中用户 key 的请求对业务端点（`/v1/chat/completions`、`/v1/responses` 等）与 `API_KEY` 完全同权；
- `/health/details`、`/metrics` 的鉴权语义不变（默认要求 Bearer，`OPENCODE_PUBLIC_DIAGNOSTICS=true` 时免认证，用户 key 与 `API_KEY` 均可通过）。多用户模式下，管理员 `API_KEY` 可见全部 key 的 `usage.byKey` 与按 key 指标，普通用户 key 仅可见自身条目，未携带密钥的 `OPENCODE_PUBLIC_DIAGNOSTICS=true` 请求仅返回汇总 `usage.total`（不公开任何 key 名称）；
- 删除（revoke）某个用户 key 后，用该 key 发出的请求立即返回 401。

### 管理端点（/admin/keys）

仅当配置了至少 1 个 `API_KEYS` 条目时才挂载。全部端点要求**管理员认证 = `Bearer API_KEY`**（即老的单一管理密钥，用户 key 一律 401），且不受 `OPENCODE_PUBLIC_DIAGNOSTICS` 影响（无免认证旁路）。`API_KEY` 为空时管理端点返回 `501`（管理面不可用）。

| 方法 | 路径 | 说明 |
|:-----|:-----|:-----|
| `GET` | `/admin/keys` | 列出全部用户 key 及其用量 |
| `POST` | `/admin/keys` | 运行时热加 key，body 为 `{"name": "carol", "key": "sk-..."}`；重名或 key 重复返回 `400` |
| `DELETE` | `/admin/keys/:name` | 移除 key；不存在返回 `404`，成功返回 `204` |

`GET /admin/keys` 响应示例（keyHint 只露末 4 位，完整 key 不可回取）：

```json
[
  {
    "name": "alice",
    "keyHint": "…xxxx",
    "requests": 12,
    "promptTokens": 8451,
    "completionTokens": 2210,
    "totalTokens": 10661,
    "lastUsedAt": 1789000000000,
    "createdAt": 1788900000000
  }
]
```

### 用量口径

用量保存在内存中，随进程重启清零（不做持久化）：

- **requests**：认证通过后进入业务 handler 的请求数（`/v1/chat/completions`、`/v1/responses`），失败的请求（4xx/5xx）同样计入；
- **promptTokens / completionTokens**：仅成功请求累计，沿用 `Math.ceil(字符数 / 4)` 的估算口径，completionTokens 包含 reasoning tokens（与响应 usage 字段一致）；
- **lastUsedAt / createdAt**：最后一次使用时间与 key 创建（进程启动或运行时新增）时间的毫秒时间戳。

`/health/details` 在多用户模式下额外返回 `usage` 字段（单 key 部署不出现，保持兼容）：

```json
{
  "status": "ok",
  "proxy": true,
  "usage": {
    "byKey": {
      "alice": {
        "requests": 12,
        "promptTokens": 8451,
        "completionTokens": 2210,
        "totalTokens": 10661,
        "lastUsedAt": 1789000000000,
        "createdAt": 1788900000000
      }
    },
    "total": {
      "requests": 12,
      "promptTokens": 8451,
      "completionTokens": 2210,
      "totalTokens": 10661
    }
  }
}
```

`/metrics` 在多用户模式下输出按 key 的 Prometheus 计数器：

```text
opencode_proxy_key_requests_total{key="alice"}
opencode_proxy_key_tokens_total{key="alice",type="prompt"}
opencode_proxy_key_tokens_total{key="alice",type="completion"}
```

## 📊 健康诊断与指标

- `/health` 始终是轻量健康检查。
- `/health/details` 返回结构化诊断 JSON（`OPENCODE_HEALTH_DETAILS_ENABLED=false` 时返回 404；默认要求 Bearer 认证，`OPENCODE_PUBLIC_DIAGNOSTICS=true` 时免认证）：

```json
{
  "status": "ok",
  "proxy": true,
  "internal_tools": {
    "config": {
      "allowed_tools": ["web_fetch"]
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

## 🖥️ Web Panel

可选的只读仪表盘，由代理自身提供，默认关闭；设 `OPENCODE_WEB_PANEL_ENABLED=true`（或在 config.json 中设 `"WEB_PANEL_ENABLED": true`）开启。

- `GET /panel` — 自包含的深色主题 HTML 页面（无外部 CSS/JS，CSP 限定同源）。展示运行状态（状态、uptime、后端地址）、模型列表，以及来自 `/health/details` 的后端诊断（工具模式计数、工具 ID 缓存）。页面把输入的密钥保存在浏览器 localStorage，并用它请求 `GET /panel/data.json`。
- `GET /panel/data.json` — 页面背后的 JSON 数据源：`models`、`health`（即 `/health/details` 的内容）、`uptime` 与 `backend_url`。永远不会返回 `OPENCODE_SERVER_PASSWORD`、`ZEN_API_KEY`、`API_KEY`、`API_KEYS` 的值。

认证规则与诊断端点一致：配置了 `API_KEY` 时，`/panel/data.json` 要求 `Authorization: Bearer <API_KEY>`（HTML 页面本体 `/panel` 公开但不包含任何数据）；`PUBLIC_DIAGNOSTICS=true` 或 `API_KEY` 为空时免认证。面板关闭时两个路由都返回 404。

## ⭐ 推荐配置

### Docker 生产环境

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### 本地开发

```env
OPENCODE_DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
