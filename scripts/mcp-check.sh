#!/usr/bin/env bash
set -euo pipefail

namespace="${MCP_CHECK_NAMESPACE:-llm-runtime}"
gateway_url="${MCP_GATEWAY_URL:-http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000/mcp}"
protocol="${MCP_PROTOCOL_VERSION:-2025-06-18}"
project_id="${PROJECT_ID:-}"
query="${QUERY:-}"
reference_chunk_id="${REFERENCE_CHUNK_ID:-}"

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
  reference_chunk_id="$5"

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

  retrieve_tool="$(sed -n "s/.*\"name\"[[:space:]]*:[[:space:]]*\"\([^\"]*memory\.retrieve_context[^\"]*\)\".*/\1/p" /tmp/tools.out | head -n1)"
  reference_search_tool="$(sed -n "s/.*\"name\"[[:space:]]*:[[:space:]]*\"\([^\"]*memory\.reference\.search[^\"]*\)\".*/\1/p" /tmp/tools.out | head -n1)"
  reference_get_tool="$(sed -n "s/.*\"name\"[[:space:]]*:[[:space:]]*\"\([^\"]*memory\.reference\.get[^\"]*\)\".*/\1/p" /tmp/tools.out | head -n1)"

  test -n "$retrieve_tool" || { echo "memory.retrieve_context not visible through gateway" >&2; exit 1; }
  test -n "$reference_search_tool" || { echo "memory.reference.search not visible through gateway" >&2; exit 1; }
  test -n "$reference_get_tool" || { echo "memory.reference.get not visible through gateway" >&2; exit 1; }

  echo "public retrieval tool: $retrieve_tool"
  echo "public reference search tool: $reference_search_tool"
  echo "public reference get tool: $reference_get_tool"

  if [ -n "$project_id" ] && [ -n "$query" ]; then
    payload="$(printf "%s" "$query" | sed "s/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g")"
    echo "=== tools/call $retrieve_tool ==="
    curl -sS \
      -X POST "$url" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $session" \
      --data "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"${retrieve_tool}\",\"arguments\":{\"project_id\":\"${project_id}\",\"query\":\"${payload}\"}}}"
    echo

    echo "=== tools/call $reference_search_tool ==="
    curl -sS -o /tmp/reference-search.out \
      -X POST "$url" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $session" \
      --data "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"${reference_search_tool}\",\"arguments\":{\"project_id\":\"${project_id}\",\"query\":\"${payload}\"}}}"
    cat /tmp/reference-search.out
    echo
    if grep -Eq '\"isError\"[[:space:]]*:[[:space:]]*true|\"error\"[[:space:]]*:' /tmp/reference-search.out; then
      echo "memory.reference.search returned an MCP error" >&2
      exit 1
    fi
  fi

  if [ -n "$project_id" ] && [ -n "$reference_chunk_id" ]; then
    echo "=== tools/call $reference_get_tool ==="
    curl -sS -o /tmp/reference-get.out \
      -X POST "$url" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "Mcp-Session-Id: $session" \
      --data "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"${reference_get_tool}\",\"arguments\":{\"project_id\":\"${project_id}\",\"chunk_id\":\"${reference_chunk_id}\"}}}"
    cat /tmp/reference-get.out
    echo
    if grep -Eq '\"isError\"[[:space:]]*:[[:space:]]*true|\"error\"[[:space:]]*:' /tmp/reference-get.out; then
      echo "memory.reference.get returned an MCP error" >&2
      exit 1
    fi
  fi
' sh "${gateway_url}" "${protocol}" "${project_id}" "${query}" "${reference_chunk_id}"
