# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-User API Keys & Per-Key Usage (`API_KEYS` / `OPENCODE_API_KEYS`)**: configure a list of named user keys — a `[{name, key}]` array in config.json or a comma-separated `name:key` string in the environment (bare keys are auto-named `key-N`; duplicates fail at startup). Requests matching any user key authenticate like `API_KEY` and are metered per name in an in-memory registry (`requests`, prompt/completion/total tokens using the existing chars/4 estimation, `lastUsedAt`; failed requests count toward `requests` but never tokens). New admin endpoints `GET`/`POST`/`DELETE /admin/keys` (mounted once `API_KEYS` is set, admin-authenticated with the legacy `API_KEY` — user keys get 401, no `PUBLIC_DIAGNOSTICS` bypass, `501` when `API_KEY` is empty) let operators hot-add or revoke keys at runtime; `GET` responses expose only a `keyHint` with the key's last 4 characters. `/health/details` gains a `usage: {byKey, total}` section and `/metrics` emits `opencode_proxy_key_requests_total{key}` / `opencode_proxy_key_tokens_total{key,type}` in multi-user mode only — single-key deployments keep their exact previous behavior and snapshot shapes.
- **Anthropic Messages API**: `POST /v1/messages` implements the Anthropic Messages protocol (Claude SDK compatible) on top of the same OpenCode backend — `x-api-key` or Bearer auth, `system` (string or blocks), text/image/tool_use/tool_result content blocks, `tools` with `input_schema`, `tool_choice`, `stop_sequences`, and Anthropic-shaped errors (`{type:'error',error:{type,message}}`). Tool calls surface as `tool_use` content blocks with the original client tool names (no `external__` namespace). Streaming (`stream: true`) emits the Anthropic SSE sequence — `message_start`, `content_block_start/delta/stop` (`thinking_delta`, `text_delta`, `input_json_delta`), `message_delta`, `message_stop` — with keepalives and polling fallback, mirroring the chat-completions pipeline including transient-error retry. Documented in both READMEs; covered by `tests/unit/anthropic.test.js`.
- **Built-in Web Panel (`WEB_PANEL_ENABLED` / `OPENCODE_WEB_PANEL_ENABLED`, default off)**: An optional read-only dashboard served by the proxy itself. `GET /panel` returns a self-contained dark-themed HTML page (zero external assets, CSP locked to same-origin, inline style/script only) showing runtime status (status, uptime, backend URL), the model list, and backend diagnostics from `/health/details` (tool-mode counters, tool ID cache). The page fetches `GET /panel/data.json` — a JSON feed assembled from the models list, the `/health/details` payload and `process.uptime()` — with a Bearer key kept in the browser's localStorage. Auth matches the diagnostics endpoints: with `API_KEY` set, `data.json` requires the Bearer key (the HTML shell is public but carries no data), and `PUBLIC_DIAGNOSTICS=true` or an empty `API_KEY` lifts auth. When disabled, both routes 404 and cost nothing. The feed never returns `OPENCODE_SERVER_PASSWORD`, `ZEN_API_KEY`, `API_KEY` or `API_KEYS` values, and responses carry `X-Content-Type-Options: nosniff` plus `Cache-Control: no-store`. Added `tests/unit/panel.test.js` (10 tests: disabled 404s, headers, 401 gating, secret-leak assertions, public/no-key modes) and full configuration docs.
- **Retry pacing follows the provider**: a throttled turn now waits for the backend's `Retry-After` (delta-seconds or HTTP-date, capped at 120s) instead of a fixed 800ms/1600ms ramp; without the header the backoff is now exponential (800ms, 1.6s, 3.2s) rather than linear.
- **Per-key usage survives restarts**: in multi-user mode (`API_KEYS`) the registry is written to `usage.json` beside `config.json` every five minutes and on `SIGINT`/`SIGTERM` (atomic temp-file + rename, mode `0600`, unreadable snapshots reported and ignored), and restored at startup. `OPENCODE_USAGE_PERSISTENCE` / `USAGE_PERSISTENCE` (default on), `OPENCODE_USAGE_FILE` / `USAGE_FILE`, and `OPENCODE_USAGE_SAVE_INTERVAL_MS` / `USAGE_SAVE_INTERVAL_MS` control it; single-key deployments keep no per-key state.

### Changed

- **Real token counts**: every response (`/v1/chat/completions` streaming and not, `/v1/messages`, `/v1/responses`) now reports the token counts the backend itself produced instead of a `chars / 4` estimate — cached prompt tokens are included in the prompt figure and reasoning tokens are reported separately while staying inside the billed completion total. The estimate survives only as a fallback for a backend that reports nothing, so per-key usage is accurate for accounting. `/v1/messages` streams keep the estimate in `message_start` (nothing else is known before the first token) but settle the real numbers in `message_delta` and in the meter.

