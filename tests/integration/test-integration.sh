#!/bin/bash
# Docker-backed integration tests for OpenCode2API.
#
# Builds the project image, starts one container, and exercises the proxy
# end to end: health, models, chat completions, tool routing metrics, and
# auth gating on /health/details and /metrics.
#
# Env overrides:
#   TEST_PORT (default 14096), API_KEY stays fixed at "test-key" unless
#   TEST_API_KEY is set. All other knobs pass through to the container.
set -euo pipefail

TEST_PORT="${TEST_PORT:-14096}"
TEST_API_KEY="${TEST_API_KEY:-test-key}"
CONTAINER_NAME="opencode2api-test-${TEST_PORT}"
INTERNAL_ALLOWED_TOOLS="${INTERNAL_ALLOWED_TOOLS:-web_fetch,filesystem}"
TOOL_DISCOVERY_FIXTURE="${TOOL_DISCOVERY_FIXTURE:-web_fetch,filesystem,bash}"
HEALTH_DETAILS_ENABLED="${HEALTH_DETAILS_ENABLED:-true}"
HEALTH_DETAILS_REQUIRE_AUTH="${HEALTH_DETAILS_REQUIRE_AUTH:-true}"
METRICS_ENABLED="${METRICS_ENABLED:-true}"
METRICS_REQUIRE_AUTH="${METRICS_REQUIRE_AUTH:-true}"

cleanup() {
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- Running Integration Tests ---"

echo "Building Docker image..."
docker build -t opencode2api:test .

echo "Starting container on port ${TEST_PORT}..."
cleanup

docker run -d --name "${CONTAINER_NAME}" \
    -p ${TEST_PORT}:10000 \
    -e API_KEY="${TEST_API_KEY}" \
    -e OPENCODE_INTERNAL_ALLOWED_TOOLS="${INTERNAL_ALLOWED_TOOLS}" \
    -e OPENCODE_TOOL_DISCOVERY_FIXTURE="${TOOL_DISCOVERY_FIXTURE}" \
    -e OPENCODE_HEALTH_DETAILS_ENABLED="${HEALTH_DETAILS_ENABLED}" \
    -e OPENCODE_HEALTH_DETAILS_REQUIRE_AUTH="${HEALTH_DETAILS_REQUIRE_AUTH}" \
    -e OPENCODE_METRICS_ENABLED="${METRICS_ENABLED}" \
    -e OPENCODE_METRICS_REQUIRE_AUTH="${METRICS_REQUIRE_AUTH}" \
    opencode2api:test

echo "Waiting for service to be ready..."
MAX_RETRIES=30
COUNT=0
until curl -sf http://localhost:${TEST_PORT}/health > /dev/null 2>&1; do
    if [ $COUNT -ge $MAX_RETRIES ]; then
        echo "Timeout waiting for service."
        docker logs "${CONTAINER_NAME}"
        exit 1
    fi
    sleep 1
    COUNT=$((COUNT+1))
done
echo "Service is up!"

echo "Testing health endpoint..."
curl -sf http://localhost:${TEST_PORT}/health || { echo "Health check failed"; exit 1; }

echo "Testing models endpoint..."
MODELS_JSON=$(curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/v1/models)
echo "$MODELS_JSON" | grep -q "opencode" || { echo "Models check failed"; exit 1; }
MODEL_ID=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["data"][0]["id"])' <<< "$MODELS_JSON")

echo "Testing chat completion (non-streaming) with ${MODEL_ID}..."
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer ${TEST_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Hi\"}]}" | grep -q "chat.completion" || { echo "Chat completion failed"; exit 1; }

echo "Testing health details endpoint..."
curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/health/details > /dev/null || { echo "/health/details check failed"; exit 1; }

echo "Testing metrics endpoint..."
curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/metrics | grep -q "opencode_internal_tool_mode_requests_total" || { echo "/metrics check failed"; exit 1; }

echo "Testing health details auth gating..."
if curl -sf http://localhost:${TEST_PORT}/health/details > /dev/null; then
    echo "/health/details unexpectedly allowed without auth"
    exit 1
fi

echo "Testing metrics auth gating..."
if curl -sf http://localhost:${TEST_PORT}/metrics > /dev/null; then
    echo "/metrics unexpectedly allowed without auth"
    exit 1
fi

echo "Testing Case 1: Full allowlist match"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer ${TEST_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use web_fetch\"}]}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/health/details)
ALLOWLIST_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["internalAllowlistRequests"])' <<< "$METRICS_JSON")
if [ "$ALLOWLIST_REQS" -lt 1 ]; then
    echo "Case 1 failed: internalAllowlistRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "Testing Case 2: External tools priority"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer ${TEST_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use external tool\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"test_tool\",\"description\":\"desc\",\"parameters\":{\"type\":\"object\",\"properties\":{}}}}]}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/health/details)
BRIDGE_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["externalBridgeRequests"])' <<< "$METRICS_JSON")
if [ "$BRIDGE_REQS" -lt 1 ]; then
    echo "Case 2 failed: externalBridgeRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "Testing Case 3: Partial match"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer ${TEST_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use unconfigured tool\"}],\"opencode\":{\"internal_allowed_tools\":[\"filesystem\",\"unconfigured_tool\"]}}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/health/details)
ALLOWLIST_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["internalAllowlistRequests"])' <<< "$METRICS_JSON")
if [ "$ALLOWLIST_REQS" -lt 2 ]; then
    echo "Case 3 failed: internalAllowlistRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "Testing Case 4: No match / Disabled"
curl -sf -X POST http://localhost:${TEST_PORT}/v1/chat/completions \
    -H "Authorization: Bearer ${TEST_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"Use unconfigured tool\"}],\"opencode\":{\"internal_allowed_tools\":[\"unconfigured_tool\"]}}" > /dev/null
METRICS_JSON=$(curl -sf -H "Authorization: Bearer ${TEST_API_KEY}" http://localhost:${TEST_PORT}/health/details)
DISABLED_REQS=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print(data["internal_tools"]["metrics"]["disabledRequests"])' <<< "$METRICS_JSON")
if [ "$DISABLED_REQS" -lt 1 ]; then
    echo "Case 4 failed: disabledRequests did not increment. Metrics: $METRICS_JSON"
    exit 1
fi

echo "--- Integration Tests Passed! ---"

