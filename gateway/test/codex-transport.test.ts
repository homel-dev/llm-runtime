import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  buildContinuationRequest,
  CodexAuthStore,
  CodexTransport,
  extractChatGptAccountId,
  normalizeSessionId,
  type CodexTransportConfig,
} from "../src/codex-transport.js";

function jwt(accountId: string, expiresInSeconds = 3600): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })).toString("base64url");
  return `aaa.${payload}.bbb`;
}

function config(authFile: string, baseUrl = "https://chatgpt.com/backend-api"): CodexTransportConfig {
  return {
    listenHost: "127.0.0.1",
    listenPort: 10533,
    baseUrl,
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "client-test",
    authFile,
    models: ["gpt-5.6-sol"],
    maxBodyBytes: 1024 * 1024,
    requestTimeoutMs: 5000,
    websocketConnectTimeoutMs: 1000,
    sessionIdleMs: 60_000,
    sessionMaxAgeMs: 60_000,
  };
}

test("continuation strips the replayed prefix and keeps only the new delta", () => {
  const first = {
    model: "gpt-5.6-sol",
    store: false,
    stream: true,
    prompt_cache_key: "rr-test",
    input: [{ role: "user", content: [{ type: "input_text", text: "Use the tool" }] }],
  };
  const assistant = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}", status: "completed" };
  const second = {
    ...first,
    input: [
      ...first.input,
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "real result" },
    ],
  };
  const result = buildContinuationRequest(second, {
    lastRequestBody: first,
    lastResponseId: "resp_1",
    lastResponseItems: [assistant],
  });
  assert.equal(result.usedContinuation, true);
  assert.equal(result.body.previous_response_id, "resp_1");
  assert.deepEqual(result.body.input, [{ type: "function_call_output", call_id: "call_1", output: "real result" }]);

  const changedTools = buildContinuationRequest({ ...second, tools: [{ type: "function", name: "other" }] }, {
    lastRequestBody: first,
    lastResponseId: "resp_1",
    lastResponseItems: [assistant],
  });
  assert.equal(changedTools.usedContinuation, false);
});

test("session ids are header-safe and ChatGPT account id comes from the access token", () => {
  assert.equal(normalizeSessionId("rr-safe_1"), "rr-safe_1");
  assert.match(normalizeSessionId("unsafe session value")!, /^rr-[0-9a-f]{61}$/);
  assert.equal(extractChatGptAccountId(jwt("acc-test")), "acc-test");
});

test("auth store refreshes expired official Codex auth.json and persists rotated tokens atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-codex-auth-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: jwt("old", -60), refresh_token: "refresh-old", account_id: "old" },
  }));
  let refreshCalls = 0;
  const store = new CodexAuthStore(config(authFile), async (_url, init) => {
    refreshCalls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.grant_type, "refresh_token");
    assert.equal(body.refresh_token, "refresh-old");
    return new Response(JSON.stringify({ access_token: jwt("new"), refresh_token: "refresh-new" }), { status: 200 });
  });
  const credential = await store.credential();
  assert.equal(credential.accountId, "new");
  assert.equal(refreshCalls, 1);
  const persisted = JSON.parse(readFileSync(authFile, "utf8"));
  assert.equal(persisted.tokens.refresh_token, "refresh-new");
  assert.equal(persisted.tokens.account_id, "new");
});

test("transport reuses one Codex websocket and sends previous_response_id plus only the new input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-codex-transport-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ tokens: { access_token: jwt("acc-test"), refresh_token: "refresh", account_id: "acc-test" } }));

  const upstreamHttp = createHttpServer();
  const upstreamWs = new WebSocketServer({ server: upstreamHttp, path: "/backend-api/codex/responses" });
  upstreamHttp.listen(0, "127.0.0.1");
  await once(upstreamHttp, "listening");
  const upstreamPort = (upstreamHttp.address() as AddressInfo).port;

  const received: Record<string, unknown>[] = [];
  let connections = 0;
  let responseNumber = 0;
  upstreamWs.on("connection", (socket, request) => {
    connections++;
    assert.equal(request.headers["chatgpt-account-id"], "acc-test");
    assert.equal(request.headers["openai-beta"], "responses_websockets=2026-02-06");
    socket.on("message", (raw) => {
      const requestBody = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(requestBody);
      responseNumber++;
      const item = {
        type: "message",
        id: `msg_${responseNumber}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: `answer-${responseNumber}`, annotations: [] }],
      };
      socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
      socket.send(JSON.stringify({
        type: "response.completed",
        response: {
          id: `resp_${responseNumber}`,
          status: "completed",
          output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }));
    });
  });

  const transport = new CodexTransport(config(authFile, `http://127.0.0.1:${upstreamPort}/backend-api`), async () => {
    throw new Error("SSE fallback was not expected");
  });
  const server = transport.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text;
  };

  try {
    const user = { role: "user", content: [{ type: "input_text", text: "first" }] };
    await post({ model: "gpt-5.6-sol", stream: true, store: false, prompt_cache_key: "rr-session", input: [user] });
    const firstAssistant = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "answer-1", annotations: [] }],
    };
    const nextUser = { role: "user", content: [{ type: "input_text", text: "second" }] };
    await post({
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      prompt_cache_key: "rr-session",
      input: [user, firstAssistant, nextUser],
    });

    assert.equal(connections, 1);
    assert.equal(received.length, 2);
    assert.equal(received[0]!.previous_response_id, undefined);
    assert.equal(received[1]!.previous_response_id, "resp_1");
    assert.deepEqual(received[1]!.input, [nextUser]);
    const stats = transport.getStats();
    assert.equal(stats.fullRequests, 1);
    assert.equal(stats.deltaRequests, 1);
    assert.equal(stats.websocketConnections, 1);
    assert.equal(stats.websocketReuses, 1);
    assert.ok(stats.lastUpstreamRequestBytes < stats.lastFullRequestBytes);
  } finally {
    server.close();
    transport.close();
    upstreamWs.close();
    upstreamHttp.close();
  }
});
