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

kubectl exec -it -n "$namespace" "$pod" -- \
  node /app/dist/src/run-antigravity-login.js
