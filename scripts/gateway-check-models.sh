#!/usr/bin/env bash
set -Eeuo pipefail

selector="${1:-all}"
mode="${2:-check}"
case "$mode" in check|list) ;; *) echo "usage: $0 <all|openai|gemini|local|small|medium|large|api|model:ID> [check|list]" >&2; exit 2;; esac
namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
deployment="${LLM_GATEWAY_DEPLOYMENT:-llm-openai-api-gateway}"

kubectl -n "$namespace" exec -i "deployment/$deployment" -c gateway -- \
  env GATEWAY_CHECK_SELECTOR="$selector" GATEWAY_CHECK_MODE="$mode" \
  node --input-type=module <<'NODE'
const selector = process.env.GATEWAY_CHECK_SELECTOR ?? "all";
const mode = process.env.GATEWAY_CHECK_MODE ?? "check";
const base = "http://127.0.0.1:8000";

function selected(entry) {
  const owner = String(entry.owned_by ?? "");
  if (selector === "all") return true;
  if (selector === "openai") return owner === "llm-runtime-subscription";
  if (selector === "gemini") return owner === "llm-runtime-gemini-subscription";
  if (selector === "api") return owner === "llm-runtime-api";
  if (selector === "local") return owner.startsWith("llm-runtime-local-");
  if (["small", "medium", "large"].includes(selector)) return owner === `llm-runtime-local-${selector}`;
  if (selector.startsWith("model:")) return entry.id === selector.slice("model:".length);
  throw new Error(`unsupported gateway check selector '${selector}'`);
}

const discovery = await fetch(`${base}/v1/models`);
const discoveryText = await discovery.text();
if (!discovery.ok) {
  console.error(`[FAIL] gateway model discovery HTTP ${discovery.status}: ${discoveryText}`);
  process.exit(1);
}
let listed;
try { listed = JSON.parse(discoveryText)?.data; }
catch { console.error(`[FAIL] gateway /v1/models returned non-JSON: ${discoveryText}`); process.exit(1); }
if (!Array.isArray(listed)) { console.error("[FAIL] gateway /v1/models has no data[]"); process.exit(1); }
const models = listed.filter(selected);
if (!models.length) { console.error(`[FAIL] no advertised models matched selector '${selector}'`); process.exit(1); }
if (mode === "list") {
  console.log(JSON.stringify({ object: "list", data: models }, null, 2));
  process.exit(0);
}

const failures = [];
for (const entry of models) {
  const backend = String(entry.owned_by ?? "").replace(/^llm-runtime-/, "");
  const model = String(entry.id);
  console.log(`[CHECK] backend=${backend} model=${model}`);
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one short acknowledgement sentence." }],
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    let body;
    try { body = JSON.parse(text); }
    catch { throw new Error(`non-JSON response: ${text}`); }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error(`response has no non-empty choices[0].message.content: ${text}`);
    const completion = body?.usage?.completion_tokens ?? body?.usage?.output_tokens;
    console.log(`[PASS] backend=${backend} model=${model}${Number.isFinite(completion) ? ` completion_tokens=${completion}` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${backend}/${model}: ${message}`);
    console.error(`[FAIL] backend=${backend} model=${model} ${message}`);
  }
}

if (failures.length) {
  console.error(`\n[FAIL] gateway check failed: ${failures.length}/${models.length} advertised model(s) failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\n[PASS] gateway check passed: ${models.length}/${models.length} advertised model(s)`);
NODE
