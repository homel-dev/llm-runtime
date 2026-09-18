#!/usr/bin/env bash
set -euo pipefail

NS="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
BACKEND_NS="${OCO_BACKEND_NAMESPACE:-observability-backend}"
SENDER="llmrun-observability-smoke-sender"
QUERY="llmrun-observability-smoke-query"
TRACE_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
SPAN_ID="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
NOW_NS="$(date +%s)000000000"

cleanup() {
  kubectl -n "$NS" delete pod "$SENDER" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
  kubectl -n "$BACKEND_NS" delete pod "$QUERY" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

kubectl -n "$NS" get daemonset/alloy service/alloy >/dev/null
kubectl -n "$BACKEND_NS" get service/alloy service/victoriametrics service/victorialogs service/tempo >/dev/null

kubectl -n "$NS" run "$SENDER" --rm -i --restart=Never \
  --image=curlimages/curl:8.16.0 -- sh -eu -c "
  curl -fsS -H 'Content-Type: application/json' \
    http://alloy:4318/v1/metrics \
    -d '{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"llm-runtime-smoke\"}}]},\"scopeMetrics\":[{\"scope\":{},\"metrics\":[{\"name\":\"llm_runtime_shared_smoke_total\",\"sum\":{\"aggregationTemporality\":2,\"isMonotonic\":true,\"dataPoints\":[{\"asInt\":\"1\",\"timeUnixNano\":\"$NOW_NS\"}]}}]}]}]}]}'

  curl -fsS -H 'Content-Type: application/json' \
    http://alloy:4318/v1/logs \
    -d '{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"llm-runtime-smoke\"}}]},\"scopeLogs\":[{\"scope\":{},\"logRecords\":[{\"timeUnixNano\":\"$NOW_NS\",\"severityText\":\"INFO\",\"body\":{\"stringValue\":\"llm-runtime-shared-backend-smoke\"},\"traceId\":\"$TRACE_ID\",\"spanId\":\"$SPAN_ID\"}]}]}]}]}'

  curl -fsS -H 'Content-Type: application/json' \
    http://alloy:4318/v1/traces \
    -d '{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"llm-runtime-smoke\"}}]},\"scopeSpans\":[{\"scope\":{},\"spans\":[{\"traceId\":\"$TRACE_ID\",\"spanId\":\"$SPAN_ID\",\"name\":\"llm-runtime-shared-backend-smoke\",\"kind\":1,\"startTimeUnixNano\":\"$NOW_NS\",\"endTimeUnixNano\":\"$NOW_NS\"}]}]}]}]}'
"

for attempt in $(seq 1 12); do
  if kubectl -n "$BACKEND_NS" run "$QUERY" --rm -i --restart=Never \
      --image=curlimages/curl:8.16.0 -- sh -eu -c "
        curl -fsS --get \
          'http://victoriametrics:8428/api/v1/query' \
          --data-urlencode 'query=llm_runtime_shared_smoke_total{project=\"llm-runtime\"}' \
          | grep -q llm_runtime_shared_smoke_total

        curl -fsS --get \
          'http://victorialogs:9428/select/logsql/query' \
          --data-urlencode 'query=_msg:llm-runtime-shared-backend-smoke' \
          | grep -q llm-runtime-shared-backend-smoke

        curl -fsS \
          'http://tempo:3200/api/traces/$TRACE_ID' \
          | grep -q llm-runtime-shared-backend-smoke
      "; then
    echo "llm-runtime -> local Alloy -> OCO shared backend smoke PASS"
    exit 0
  fi

  kubectl -n "$BACKEND_NS" delete pod "$QUERY" --ignore-not-found=true --wait=true >/dev/null 2>&1 || true
  sleep 5
done

echo "Shared observability smoke did not reach VictoriaMetrics/VictoriaLogs/Tempo" >&2
exit 1
