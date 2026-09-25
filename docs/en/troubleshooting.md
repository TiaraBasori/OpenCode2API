# 🔧 Troubleshooting

## ❓ FAQ

### Requests hang, but `/v1/models` works

Set `OPENCODE_USE_ISOLATED_HOME=false` so OpenCode reuses the host login state:

```env
OPENCODE_USE_ISOLATED_HOME=false
```

### Model not found (`model_not_found`)

Check the model ID against the backend:

```bash
curl http://127.0.0.1:10000/v1/models
```

### Sent `reasoning_effort` but got no reasoning output

Use the Responses API with `stream: true`, and pass `reasoning.effort` or `reasoning_effort`.

### Client unexpectedly triggers OpenCode built-in tools

Keep `OPENCODE_DISABLE_TOOLS=true`.

### Port conflict (`EADDRINUSE`)

```bash
# Check usage
lsof -i :10000
lsof -i :10001

# Change ports
OPENCODE_PROXY_PORT=10002
OPENCODE_SERVER_PORT=10003
```

### OpenCode not installed (`Cannot verify OpenCode installation`)

```bash
npm install -g opencode-ai
# Or curl -fsSL https://opencode.ai/install | bash
```

You can also point to the full binary path via `OPENCODE_PATH`.

### Docker container fails to start

```bash
docker compose logs
netstat -tulpn | grep -E '10000|10001'
```

### Auth failure (`401 Unauthorized`)

Confirm the request carries the same Bearer token as `API_KEY`:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" ...
```

## 🔍 Debug Mode

```env
OPENCODE_PROXY_DEBUG=true
```

Debug logs print detailed request and response info.

## 🆘 Get Help

- 🐛 [GitHub Issues](https://github.com/TiaraBasori/opencode2api/issues)
