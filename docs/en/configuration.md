# ⚙️ Configuration

Priority: **env vars > config.json > defaults**.

Env vars use the `OPENCODE_` prefix; config.json uses the short names (see tables).

## 🔧 Environment Variables

### Service & Auth

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_PORT` / `PORT` | `PORT` | `10000` | Proxy listen port |
| `BIND_HOST` | `BIND_HOST` | `0.0.0.0` | Listen address |
| `OPENCODE_SERVER_PORT` | - | `10001` | Backend port, only used to build default `OPENCODE_SERVER_URL` |
| `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode backend address |
| `OPENCODE_SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | (empty) | Backend auth password |
| `API_KEY` | `API_KEY` | (empty) | Proxy Bearer key (also the admin credential for `/admin/keys`), no auth when unset |
| `OPENCODE_API_KEYS` | `API_KEYS` | (empty) | Multi-user API key list: a comma-separated `name:key` string for env, a `[{name, key}]` array for config.json. See [Multi-user API Keys](#-multi-user-api-keys) |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `MANAGE_BACKEND` | `true` | Proxy starts and manages the OpenCode backend process, which loads the tool-lock plugin |
| `OPENCODE_PATH` | `OPENCODE_PATH` | `opencode` | OpenCode binary path |
| `OPENCODE_ZEN_API_KEY` | `ZEN_API_KEY` | (empty) | Zen API key, passed to the managed backend as `OPENCODE_API_KEY` for paid models |
| `OPENCODE_USE_ISOLATED_HOME` | `USE_ISOLATED_HOME` | `false` | Use an isolated OpenCode config directory |

### Tool Control

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` | `DISABLE_TOOLS` | `true` | Disable OpenCode built-in tools |
| `OPENCODE_CHAT_SESSION_AFFINITY` | `CHAT_SESSION_AFFINITY` | `false` | Reuse one backend session per multi-turn chat conversation |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `INTERNAL_ALLOWED_TOOLS` | (empty) | Built-in tools allowed when request has no `tools`, comma-separated (e.g. `web_fetch`) |

### Prompts & Sessions

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `OMIT_SYSTEM_PROMPT` | `false` | Ignore the incoming system prompt |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `AUTO_CLEANUP_CONVERSATIONS` | `false` | Auto clean session storage |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `CLEANUP_INTERVAL_MS` | `43200000` | Cleanup interval (ms) |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `CLEANUP_MAX_AGE_MS` | `86400000` | Max session age (ms) |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `REQUEST_TIMEOUT_MS` | `180000` | Request timeout (ms) |
| `OPENCODE_USAGE_FILE` | `USAGE_FILE` | `usage.json` beside `config.json` | Per-key usage snapshot path (multi-user only) |
| `OPENCODE_USAGE_PERSISTENCE` | `USAGE_PERSISTENCE` | `true` | Keep per-key counters across restarts |
| `OPENCODE_USAGE_SAVE_INTERVAL_MS` | `USAGE_SAVE_INTERVAL_MS` | `300000` | Snapshot rewrite interval (ms); `0` = shutdown save only |

### Diagnostics & Debug

| Env var | config.json | Default | Description |
|:---------|:------------|:-------|:-----|
| `OPENCODE_HEALTH_DETAILS_ENABLED` | `HEALTH_DETAILS_ENABLED` | `true` | Expose `/health/details` |
| `OPENCODE_METRICS_ENABLED` | `METRICS_ENABLED` | `false` | Expose `/metrics` |
| `OPENCODE_PUBLIC_DIAGNOSTICS` | `PUBLIC_DIAGNOSTICS` | `false` | `true` makes `/health/details`, `/metrics` and the web panel data endpoint public (default: Bearer auth) |
| `OPENCODE_WEB_PANEL_ENABLED` | `WEB_PANEL_ENABLED` | `false` | Serve the built-in web panel at `/panel` |
| `OPENCODE_PROXY_DEBUG` | `DEBUG` | `false` | Debug logs |
| `OPENCODE2API_EVENT_FIRST_DELTA_TIMEOUT_MS` | - | `30000` | First-delta timeout for streaming |
| `OPENCODE2API_EVENT_IDLE_TIMEOUT_MS` | - | `8000` | Idle timeout for streaming |

## 📄 config.json Example

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

## 🛠️ Tool Control Details

### External Tool Bridge

