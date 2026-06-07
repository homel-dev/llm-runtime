# scripts/smoke-chat.sh
#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${1:-http://localhost:8000}"

MODEL="$(
  curl \
    --fail \
    --silent \
    --show-error \
    "${BASE_URL}/v1/models" \
  | jq -r '.data[0].id'
)"

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
        \"content\": \"Return exactly: ok\"
      }
    ],
    \"temperature\": 0
  }" \
| jq .
