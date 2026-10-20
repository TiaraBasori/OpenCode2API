#!/bin/bash

PUID=${PUID:-1000}
PGID=${PGID:-1000}
OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-}

if [ "$(id -g node)" -ne "$PGID" ]; then
    groupmod -o -g "$PGID" node
fi

if [ "$(id -u node)" -ne "$PUID" ]; then
    usermod -o -u "$PUID" node
fi

chown -R node:node /home/node/.local/share/opencode
chown -R node:node /home/node/.config/opencode
chown -R node:node /home/node/project

# Allow overriding via environment variables
# Ports are validated/normalized here so an invalid value never reaches
# `opencode serve --port`; canonical names are exported so the proxy merges
# the same value the container actually uses.
normalize_port() {
    local label="$1"
    local value="$2"
    local fallback="$3"
    if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
        printf '%s\n' "$value"
        return 0
    fi
    if [ -n "$value" ]; then
        echo "[Config] Warning: ${label}=\"${value}\" is not a valid port (1-65535); using ${fallback}" >&2
    fi
    printf '%s\n' "$fallback"
}

PROXY_PORT=$(normalize_port "OPENCODE_PROXY_PORT" "${OPENCODE_PROXY_PORT:-}" "")
if [ -z "$PROXY_PORT" ] && [[ "${PORT:-}" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; then
    PROXY_PORT="$PORT"
elif [ -z "$PROXY_PORT" ] && [ -n "${OPENCODE_PROXY_PORT:-}${PORT:-}" ]; then
    echo "[Config] Warning: OPENCODE_PROXY_PORT=\"${OPENCODE_PROXY_PORT:-}\" PORT=\"${PORT:-}\" is not a valid port (1-65535); leaving unset for config.json/file merge" >&2
fi
SERVER_PORT=$(normalize_port "OPENCODE_SERVER_PORT" "${OPENCODE_SERVER_PORT:-}" 10001)
if [ -n "$PROXY_PORT" ]; then
    export OPENCODE_PROXY_PORT="$PROXY_PORT"
else
    unset OPENCODE_PROXY_PORT
    PROXY_PORT=10000
fi
export OPENCODE_SERVER_PORT="$SERVER_PORT"

# Backend permission lockdown (single source: src/backend/backend-permission.ts,
# mirrored in src/backend/manager.ts for the isolated-home path): the headless
# backend must never `ask` (nobody approves -> prompt hangs until the proxy
# 180s timeout) nor silently execute tools the proxy did not authorize (the
# free-tier strip omits the prompt tools map -> backend agent defaults on).
# Deny-all by default; only explicitly allowlisted internal tools are allowed.
# Applies in every prompt mode (standard and plugin-inject alike).
BACKEND_PERM_JSON=""
if [ -f ./dist/src/backend/backend-permission.js ]; then
    BACKEND_PERM_JSON=$(node --input-type=module -e "
import('./dist/src/backend/backend-permission.js').then((m) => {
  const rawList = process.env['OPENCODE_INTERNAL_ALLOWED_TOOLS'] ?? '';
  const rawFetch = (process.env['OPENCODE_INTERNAL_WEB_FETCH_ENABLED'] ?? '').trim().toLowerCase();
  const list = String(rawList).split(',').map((s) => s.trim()).filter(Boolean);
  const fetchOn = ['1', 'true', 'yes', 'y', 'on'].includes(rawFetch);
  console.log(JSON.stringify(m.buildBackendPermission(list, fetchOn)));
}).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });" 2>/dev/null) || BACKEND_PERM_JSON=""
fi
if [ -z "$BACKEND_PERM_JSON" ]; then
    # Safety mirror of buildBackendPermission() with no allowlist; guarded
    # against drift by tests/backend-permission.test.js.
    echo "[Config] Warning: backend permission generator unavailable; using static deny-all-execution fallback" >&2
    BACKEND_PERM_JSON='{"read":{"*":"deny","/__opencode_free_tier_gate_never__\u0000":"allow"},"edit":"deny","glob":"deny","grep":"deny","list":"deny","bash":"deny","task":"deny","todowrite":"deny","question":"deny","webfetch":"deny","websearch":"deny","lsp":"deny","doom_loop":"deny","skill":"deny","external_directory":{"/home/node/project/**":"allow","*":"deny"}}'
fi
PLUGIN_JSON_LINE=""
if [[ "${OPENCODE_PROXY_PROMPT_MODE:-standard}" == "plugin-inject" ]]; then
    echo "Preparing opencode2api plugin-inject prompt mode..."
    mkdir -p /home/node/.config/opencode/plugin/opencode2api-empty
    cat > /home/node/.config/opencode/plugin/opencode2api-empty/index.js <<'EOF'
export const Opencode2apiEmptyPlugin = async () => ({})
export default Opencode2apiEmptyPlugin
EOF
    PLUGIN_JSON_LINE='  "plugin": ["/home/node/.config/opencode/plugin/opencode2api-empty/index.js"],'
fi
mkdir -p /home/node/.config/opencode
# printf-built (never an interpolated heredoc): generated JSON cannot be
# shell-expanded into the config even if it ever contains $, backticks, or \.
{
printf '%s\n' '{'
if [ -n "$PLUGIN_JSON_LINE" ]; then printf '%s\n' "$PLUGIN_JSON_LINE"; fi
printf '%s\n' '  "instructions": [],'
printf '%s\n' '  "theme": "system",'
printf '  "permission": %s\n' "$BACKEND_PERM_JSON"
printf '%s\n' '}'
} > /home/node/.config/opencode/opencode.json
chown -R node:node /home/node/.config/opencode

if [[ "$1" == "opencode" && "$2" == "serve" ]]; then
    echo "Initializing OpenCode-to-OpenAI (Server + Proxy)"

    # opencode serve rewrites <project>/config.json on (nearly) every API call
    # (ConfigHttpApi.update) and its own file watcher treats that as a config
    # change: it disposes/recreates the project instance, aborting in-flight
    # session work. Under concurrent/rapid proxy traffic this becomes a
    # self-sustaining abort storm (backend MessageAbortedError -> proxy
    # response.failed "Aborted" -> client retries -> more reloads).
    # Pin a skeleton config.json root-owned/read-only for the node user so the
    # write fails (EACCES, logged by the backend, otherwise harmless) without
    # changing mtime, which keeps the watcher quiet. No real settings live in
    # this file (backend state stays under /home/node/.local/share/opencode).
    if [ ! -f /home/node/project/config.json ]; then
        printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > /home/node/project/config.json
    fi
    chown root:root /home/node/project/config.json
    chmod 644 /home/node/project/config.json

    echo "Starting OpenCode Server on internal port ${SERVER_PORT}..."
    gosu node opencode serve --hostname 0.0.0.0 --port ${SERVER_PORT} &
    SERVER_PID=$!
    
    echo "Waiting for OpenCode Server to become available..."
    # Cold start on small (1GB) hosts can take minutes; do not kill early.
    # Budget: 90 x 2s sleep ~= 180s when the backend refuses fast (normal
    # cold start; covered by compose start_period 200s). If the backend
    # accepts but hangs every probe, each round costs up to curl -m 5 + 2s
    # sleep (worst case ~630s) — that means the backend itself is wedged,
    # not slow, and the container will exit 1 so it can be rescheduled.
    MAX_RETRIES=90
    RETRY_DELAY=2
    COUNT=0
    while ! curl -s -m 5 http://127.0.0.1:${SERVER_PORT}/health > /dev/null; do
        if [ $COUNT -ge $MAX_RETRIES ]; then
            echo "Timeout waiting for OpenCode Server."
            kill $SERVER_PID 2>/dev/null
            exit 1
        fi

        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "OpenCode Server process died unexpectedly."
            exit 1
        fi

        sleep $RETRY_DELAY
        COUNT=$((COUNT+1))
    done
    echo "OpenCode Server is up!"

    echo "Starting OpenAI Proxy on port ${PROXY_PORT}..."
    exec gosu node node dist/index.js
else
    exec gosu node "$@"
fi