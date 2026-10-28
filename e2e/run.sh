#!/bin/bash
# End-to-end: the image answers one question with a stub model and stub products, each in a container of its own on a
# network of their own, and the answer comes back with its calls cited and linked (ADR 0073). No hosted model is
# called. Needs Docker and Node, and the image to test (default assistant:dev). Exits non-zero on failure.
set -eu
IMAGE=${1:-assistant:dev}
PORT=${E2E_PORT:-47613}
HERE=$(cd "$(dirname "$0")/.." && pwd)
D=$(mktemp -d)
cleanup() { docker rm -f e2e-assistant e2e-assistant-stubs >/dev/null 2>&1 || true; docker network rm e2e-assistant >/dev/null 2>&1 || true; }
cleanup
trap cleanup EXIT
docker network create e2e-assistant >/dev/null
openssl rand -hex 32 > "$D/kek"
chmod 644 "$D/kek"
docker run -d --name e2e-assistant-stubs --network e2e-assistant -v "$HERE:/src:ro" -w /src node:26.12.0-trixie-slim node e2e/stubs.ts >/dev/null
docker run -d --name e2e-assistant --network e2e-assistant -p "127.0.0.1:$PORT:8080" -e ASSISTANT_PUBLIC_URL="http://localhost:$PORT" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$D/kek:/run/secrets/openasy-kek:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -sf "localhost:$PORT/readyz" >/dev/null && break; sleep 1; done
for _ in $(seq 1 30); do docker logs e2e-assistant-stubs 2>&1 | grep -q 'stub model' && break; sleep 1; done
curl -sf "localhost:$PORT/healthz" | grep -q '"ok"' && echo "ok   /healthz"
curl -sf "localhost:$PORT/metrics" | grep -q 'openasy_build_info{product="assistant"' && echo "ok   /metrics"
SETUP=$(docker logs e2e-assistant 2>&1 | grep -o "http://localhost:$PORT/?setup=[A-Za-z0-9_-]*" | tail -1)
node "$HERE/e2e/flow.ts" "$SETUP" e2e-assistant-stubs || { docker logs e2e-assistant | tail -20; exit 1; }
