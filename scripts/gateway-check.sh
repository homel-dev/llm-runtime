#!/usr/bin/env bash
set -Eeuo pipefail

namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
deployment="${LLM_GATEWAY_DEPLOYMENT:-llm-openai-api-gateway}"
selector="${1:-all}"
timeout_ms="${LLM_GATEWAY_CHECK_TIMEOUT_MS:-210000}"

if ! [[ "$timeout_ms" =~ ^[1-9][0-9]*$ ]]; then
  echo "LLM_GATEWAY_CHECK_TIMEOUT_MS must be a positive integer" >&2
  exit 2
fi

case "$selector" in
  all)
    owner=""
    ;;
  openai)
    owner="llm-runtime-subscription"
    ;;
  gemini)
    owner="llm-runtime-gemini-subscription"
    ;;
  api)
    owner="llm-runtime-api"
    ;;
  *)
    echo "usage: $0 [all|openai|gemini|api]" >&2
    exit 2
    ;;
esac

kubectl -n "$namespace" exec -i "deployment/$deployment" -c gateway -- \
  env GATEWAY_CHECK_SELECTOR="$selector" GATEWAY_CHECK_OWNER="$owner" GATEWAY_CHECK_TIMEOUT_MS="$timeout_ms" \
  node --input-type=module <<'NODE'
const baseUrl = "http://127.0.0.1:8000";
const selector = process.env.GATEWAY_CHECK_SELECTOR ?? "all";
const ownerFilter = process.env.GATEWAY_CHECK_OWNER ?? "";
const timeoutMs = Number(process.env.GATEWAY_CHECK_TIMEOUT_MS ?? "210000");

function backendName(owner) {
  return owner.startsWith("llm-runtime-") ? owner.slice("llm-runtime-".length) : owner;
}

function snippet(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 600 ? `${normalized.slice(0, 600)}...` : normalized;
}

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let modelsResponse;
try {
  modelsResponse = await request(`${baseUrl}/v1/models`);
} catch (error) {
  console.error(`[FAIL] gateway router is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const modelsText = await modelsResponse.text();
if (!modelsResponse.ok) {
  console.error(`[FAIL] /v1/models HTTP ${modelsResponse.status}: ${snippet(modelsText)}`);
  process.exit(1);
}

let modelsBody;
try {
  modelsBody = JSON.parse(modelsText);
} catch {
  console.error(`[FAIL] /v1/models returned non-JSON: ${snippet(modelsText)}`);
  process.exit(1);
}

if (!Array.isArray(modelsBody?.data)) {
  console.error("[FAIL] /v1/models response has no data array");
  process.exit(1);
}

const advertised = modelsBody.data
  .filter((entry) => entry && typeof entry.id === "string" && typeof entry.owned_by === "string")
  .filter((entry) => !ownerFilter || entry.owned_by === ownerFilter);

if (advertised.length === 0) {
  console.error(`[FAIL] no advertised models found for selector=${selector}`);
  process.exit(1);
}

const failures = [];
for (const entry of advertised) {
  const backend = backendName(entry.owned_by);
  process.stdout.write(`[CHECK] backend=${backend} model=${entry.id}\n`);
  let response;
  try {
    response = await request(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: entry.id,
        messages: [{ role: "user", content: "Reply with a short acknowledgement." }],
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${backend}/${entry.id}: transport error: ${message}`);
    console.error(`[FAIL] backend=${backend} model=${entry.id} transport=${message}`);
    continue;
  }

  const text = await response.text();
  if (!response.ok) {
    const message = `HTTP ${response.status}: ${snippet(text)}`;
    failures.push(`${backend}/${entry.id}: ${message}`);
    console.error(`[FAIL] backend=${backend} model=${entry.id} ${message}`);
    continue;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    const message = `non-JSON response: ${snippet(text)}`;
    failures.push(`${backend}/${entry.id}: ${message}`);
    console.error(`[FAIL] backend=${backend} model=${entry.id} ${message}`);
    continue;
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    const message = `missing non-empty choices[0].message.content: ${snippet(text)}`;
    failures.push(`${backend}/${entry.id}: ${message}`);
    console.error(`[FAIL] backend=${backend} model=${entry.id} ${message}`);
    continue;
  }

  const usage = body?.usage;
  const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const tokenText = outputTokens === undefined ? "unknown" : String(outputTokens);
  console.log(`[PASS] backend=${backend} model=${entry.id} completion_tokens=${tokenText}`);
}

if (failures.length > 0) {
  console.error(`\n[FAIL] gateway check failed: ${failures.length}/${advertised.length} advertised model(s) failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\n[PASS] gateway check passed: ${advertised.length}/${advertised.length} advertised model(s), selector=${selector}`);
NODE
