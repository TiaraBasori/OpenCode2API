# 🐳 Docker 部署

<p align="center">
  <img src="https://img.shields.io/badge/version-1.6.0-blue" alt="Version">
</p>

---

## 🚀 快速开始

### 1️⃣ 克隆项目

```bash
git clone https://github.com/samson910022/OpenCode2API.git
cd OpenCode2API
```

### 2️⃣ 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，设置你的配置
```

### 3️⃣ 启动服务

```bash
docker compose up -d
```

### 4️⃣ 验证

```bash
# 健康检查
curl http://127.0.0.1:10000/health

# 获取模型列表
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:10000/v1/models
```

---

## ⚙️ 配置说明

### .env 文件

```env
# 必需配置
API_KEY=change-me
OPENCODE_SERVER_PASSWORD=change-me-too

# 安全相关
DISABLE_TOOLS=true

# 可选配置
OPENCODE_PROXY_PROMPT_MODE=plugin-inject
OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=true
OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=true
```

---

## 📦 卷挂载

| 卷名 | 容器内路径 | 说明 |
|:-----|:----------|:-----|
| `opencode-data` | `/home/node/.local/share/opencode` | OpenCode 数据目录 |
| `opencode-config` | `/home/node/.config/opencode` | OpenCode 配置目录 |
| 项目目录 | `/home/node/project` | 项目源代码 |

---

## 🔨 自定义构建

### 构建镜像

```bash
docker build -t my-opencode2api .
```

### 固定 OpenCode 后端版本

镜像默认安装 `opencode-ai@1.18.35`（由 Dockerfile 的 `ARG OPENCODE_VERSION` 控制）。这个版本是有意固定的：Zen 免费层的 `read` 闸门依赖 OpenCode `Permission.disabled()` 的 findLast 语义——它先按工具名选出最后一条规则，再检查该规则的 pattern 是否为 `*`。不指定版本的 npm `latest`（例如 `npm install -g opencode-ai`）可能悄悄改变该行为，让免费层 403 修复重新失效。需要 Zen 免费层修复时，不要使用不指定版本安装的镜像。

构建时覆盖版本：

```bash
docker build --build-arg OPENCODE_VERSION=1.18.35 -t my-opencode2api .
```

`docker compose build` 默认使用 Dockerfile 里的版本；要覆盖需在 `docker-compose.yml`（或 override 文件）的 `build.args` 中传 `OPENCODE_VERSION`：

```yaml
services:
  opencode2api:
    build:
      args:
        OPENCODE_VERSION: "1.18.35"
```

也可以一次性覆盖（无需改 compose 文件）：

```bash
docker compose build --build-arg OPENCODE_VERSION=1.18.35 opencode2api
```

修改 `build.args` 不会让 `docker compose up -d` 自动重建镜像；需要先构建再强制重建容器：

```bash
docker compose build opencode2api
docker compose up -d --force-recreate
```

升级固定版本时，代理侧单测只能保护代理侧契约，无法执行镜像里安装的后端。合并前必须完成：

1. 同步更新 `Dockerfile` 的 `ARG OPENCODE_VERSION`、`tests/dockerfile-pin.test.js` 的 `PINNED_VERSION`、本页所有版本字符串（含默认说明），以及 `docs/troubleshooting.md` / `AGENTS.md` / `CHANGELOG.md` 中当前 pin 的版本引用；
2. 重跑 `tests/free-tier-gate.test.js`、`tests/backend-permission.test.js` 与 `tests/dockerfile-pin.test.js`；
3. 检查目标版本源码，确认 `Permission.disabled()` 仍使用 `findLast`，且选择逻辑仍是“按工具名取最后一条规则，再判断该规则 pattern 是否为 `*`”；
4. 用真实后端与 Zen 请求验证 `read` 仍出现在上游 `tools[]` 中，然后再合并。

### 运行单个容器

```bash
docker run -d \
  -p 10000:10000 \
  -e API_KEY=your-key \
  -e OPENCODE_SERVER_PASSWORD=your-password \
  -v opencode-data:/home/node/.local/share/opencode \
  -v opencode-config:/home/node/.config/opencode \
  my-opencode2api
```

> 后端 `10001` 仅容器内部使用，不要对外发布（compose 默认也只映射代理端口；改端口用 `OPENCODE_PROXY_PORT`，legacy 别名 `PORT` 也生效，如 `8090`；`ports` 映射与 `healthcheck` 会同步跟随）。

> compose 里所有配置项都写成空值（`${X:-}`），默认值由代码持有：这样挂载进来的 `config.json` 与 legacy 别名不会被镜像/编排里的非空默认值遮蔽。端口类变量在 `entrypoint.sh` 启动时做 `1..65535` 校验，非法值告警后回落默认，不会把坏端口传给后端。

> 注意：镜像构建时**不会**把本地 `config.json` 烘焙进去（多阶段构建只复制 `dist/` 与依赖，避免把本地密钥带进镜像）。容器内配置请用环境变量，或 `-v ./config.json:/home/node/project/config.json:ro` 挂载（代理会按 `dist/` 同层 → 项目根 → 工作目录顺序查找）。

### 多架构

`ghcr.io/samson910022/opencode2api:latest` 同时含 `linux/amd64` 与 `linux/arm64`，ARM 机器可直接 pull，无需本地 build（仅自带 `custom-bin/opencode` 二进制时才需按架构重建）。

### 覆寫資源限制

compose 預設 `mem_limit 768m`（單容器含 proxy＋後端）。大機要放寬或取消，用 override 檔：

```yaml
# docker-compose.override.yml
services:
  opencode2api:
    mem_limit: 2g
    mem_reservation: 512m
    cpus: 4.0
```

### 改變出口 IP（後端走代理）

後端（Bun）認標準代理環境變數（`ALL_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY`，大小寫皆可，`NO_PROXY` 跳過直連），用 compose `environment` 或 `.env` 傳入即可（不要提交帶值的 `.env`）。兩點注意：`NO_PROXY` 必須含 `localhost,127.0.0.1,::1`（否則 proxy↔後端的 loopback 也被送進代理而中斷）；Bun 不支援 `socks5(h)://`（會報 `UnsupportedProxyProtocol`），只認 http/https 代理——SOCKS 需求先在外層轉成 HTTP CONNECT 入口。

---

## 📊 日志管理

compose 已内置 json-file 轮转（`max-size: 10m`、`max-file: 3`）；裸 `docker run` 请自行加上 `--log-opt max-size=10m --log-opt max-file=3`。

### 查看日志

```bash
docker compose logs -f
```

---

## ✅ 健康检查

服务配置了健康检查:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:${OPENCODE_PROXY_PORT:-${PORT:-10000}}/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 200s
```

> `/health` 是浅检查（只确认代理活着，不测后端；`start_period` 200s 覆盖 entrypoint 约 180s 的小机冷启动等待）。小机（1GB）另有 `mem_limit 768m` / `pids_limit 256` 保护，裸 `docker run` 请加等价旗（见 `docker-compose.yml` 注释）。

---

## ❓ 常见问题

### 容器无法启动

检查日志:
```bash
docker compose logs
```

### 挂载权限问题

确保 PUID/PGID 配置正确 (默认 1000:1000)。

---

> 📖 [Docs Index](./README.md) | 🚀 [Getting Started](./getting-started.md)
