# 💻 开发指南

## 📋 环境准备

```bash
node --version    # 需要 18+
npm install

# 安装 OpenCode CLI
npm install -g opencode-ai
# 或 curl -fsSL https://opencode.ai/install | bash
```

## 🚀 本地运行

```bash
cp config.json.example config.json
npm start
```

启动后会按需拉起 OpenCode 后端并启动代理服务。

## ✅ 测试

| 命令 | 说明 |
|:-----|:-----|
| `npm test` | 全部单元测试（Jest） |
| `npm run test:integration` | 集成测试 |

Docker 环境验证：

```bash
docker compose up -d --build
docker compose logs -f
```

## 📂 项目结构

```
OpenCode2API/
├── index.js                  # 入口与配置加载
├── src/
│   ├── proxy.js              # 核心代理逻辑
│   └── tool-runtime/         # 工具桥接运行时（contracts/parser/policy/registry/router/validator）
├── tests/
│   ├── app.test.js           # 单元测试
│   ├── parser-foreign-formats.test.js
│   ├── test-integration.sh   # 集成测试
│   └── test-streaming-real.sh
├── docs/                     # 文档
├── entrypoint.sh             # Docker 入口脚本
├── Dockerfile
└── docker-compose.yml
```

## 📝 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: add new feature
fix: fix bug
docs: update documentation
refactor: refactor code
test: add tests
chore: update build/ci
```

## 🔄 贡献流程

1. Fork 项目并创建功能分支：`git checkout -b feature/your-feature`
2. 提交更改，确保 `npm test` 通过
3. 推送分支并创建 Pull Request

详见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## 📄 许可证

MIT License · 详见 [LICENSE](../LICENSE.md)
