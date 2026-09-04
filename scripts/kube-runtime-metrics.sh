#!/usr/bin/env bash
set -euo pipefail

tier="${1:?usage: $0 <small|medium|large>}"
namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
deployment="${LLM_GATEWAY_DEPLOYMENT:-llm-openai-api-gateway}"
url="http://llm-${tier}.llm-runtime.svc.cluster.local:8000/metrics"

kubectl -n "$namespace" exec "deployment/$deployment" -c gateway -- \
  env RUNTIME_METRICS_URL="$url" \
  node -e 'const u=process.env.RUNTIME_METRICS_URL; fetch(u).then(async r=>{const t=await r.text();process.stdout.write(t);if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})'