- Client-supplied `tools` are not registered as OpenCode built-in tools. The proxy virtualizes them for the model.
- Model output is normalized to OpenAI-compatible `tool_calls` / `function_call` for the client.
- Same-name conflicts are isolated via an internal namespace (e.g. `external__web_fetch`). Namespace names are internal details, not public API.
- Once a request passes `tools` explicitly, OpenCode built-in tools stay disabled for that request.

### Tool-Lock Plugin

The OpenCode service rejects requests whose tool list has been modified (with the error `free tier can only be used from within OpenCode`). The proxy therefore loads `plugin/opencode2api-tool-lock.js` into the backend it starts automatically: the tool list stays intact, the tool policy rides in the session title, and the plugin blocks tools at execution time. No configuration needed.

- With a backend you start yourself (`MANAGE_BACKEND=false`), add the absolute path of that file to the backend's `plugin` config. Otherwise the proxy falls back to per-request tool overrides and free models are rejected.

### Built-in Tool Allowlist

- When a request has **no** `tools`, the proxy enters internal allowlist mode. Only tools in `OPENCODE_INTERNAL_ALLOWED_TOOLS` are allowed.
- Tool names are compared ignoring case and underscores, so `web_fetch` matches OpenCode's `webfetch`.
- Tool mode selection, tool discovery, and match results are logged at DEBUG level (`OPENCODE_PROXY_DEBUG=true`). Tool return content is not logged.

### Request-level Allowlist Override

When a request has no `tools`, `opencode.internal_allowed_tools` in the request body overrides the server default allowlist. For isolation, the override is **intersect-only, never expands**:

```json
{
  "model": "opencode/kimi-k2.5",
  "messages": [{"role": "user", "content": "Fetch this URL"}],
  "opencode": {
    "internal_allowed_tools": ["web_fetch"]
  }
}
```

## 👥 Multi-user API Keys

Besides the single `API_KEY`, you can configure a set of **named user keys** (`API_KEYS`) for multi-user distribution with per-key usage metering. Both can be configured at once:

- A request matching any `API_KEYS` entry authenticates and is metered under that key's name;
- Otherwise the request falls back to `API_KEY` (existing single-key deployments are unchanged);
- Both empty → no auth (current behavior).

### Configuration formats

`OPENCODE_API_KEYS` (env) is a **comma-separated `name:key`** string (`=` also works as the separator):

```env
OPENCODE_API_KEYS=alice:sk-alice-xxxx,bob:sk-bob-xxxx,sk-bare-key-xxxx
```

config.json uses an `API_KEYS` array of `{name, key}` entries (`name` optional):

```json
{
    "API_KEYS": [
        { "name": "alice", "key": "sk-alice-xxxx" },
        { "key": "sk-bare-key-xxxx" }
    ]
}
```

**Name semantics**:

- Bare keys without a name are auto-named `key-N` (N = 1-based position of the entry in the list);
- Names are the primary key for usage metering and `/admin/keys` and must be unique; key values must be unique too;
- Duplicate names or duplicate keys **fail at startup** with an error instead of running misconfigured.

### Authentication behavior

- User keys carry exactly the same business-endpoint access (`/v1/chat/completions`, `/v1/responses`, ...) as `API_KEY`;
- `/health/details` and `/metrics` auth semantics are unchanged (Bearer by default, public with `OPENCODE_PUBLIC_DIAGNOSTICS=true`; user keys and `API_KEY` both pass). In multi-user mode, the admin `API_KEY` sees all keys in `usage.byKey` / per-key metrics, a user key sees only its own entry, and unauthenticated `OPENCODE_PUBLIC_DIAGNOSTICS=true` requests see only the aggregate `usage.total` (no key names are exposed publicly);
- Deleting (revoking) a user key makes that key's requests fail with 401 immediately.

### Admin endpoints (/admin/keys)

Mounted only when at least one `API_KEYS` entry is configured. Every endpoint requires the **admin credential = `Bearer API_KEY`** (the legacy single admin key — user keys always get 401), and there is no `OPENCODE_PUBLIC_DIAGNOSTICS` bypass. With an empty `API_KEY` the admin surface answers `501` (unavailable).

| Method | Path | Description |
|:-----|:-----|:-----|
| `GET` | `/admin/keys` | List all user keys with their usage |
| `POST` | `/admin/keys` | Hot-add a key at runtime, body `{"name": "carol", "key": "sk-..."}`; duplicate name or key → `400` |
| `DELETE` | `/admin/keys/:name` | Remove a key; unknown name → `404`, success → `204` |

