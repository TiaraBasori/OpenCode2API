# P5: multi-stage — builder compiles TS -> dist, runtime ships only prod deps + dist.
# Local `dist/` stays in .dockerignore (never enters context); the runtime
# COPY --from=builder bypasses the ignore because it copies from the build
# stage filesystem, not from the build context.
FROM node:lts-slim AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY index.ts ./
COPY src ./src
RUN npm run build

# ---------------- runtime ----------------
FROM node:lts-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && dpkgArch="$(dpkg --print-architecture | awk -F- '{ print $NF }')" \
    && curl -Lo /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/1.19/gosu-$dpkgArch" \
    && chmod +x /usr/local/bin/gosu \
    && gosu --version \
    && rm -rf /var/lib/apt/lists/*

# Pin the bundled backend: the Zen free-tier read gate relies on the
# Permission.disabled() findLast semantics verified against this version.
# Bumping requires both proxy-side regression tests and a live check that the
# target version's Permission.disabled()/upstream tools[] behavior still holds.
ARG OPENCODE_VERSION=1.18.35
RUN test -n "${OPENCODE_VERSION}" && npm install -g "opencode-ai@${OPENCODE_VERSION}"

RUN mkdir -p /home/node/.local/share/opencode \
    && mkdir -p /home/node/.config/opencode \
    && mkdir -p /home/node/project \
    && chown -R node:node /home/node

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /home/node/project

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/dist ./dist
RUN chown -R node:node /home/node/project

EXPOSE 10000 10001

# Config env defaults stay empty on purpose: a non-empty default would win over
# a mounted config.json (or a legacy alias) because the merge order is
# env canonical > env legacy alias > file > hardcoded default. Code owns the
# documented defaults, so empty env + no file behaves exactly like the old
# non-empty env.
ENV OPENCODE_SERVER_PASSWORD=
ENV API_KEY=
ENV API_KEYS=
ENV OPENCODE_API_KEYS=
ENV PORT=
ENV OPENCODE_PROXY_PORT=
ENV OPENCODE_SERVER_PORT=
ENV OPENCODE_SERVER_URL=
ENV BIND_HOST=
ENV OPENCODE_PROXY_BIND_HOST=
ENV DISABLE_TOOLS=
ENV OPENCODE_DISABLE_TOOLS=
ENV OPENCODE_PROXY_MANAGE_BACKEND=
ENV OPENCODE_PATH=
ENV OPENCODE_ZEN_API_KEY=
ENV OPENCODE_EXTERNAL_TOOLS_MODE=
ENV OPENCODE_EXTERNAL_TOOLS_CONFLICT_POLICY=
ENV OPENCODE_EXTERNAL_TOOL_POLICY_MODE=
ENV OPENCODE_EXTERNAL_TOOL_DEFAULT_RISK_LEVEL=
ENV OPENCODE_EXTERNAL_TOOL_ALLOWLIST=
ENV OPENCODE_EXTERNAL_TOOL_DENYLIST=
ENV OPENCODE_EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR=
ENV EXTERNAL_TOOL_POLICY_MODE=
ENV EXTERNAL_TOOL_DEFAULT_RISK_LEVEL=
ENV EXTERNAL_TOOL_ALLOWLIST=
ENV EXTERNAL_TOOL_DENYLIST=
ENV EXTERNAL_TOOL_REQUIRE_CONFIRMATION_FOR=
ENV OPENCODE_INTERNAL_WEB_FETCH_ENABLED=
ENV OPENCODE_INTERNAL_ALLOWED_TOOLS=
ENV OPENCODE_INTERNAL_TOOL_METRICS_ENABLED=
ENV OPENCODE_TOOL_DISCOVERY_FIXTURE=
ENV OPENCODE_HEALTH_DETAILS_ENABLED=
ENV OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH=
ENV OPENCODE_METRICS_ENABLED=
ENV OPENCODE_METRICS_REQUIRE_AUTH=
ENV OPENCODE_USE_ISOLATED_HOME=
ENV OPENCODE_PROXY_DEBUG=
ENV OPENCODE_PROXY_PROMPT_MODE=
ENV OPENCODE_PROXY_OMIT_SYSTEM_PROMPT=
ENV OPENCODE_PROXY_AUTO_CLEANUP_CONVERSATIONS=
ENV OPENCODE_PROXY_CLEANUP_INTERVAL_MS=
ENV OPENCODE_PROXY_CLEANUP_MAX_AGE_MS=
ENV OPENCODE_PROXY_REQUEST_TIMEOUT_MS=
ENV OPENCODE_PROXY_RETRY_MAX_RETRIES=
ENV RETRY_MAX_RETRIES=
ENV OPENCODE_UPSTREAM_PROXIES=
ENV UPSTREAM_PROXIES=
ENV OPENCODE_UPSTREAM_PROXY_STRATEGY=
ENV UPSTREAM_PROXY_STRATEGY=
ENV OPENCODE_UPSTREAM_PROXY_COOLDOWN_MS=
ENV UPSTREAM_PROXY_COOLDOWN_MS=
ENV OPENCODE_UPSTREAM_PROXY_NO_PROXY=
ENV UPSTREAM_PROXY_NO_PROXY=

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "10001"]
