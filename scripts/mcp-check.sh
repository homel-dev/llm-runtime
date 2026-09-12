#!/usr/bin/env bash
set -euo pipefail

namespace="${MCP_CHECK_NAMESPACE:-llm-runtime}"
gateway_url="${MCP_GATEWAY_URL:-http://llm-runtime-mcp.envoy-gateway-system.svc.cluster.local:8000/mcp}"
protocol="${MCP_PROTOCOL_VERSION:-2025-06-18}"
project_id="${PROJECT_ID:-}"
query="${QUERY:-}"

name="mcp-check-$(date +%s)-$RANDOM"

cleanup() {
  kubectl -n "${namespace}" delete pod "${name}" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl -n "${namespace}" run "${name}" \
  --restart=Never \
  --labels=app.kubernetes.io/name=runtime-operator-check,app.kubernetes.io/part-of=llm-runtime \
  --image=curlimages/curl:8.10.1 \
  --command -- sleep 3600 >/dev/null

kubectl -n "${namespace}" wait --for=condition=Ready "pod/${name}" --timeout=120s >/dev/null

kubectl -n "${namespace}" exec "${name}" -- sh -eu -c '
  url="$1"
  protocol="$2"
  project_id="$3"
  query="$4"

  init_body=/tmp/init.body
  init_headers=/tmp/init.headers

  curl -sS -D "$init_headers" -o "$init_body" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"${protocol}\",\"capabilities\":{},\"clientInfo\":{\"name\":\"llm-runtime-check\",\"version\":\"1\"}}}"

  session="$(awk "BEGIN{IGNORECASE=1} /^mcp-session-id:/ {gsub(/\r/,\"\",\$2); print \$2}" "$init_headers" | tail -n1)"
  test -n "$session" || { echo "MCP initialize did not return Mcp-Session-Id" >&2; cat "$init_headers" >&2; cat "$init_body" >&2; exit 1; }

  curl -sS -o /tmp/initialized.out \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $session" \
    --data "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}"

  curl -sS -o /tmp/tools.out \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Mcp-Session-Id: $session" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"

  echo "=== initialize ==="
  cat "$init_body"
  echo
  echo "=== tools/list ==="
  cat /tmp/tools.out
  echo

  tool="$(sed -n "s/.*\"name\"[[:space:]]*:[[:space:]]*\"\([^\"]*memory\.retrieve_context[^\"]*\)\".*/\1/p" /tmp/tools.out | head -n1)"
  test -n "$tool" || { echo "memory.retrieve_context not visible through gateway" >&2; exit 1; }

  echo "public retrieval tool: $tool"

  if [ -n "$project_id" ] && [ -n "$query" ]; then
    payload="$(printf "%s" "$query" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")"
    echo "=== tools/call $tool ==="
    curl -sS \
      -X POST "$url" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $session" \
      --data "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":{\"project_id\":\"${project_id}\",\"query\":\"${payload}\"}}}"
    echo
  fi
' sh "${gateway_url}" "${protocol}" "${project_id}" "${query}"
