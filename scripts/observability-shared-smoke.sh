#!/usr/bin/env bash
set -euo pipefail

NS="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
BACKEND_NS="${OCO_BACKEND_NAMESPACE:-observability-backend}"
RUN_ID="$(date +%s)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
SENDER="llmrun-observability-smoke-sender-${RUN_ID//[^a-zA-Z0-9-]/-}"
QUERY="llmrun-observability-smoke-query-${RUN_ID//[^a-zA-Z0-9-]/-}"
TRACE_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
SPAN_ID="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
NOW_NS="$(date +%s)000000000"
LOG_MARKER="llm-runtime-shared-backend-smoke-${RUN_ID}"

cleanup() {
  kubectl -n "$NS" delete pod "$SENDER" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
  kubectl -n "$BACKEND_NS" delete pod "$QUERY" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "preflight: waiting for Alloy and OCO backends"
kubectl -n "$NS" rollout status daemonset/alloy --timeout=90s >/dev/null
for deployment in alloy victoriametrics victorialogs tempo; do
  kubectl -n "$BACKEND_NS" rollout status "deployment/$deployment" --timeout=120s >/dev/null
done
for service in alloy victoriametrics victorialogs tempo; do
  endpoint="$(kubectl -n "$BACKEND_NS" get endpoints "$service" -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null || true)"
  if [[ -z "$endpoint" ]]; then
    echo "FAIL: service/$service has no ready endpoint in namespace $BACKEND_NS" >&2
    exit 1
  fi
done

echo "send: metric/log/trace marker=$RUN_ID"
kubectl -n "$NS" run "$SENDER" --rm -i --restart=Never \
  --image=curlimages/curl:8.16.0 -- sh -eu -c "
  curl -fsS -o /dev/null -H 'Content-Type: application/json' \
    http://alloy:4318/v1/metrics \
    -d '{\"resourceMetrics\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"llm-runtime-smoke\"}}]},\"scopeMetrics\":[{\"scope\":{},\"metrics\":[{\"name\":\"llm_runtime_shared_smoke_total\",\"sum\":{\"aggregationTemporality\":2,\"isMonotonic\":true,\"dataPoints\":[{\"attributes\":[{\"key\":\"smoke_id\",\"value\":{\"stringValue\":\"$RUN_ID\"}}],\"asInt\":\"1\",\"timeUnixNano\":\"$NOW_NS\"}]}}]}]}]}]}'

  curl -fsS -o /dev/null -H 'Content-Type: application/json' \
    http://alloy:4318/v1/logs \
    -d '{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"llm-runtime-smoke\"}}]},\"scopeLogs\":[{\"scope\":{},\"logRecords\":[{\"timeUnixNano\":\"$NOW_NS\",\"severityText\":\"INFO\",\"body\":{\"stringValue\":\"$LOG_MARKER\"},\"traceId\":\"$TRACE_ID\",\"spanId\":\"$SPAN_ID\"}]}]}]}]}'

  curl -fsS -o /dev/null -H 'Content-Type: application/json' \
    http://alloy:4318/v1/traces \
    -d '{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"llm-runtime-smoke\"}}]},\"scopeSpans\":[{\"scope\":{},\"spans\":[{\"traceId\":\"$TRACE_ID\",\"spanId\":\"$SPAN_ID\",\"name\":\"$LOG_MARKER\",\"kind\":1,\"startTimeUnixNano\":\"$NOW_NS\",\"endTimeUnixNano\":\"$NOW_NS\"}]}]}]}]}'
"

echo "verify: waiting for this run only"
kubectl -n "$BACKEND_NS" run "$QUERY" --rm -i --restart=Never \
  --image=curlimages/curl:8.16.0 -- sh -eu -c "
  for attempt in \$(seq 1 12); do
    if ! metrics_code=\$(curl -sS -o /tmp/metrics -w '%{http_code}' --get \
      'http://victoriametrics:8428/api/v1/query' \
      --data-urlencode 'query=llm_runtime_shared_smoke_total{project=\"llm-runtime\",smoke_id=\"$RUN_ID\"}'); then
      echo 'FAIL: VictoriaMetrics transport error' >&2
      exit 2
    fi
    if [ \"\$metrics_code\" != 200 ]; then
      echo \"FAIL: VictoriaMetrics HTTP \$metrics_code\" >&2
      cat /tmp/metrics >&2
      exit 2
    fi

    if ! logs_code=\$(curl -sS -o /tmp/logs -w '%{http_code}' --get \
      'http://victorialogs:9428/select/logsql/query' \
      --data-urlencode 'query=_msg:$LOG_MARKER'); then
      echo 'FAIL: VictoriaLogs transport error' >&2
      exit 2
    fi
    if [ \"\$logs_code\" != 200 ]; then
      echo \"FAIL: VictoriaLogs HTTP \$logs_code\" >&2
      cat /tmp/logs >&2
      exit 2
    fi

    if ! trace_code=\$(curl -sS -o /tmp/trace -w '%{http_code}' \
      'http://tempo:3200/api/traces/$TRACE_ID'); then
      echo 'FAIL: Tempo transport error' >&2
      exit 2
    fi
    case \"\$trace_code\" in
      200|404) ;;
      *)
        echo \"FAIL: Tempo HTTP \$trace_code\" >&2
        cat /tmp/trace >&2
        exit 2
        ;;
    esac

    metrics=0
    logs=0
    traces=0
    grep -q 'llm_runtime_shared_smoke_total' /tmp/metrics && metrics=1 || true
    grep -q '$LOG_MARKER' /tmp/logs && logs=1 || true
    if [ \"\$trace_code\" = 200 ]; then
      grep -q '$LOG_MARKER' /tmp/trace && traces=1 || true
    fi

    echo \"attempt=\$attempt metrics=\$metrics logs=\$logs traces=\$traces\"
    if [ \"\$metrics\" = 1 ] && [ \"\$logs\" = 1 ] && [ \"\$traces\" = 1 ]; then
      exit 0
    fi
    sleep 5
  done

  echo 'FAIL: propagation timeout' >&2
  echo '--- VictoriaMetrics ---' >&2
  cat /tmp/metrics >&2
  echo >&2
  echo '--- VictoriaLogs ---' >&2
  cat /tmp/logs >&2
  echo >&2
  echo '--- Tempo ---' >&2
  cat /tmp/trace >&2
  echo >&2
  exit 1
"

echo "PASS: llm-runtime -> Alloy -> OCO metrics/logs/traces marker=$RUN_ID"
