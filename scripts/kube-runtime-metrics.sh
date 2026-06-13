#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <small|medium|large>" >&2
  exit 2
fi

tier="$1"
metrics_url="http://llm-${tier}:8000/metrics"

echo "checking ${metrics_url}"

payload="$(./scripts/kcurl.sh llm-runtime "${metrics_url}")"

if [[ -z "${payload}" ]]; then
  echo "metrics endpoint returned an empty response" >&2
  exit 1
fi

if ! grep -Eq '(^# HELP |^vllm[:_]|^process_|^python_)' <<<"${payload}"; then
  echo "metrics endpoint responded, but no recognizable Prometheus/vLLM metrics were found" >&2
  exit 1
fi

printf '%s\n' "${payload}" \
  | awk '/^# HELP / { print $3 } /^[a-zA-Z_:][a-zA-Z0-9_:]*/ { print $1 }' \
  | sed 's/{.*//' \
  | sort -u \
  | head -100
