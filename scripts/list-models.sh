# scripts/list-models.sh
#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${1:-http://localhost:8000}"

curl \
  --fail \
  --silent \
  --show-error \
  "${BASE_URL}/v1/models" \
| jq .
