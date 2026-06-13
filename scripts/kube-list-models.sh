#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <small|medium|large>" >&2
  exit 2
fi

tier="$1"
./scripts/kcurl.sh llm-runtime "http://llm-${tier}:8000/v1/models" | jq .
