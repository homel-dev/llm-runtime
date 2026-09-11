import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexCacheAffinityFetch } from "../src/codex-cache-affinity.js";

function recorder() {
  let seen: { url: string; headers: Headers; body: BodyInit | null | undefined } | undefined;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    seen = {
      url: input instanceof Request ? input.url : input instanceof URL ? input.toString() : String(input),
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, seen: () => seen };
}

test("Codex Responses derives session-id from prompt_cache_key", async () => {
  const rec = recorder();
  const wrapped = createCodexCacheAffinityFetch(rec.fetchImpl);
  await wrapped("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", prompt_cache_key: "rr-stable-cache-key" }),
  });
  assert.equal(rec.seen()?.headers.get("session-id"), "rr-stable-cache-key");
});

test("Codex Responses preserves an explicit session-id", async () => {
  const rec = recorder();
  const wrapped = createCodexCacheAffinityFetch(rec.fetchImpl);
  await wrapped("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "session-id": "explicit-session" },
    body: JSON.stringify({ prompt_cache_key: "rr-stable-cache-key" }),
  });
  assert.equal(rec.seen()?.headers.get("session-id"), "explicit-session");
});

test("non-Codex traffic is unchanged", async () => {
  const rec = recorder();
  const wrapped = createCodexCacheAffinityFetch(rec.fetchImpl);
  await wrapped("https://example.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt_cache_key: "rr-stable-cache-key" }),
  });
  assert.equal(rec.seen()?.headers.has("session-id"), false);
});