### Fixed

- **Disconnected clients no longer leave the backend generating**: a request whose client goes away now aborts the backend turn and drops the session immediately, instead of letting it run to the request timeout while holding the single-request lock queue. This covers all four endpoints and both stream/non-stream paths; skipped fallback polls no longer re-read a session nobody is waiting for. `/v1/chat/completions` and `/v1/messages` no longer report a canceled turn as a provider error.
- **Shutdown**: one shutdown path in the entry point flushes the usage snapshot, closes the server and kills the backend; the duplicate `SIGINT`/`SIGTERM` handlers in the proxy module that called `process.exit(0)` first were removed (temp-dir cleanup stays on `process.on('exit')`).

## [2.5.0] - 2026-10-15

### Fixed

- **Test Scripts**: `tests/integration/test-integration.sh` passed `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` / `OPENCODE_METRICS_REQUIRE_AUTH` / `OPENCODE_TOOL_DISCOVERY_FIXTURE`, which the proxy no longer reads (auth now via `OPENCODE_PUBLIC_DIAGNOSTICS`, fixture removed); it also hardcoded the docs placeholder `Authorization: Bearer ***` everywhere instead of `TEST_API_KEY`. `tests/manual/test-streaming-real.sh` had the same placeholder bug and defaulted to `opencode/kimi-k2.5`, which is no longer in the catalog (default now `opencode/cat-jam-free`, overridable via `TEST_MODEL`); its `-d '…'` payload also blocked shell expansion. Both scripts verified against a live proxy.
- **User-Oriented Docs**: user docs no longer narrate implementation details or probe results — the tool-lock section explains the mechanism and its zero-config behavior from the user's perspective, and the 2.x troubleshooting entry states the symptom and fix instead of the API-migration backstory. READMEs credit the same-named jasonxu114514/opencode2api gateway in the acknowledgements.

### Removed

- **Dead External-Tool Policy Layer**: The risk-level / side-effect / confirmation machinery in `tool-runtime/policy.js` had no configuration entry point (`EXTERNAL_TOOL_POLICY_MODE`, `EXTERNAL_TOOL_DENYLIST`, `x_proxy_*` metadata were never read from env, config.json, or docs), and because "write"-shaped tool names (`create_*`, `send_*`, `delete_*` …) were inferred as high-risk, those client tool calls were silently swallowed in production — the client declared a tool and never received `tool_calls`. Deleted the layer, `plugin/tool-lock.js` (9-line stub superseded by `plugin/opencode2api-tool-lock.js`), and the unused `buildExternalToolsReminder` / `createRegistryIndex` helpers. Tool calls now flow straight from validation back to the client.
- **Single-Value Config Knobs**: `EXTERNAL_TOOLS_MODE` (only value: `proxy-bridge`) and `EXTERNAL_TOOLS_CONFLICT_POLICY` (only value: `namespace`) threw on anything but their sole legal value — pure noise. Removed; namespace isolation stays as the implementation detail it already was.
- **`PROMPT_MODE` / `plugin-inject`**: Only effect was skipping the guard-message prompt and writing an empty plugin into the backend home; `OMIT_SYSTEM_PROMPT` already covers the observable behavior. Removed; set `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true` instead.
- **Test-Only & Redundant Switches**: `OPENCODE_TOOL_DISCOVERY_FIXTURE` (test fixture), `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` (legacy alias — put `web_fetch` in `OPENCODE_INTERNAL_ALLOWED_TOOLS`), `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` (metrics now always emitted with DEBUG logs), `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` + `OPENCODE_METRICS_REQUIRE_AUTH` (merged into one `OPENCODE_PUBLIC_DIAGNOSTICS`; both endpoints keep defaulting to Bearer auth).

### Changed

- **Chat Session Affinity (`CHAT_SESSION_AFFINITY` / `OPENCODE_CHAT_SESSION_AFFINITY`, default off)**: `/v1/chat/completions` previously created a fresh OpenCode session for every request, so each turn of a multi-turn conversation paid for the full history again. When enabled, requests whose prompt is a pure sequence of user turns and that extend the conversation's recorded turn sequence resume the same backend session and append only the new turns, so upstream prompt caches hit (live probes: ~99% cached tokens on a second turn). Requests with assistant/tool parts, a changed system prompt, tool policy, or model, a concurrent second turn, or a failed turn fall back to a fresh session with the full history — same output semantics as before. Affinity sessions expire after 30 minutes of inactivity and are deleted.

