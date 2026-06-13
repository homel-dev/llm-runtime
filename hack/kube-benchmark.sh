#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <small|medium|large>" >&2
  exit 2
fi

tier="$1"
base_url="http://llm-${tier}:8000"
requests="${REQUESTS:-10}"

model="$(
  ./scripts/kcurl.sh llm-runtime "${base_url}/v1/models" \
    | jq -r '.data[0].id'
)"

echo "Endpoint: ${base_url}"
echo "Model: ${model}"
echo "Requests: ${requests}"
echo

for i in $(seq 1 "${requests}"); do
  start_ns="$(date +%s%N)"

  ./scripts/kcurl.sh llm-runtime "${base_url}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{
      \"model\": \"${model}\",
      \"messages\": [
        {
          \"role\": \"user\",
          \"content\": \"Return exactly: benchmark-ok\"
        }
      ],
      \"temperature\": 0
    }" \
    > /dev/null

  end_ns="$(date +%s%N)"
  duration_ms="$(( (end_ns - start_ns) / 1000000 ))"

  echo "request=${i} duration_ms=${duration_ms}"
done
