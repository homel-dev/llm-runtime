#!/usr/bin/env bash
set +x
set -euo pipefail

# Input environment variables: ZAI_API_KEY, OPENCODE_API_KEY.
# Optional overrides:
NAMESPACE="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
ZAI_SECRET_NAME="${ZAI_SECRET_NAME:-rr-zai-coding}"
OPENCODE_SECRET_NAME="${OPENCODE_SECRET_NAME:-rr-opencode-zen}"
KUBECTL="${KUBECTL:-kubectl}"

# Validate both inputs before changing anything in Kubernetes.
if [[ -z "${ZAI_API_KEY:-}" || -z "${OPENCODE_API_KEY:-}" ]]; then
  printf '%s\n' 'ERROR: export both ZAI_API_KEY and OPENCODE_API_KEY before running this script.' >&2
  exit 2
fi

command -v "$KUBECTL" >/dev/null 2>&1 || {
  printf 'ERROR: kubectl executable not found: %s\n' "$KUBECTL" >&2
  exit 127
}

"$KUBECTL" get namespace "$NAMESPACE" -o name >/dev/null
printf 'Context: %s; namespace: %s\n' "$("$KUBECTL" config current-context)" "$NAMESPACE"

apply_api_key_secret() {
  local name="$1" value="$2"
  # --from-file reads the value via stdin instead of exposing it in process args.
  # All three commands participate in pipefail; an unsuccessful write fails the script.
  printf '%s' "$value" \
    | "$KUBECTL" -n "$NAMESPACE" create secret generic "$name" \
        --from-file=api-key=/dev/stdin --dry-run=client -o yaml \
    | "$KUBECTL" -n "$NAMESPACE" apply -f - >/dev/null
  printf 'Applied secret/%s (key: api-key)\n' "$name"
}

apply_api_key_secret "$ZAI_SECRET_NAME" "$ZAI_API_KEY"
apply_api_key_secret "$OPENCODE_SECRET_NAME" "$OPENCODE_API_KEY"
printf '%s\n' 'OmniRoute provider Secrets are ready.'

