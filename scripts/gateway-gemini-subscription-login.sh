#!/usr/bin/env bash
set -Eeuo pipefail

namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
image="${LLM_GATEWAY_IMAGE:-ghcr.io/homel-dev/llm-runtime-gateway:main}"
pod="llm-gemini-subscription-login"
pvc_manifest="k8s/gateway/gemini-subscription-auth-pvc.yml"
pod_manifest="k8s/gateway/gemini-subscription-login-pod.yml"

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

echo 'Antigravity will print the remote OAuth URL/code flow. Complete it with the Google AI subscription account, then exit the TUI.'
kubectl exec -it -n "$namespace" "$pod" -- \
  env SSH_CONNECTION='127.0.0.1 1 127.0.0.1 1' agy

echo 'Verifying persisted account authentication in Antigravity headless mode...'
kubectl exec -n "$namespace" "$pod" -- \
  agy -p 'Reply with exactly: LLM_RUNTIME_GEMINI_AUTH_OK' --model gemini-3.1-pro-high --output-format json \
  | tee /tmp/llm-runtime-gemini-auth-check.json \
  | jq -e '.status == "SUCCESS" and ((.response // "") | contains("LLM_RUNTIME_GEMINI_AUTH_OK"))' >/dev/null
