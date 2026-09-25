# 🚀 快速开始

## 📋 环境要求

- **Docker 方式**：Docker 20.10+ 与 Docker Compose
- **本地 Node 方式**：Node.js 18+，以及 OpenCode CLI

## 🏁 Docker 部署（推荐）

```bash
git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
cp .env.example .env        # 编辑 .env，必填 API_KEY 与 OPENCODE_SERVER_PASSWORD
docker compose up -d
```

## 💻 本地 Node 部署

```bash
# 安装 OpenCode CLI
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash

git clone https://github.com/TiaraBasori/opencode2api.git
cd opencode2api
npm install
cp config.json.example config.json
npm start
```

## ✅ 验证服务

```bash
# 健康检查
curl http://127.0.0.1:10000/health

# 模型列表
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

## 💡 快速测试

```bash
curl -X POST http://127.0.0.1:10000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opencode/big-pickle",
    "messages": [{"role": "user", "content": "hi"}],
    "stream": false
  }'
```

## ➡️ 下一步

- ⚙️ [Configuration](./configuration.md) — 全部配置选项
- 🐳 [Docker Deployment](./docker.md) — Docker 部署详情
