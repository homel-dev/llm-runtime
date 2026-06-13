#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <small|medium|large>" >&2
  exit 2
fi

tier="$1"
base_url="http://llm-${tier}:8000"

model="$(
  ./scripts/kcurl.sh llm-runtime "${base_url}/v1/models" \
    | jq -r '.data[0].id'
)"

./scripts/kcurl.sh llm-runtime "${base_url}/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\": \"${model}\",
    \"messages\": [
      {
        \"role\": \"user\",
        \"content\": \"Return exactly: ok\"
      }
    ],
    \"temperature\": 0
  }" \
| jq .
