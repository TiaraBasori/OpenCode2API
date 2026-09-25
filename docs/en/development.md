# 💻 Development Guide

## 📋 Setup

```bash
node --version    # Requires 18+
npm install

# Install OpenCode CLI
npm install -g opencode-ai
# Or curl -fsSL https://opencode.ai/install | bash
```

## 🚀 Run Locally

```bash
cp config.json.example config.json
npm start
```

On start, the OpenCode backend is launched on demand, then the proxy starts.

## ✅ Tests

| Command | Description |
|:-----|:-----|
| `npm test` | All unit tests (Jest, `tests/unit`) |
| `npm run test:integration` | Docker-backed integration tests |
| `npm run test:stream` | Live-backend streaming smoke test (manual) |

Docker verification:

```bash
docker compose up -d --build
docker compose logs -f
```

## 📂 Project Layout

```
OpenCode2API/
├── index.js                  # Entry and config loading
├── src/
│   ├── proxy.js              # Core proxy logic
│   └── tool-runtime/         # Tool bridge runtime (contracts/parser/policy/registry/router/validator)
├── tests/
│   ├── unit/                 # Jest unit tests (npm test)
│   ├── integration/          # Docker-backed integration tests
│   └── manual/               # Live-backend smoke tests, not in CI
├── docs/                     # Docs (zh/ + en/)
├── entrypoint.sh             # Docker entrypoint
├── Dockerfile
└── docker-compose.yml
```

## 📝 Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix bug
docs: update documentation
refactor: refactor code
test: add tests
chore: update build/ci
```

## 🔄 Contribute

1. Fork the repo and create a feature branch: `git checkout -b feature/your-feature`
2. Commit changes, make sure `npm test` passes
3. Push the branch and open a Pull Request

See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## 📄 License

MIT License · See [LICENSE](../../LICENSE.md)
