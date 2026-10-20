# AGENTS.md — opencode2api agent operating manual

> **Language:** English canonical. Docs under `docs/` may remain Simplified Chinese during the EN-first migration (see §7); env names and defaults below are normative in English.
>
> 🏠 [README](./README.md) | [简体中文](./README.zh-CN.md) | 📖 [Docs](./docs/README.md) | 🤝 [CONTRIBUTING](./CONTRIBUTING.md)

## 1. Project overview

- **What:** OpenAI-, Anthropic-, and Gemini-compatible gateway in front of a local [OpenCode](https://opencode.ai) runtime. Endpoints: `GET /health`, `GET /health/details`, `GET /metrics`, `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages` (Anthropic-compatible), `POST /v1beta/interactions` (alias `POST /v1/interactions`, Gemini-compatible thin layer).
- **Production entry:** `index.ts` (env > file > default merge, `index.ts:197-368`, then `startProxy`, `index.ts:463`). Never import `index.ts` from tests — it boots the server on import.
- **Library entry:** `startProxy` / `createApp` in `src/proxy.ts` (`startProxy` at `src/proxy.ts:1115-1149`); test/library config builder is `buildProxyConfig` in `src/config/proxy-config.ts:229-432` (shared pure resolvers at `:90-187`).
- **Runtime matrix:** local dev `tsx watch index.ts` vs prod `node dist/index.js` vs Docker (multi-stage `Dockerfile`, backend owned by `entrypoint.sh`). `index.ts:83-88` probes three `config.json` locations to cover the `index.ts` ↔ `dist/index.js` directory shift.

## 2. Tech stack & commands (single source of truth)

- `node >= 22.19` (undici 8 `engines` floor), TypeScript (`tsconfig.json`: `module/moduleResolution NodeNext`, `strict`, `noEmitOnError`), Express, Jest 30 + Supertest via `@swc/jest`, `tsx` for dev.
- Run in this order:
  ```bash
  npm run typecheck   # tsc --noEmit (covers index.ts + src/**/*.ts only; tests excluded by design)
  npm run build       # tsc -p tsconfig.json -> dist/ (entry dist/index.js)
  npm test -- --runInBand  # jest ESM; needs NODE_OPTIONS=--experimental-vm-modules (in script)
  npm run test:integration # bash tests/test-integration.sh — needs Docker + real backend/credentials, NOT run in CI
  ```
- Aliases: `npm run test:unit` === `npm test` (full jest suite, name is historical). `npm run dev` === `tsx watch index.ts`. `npm start` === `node dist/index.js` (rebuild first; a stale `dist/` will silently run old code).
- **There is no `lint` script.** Do not run or document `npm run lint` (`docs/development.md` previously mentioned it by mistake).
- Docker: `docker compose up -d --build`, `docker compose logs -f`. Health: `/health` (no auth, used by compose healthcheck) vs `/health/details` (auth-gated by default).

## 3. Directory structure

```
index.ts                 # prod bootstrap + config merge (487 lines)
src/proxy.ts             # createApp/startProxy (1149 lines; god file, see §9)
src/config/proxy-config.ts # buildProxyConfig + shared pure normalizers (bool/int/port/url/list/enum)
src/routes/              # chat.ts (1213) / responses.ts (1798) / messages.ts (979) / interactions.ts (533) / system.ts
src/tool-runtime/        # contracts / registry / router / parser (1934) / validator / policy
src/backend/manager.ts   # backend lifecycle + request lock/queue (608 lines)
src/backend/active-model.ts # ensureActiveModel change-only PUT per client + reset on respawn, pure (56 lines)
src/backend/backend-permission.ts # buildBackendPermission deny-all generator + inert ordered `read` free-tier gate (NUL sentinel), single source for entrypoint.sh + manager.ts isolated path, pure (125 lines)
src/stream/collector.ts  # prompt/poll/collect SSE pipeline
src/retry/policy.ts      # pure retry helpers (resolveMaxRetries, backoff+jitter)
src/errors/upstream.ts   # normalizeBackendError, transformUpstreamError, isTransient*
src/converters/anthropic.ts # pure Anthropic<->chat converters
src/types/               # shared types (re-exported via src/types/index.ts)
src/utils/guards.ts      # shared unknown-guards (asRecord/toErrorMessage)
tests/*.test.js          # JS tests importing TS sources via @swc/jest (see §8)
docs/                    # EN index + Chinese guides (EN migration tracked in docs/README.md)
Dockerfile / docker-compose.yml / entrypoint.sh
config.json.example / .env.example   # examples only, never real secrets
```

## 4. Configuration principle: env canonical > env legacy alias > file > default

- Lookup order for `config.json`: `<entrydir>/config.json` → `<entrydir>/../config.json` → `cwd/config.json` (`index.ts:83-88`).
- Merge order: **env canonical > env legacy alias > file short key > hardcoded default**. Invalid env values fall through to the next source (do not coerce garbage to `false`).
- Canonical env names (use these in `.env` / compose / Dockerfile / docs; file keys are the short forms in `config.json.example`):

| Meaning | Canonical env | File key | Default |
|:--------|:--------------|:---------|:--------|
| Proxy port | `OPENCODE_PROXY_PORT` (legacy env `PORT` also read) | `PORT` | `10000` (strict `1..65535`) |
| Backend port (bakes default URL only) | `OPENCODE_SERVER_PORT` | — (`OPENCODE_SERVER_URL` file key) | `10001` (strict `1..65535`; `entrypoint.sh` re-validates) |
| Backend URL | `OPENCODE_SERVER_URL` | `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` (http/https only) |
| Backend password | `OPENCODE_SERVER_PASSWORD` | `OPENCODE_SERVER_PASSWORD` | `''` |
| Bind host | `BIND_HOST` primary, `OPENCODE_PROXY_BIND_HOST` fallback | `BIND_HOST` | `0.0.0.0` |
| Tool master switch | `OPENCODE_DISABLE_TOOLS` (legacy `DISABLE_TOOLS` also read) | `DISABLE_TOOLS` | `true` |
| External bridge | `OPENCODE_EXTERNAL_TOOLS_MODE` / `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `EXTERNAL_TOOLS_MODE` / `EXTERNAL_TOOLS_CONFLICT_POLICY` | `proxy-bridge` / `namespace` (invalid env/file warns + falls through; explicit library `options` value throws) |
| External tool policy | `OPENCODE_EXTERNAL_TOOL_POLICY_MODE` / `OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL` / `OPENCODE_EXTERNAL_TOOL_ALLOWLIST` / `OPENCODE_EXTERNAL_TOOL_DENYLIST` / `OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR` (legacy raw env = bare `EXTERNAL_TOOL_*` also read) | bare `EXTERNAL_TOOL_*` (same names) | `enforce` / `low` / `(none)` / `(none)` / `(none)` |
| Internal allowlist | `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` / `OPENCODE_INTERNAL_ALLOWED_TOOLS` / `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` | `INTERNAL_*` short forms | `false` / `(none)` / `true` |
| Discovery fixture (note asymmetric name) | `OPENCODE_TOOL_DISCOVERY_FIXTURE` (no `INTERNAL_` infix) | `INTERNAL_TOOL_DISCOVERY_FIXTURE` | `(none)` |
| Health / metrics | `OPENCODE_HEALTH_DETAILS_ENABLED` / `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` / `OPENCODE_METRICS_ENABLED` / `OPENCODE_METRICS_REQUIRE_AUTH` | bare short forms | `true` / `true` / `false` / `true` |
| Isolated home | `OPENCODE_USE_ISOLATED_HOME` (bare `USE_ISOLATED_HOME` is file-only) | `USE_ISOLATED_HOME` | `false` |
| Prompt | `OPENCODE_PROXY_PROMPT_MODE` / `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` / `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` / `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` / `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` / `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` / `OPENCODE_PROXY_RETRY_MAX_RETRIES` (legacy raw env `RETRY_MAX_RETRIES` also read) / `OPENCODE_PROXY_DEBUG` | bare short forms | `standard` / `false` / `false` / `43200000` / `86400000` / `180000` / `3` / `false` |
| Binary / zen | `OPENCODE_PATH` / `OPENCODE_ZEN_API_KEY` | `OPENCODE_PATH` / `ZEN_API_KEY` | `opencode` / `''` |
| Backend mgmt | `OPENCODE_PROXY_MANAGE_BACKEND` | `MANAGE_BACKEND` | see known drift below |
| Auth | `API_KEY` (env+file same name) | `API_KEY` | `''` (= no auth) |
| Auth multi-key (A) | `OPENCODE_API_KEYS` canonical, `API_KEYS` legacy alias (merge; empty never blocks) | `API_KEYS` | `(none, merges with API_KEY)` |
| Fallback proxies | `OPENCODE_UPSTREAM_PROXIES` / `OPENCODE_UPSTREAM_PROXY_STRATEGY` / `OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS` / `OPENCODE_UPSTREAM_PROXY_NO_PROXY` (legacy raw env `UPSTREAM_*` merged in **both** entries) | `UPSTREAM_*` short forms | `(none)` / `failover-rr` / `300000` / `localhost,127.0.0.1,::1` |

- `DISABLE_TOOLS` resolution: `OPENCODE_DISABLE_TOOLS > DISABLE_TOOLS > file > true` via `resolveDisableTools` (`src/config/proxy-config.ts:76-86`); covered by `tests/env-alias.test.js`. Never `??`-chain booleans by hand; call the helper. Note: `true` still resolves `true` — the free-tier strip (`selectPromptToolOverrides`, `src/proxy.ts:75-91`) is a post-resolution prompt-body filter for `isFreeTierSuspectModel` only (guard text + output markup stripping stay active). The default backend `read` permission is an inert ordered gate (see §5), so free-tier requests still carry `read`; explicit allowlist `read` remains a real allow.
- Out-of-matrix backend identity (do NOT add to the six-way matrix): `OPENCODE_CLIENT` is read directly in `src/backend/manager.ts:41-45` (allowlist `cli/desktop/acp/app`, default `cli`, foreign values overwritten), never enters `ProxyConfig`/`buildProxyConfig`; documented in `docs/configuration.md` backend-identity subsection + `CHANGELOG.md`. Same for the `OPENCODE_API_KEY="public"` strip and best-effort jail `git init`.
- `RETRY`: strict-merged by `resolveRetryCountSetting` (options > `OPENCODE_PROXY_RETRY_MAX_RETRIES` > legacy `RETRY_MAX_RETRIES` > file > `3`; partial numerics like `3abc`/`2.9` are invalid and fall through — never `parseInt`-truncated), then clamped by `resolveMaxRetries` (`src/retry/policy.ts:51-58`, clamp 0–5, total attempts `1+n`, `2s×2ⁿ⁻¹` + 25% jitter, `retry-after` clamped to 30s). Covered by `tests/env-alias.test.js` + `tests/retry-policy.test.js`.
- **Single merge contract:** every key goes through the pure resolvers in `src/config/proxy-config.ts` (`resolveStringSetting` / `resolveBoolSetting` / `resolveIntSetting` / `resolvePortSetting` / `resolveDurationSetting` / `resolveRetryCountSetting` / `resolveListSetting` / `resolveEnumSetting` / `resolveUrlSetting`, plus parsers `parseStrictInteger` / `parseStrictPort` / `parseHttpUrl` / `parseToolNameList`). `index.ts` and `buildProxyConfig` share them, so never re-implement a local `parseBool`/`parsePort`/list parser in either entry — add a resolver there instead. Recognized bool tokens are exactly `1/true/yes/y/on` and `0/false/no/n/off` (case-insensitive, trimmed); everything else is *unset* and falls through (no `Boolean()` coercion).
- Docker/Compose declare **empty** defaults (`ENV X=` / `${X:-}`) for every config item: a non-empty image/compose default would outrank a mounted `config.json` or a legacy alias (env > file > default). Code owns the documented defaults, so empty env + no file is behaviorally identical. Compose `ports` + `healthcheck` both use `${OPENCODE_PROXY_PORT:-${PORT:-10000}}` (never a hardcoded 10000). `entrypoint.sh` validates `OPENCODE_PROXY_PORT` (falling back to legacy `PORT`) and `OPENCODE_SERVER_PORT` against `1..65535`, warns, and exports the normalized value so an invalid port never reaches `opencode serve --port`.
- **Known dual-entry drifts (do NOT silently "fix" defaults — they change behavior; unify explicitly with tests):** `REQUEST_TIMEOUT_MS` prod `180000` (`index.ts:295`, docs) vs library `300000` (`src/config/proxy-config.ts:16`); `MANAGE_BACKEND` prod `false` (`index.ts:209-212`) vs library `true` (`src/config/proxy-config.ts:308`); `OMIT_SYSTEM_PROMPT` prod unconditional `false` (`index.ts:313-316`) vs library auto-`true` under `plugin-inject` (`src/config/proxy-config.ts:374-377`); bool parsing is now **unified** (both entries use `normalizeBool` through `resolveBoolSetting`; the old loose `index.ts` parser and the `DEBUG`/`USE_ISOLATED_HOME` exact-match chains are gone — behavior change: env/options `'yes'`/`'on'`/`'TRUE '` and numeric-string booleans are now recognized everywhere, garbage never coerces). Any new env must update all six: `.env.example`, `config.json.example`, `Dockerfile`, `docker-compose.yml`, `index.ts`, `docs/configuration.md` + this table.

## 5. Tool safety principle (default-deny)

- `DISABLE_TOOLS=true` default. External client `tools` go through the proxy bridge and are namespaced (`external__*`, never registered as OpenCode built-ins).
- Internal allowlist applies **only when the request carries no `tools`**; empty/unmatched allowlist falls back to all-builtins-disabled (safe). Request-level `opencode.internal_allowed_tools` can only narrow: `effective = server ∩ request`.
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` is a legacy shortcut for allowlist `web_fetch` when no explicit allowlist is configured.
- Backend `read` permission default is an **inert ordered gate**, not plain `deny`/`allow`: `{ '*': 'deny', [FREE_TIER_READ_GATE_PATH]: 'allow' }` with `FREE_TIER_READ_GATE_PATH = '/__opencode_free_tier_gate_never__\u0000'` (`src/backend/backend-permission.ts`). OpenCode `Permission.disabled()` selects the last rule by **tool name** (`findLast`) then checks whether that rule's pattern is exactly `*`; the trailing non-`*` NUL sentinel allow keeps `read` in the upstream `tools[]` (Zen free tier otherwise returns 403 `FreeTierError`). Execution-time path matching still denies every real path via the leading `*: deny`, and the terminal NUL means no real path can match the sentinel even after `Wildcard.match` backslash normalization. This is an upstream gate token, not execution permission — explicit allowlist `read` still emits a real `'allow'`, and `bash` stays `deny` by default. Do not "simplify" it to `deny` (re-breaks free tier) or `allow` (real read execution).
- Never log tool outputs; `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` logs mode/hits/downgrade reasons only.
- Prod posture: `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true`, `OPENCODE_METRICS_ENABLED=false`.

## 6. Secrets & prohibited actions

- **NEVER commit, force-add, print back, or paste:** `.env`, `.env.*` (except tracked `.env.example`), `config.json`, `*.log`, `coverage/`, `dist/`, `node_modules/`, `.opencode/`, `opencode.json`, `custom-bin/`, `docs/host-deployments.md`. A local `.env` with real keys exists on dev hosts — do not `cat` it, do not quote it in issues, do not `git add -f` it.
- `.env.*` is ignored with `!.env.example` kept tracked (`.gitignore:10-11`). Before `git add`, run `git check-ignore -v <file>` for anything unfamiliar.
- `custom-bin/` + `docs/host-deployments.md` are local-only via `.gitignore` (propagates on clone; the old `.git/info/exclude` entries are redundant backups, not the source of truth).
- Container images never bake `config.json`/`.env` (`.dockerignore` + multi-stage `COPY --from=builder`); containers are configured via env or an explicit `-v ./config.json:...:ro` mount.
- Before any commit/push, inspect `git status --short`, `git diff --stat`, and `git log --oneline -10`; stage only intended files. No `--no-verify`, no empty commits, no force-push unless explicitly requested.

## 7. Docs language: EN-first

- Root `README.md` is the English canonical homepage; `README.zh-CN.md` is its Simplified Chinese mirror. Keep the top language bars bidirectional.
- `docs/README.md` is the English index; `docs/README.zh-CN.md` is its Chinese mirror. Per-guide bodies may stay Chinese during migration; the index tracks per-file English status — do not add `English | 中文` bars pointing at files that do not exist yet.
- Never link `docs/host-deployments.md` from tracked docs (it is git-ignored and 404s on GitHub); mention it only as inline code.
- `CONTRIBUTING.md` stays English; `CHANGELOG.md` new entries are EN-first with Chinese counterpart after.

## 8. Tests & build notes for agents

- `tsconfig.json` includes only `index.ts` + `src/**/*` (tests excluded): `tsc` will NOT catch test-side API misuse. `tests/*.test.js` are JS run through `@swc/jest` (`jest.config.cjs`) importing `../src/*.js` paths mapped to `.ts`. Keep `import { jest } from '@jest/globals'` + `jest.unstable_mockModule` + top-level `await import(...)` patterns as-is (ESM order-sensitive).
- `tests/env-alias.test.js` mirrors the `index.ts` merge (it cannot import `index.ts`, which boots the server): the `DISABLE_TOOLS` chain plus the port/url/bool/policy-list/retry/upstream-strategy layer arrays. Update the mirrors when a layer array changes; the shared resolvers themselves are imported from `src/config/proxy-config.ts` and tested directly.
- `tests/free-tier-gate.test.js` locks the cross-module free-tier contract: `selectPromptToolOverrides` drops every `false` entry (all-false maps omitted) for suspect models, and `buildBackendPermission` keeps `read` visible via the ordered NUL-sentinel gate while the leading `*: deny` keeps real paths denied. This is a data-level contract only — source/live verification is still required when bumping the backend. Update both halves together — either regression re-breaks Zen free tier.
- `tests/dockerfile-pin.test.js` locks `ARG OPENCODE_VERSION=1.18.35` (build-only, not a runtime `ENV`). Bumping the pin requires updating the Dockerfile `ARG OPENCODE_VERSION`, `PINNED_VERSION`, and current version references, re-running `tests/free-tier-gate.test.js`, `tests/backend-permission.test.js`, and `tests/dockerfile-pin.test.js`, checking the target version's source for `Permission.disabled()` findLast semantics (last rule by tool name, pattern exactly `*`), plus a live Zen check that `read` stays in upstream `tools[]`; see `docs/docker.md`.
- `tests/test-integration.sh` and `tests/test-streaming-real.sh` need a real backend/credentials and are not CI gates; do not "fix" them into the default `npm test` path.
- `custom-bin/opencode` is a local-only binary; `Dockerfile` intentionally has no `custom-bin` logic (stock `npm i -g opencode-ai`). Do not reintroduce arch-specific binary coupling without an explicit request.

## 9. Architecture notes (maintainability / extensibility)

- `src/proxy.ts:createApp` is a god closure (~800 lines) assembling `AppContext` (50+ fields, `src/types/context.ts`); the four routes (`chat`/`responses`/`messages`/`interactions`, ~3200 lines combined) duplicate the preflight → stream/non-stream → retry → usage/cleanup template. Prefer **pure moves + thin wrappers** over behavior changes.
- Shared unknown-guards (`asRecord`, `toErrorMessage`) live in `src/utils/guards.ts` — import from there, do not add new copies. Exception: `src/routes/system.ts` and `src/stream/collector.ts` keep their own narrower `toErrorMessage` variant (see `guards.ts` header); do not "unify" it.
- Pure layers to preserve: `src/retry/policy.ts`, `src/converters/anthropic.ts`, `src/errors/upstream.ts` (no Express/SDK deps). Route error exits must keep their wire shapes: chat non-stream JSON, responses-stream `response.failed` SSE + `[DONE]`, messages-stream `error` event without `[DONE]`, interactions-stream `interaction.completed` / `error` event without `[DONE]`.
- High-risk no-touch list without explicit approval + regression tests: timeout/retry constants, `transformUpstreamError` mappings, `isTransientUpstreamError` matchers, parser ambiguity policy, prompt guard text/order, model alias rules, policy evaluation order, backend permission gate ordering/sentinel, backend spawn/jail/HOME isolation, collector `finish==='tool'`/idle-exemption logic, bool-fallthrough semantics.

## 10. Commit convention & PR checklist

- Conventional Commits per `CONTRIBUTING.md:38-62`: `feat|fix|docs|style|refactor|test|chore`, e.g. `feat(api): add streaming support for Responses API`. Squash before merge.
- [ ] `typecheck + build + test -- --runInBand` green
- [ ] six-way config matrix (§4) updated if any env changed
- [ ] no secrets in diff; `git status/diff/log --oneline -10` inspected; new files `check-ignore` verified
- [ ] docs language bars + index updated; no links to git-ignored files
