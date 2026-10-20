# ⚙️ 配置详解

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## 📌 配置方式

> 配置优先级：**canonical 环境变量 > 兼容别名（legacy raw env） > `config.json` > 程序内默认值**

> 每一层都会先做严格正规化再比较：**无效值一律让位给下一层**（不会 `Boolean('garbage')` 之类的强制转换，也不会静默遮蔽下层）。详见 [合并与正规化规则](#-合并与正规化规则)。

> 📖 [Docs Index](./README.md) | 🏠 [Main README](../README.md)

---

## 🔧 环境变量

### 核心配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_PROXY_PORT` / `PORT` | `10000` | 代理服务端口（canonical 优先，legacy `PORT` 其次，`config.json` 短键 `PORT` 第三）；严格校验 `1..65535`，无效值让位给下一层 |
| `OPENCODE_SERVER_PORT` | `10001` | OpenCode 后端服务端口；严格校验 `1..65535`，无效值回落 `10001`（不会把 `abc` 拼进 URL 或传给 `opencode serve --port`）。**只用于生成默认回环 URL** `http://127.0.0.1:<port>`，显式 `OPENCODE_SERVER_URL` 永远优先 |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:10001` | OpenCode 后端地址；只接受可解析的 `http(s)` URL，非法值让位给 `config.json`（短键同名）/ 默认值 |
| `API_KEY` | - | Bearer Token 认证密钥 |
| `API_KEYS` / `OPENCODE_API_KEYS` | - | 多 client keys（逗号分隔，任一通过；与 `API_KEY` 合并；为空回退免认证） |
| `BIND_HOST` | `0.0.0.0` | 绑定地址（`BIND_HOST` 优先，`OPENCODE_PROXY_BIND_HOST` 为后备） |
| `OPENCODE_SERVER_PASSWORD` | - | OpenCode 后端密码 |
| `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径（空白/非字符串让位给 `config.json` / 默认值） |

### 功能配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_DISABLE_TOOLS` / `DISABLE_TOOLS` | `true` | 禁用 OpenCode 工具调用（兼容别名；`OPENCODE_DISABLE_TOOLS` 优先，二者无效值都会让位给下一顺位：canonical env > legacy env > `config.json` > 默认）。例外：① 疑似免费 Zen 模型（`opencode` provider 且 `-free` 后缀、`big-pickle`、`union-alpha`）剔除 prompt `tools` 映射中的 `false` 项（仅保留 `true` 项；全 `false` 则省略整个映射）以避开上游 `FreeTierError` 403（任意 `false` 均触发，`{}`/省略/`true`-only 通过），被剔除的工具回落服务端 agent 默认，此时仅靠 system prompt 禁用语 + 输出侧 markup 剥离承载禁用姿态；② `/v1/responses` 的 `web_search` 与 Interactions 的 `google_search` 会以 `hosted-search-grant` 单独放行 `websearch`（输出仅 `web_search_call` + 引文，不经过外部桥接） |
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 外部工具桥接模式；当前仅支持 `proxy-bridge`。非法值（env 或 `config.json`）打印 `[Config] Warning` 后让位给下一层，不会静默遮蔽 `config.json`；library 侧显式传入的 `options.EXTERNAL_TOOLS_MODE` 非法则直接抛错（fail-fast） |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 外部工具冲突隔离策略；当前仅支持 `namespace`，处理规则同上 |
| `OPENCODE_EXTERNAL_TOOL_POLICY_MODE` | `enforce` | 外部工具策略模式：`enforce`（命中 `REQUIRE_CONFIRMATION_FOR` 时拦截）/ `report-only`（只记日志放行）。legacy raw env `EXTERNAL_TOOL_POLICY_MODE` 次之，`config.json` 短键同名第三 |
| `OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL` | `low` | 外部工具未声明风险时的兜底等级：`low`/`medium`/`high`/`critical`（大小写不敏感）。legacy raw env `EXTERNAL_TOOL_DEFAULT_RISK_LEVEL` 次之，`config.json` 短键同名第三 |
| `OPENCODE_EXTERNAL_TOOL_ALLOWLIST` | `(none)` | 外部工具白名单，逗号分隔；非空时不在名单内的外部工具调用一律拦截。legacy raw env `EXTERNAL_TOOL_ALLOWLIST` 次之，`config.json` 短键同名第三（数组写法） |
| `OPENCODE_EXTERNAL_TOOL_DENYLIST` | `(none)` | 外部工具黑名单，逗号分隔；优先级最高（命中即拒绝，不看白名单）。legacy raw env `EXTERNAL_TOOL_DENYLIST` 次之，`config.json` 短键同名第三 |
| `OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR` | `(none)` | 需要确认才执行的外部工具名单，逗号分隔（`report-only` 模式只记录不拦截）。legacy raw env `EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR` 次之，`config.json` 短键同名第三 |
| `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` | `false` | 兼容旧开关；未显式配置 allowlist 时，启用后默认放行 `web_fetch` |
| `OPENCODE_INTERNAL_ALLOWED_TOOLS` | `(none)` | 当请求未传入 `tools` 时允许使用的 OpenCode 内置工具列表，逗号分隔（例 `websearch,webfetch`；`web_fetch` 等旧写法仍可匹配，大小写/分隔符不敏感） |
| `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED` | `true` | 输出 internal allowlist 模式的调试/指标日志 |
| `OPENCODE_TOOL_DISCOVERY_FIXTURE` | `(none)` | 集成测试/本地调试用的固定后端工具 ID 列表，逗号分隔 |
| `OPENCODE_HEALTH_DETAILS_ENABLED` | `true` | 控制 `/health/details` 是否暴露 |
| `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH` | `true` | 控制 `/health/details` 是否要求 Bearer 认证 |
| `OPENCODE_METRICS_ENABLED` | `false` | 控制 Prometheus `/metrics` 是否暴露 |
| `OPENCODE_METRICS_REQUIRE_AUTH` | `true` | 控制 `/metrics` 是否要求 Bearer 认证 |
| `OPENCODE_USE_ISOLATED_HOME` | `false` | 使用隔离的 OpenCode 配置目录（`config.json` 中用短键 `USE_ISOLATED_HOME`；裸 `USE_ISOLATED_HOME` 只是 file 短键，不读同名 env） |
| `OPENCODE_PROXY_PROMPT_MODE` | `standard` | 提示词处理模式（`config.json` 中用短键 `PROMPT_MODE`） |
| `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT` | `false` | 忽略传入的 system prompt（`config.json` 中用短键 `OMIT_SYSTEM_PROMPT`） |
| `OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS` | `false` | 自动清理会话存储（`config.json` 中用短键 `AUTO_CLEANUP_CONVERSATIONS`） |
| `OPENCODE_PROXY_CLEANUP_INTERVAL_MS` | `43200000` | 清理间隔 (毫秒)（`config.json` 中用短键 `CLEANUP_INTERVAL_MS`） |
| `OPENCODE_PROXY_CLEANUP_MAX_AGE_MS` | `86400000` | 最大存储时间 (毫秒)（`config.json` 中用短键 `CLEANUP_MAX_AGE_MS`） |
| `OPENCODE_PROXY_REQUEST_TIMEOUT_MS` | `180000` | 请求超时时间 (毫秒)（`config.json` 中用短键 `REQUEST_TIMEOUT_MS`） |
| `OPENCODE_PROXY_RETRY_MAX_RETRIES` | `3` | 首次失败后重试次数 (0-5，总尝试 1+n；退避指数+jitter 并优先 `retry-after`)（`config.json` 中用短键 `RETRY_MAX_RETRIES`，legacy raw env `RETRY_MAX_RETRIES` 亦可）。合并时按**严格整数**解析：`'3abc'`/`'2.9'`/`'1e1'` 视为无效并让位给下一层（不会被 `parseInt` 截断成 `3`/`2`/`1`）；0-5 的 clamp 仍由 `resolveMaxRetries` 统一执行 |

> 重试退避移植自上游 `session/retry.ts`（`2s×2ⁿ⁻¹` +25% jitter），但 `retry-after` 等待 clamp 在 30s（上游近无界；网关面对自带超时的客户端不宜久睡）。旧部署注意：默认总尝试由 3 次变为 1+3=4 次，如需接近旧次数可设 `2`。

### 免费额度 fallback 代理

平时直连、零开销；仅当上游返回免费/Go 配额耗尽（`429 + FreeUsageLimitError/GoUsageLimitError`）时自动切到代理并按冷却粘滞，普通 5xx 不触发。

> 两跳模型：代理作用于网关 → OpenCode 后端这一跳。若后端是远端地址（`OPENCODE_SERVER_URL` 非 loopback），切换出口 IP 可命中新的匿名/IP 配额；若是默认本地托管后端（`127.0.0.1`，恒直连 bypass），fallback 退化为同后端直接重试 + engaged 状态标记——此时如需改变后端 → Zen 的出口 IP，需给后端进程配 `HTTP(S)_PROXY`（`spawn` 会继承环境）。

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_UPSTREAM_PROXIES` / `UPSTREAM_PROXIES` | `(none)` | 逗号分隔的代理 URL（`socks5://` 优先，亦支持 `http(s)://`；`config.json` 中用短键 `UPSTREAM_PROXIES` 数组） |
| `OPENCODE_UPSTREAM_PROXY_STRATEGY` / `UPSTREAM_PROXY_STRATEGY` | `failover-rr` | `failover-rr` / `round-robin` / `random`（连续限流即轮换下一个）。非法值让位给下一层（`config.json` 短键 `UPSTREAM_PROXY_STRATEGY`） |
| `OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS` / `UPSTREAM_PROXY_COOLDOWN_MS` | `300000` |  engaged 粘滞时长（毫秒），到期回直连；非法/非正数让位给下一层（`config.json` 短键同名） |
| `OPENCODE_UPSTREAM_PROXY_NO_PROXY` / `UPSTREAM_PROXY_NO_PROXY` | `localhost,127.0.0.1,::1` | 永不走代理的目标 host（默认后端 `127.0.0.1` 恒直连）；空字符串视为未设置，让位给别名/`config.json` |

> 注意：`GET /health/details` 的 `internal_tools.fallback_proxies` 可观察 engaged 状态；`/metrics` 有 `opencode_fallback_proxy_engaged` gauge。流式 SSE 不走自定义 fetch（上游 SDK 缺口），fallback 自动降级为轮询。

> 流量归属（proxy 究竟代理什么）：网关本体是翻译网关——client 协议进、转成 session 协议打本地后端、译回原协议出；后端 → Zen 的 TLS 是后端自发连接，永远不经过网关进程。fallback pool 只在「配了 pool ＋ 打到免费额度错误 ＋ 目标非 loopback」三条件齐备时，把网关 → 后端这一跳换路上代理。因此它**不能**改变 Zen 看到的出口 IP；multimodal 图片抓取、`models.dev` 等杂项同样直连。改 Zen 出口 IP 的有效路径见 `docs/docker.md`「改变出口 IP」一节（后端 HTTP 代理 / 网络层 VPN / 去匿名化登录）。

### 调试配置

| 变量 | 默认值 | 说明 |
|:-----|:-------|:-----|
| `OPENCODE_PROXY_DEBUG` | `false` | 开启调试日志（`config.json` 中用短键 `DEBUG`） |
| `OPENCODE_PROXY_MANAGE_BACKEND` | `false` | 是否由代理拉起本地后端（`config.json` 中用短键 `MANAGE_BACKEND`；prod/`index.ts` 默认 `false`，library/`buildProxyConfig` 默认 `true`——已知双入口差异） |
| `OPENCODE_PATH` | `opencode` | OpenCode 可执行文件路径 |
| `OPENCODE_ZEN_API_KEY` | - | Zen API Key 透传 |

### 后端 identity（非 proxy knob，不进六向矩阵）

- `OPENCODE_CLIENT`：被拉起后端向 Zen 声明的第一方身份。allowlist 为 `cli`/`desktop`/`acp`/`app`，默认 `cli`；未设置/空白/未知值一律回落 `cli`（allowlist clamp，非 bool fallthrough）。
- 从网关宿主环境继承的外来值会被覆写（如 `opencode2api` 会被重写为 `cli`），已知值透传。无 file key、无别名，不进 `ProxyConfig`/`buildProxyConfig`，故 `.env.example`/`config.json.example`/`Dockerfile`/`docker-compose.yml`/`index.ts` 均不声明。
- 附带：`OPENCODE_API_KEY="public"` 字面值会从后端环境删除（匿名应传空而非该字面）；jail 工作目录会 best-effort `git init`（5s 超时，失败 warn 继续）。

---

## 🧮 合并与正规化规则

配置矩阵的合并与正规化逻辑集中在 `src/config/proxy-config.ts` 的纯函数里（`resolveStringSetting` / `resolveBoolSetting` / `resolveIntSetting` / `resolvePortSetting` / `resolveDurationSetting` / `resolveRetryCountSetting` / `resolveListSetting` / `resolveEnumSetting` / `resolveUrlSetting`），`index.ts`（生产入口）与 `buildProxyConfig`（library 入口）共用同一套实现，因此两边行为一致、且可被单元测试直接覆盖（`index.ts` 本身不可 import，会启动服务）。

### 每层的判定顺序

1. caller options（仅 library：`startProxy(...)` / `buildProxyConfig(...)` 传入值）
2. env canonical（`OPENCODE_*`）
3. env legacy raw alias（如 `PORT`、`DISABLE_TOOLS`、`RETRY_MAX_RETRIES`、`UPSTREAM_PROXY_*`、`EXTERNAL_TOOL_*`）
4. `config.json` 短键
5. 程序内硬编码默认值

任何一层取值后都会先经过正规化，**无效即视为未设置**并让位给下一层；空字符串/空数组以外的非法值（`'garbage'`、`'2'`、`'yes '` 之类拼写错误、`0`/负数端口、不可解析 URL）都不会强制转换，也不会静默遮蔽下层。

### 正规化细则

| 类型 | 认可的写法 | 无效示例（让位下一层） |
|:-----|:-----------|:-----------------------|
| 布尔 | `1/true/yes/y/on` → true，`0/false/no/n/off` → false（大小写不敏感、自动 trim）；数字仅 `0`/`1` | `garbage`、`2`、`-1`、``（空串）、`   ` |
| 整数（时长/重试等） | 整数字面量或纯整数字符串（可带 `+`/`-`、首尾空白） | `3abc`、`2.9`、`1e3`、`43200000ms`、空串 |
| 端口 | 严格 `1..65535` 的整数 | `0`、`65536`、`-1`、`100 01`、`abc` |
| URL | 可被 `URL` 解析且协议为 `http:`/`https:` | `not-a-url`、`127.0.0.1:10001`、`ftp://…` |
| 枚举 | 大小写不敏感命中允许集合 | `yolo`、`urgent`（→ 打印 warning 并让位） |
| 列表 | 逗号分隔字符串或字符串数组（trim + 去重 + 去空） | 非字符串/非数组（数字、对象）；空字符串视为未设置，显式 `[]` 视为「明确为空」 |

### 双入口差异（已知，勿静默「修正」）

| 项 | 生产入口 `index.ts` | library 入口 `buildProxyConfig` |
|:---|:--------------------|:------------------------------|
| `REQUEST_TIMEOUT_MS` 默认 | `180000` | `300000` |
| `MANAGE_BACKEND` 默认 | `false` | `true` |
| `OMIT_SYSTEM_PROMPT` 默认 | 恒定 `false` | `PROMPT_MODE=plugin-inject` 时自动 `true` |

library 入口会额外读取 env 矩阵（非法值同样让位）：`OPENCODE_PROXY_PORT`/`PORT`、`OPENCODE_SERVER_PORT`（仅用于生成默认回环 URL）、`OPENCODE_SERVER_URL`、`OPENCODE_PATH`、`OPENCODE_PROXY_MANAGE_BACKEND`、`OPENCODE_USE_ISOLATED_HOME`、`OPENCODE_PROXY_RETRY_MAX_RETRIES`/`RETRY_MAX_RETRIES`，以及 `UPSTREAM_PROXIES`/`UPSTREAM_PROXY_STRATEGY`/`UPSTREAM_PROXY_COOLDOWN_MS`/`UPSTREAM_PROXY_NO_PROXY` 与 `EXTERNAL_TOOL_*` 别名。

### Docker / Compose 为什么一律留空

`Dockerfile` 的 `ENV` 与 `docker-compose.yml` 的 `environment` 对所有配置项都写成**空值**（`ENV X=` / `${X:-}`）。因为合并顺序是 env > file > default，镜像里写死非空默认值会**遮蔽挂载进来的 `config.json` 与 legacy 别名**（例如镜像内写死 `OPENCODE_PROXY_PORT=10000` 会让挂载的 `config.json` 里 `PORT: 8090` 永远不生效）。默认值由代码持有，因此「env 空 + 无 file」与旧的「env 非空默认值」表现完全一致。

`docker-compose.yml` 的 `ports` 映射与 `healthcheck` 统一使用 `${OPENCODE_PROXY_PORT:-${PORT:-10000}}`，因此 legacy `PORT` 也能正确映射并探活，不会固定打在 `10000`。

### entrypoint 端口校验

`entrypoint.sh` 会对 `OPENCODE_PROXY_PORT`（回退到合法 legacy `PORT`）与 `OPENCODE_SERVER_PORT` 做 `1..65535` 校验。`OPENCODE_PROXY_PORT` 为空或非法时不会 export，让 `config.json` 的 `PORT` 有机会生效，脚本内部仅用 `10000` 打日志；`OPENCODE_SERVER_PORT` 仍会 export 正规化后的值，保证 invalid 端口不会被传给 `opencode serve --port`。

---

## 📄 config.json 示例


```json
{
    "PORT": 10000,
    "API_KEY": "your-secret-api-key",
    "API_KEYS": ["key-alpha", "key-beta"],
    "BIND_HOST": "0.0.0.0",
    "DISABLE_TOOLS": true,
    "EXTERNAL_TOOLS_MODE": "proxy-bridge",
    "EXTERNAL_TOOLS_CONFLICT_POLICY": "namespace",
    "EXTERNAL_TOOL_POLICY_MODE": "enforce",
    "EXTERNAL_TOOL_DEFAULT_RISK_LEVEL": "low",
    "EXTERNAL_TOOL_ALLOWLIST": [],
    "EXTERNAL_TOOL_DENYLIST": [],
    "EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR": [],
    "INTERNAL_WEB_FETCH_ENABLED": false,
    "INTERNAL_ALLOWED_TOOLS": ["web_fetch"],
    "INTERNAL_TOOL_METRICS_ENABLED": true,
    "INTERNAL_TOOL_DISCOVERY_FIXTURE": [],
    "HEALTH_DETAILS_ENABLED": true,
    "HEALTH_DETAILS_REQUIRE_AUTH": true,
    "METRICS_ENABLED": false,
    "METRICS_REQUIRE_AUTH": true,
    "USE_ISOLATED_HOME": false,
    "PROMPT_MODE": "standard",
    "OMIT_SYSTEM_PROMPT": false,
    "AUTO_CLEANUP_CONVERSATIONS": false,
    "CLEANUP_INTERVAL_MS": 43200000,
    "CLEANUP_MAX_AGE_MS": 86400000,
    "DEBUG": false,
    "OPENCODE_SERVER_URL": "http://127.0.0.1:10001",
    "OPENCODE_SERVER_PASSWORD": "",
    "OPENCODE_PATH": "opencode",
    "ZEN_API_KEY": "",
    "MANAGE_BACKEND": false,
    "REQUEST_TIMEOUT_MS": 180000,
    "RETRY_MAX_RETRIES": 3,
    "UPSTREAM_PROXIES": [],
    "UPSTREAM_PROXY_STRATEGY": "failover-rr",
    "UPSTREAM_PROXY_COOLDOWN_MS": 300000,
    "UPSTREAM_PROXY_NO_PROXY": ["localhost", "127.0.0.1", "::1"]
}
```

---

## 🛠️ 外部工具桥接

OpenCode2API 现在支持把外部客户端传入的 OpenAI-compatible `tools` 桥接到代理层，而不是把这些工具直接暴露为 OpenCode 内置工具。

### 当前支持的模式

| 配置项 | 支持值 | 说明 |
|:------|:------|:-----|
| `OPENCODE_EXTERNAL_TOOLS_MODE` | `proxy-bridge` | 由代理虚拟化外部工具，并返回 OpenAI-compatible tool calling 结果（`config.json` 中用短键 `EXTERNAL_TOOLS_MODE`） |
| `OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY` | `namespace` | 使用代理内部命名空间隔离同名冲突（`config.json` 中用短键 `EXTERNAL_TOOLS_CONFLICT_POLICY`） |

### 工具冲突策略

- 外部客户端工具优先以“代理桥接”的方式参与对话。
- OpenCode 内置工具仍按现有 `DISABLE_TOOLS` 机制管理，不会因为客户端传入同名工具而被误触发。
- 代理内部会使用类似 `external__web_fetch` 的命名空间名避免冲突。
- 这些内部命名空间名称不会作为公开 API 的一部分暴露给客户端。

### 外部工具策略（allowlist / denylist / 确认）

外部工具调用在执行前会过一层策略判定，五个开关都已正式接入配置矩阵（canonical `OPENCODE_EXTERNAL_TOOL_*` > legacy raw env `EXTERNAL_TOOL_*` > `config.json` 同名短键 > 默认值，非法值让位下一层）：

| 判定顺序 | 配置项 | 行为 |
|:---------|:-------|:-----|
| 1（最高） | `EXTERNAL_TOOL_DENYLIST` | 命中即拒绝（`tool_denied_by_policy`），不再看白名单 |
| 2 | `EXTERNAL_TOOL_ALLOWLIST` | 非空时，未命中即拒绝（`tool_not_allowed_by_policy`）；为空表示不限制 |
| 3 | `EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR` | 命中（或工具自身声明 `requiresConfirmation`）且 `EXTERNAL_TOOL_POLICY_MODE=enforce` 时返回 `require_confirmation`，该工具调用不会执行 |
| 4 | `EXTERNAL_TOOL_POLICY_MODE` | `enforce`（默认，命中确认名单即拦截）/ `report-only`（只记 debug 日志并放行） |
| 兜底 | `EXTERNAL_TOOL_DEFAULT_RISK_LEVEL` | 工具未声明风险等级时返回的 `effectiveRisk`（默认 `low`） |

> 名单按客户端声明名 / 命名空间名（`external__<name>`）/ 原始名任一精确命中即可（exact-match only，不支持 `*` 通配符，例如用 `delete_repo,write_file` 而非 `delete_*,write_*`）；三个列表默认为空，即不改变现有行为。library 调用方也可直接传 `EXTERNAL_TOOL_ALLOWLIST: [...]` 等 options 覆盖。外部桥接工具由客户端执行，代理仅返回调用契约；名称推断的 sideEffect/risk 只做元数据，不自动触发 confirmation，operator 需用显式 confirmation 名单、deny/allowlist 控制。

### 内置工具 allowlist

- 当请求 **未传入** `tools` 时，代理会进入 internal allowlist 模式，只允许 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 中声明的 OpenCode 内置工具。
- `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` 仅用于兼容旧配置：如果未显式配置 allowlist，则默认把 allowlist 视为 `web_fetch`。
- 代理会读取后端工具列表，并通过精确匹配、`.<tool>` / `/<tool>` 后缀匹配或大小写/分隔符不敏感匹配（如 `web_fetch` ↔ `webfetch`）解析最终可用工具。
- 要启用上游搜索（`opencode`/`opencode-go` provider 自带 `websearch`，免额外 key）：`OPENCODE_INTERNAL_ALLOWED_TOOLS=websearch,webfetch`，模型用 `opencode-go/<model>`，并确保后端 `permission.websearch=allow`（默认 agent 已放行，无人值守勿设 `ask`）。
- 如果配置的 allowlist 在后端工具列表中一个也没有匹配到，代理会自动回退到“全部内置工具禁用”的安全模式。
- `OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true` 时，会输出 internal allowlist 模式的调试/指标日志，记录模式选择、后端工具发现、allowlist 命中情况和降级原因，但不会记录工具输出内容。
- `OPENCODE_TOOL_DISCOVERY_FIXTURE` 可在集成测试或本地调试时绕过真实 `client.tool.ids()`，直接提供固定工具 ID 列表。
- 一旦客户端传入 `tools`，请求立即切回外部工具桥接模式，所有 OpenCode 内置工具继续保持禁用。

### 后端权限锁定（headless 防 hang）

后端（`opencode serve`）是无人值守的：任何 `ask` 都没有人批准，会卡住整个 prompt 直到代理 180s 超时；同时免费模型的 tools map 会被剥掉（见上），后端回退到 agent 全开，可能静默执行调用方没授权的工具。为此容器启动（`entrypoint.sh`，`USE_ISOLATED_HOME` 下由 `src/backend/manager.ts` 同步）会给后端 `opencode.json` 写入生成的 `permission`（单一来源 `src/backend/backend-permission.ts`，所有 prompt 模式生效）：

- 默认 deny-all；只放行 `OPENCODE_INTERNAL_ALLOWED_TOOLS` 明确列出的工具（`web_fetch` 等别名归一；未知名忽略，不会写坏 schema）。
- 未显式配置 allowlist 时 `OPENCODE_INTERNAL_WEB_FETCH_ENABLED=true` 沿用旧兼容：放行 `webfetch`。
- `external_directory` 永远 jail 在 `/home/node/project/**`，之外一律 deny（快速失败，不会 hang；模型转而走外部桥接，由客户端执行并经用户确认）。
- `read` 是默认规则中的惰性闸门例外：只要 allowlist 未显式放行 `read`（包括配置了其他 allowlist 时），它写成一个**有序惰性闸门对象** `{ "*": "deny", "/__opencode_free_tier_gate_never__\u0000": "allow" }`，而不是裸 `deny` 或 `allow`。OpenCode 的 `Permission.disabled()`（供 `resolveTools()` 使用）先按**工具名**对规则做 `findLast`，再检查选中规则的 pattern 是否为 `*`；最后一条非 `*` 的 NUL 哨兵 allow 让按工具名的检查不隐藏 `read`，因此 Zen 免费层要求的上游 `tools[]` 中仍包含 `read`（否则返回 403 `FreeTierError`）。执行期的路径匹配是另一套逻辑：真实路径只会命中开头的 `*: deny`，所以仍然全部拒绝。哨兵以 NUL 结尾，真实文件路径不可能包含 NUL，因此即使 OpenCode 的 `Wildcard.match` 把反斜杠归一成斜杠，也不会有真实路径命中哨兵。该哨兵只是上游免费层闸门 token，**不是执行权限**；显式在 allowlist 中写 `read` 才会恢复真正的 `allow`。
- `bash` 默认仍是 `deny`；不要为了“通过闸门”把 `read` 或 `bash` 设为 `allow`（前者打开真实后端读取，后者打开命令执行）。
- 空 allowlist 且未启用 `OPENCODE_INTERNAL_WEB_FETCH_ENABLED` 兼容开关时 = 后端零真实执行；启用该开关时仅额外放行 `webfetch`。`read` 仅为免费层闸门保持可见，**并未放行**（真实路径仍被拒绝）。
- 客户端自带 `tools` 时仍走外部桥接（`external__*`），这些工具从不会注册成后端内置工具，因此上述 `read` 闸门不影响客户端侧的工具执行。

### 请求级 allowlist 覆盖 (Request-Level Override)

在请求未传入 `tools` 的前提下，客户端可以在请求体中传入自定义字段 `opencode.internal_allowed_tools` 来覆盖服务端的默认内置工具列表。
出于安全隔离原则，请求级覆盖**只能缩小（求交集），不能扩大**服务端的 allowlist 权限：
- 如果请求了服务端未开启的内置工具，该工具会被自动忽略。
- `effective_allowlist = intersection(server_allowlist, request_allowlist)`

**示例：**
```json
{
  "model": "opencode/muse-spark-1.3-contributor-free",
  "messages": [{"role": "user", "content": "Fetch this URL"}],
  "opencode": {
    "internal_allowed_tools": ["web_fetch"]
  }
}
```

### 结构化健康诊断接口

可以通过 `GET /health/details` 接口获取代理内部的运行状态与指标。这不仅有助于问题排查，也是用于编写集成行为测试的重要依据。
- `OPENCODE_HEALTH_DETAILS_ENABLED=false` 时，接口返回 `404`。
- `OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true` 时，接口要求 Bearer 认证；否则返回 `401`。
返回值格式如下：
```json
{
  "status": "ok",
  "proxy": true,
  "internal_tools": {
    "config": {
      "allowed_tools": ["web_fetch", "filesystem"],
      "metrics_enabled": true,
      "discovery_fixture": ["web_fetch", "filesystem", "bash"]
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
      "tool_id_count": 3,
      "age_ms": 12000
    },
    "audit": {
      "available": true,
      "fields": [
        "requestedAllowlist",
        "allowedToolNames",
        "deniedRequestedTools",
        "resolutionPath",
        "resultingMode"
      ]
    }
  }
}
```

### Prometheus 指标接口

可以通过 `GET /metrics` 获取 Prometheus 文本格式指标。
- `OPENCODE_METRICS_ENABLED=false` 时，接口返回 `404`。
- `OPENCODE_METRICS_REQUIRE_AUTH=true` 时，接口要求 Bearer 认证；否则返回 `401`。
当前暴露的核心指标包括：
- `opencode_internal_tool_mode_requests_total{mode="external_bridge"}`
- `opencode_internal_tool_mode_requests_total{mode="internal_allowlist"}`
- `opencode_internal_tool_mode_requests_total{mode="disabled"}`
- `opencode_internal_tool_discovery_failures_total`
- `opencode_internal_tool_fallback_disabled_total`
- `opencode_internal_tool_cache_ids`

### 推荐生产配置

```bash
DISABLE_TOOLS=true
OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true
OPENCODE_TOOL_DISCOVERY_FIXTURE=
OPENCODE_HEALTH_DETAILS_ENABLED=true
OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true
OPENCODE_METRICS_ENABLED=false
OPENCODE_METRICS_REQUIRE_AUTH=true
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```


---

## 🎯 Prompt Mode 说明

| 模式 | 说明 |
|:-----|:-----|
| **standard** (默认) | 标准模式，完整处理提示词 |
| **plugin-inject** | 插件注入模式，减小模型侧提示词大小，通常与 `OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true` 配合使用 |

---

## ⭐ 推荐配置

### 🐳 Docker 生产环境

```bash
DISABLE_TOOLS=true
OPENCODE_EXTERNAL_TOOLS_MODE=proxy-bridge
OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=namespace
OPENCODE_INTERNAL_ALLOWED_TOOLS=web_fetch
OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=true
OPENCODE_TOOL_DISCOVERY_FIXTURE=
OPENCODE_HEALTH_DETAILS_ENABLED=true
OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=true
OPENCODE_METRICS_ENABLED=false
OPENCODE_METRICS_REQUIRE_AUTH=true
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```


### 💻 本地开发

```bash
DISABLE_TOOLS=false
OPENCODE_PROXY_DEBUG=true
```
