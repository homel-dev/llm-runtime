#!/usr/bin/env bash
set -euo pipefail

namespace="${OMNIROUTE_NAMESPACE:-llm-runtime}"

kubectl -n "$namespace" get deployment/omniroute >/dev/null
kubectl -n "$namespace" get secret/omniroute-operator-token >/dev/null
kubectl -n "$namespace" get secret/rr-zai-coding >/dev/null

token="$(kubectl -n "$namespace" get secret omniroute-operator-token -o jsonpath='{.data.token}' | base64 -d)"
glm_key_b64="$(kubectl -n "$namespace" get secret rr-zai-coding -o jsonpath='{.data.api-key}')"

if [[ -z "$token" ]]; then
  echo "OmniRoute operator token is empty; run: task omniroute:operator-token" >&2
  exit 2
fi
if [[ -z "$glm_key_b64" ]]; then
  echo "rr-zai-coding/api-key is empty; run: task gateway:zai:secret" >&2
  exit 2
fi

kubectl -n "$namespace" exec -i deployment/omniroute -c omniroute -- \
  env OR_TOKEN="$token" GLM_API_KEY_B64="$glm_key_b64" node --input-type=module \
  < "$(dirname "$0")/omniroute-configure-runtime.mjs"
