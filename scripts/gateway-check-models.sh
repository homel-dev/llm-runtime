#!/usr/bin/env bash
set -Eeuo pipefail

selector="${1:-all}"
mode="${2:-check}"
case "$mode" in check|list) ;; *) echo "usage: $0 <all|openai|gemini|local|small|medium|large|api|model:ID> [check|list]" >&2; exit 2;; esac
namespace="${LLM_RUNTIME_NAMESPACE:-llm-runtime}"
deployment="${LLM_GATEWAY_DEPLOYMENT:-llm-openai-api-gateway}"
timeout_ms="${LLM_GATEWAY_CHECK_TIMEOUT_MS:-210000}"
if ! [[ "$timeout_ms" =~ ^[1-9][0-9]*$ ]]; then
  echo "LLM_GATEWAY_CHECK_TIMEOUT_MS must be a positive integer" >&2
  exit 2
fi

kubectl -n "$namespace" exec -i "deployment/$deployment" -c gateway -- \
  env GATEWAY_CHECK_SELECTOR="$selector" GATEWAY_CHECK_MODE="$mode" GATEWAY_CHECK_TIMEOUT_MS="$timeout_ms" \
  node --input-type=module <<'NODE'
const selector = process.env.GATEWAY_CHECK_SELECTOR ?? "all";
const mode = process.env.GATEWAY_CHECK_MODE ?? "check";
const base = "http://127.0.0.1:8000";
const timeoutMs = Number(process.env.GATEWAY_CHECK_TIMEOUT_MS ?? "210000");

