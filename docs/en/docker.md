# 🐳 Docker Deployment

## 🚀 Quick Start

```bash
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env    # Edit .env, API_KEY and OPENCODE_SERVER_PASSWORD are required
docker compose up -d

# Verify
curl http://127.0.0.1:10000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## ⚙️ Configuration

Common `.env` items (full list in [Configuration](./configuration.md)):

```env
# Required
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# Security
OPENCODE_DISABLE_TOOLS=true

# Optional
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

## 📦 Volumes

| Volume | Container Path | Description |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode data directory |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode config directory |

Project source is copied into the image at `/home/node/project` at build time. The host directory is not mounted by default, so `node_modules` in the image is not overwritten.

## 🔨 Custom Build

```bash
# Build image
docker build -t my-opencode2api .

# Run a single container
docker run -d \
  -p 10000:10000 \
  -p 10001:10001 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode2api
```

## 📊 Log Management

```bash
# View logs
docker compose logs -f
```

Log rotation in Compose is recommended:

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

## ✅ Health Check

Compose has a built-in health check:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:10000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 60s
```

## ❓ FAQ

- **Container fails to start**: check logs with `docker compose logs`, confirm ports are free.
- **Mount permission issues**: check PUID/PGID (default 1000:1000).