`GET /admin/keys` response example (`keyHint` shows only the last 4 characters; the full key is never retrievable):

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

### Usage accounting

Usage is counted in memory and, on multi-user deployments, also saved to disk so counters survive a restart:

- **requests**: requests that authenticated and entered a business handler (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`); failed requests (4xx/5xx) also count;
- **promptTokens / completionTokens**: accumulated for successful requests. The backend reports its own token counts for every turn, so those are what gets billed; the `Math.ceil(chars / 4)` estimate is only a fallback for a backend that reports none. Cached prompt tokens are included in promptTokens, and completionTokens include reasoning tokens;
- **lastUsedAt / createdAt**: millisecond timestamps of the last use and of key creation (process start or runtime add).

#### Keeping the counters across restarts

With `API_KEYS` configured, the counters are written to `usage.json` next to `config.json` every five minutes and once more on `SIGINT`/`SIGTERM`. The file is written atomically (temp file + rename) with mode `0600`, and a damaged file is reported and ignored instead of blocking startup. On start the saved counters are restored, so a restart — or a redeploy — does not reset them.

| Variable | Config key | Default | Description |
|:-----|:-----|:-----|:-----|
| `OPENCODE_USAGE_PERSISTENCE` | `USAGE_PERSISTENCE` | `true` | Save per-key counters to disk. `false` restores the old in-memory-only behavior |
| `OPENCODE_USAGE_FILE` | `USAGE_FILE` | `usage.json` next to `config.json` | Snapshot path |
| `OPENCODE_USAGE_SAVE_INTERVAL_MS` | `USAGE_SAVE_INTERVAL_MS` | `300000` | How often the snapshot is rewritten; `0` disables periodic saves (the shutdown save still runs) |

To reset the counters, stop the proxy and delete `usage.json`. Single-key deployments (no `API_KEYS`) keep no per-key state and never write the file.

`/health/details` gains a `usage` field in multi-user mode (absent for single-key deployments, preserving the legacy snapshot shape):

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

`/metrics` emits per-key Prometheus counters in multi-user mode:

```text
opencode_proxy_key_requests_total{key="alice"}
opencode_proxy_key_tokens_total{key="alice",type="prompt"}
opencode_proxy_key_tokens_total{key="alice",type="completion"}
```

## 📊 Health Diagnostics & Metrics

- `/health` is always a lightweight check.
- `/health/details` returns structured diagnostic JSON (`404` when `OPENCODE_HEALTH_DETAILS_ENABLED=false`; Bearer auth by default, public with `OPENCODE_PUBLIC_DIAGNOSTICS=true`):

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

- `/metrics` returns Prometheus text format (`404` when `OPENCODE_METRICS_ENABLED=false`):

```text
opencode_internal_tool_mode_requests_total{mode="external_bridge"}
opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}
opencode_internal_tool_mode_requests_total{mode="disabled"}
opencode_internal_tool_discovery_failures_total
opencode_internal_tool_fallback_disabled_total
opencode_internal_tool_cache_ids
```

## 🖥️ Web Panel

An optional read-only dashboard served by the proxy itself. Off by default; enable with `OPENCODE_WEB_PANEL_ENABLED=true` (or `"WEB_PANEL_ENABLED": true` in config.json).

- `GET /panel` — a self-contained dark-themed HTML page (no external CSS/JS, CSP locked to same-origin). It shows the runtime status (status, uptime, backend URL), the model list, and backend diagnostics from `/health/details` (tool-mode counters, tool ID cache). The page stores the key you enter in the browser's localStorage and calls `GET /panel/data.json` with it.
- `GET /panel/data.json` — the JSON feed behind the page: `models`, `health` (the `/health/details` payload), `uptime` and `backend_url`. It never returns `OPENCODE_SERVER_PASSWORD`, `ZEN_API_KEY`, `API_KEY` or `API_KEYS` values.

Authentication follows the diagnostics rules: with `API_KEY` set, `/panel/data.json` requires `Authorization: Bearer <API_KEY>` (the HTML shell at `/panel` is public but contains no data), and `PUBLIC_DIAGNOSTICS=true` or an empty `API_KEY` lifts the auth. When the panel is disabled, both routes return `404`.

## ⭐ Recommended Configs

### Docker Production

```env
API_KEY=your-secret-key
OPENCODE_SERVER_PASSWORD=your-password
OPENCODE_DISABLE_TOOLS=true
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

### Local Development

```env
OPENCODE_DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