// Every probe is time-bounded across BOTH the fetch and the body read: fetch()
// resolves on headers, so a passthrough backend that streams a few bytes and then
// never ends its SSE body would otherwise hang `task gateway:check` forever. The
// AbortController stays armed until the body is fully read.
async function requestText(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

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

const { response: discovery, text: discoveryText } = await requestText(`${base}/v1/models`);
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

  // The ChatGPT subscription backend is Responses-only. Its health probe also
  // verifies that the second logical turn is sent upstream as a Codex
  // previous_response_id delta rather than replaying the full client context.
  if (backend === "subscription") {
    try {
      const codexPort = process.env.GATEWAY_SUBSCRIPTION_PORT ?? "10533";
      const statsUrl = `http://127.0.0.1:${codexPort}/debug/stats`;
      const readStats = async () => {
        const { response, text } = await requestText(statsUrl);
        if (!response.ok) throw new Error(`Codex transport stats HTTP ${response.status}: ${text}`);
        return JSON.parse(text);
      };
      const parseResponsesSse = (text) => {
        const output = [];
        let terminal;
        for (const line of text.split("\n")) {
          const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
          if (!normalized.startsWith("data:")) continue;
          const raw = normalized.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let event;
          try { event = JSON.parse(raw); }
          catch { throw new Error(`Responses stream emitted non-JSON data event: ${raw}`); }
          if (event?.type === "response.output_item.done" && event.item) output.push(event.item);
          if (["response.completed", "response.done", "response.incomplete"].includes(event?.type)) {
            terminal = event.response;
            if (Array.isArray(event?.response?.output) && event.response.output.length) {
              output.splice(0, output.length, ...event.response.output);
            }
          }
        }
        if (!terminal) throw new Error("Responses stream has no terminal response event");
        return { terminal, output };
      };
      const postResponses = async (input, promptCacheKey) => {
        const { response, text } = await requestText(`${base}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            input,
            stream: true,
            store: false,
            prompt_cache_key: promptCacheKey,
            max_output_tokens: 1024,
          }),
        });
        if (!response.ok) throw new Error(`Responses HTTP ${response.status}: ${text}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) throw new Error(`Responses expected text/event-stream, got ${contentType || "unset"}`);
        return parseResponsesSse(text);
      };

      const before = await readStats();
      const promptCacheKey = `gwcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const firstInput = [{ role: "user", content: [{ type: "input_text", text: "Reply exactly with OK." }] }];
      const first = await postResponses(firstInput, promptCacheKey);
      if (first.terminal?.status && first.terminal.status !== "completed") {
        throw new Error(`first Responses turn did not complete: ${first.terminal.status}`);
      }
      if (!first.output.length) throw new Error("first Responses turn exposed no replayable output items");

      const secondUser = { role: "user", content: [{ type: "input_text", text: "Reply exactly with OK again." }] };
      const second = await postResponses([...firstInput, ...first.output, secondUser], promptCacheKey);
      if (second.terminal?.status && second.terminal.status !== "completed") {
        throw new Error(`second Responses turn did not complete: ${second.terminal.status}`);
      }
      const after = await readStats();
      if (!Number.isFinite(after?.deltaRequests) || after.deltaRequests <= Number(before?.deltaRequests ?? 0)) {
        throw new Error(`Codex transport did not record a delta continuation: before=${before?.deltaRequests} after=${after?.deltaRequests}`);
      }
      if (!Number.isFinite(after?.lastFullRequestBytes) || !Number.isFinite(after?.lastUpstreamRequestBytes) ||
          after.lastUpstreamRequestBytes >= after.lastFullRequestBytes) {
        throw new Error(`Codex delta did not reduce upstream bytes: full=${after?.lastFullRequestBytes} upstream=${after?.lastUpstreamRequestBytes}`);
      }
      console.log(`[PASS] backend=${backend} model=${model} responses_delta upstream_bytes=${after.lastUpstreamRequestBytes} full_bytes=${after.lastFullRequestBytes}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${backend}/${model} (responses continuation): ${message}`);
      console.error(`[FAIL] backend=${backend} model=${model} (responses continuation) ${message}`);
    }
    continue;
  }
  try {
    const { response, text } = await requestText(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with one short acknowledgement sentence." }],
      }),
    });
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

  // Streaming probe. All backends must produce a real functional stream (valid
  // SSE, actual assistant content, terminal [DONE]). Subscription additionally
  // must carry the terminal choices:[] usage chunk immediately before [DONE] —
  // the enforcement invariant. Gemini direct transport is checked like every
  // other functional SSE backend.
  const requireUsage = backend === "subscription";
  try {
    const streamBody = {
      model,
      messages: [{ role: "user", content: "Reply with one short acknowledgement sentence." }],
      stream: true,
      ...(requireUsage ? { max_completion_tokens: 1024 } : {}),
    };
    const { response: streamResponse, text: streamText } = await requestText(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(streamBody),
    });
    if (!streamResponse.ok) throw new Error(`stream HTTP ${streamResponse.status}: ${streamText}`);
    const contentType = streamResponse.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) throw new Error(`stream expected text/event-stream, got ${contentType || "unset"}`);
    const events = streamText.split("\n")
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
      .filter((l) => l.startsWith("data:"))
      .map((l) => { const v = l.slice(5); return v.startsWith(" ") ? v.slice(1) : v; });
    if (!events.length) throw new Error("stream produced no data events");
    if (events[events.length - 1] !== "[DONE]") throw new Error("stream did not terminate with [DONE]");
    const dataEvents = events.slice(0, -1);
    if (!dataEvents.length) throw new Error("stream produced no non-terminal data events");
    let streamedContent = "";
    for (const payload of dataEvents) {
      let chunk;
      try { chunk = JSON.parse(payload); }
      catch { throw new Error(`stream emitted non-JSON data event: ${payload}`); }
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") streamedContent += delta;
    }
    if (!streamedContent.trim()) throw new Error("stream produced no assistant content");
    if (requireUsage) {
      const terminal = JSON.parse(dataEvents[dataEvents.length - 1]);
      const completion = terminal?.usage?.completion_tokens;
      if (!Array.isArray(terminal?.choices) || terminal.choices.length !== 0 || !Number.isFinite(completion)) {
        throw new Error("stream has no terminal choices:[] usage chunk immediately before [DONE]");
      }
      console.log(`[PASS] backend=${backend} model=${model} stream completion_tokens=${completion}`);
    } else {
      console.log(`[PASS] backend=${backend} model=${model} stream content_chars=${streamedContent.trim().length}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${backend}/${model} (stream): ${message}`);
    console.error(`[FAIL] backend=${backend} model=${model} (stream) ${message}`);
  }
}

if (failures.length) {
  console.error(`\n[FAIL] gateway check failed: ${failures.length}/${models.length} advertised model(s) failed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\n[PASS] gateway check passed: ${models.length}/${models.length} advertised model(s)`);
NODE
