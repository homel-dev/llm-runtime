# hack/benchmark.sh
#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${1:?base url required}"
REQUESTS="${REQUESTS:-10}"

MODEL="$(
  curl \
    --fail \
    --silent \
    --show-error \
    "${BASE_URL}/v1/models" \
  | jq -r '.data[0].id'
)"

echo "Endpoint: ${BASE_URL}"
echo "Model: ${MODEL}"
echo "Requests: ${REQUESTS}"
echo

for i in $(seq 1 "${REQUESTS}"); do

  START_NS="$(date +%s%N)"

  curl \
    --fail \
    --silent \
    --show-error \
    "${BASE_URL}/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{
      \"model\": \"${MODEL}\",
      \"messages\": [
        {
          \"role\": \"user\",
          \"content\": \"Return exactly: benchmark-ok\"
        }
      ],
      \"temperature\": 0
    }" \
    > /dev/null

  END_NS="$(date +%s%N)"

  DURATION_MS="$(( (END_NS - START_NS) / 1000000 ))"

  echo "request=${i} duration_ms=${DURATION_MS}"

done
