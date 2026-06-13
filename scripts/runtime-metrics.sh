#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-}"

if [[ -z "${base_url}" ]]; then
  echo "usage: $0 <base-url>" >&2
  echo "example: $0 http://localhost:8001" >&2
  exit 2
fi

metrics_url="${base_url%/}/metrics"

echo "checking ${metrics_url}"

payload="$(curl -fsS "${metrics_url}")"

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
