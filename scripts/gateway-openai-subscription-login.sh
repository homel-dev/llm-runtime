#!/usr/bin/env bash
set -Eeuo pipefail

namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
image="${LLM_GATEWAY_IMAGE:-ghcr.io/homel-dev/llm-runtime-gateway:main}"
pod="llm-openai-subscription-login"
pvc_manifest="k8s/gateway/openai-subscription-auth-pvc.yml"
pod_manifest="k8s/gateway/openai-subscription-login-pod.yml"
codex_version="${CODEX_LOGIN_VERSION:-0.149.1}"

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  kubectl delete pod -n "$namespace" "$pod" --ignore-not-found=true >/dev/null 2>&1 || true
  return "$rc"
}

on_signal() {
  local code="$1"
  cleanup || true
  exit "$code"
}

trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

kubectl apply -f "$pvc_manifest"
kubectl delete pod -n "$namespace" "$pod" --ignore-not-found=true
sed "s#image: llm-runtime-gateway:dev#image: ${image}#g" "$pod_manifest" | kubectl apply -f -
kubectl wait -n "$namespace" --for=condition=Ready "pod/$pod" --timeout=120s

echo 'Starting headless ChatGPT/Codex device-code authentication.'
echo 'Open the URL printed below on the laptop and enter the one-time code. No localhost callback or browser on srv100 is required.'
kubectl exec -it -n "$namespace" "$pod" -- \
  npx --yes "@openai/codex@${codex_version}" login --device-auth

kubectl exec -n "$namespace" "$pod" -- test -s /auth/auth.json
kubectl exec -n "$namespace" "$pod" -- \
  npx --yes "@openai/codex@${codex_version}" login status
