#!/usr/bin/env bash
set -euo pipefail

namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
deployment="${LLM_GATEWAY_DEPLOYMENT:-llm-openai-api-gateway}"
model="${LLM_GATEWAY_GEMINI_MODEL:-gemini-subscription-pro}"
marker="LLM_RUNTIME_GEMINI_SUBSCRIPTION_OK"

kubectl -n "$namespace" exec -i "deployment/$deployment" -c gateway -- \
  env GEMINI_SMOKE_MODEL="$model" GEMINI_SMOKE_MARKER="$marker" \
  node --input-type=module <<'NODE'
const model = process.env.GEMINI_SMOKE_MODEL;
const marker = process.env.GEMINI_SMOKE_MARKER;
const response = await fetch("http://127.0.0.1:8000/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: `Reply with exactly: ${marker}` }],
    max_completion_tokens: 64,
  }),
});
const text = await response.text();
if (!response.ok) {
  console.error(`gateway Gemini smoke failed: HTTP ${response.status}: ${text}`);
  process.exit(1);
}
let body;
try { body = JSON.parse(text); }
catch { console.error(`gateway returned non-JSON: ${text}`); process.exit(1); }
const content = body?.choices?.[0]?.message?.content;
if (typeof content !== "string" || !content.includes(marker)) {
  console.error(`unexpected Gemini response: ${text}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, model, content }));
NODE
