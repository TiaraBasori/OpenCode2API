# 🔧 故障排查

## ❓ 常见问题

### 请求卡住，但 `/v1/models` 正常

设置 `OPENCODE_USE_ISOLATED_HOME=false`，让 OpenCode 复用本机登录态：

```env
OPENCODE_USE_ISOLATED_HOME=false
```

### 模型不存在（`model_not_found`）

确认模型 ID 与后端一致：

```bash
curl http://127.0.0.1:10000/v1/models
```

### 发送了 `reasoning_effort` 但没有推理输出

使用 `stream: true` 的 Responses API，并传 `reasoning.effort` 或 `reasoning_effort`。

### 客户端意外触发 OpenCode 内置工具

保持 `OPENCODE_DISABLE_TOOLS=true`。

### 端口冲突（`EADDRINUSE`）

```bash
# 检查占用
lsof -i :10000
lsof -i :10001

# 更换端口
OPENCODE_PROXY_PORT=10002
OPENCODE_SERVER_PORT=10003
```

### OpenCode 未安装（`Cannot verify OpenCode installation`）

```bash
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash
```

也可通过 `OPENCODE_PATH` 指定可执行文件完整路径。

### Docker 容器无法启动

```bash
docker compose logs
netstat -tulpn | grep -E '10000|10001'
```

### 认证失败（`401 Unauthorized`）

确认请求携带了与 `API_KEY` 一致的 Bearer Token：

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" ...
```

## 🔍 调试模式

```env
OPENCODE_PROXY_DEBUG=true
```

调试日志会输出详细的请求和响应信息。

## 🆘 获取帮助

- 🐛 [GitHub Issues](https://github.com/TiaraBasori/opencode2api/issues)
