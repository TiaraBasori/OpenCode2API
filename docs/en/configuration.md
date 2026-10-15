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
| `API_KEY` | `API_KEY` | (empty) | Proxy Bearer key, no auth when unset |
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
