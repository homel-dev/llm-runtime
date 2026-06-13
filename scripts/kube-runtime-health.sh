#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <small|medium|large>" >&2
  exit 2
fi

tier="$1"

echo "== llm-${tier} /v1/models =="
./scripts/kcurl.sh llm-runtime "http://llm-${tier}:8000/v1/models" | jq .

echo
echo "== Health Check Passed =="
