#!/usr/bin/env bash
set -euo pipefail

tier="${1:?usage: $0 <small|medium|large>}"
namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
deployment="${LLM_GATEWAY_DEPLOYMENT:-llm-openai-api-gateway}"
requests="${REQUESTS:-10}"

kubectl -n "$namespace" exec -i "deployment/$deployment" -c gateway -- \
  env BENCHMARK_MODEL="llm-${tier}" BENCHMARK_REQUESTS="$requests" \
  node --input-type=module <<'NODE'
const model = process.env.BENCHMARK_MODEL;
const count = Number(process.env.BENCHMARK_REQUESTS ?? "10");
const base = "http://127.0.0.1:8000";
const modelsRes = await fetch(`${base}/v1/models`);
const modelsText = await modelsRes.text();
if (!modelsRes.ok) throw new Error(`model discovery HTTP ${modelsRes.status}: ${modelsText}`);
const models = JSON.parse(modelsText).data ?? [];
if (!models.some((entry) => entry.id === model)) throw new Error(`gateway does not advertise ${model}`);
console.log(`Endpoint: ${base}`);
console.log(`Model: ${model}`);
console.log(`Requests: ${count}\n`);
for (let i = 1; i <= count; i += 1) {
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with one short acknowledgement sentence." }], temperature: 0 }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${model} benchmark HTTP ${response.status}: ${text}`);
  const body = JSON.parse(text);
  if (typeof body?.choices?.[0]?.message?.content !== "string" || !body.choices[0].message.content.trim()) throw new Error(`${model} benchmark returned no assistant content`);
  console.log(`request=${i} duration_ms=${Math.round(performance.now() - started)}`);
}
NODE
