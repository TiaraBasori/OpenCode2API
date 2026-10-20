# 🔧 故障排查

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## ❓ 常见问题

### 1️⃣ 请求卡住

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 模型列表接口正常，但实际请求无响应 |
| **解决方案** | 设置 `OPENCODE_USE_ISOLATED_HOME=false` 让 OpenCode 复用本机登录态（`config.json` 中用短键 `USE_ISOLATED_HOME`） |

```bash
OPENCODE_USE_ISOLATED_HOME=false
```

---

### 2️⃣ 模型不存在

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 返回 `model_not_found` 错误 |
| **解决方案** | 检查可用模型列表，确认模型 ID 正确 |

```bash
curl http://127.0.0.1:10000/v1/models
```

---

### 3️⃣ 没有推理输出

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 发送了 `reasoning_effort` 但没有推理输出 |
| **解决方案** | 使用 `stream: true` 的 Responses API |

---

### 4️⃣ 工具调用意外触发

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 客户端意外触发了 OpenCode 工具调用 |
| **解决方案** | 保持 `DISABLE_TOOLS=true` |

---

### 5️⃣ 端口冲突

| 项目 | 说明 |
|:-----|:-----|
| **症状** | `Error: listen EADDRINUSE: address already in use` |
| **解决方案** | 更改端口或检查端口占用 |

```bash
# 检查端口占用
lsof -i :10000
lsof -i :10001

# 更改端口
OPENCODE_PROXY_PORT=10002
OPENCODE_SERVER_PORT=10003
```

---

### 6️⃣ OpenCode 未安装

| 项目 | 说明 |
|:-----|:-----|
| **症状** | `Cannot verify OpenCode installation` |
| **解决方案** | 安装 OpenCode CLI |

```bash
# Windows
npm install -g opencode-ai

# Linux/macOS
curl -fsSL https://opencode.ai/install | bash
```

---

### 7️⃣ Docker 容器无法启动

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 容器启动失败或立即退出 |
| **解决方案** | 检查日志和配置 |

```bash
# 查看日志
docker compose logs

# 检查端口
netstat -tulpn | grep -E '10000|10001'
```

---

### 8️⃣ 认证失败

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 返回 `401 Unauthorized` |
| **解决方案** | 确认 `API_KEY` 配置正确 |

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" ...
```

---

### 9️⃣ Zen 免费层 403（FreeTierError）

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 请求返回 HTTP `403`，客户端可见的 `type`/`code` 为 `permission_denied`；上游响应/日志中含 `FreeTierError`。上游消息为 `OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.` |
| **原因** | 代理侧已知两类原因：(a) 上游请求 `tools[]` 缺少 `read`（headless deny-all 或旧版/未固定版本的后端会隐藏它）；(b) 免费层模型的 prompt `tools` **map** 中出现任何 `false` 条目（代理会为疑似免费模型剥离这些条目，但自定义/旧路径可能漏掉）。若两者均已排除，403 也可能是上游 Zen 的账号资格/网络/出口 IP 拒绝，代理无法修复。 |

排查/修复清单：

1. 升级并重建到当前镜像（后端固定 `opencode-ai@1.18.35`）或当前源码；使用 compose 时执行 `docker compose build`，再 `docker compose up -d --force-recreate`（只改 `build.args` 不会让 `up -d` 自动重建）。
2. 保持 `DISABLE_TOOLS=true`（默认）。不要仅为通过闸门把 `read` 加入 `OPENCODE_INTERNAL_ALLOWED_TOOLS`——那会授予真实的后端读取执行权限。
3. 客户端工具按正常请求 `tools` 发送；代理会把它们桥接为 `external__*`，不会注册成后端内置工具。
4. 默认容器每次启动都会重新生成 `/home/node/.config/opencode/opencode.json`（生成的 `permission` 就在其中）；实际可能覆盖它的是项目级 `/home/node/project/config.json`。若该文件设置了冲突的 `permission.read` deny（字符串或对象形式），删除该 deny；**不要**把它改成 `"allow"`。重建后确认生成的 `read` 闸门仍在。
5. 若使用自定义或未固定版本的后端，确认其 `Permission.disabled()` 仍使用 `findLast`，且 `read` 仍出现在上游 `tools[]` 中；版本升级检查见 [docs/docker.md](./docker.md) 的「固定 OpenCode 后端版本」。

> 该闸门只保证 `read` 出现在上游 `tools[]` 中，不保证 Zen 免费额度可用；额度限制仍可能以其他错误返回。

---

### 🔟 跨协议转换结果异常

| 项目 | 说明 |
|:-----|:-----|
| **症状** | 非原生协议客户端收到缺字段、空工具调用、`usage` 为 0、截断信号丢失 |
| **说明** | 网关建议各客户端使用原生协议端点（OpenAI SDK → `/v1/chat/completions` 或 `/v1/responses`，Anthropic SDK → `/v1/messages`，Gemini SDK → `/v1beta/interactions`）。跨协议转换是 best-effort，目前仅 `POST /v1/messages` 入站走转换矩阵，其余路径可能降级（纯文本 + 零填充用量），属已知限制而非后端故障 |

提 issue 前请先排除偶发因素：

```bash
# 1. 重试一次，并检查后端状态（排除波动/限流）
curl -H "Authorization: Bearer YOUR_API_KEY" http://127.0.0.1:10000/health/details

# 2. 用原生协议端点复现同一请求（确认是转换问题，而非模型/后端问题）

# 3. 开调试日志抓最小复现
OPENCODE_PROXY_DEBUG=true
```

提 issue 时请附（并删掉 `API_KEY` 等密钥）：端点 + 协议方向（如 messages→chat）、最小请求 JSON、期望 vs 实际响应、模型 ID、原生端点是否同样复现。

---

## 🔍 调试模式

开启调试日志:

```bash
# 环境变量
OPENCODE_PROXY_DEBUG=true
```

调试日志会输出详细的请求和响应信息。

---

## 🆘 获取帮助

- 🐛 [GitHub Issues](https://github.com/samson910022/OpenCode2API/issues)

> 📖 [Docs Index](./README.md) | 🏠 [Main README](../README.md)