### Changed

- **Backend Pin (opencode-ai 1.19.0)**: OpenCode 2.x moved the server API under `/api/*` and dropped the 1.x routes the bundled `@opencode-ai/sdk` calls, so an unpinned backend (`npm install -g opencode-ai`) silently broke `/v1/models` (empty list) and every completion. The Dockerfile now installs `opencode-ai@1.19.0` — the newest 1.x release, verified against the OpenCode Zen free tier on 2026-10-15 — and the proxy's `/global/health` check rejects a 2.x backend up front with the install command instead of failing per request. Docs and the quick-start now pin the version too.

### Fixed

- **Free Models Rejected (#17, #18)**: OpenCode Zen free models (all but `space-bunny-free`) refuse requests whose tool list differs from the official client's. Tools are no longer disabled per request; the backend loads `plugin/opencode2api-tool-lock.js`, the tool policy rides in the session title, and the plugin blocks tools at execution time. Internal allowlists keep working, and native calls to bridged external tools are steered back to the text contract.
- **Docker Startup Hang (#17)**: The entrypoint's health probe ran `curl` without a timeout against `/health`, which is not an OpenCode API route; a connection made while the backend was still booting never returned. The proxy now starts and supervises the backend itself (`MANAGE_BACKEND` defaults to `true`) and probes `/global/health`.
- **Backend Password**: `OPENCODE_SERVER_PASSWORD` and `OPENCODE_ZEN_API_KEY` are passed to the managed backend as environment variables; the old `--password` flag does not exist and kept the backend from starting.

### Removed

- `SEND_TOOL_OVERRIDES` / `OPENCODE2API_SEND_TOOL_OVERRIDES`: the proxy picks plugin or override mode by checking the backend's loaded plugins.

## [2.0.0] - 2026-09-25

### Added

- **English README**: Added `README.en.md` with a language switch between the Chinese and English docs.
- **English Docs**: Added full `docs/en/` translations of every guide; Chinese guides now live under `docs/zh/`.
- **Test Layout**: Split tests into `tests/unit/`, `tests/integration/`, and `tests/manual/`; added `npm run test:stream` for the live streaming smoke test and scoped Jest to `tests/unit`.

### Changed

- **Integration Script**: `tests/integration/test-integration.sh` accepts `TEST_API_KEY`; the manual streaming smoke test now documents its usage and stays out of CI.
- **Documentation Overhaul**: Rewrote the README and `docs/` for accuracy and concision; documented `previous_response_id` session chaining, the full environment-variable surface, and corrected env var names to match the implementation (`OPENCODE_DISABLE_TOOLS`, `OPENCODE_USE_ISOLATED_HOME`, `OPENCODE_PROXY_PROMPT_MODE`, etc.).
- **Config Surface Consistency**: `.env.example`, `docker-compose.yml`, and the `Dockerfile` now set `OPENCODE_DISABLE_TOOLS` instead of `DISABLE_TOOLS`, which the proxy never read.

## [1.5.0] - 2026-04-18

### Added

- **External Tool Bridge**: Added proxy-level bridging for external OpenAI-compatible `tools` across `/v1/chat/completions` and `/v1/responses`.
- **Streaming Tool Call Parity**: Added streaming support for external tool calls in both Chat Completions and Responses APIs.
- **Explicit External Tool Config**: Added explicit `EXTERNAL_TOOLS_MODE=proxy-bridge` and `EXTERNAL_TOOLS_CONFLICT_POLICY=namespace` configuration surface and documentation.

### Changed

- **Project Version**: Bumped the repository version to `1.5.0` across package metadata and documentation badges.

### Fixed

- **Jest Test Shutdown**: Removed a lingering queue rescheduling timer from the proxy request lock flow and updated the default test command to use the verified clean Jest invocation, eliminating the previous generic open-handle warning during `npm test`.

## [1.0.0] - 2025-04-11

### Added

- **OpenAI-compatible API**: `/v1/models`, `/v1/chat/completions`, `/v1/responses` endpoints
- **Streaming Support**: Full SSE streaming for Chat Completions and Responses API
- **Model Aliases**: GPT-style model aliasing (e.g., `gpt5-nano` → `gpt-5-nano`)
- **Docker Deployment**: Complete Docker setup with healthcheck and volume management
- **Configuration**: Environment variables and config.json support
- **Auto Cleanup**: Configurable automatic conversation/session storage cleanup

### Changed

- **Default Security**: `DISABLE_TOOLS` defaults to `true` for safer out-of-box behavior
