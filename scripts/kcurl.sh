#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <namespace> <url> [curl-args...]" >&2
  exit 2
fi

namespace="$1"
url="$2"
shift 2

name="kcurl-$(date +%s)-$RANDOM"
image="${KCURL_IMAGE:-curlimages/curl:8.10.1}"

kubectl -n "${namespace}" run "${name}" \
  --rm \
  -i \
  --restart=Never \
  --image="${image}" \
  --quiet \
  --command -- \
  curl -fsS "${url}" "$@"
