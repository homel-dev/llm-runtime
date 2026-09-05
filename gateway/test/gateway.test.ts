import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  createGateway, createGatewayMetricsServer, GatewayMetrics, loadGatewayConfigFromEnv, sanitizeRequestHeaders, applyBodyPolicy, backendForModel,
  type GatewayBackend, type GatewayConfig, type UpstreamRequester,
} from "../src/openai-gateway.js";
import {
  createAntigravityAdapter, loadAntigravityAdapterConfigFromEnv, runAntigravityCli,
  type AntigravityAdapterConfig, type AntigravityCliInvocation, type AntigravityCliResult, type AntigravityCliRunner,
} from "../src/antigravity-adapter.js";

const apiBackend: GatewayBackend = {
  id: "api", protocol: "https", host: "api.openai.com", port: 443,
  models: ["gpt-api"], apiKey: "sk-secret",
};
const subscriptionBackend: GatewayBackend = {
  id: "subscription", protocol: "http", host: "127.0.0.1", port: 10531,
  models: ["gpt-sub"],
};
const geminiBackend: GatewayBackend = {
  id: "gemini-subscription", protocol: "http", host: "127.0.0.1", port: 10532,
  models: ["gemini-subscription-pro"],
};
const base: GatewayConfig = {
  listenPort: 0, metricsPort: 0, maxBodyBytes: 1024, upstreamTimeoutMs: 1000,
  allowedEndpoints: ["/v1/chat/completions", "/v1/responses", "/v1/models"],
  maxOutputTokens: 4096, backends: [apiBackend, subscriptionBackend, geminiBackend],
};

test("config permits subscription-only operation and validates backend boundaries", () => {
  const subOnly = loadGatewayConfigFromEnv({ GATEWAY_SUBSCRIPTION_MODELS: "gpt-5.6-sol" });
  assert.equal(subOnly.backends.length, 1);
  assert.equal(subOnly.backends[0]!.id, "subscription");
  assert.equal(subOnly.metricsPort, 9091);
  assert.throws(() => loadGatewayConfigFromEnv({ GATEWAY_SUBSCRIPTION_MODELS: "gpt-sub", GATEWAY_LISTEN_PORT: "8000", GATEWAY_METRICS_PORT: "8000" }), /must differ/);
  assert.throws(() => loadGatewayConfigFromEnv({}), /at least one gateway backend/);
  assert.throws(() => loadGatewayConfigFromEnv({ GATEWAY_API_MODELS: "gpt-api" }), /GATEWAY_UPSTREAM_API_KEY is required/);
  assert.throws(() => loadGatewayConfigFromEnv({ GATEWAY_SUBSCRIPTION_MODELS: "gpt-sub", GATEWAY_SUBSCRIPTION_HOST: "oauth.example.com" }), /must be loopback/);
  assert.throws(() => loadGatewayConfigFromEnv({ GATEWAY_UPSTREAM_API_KEY: "k", GATEWAY_API_MODELS: "same", GATEWAY_SUBSCRIPTION_MODELS: "same" }), /multiple gateway backends/);
  const geminiOnly = loadGatewayConfigFromEnv({ GATEWAY_GEMINI_MODELS: "gemini-subscription-pro" });
  assert.equal(geminiOnly.backends[0]!.id, "gemini-subscription");
  assert.equal(geminiOnly.backends[0]!.port, 10532);
  assert.throws(() => loadGatewayConfigFromEnv({ GATEWAY_GEMINI_MODELS: "g", GATEWAY_GEMINI_HOST: "evil.example.com" }), /must be loopback/);
  assert.throws(() => loadGatewayConfigFromEnv({ GATEWAY_SUBSCRIPTION_MODELS: "same", GATEWAY_GEMINI_MODELS: "same" }), /multiple gateway backends/);
});

test("api backend strips inbound credentials and injects only the gateway key", () => {
  const out = sanitizeRequestHeaders({ authorization: "Bearer client-token", "x-api-key": "client-key", "content-type": "application/json" }, apiBackend);
  assert.equal(out.authorization, "Bearer sk-secret");
  assert.equal("x-api-key" in out, false);
  assert.equal(out.host, "api.openai.com");
});

test("subscription backend strips inbound credentials and injects no credential", () => {
  const out = sanitizeRequestHeaders({ authorization: "Bearer client-token", "x-api-key": "client-key", "content-type": "application/json" }, subscriptionBackend);
  assert.equal("authorization" in out, false);
  assert.equal("x-api-key" in out, false);
  assert.equal(out.host, "127.0.0.1");
});

test("Gemini subscription backend strips inbound credentials and stays loopback-only", () => {
  const out = sanitizeRequestHeaders({ authorization: "Bearer client-token", "x-api-key": "client-key", "content-type": "application/json" }, geminiBackend);
  assert.equal("authorization" in out, false);
  assert.equal("x-api-key" in out, false);
  assert.equal(out.host, "127.0.0.1");
});

test("body policy selects only configured models and clamps output token fields", () => {
  const denied = applyBodyPolicy("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "other", max_tokens: 10 })), base);
  assert.equal(denied.ok, false); assert.equal(denied.status, 403);
  const clamped = applyBodyPolicy("/v1/responses", Buffer.from(JSON.stringify({ model: "gpt-sub", max_output_tokens: 999999 })), base);
  assert.equal(clamped.ok, true);
  assert.equal(JSON.parse(clamped.body.toString()).max_output_tokens, 4096);
  assert.equal(backendForModel(base, "gpt-sub")?.id, "subscription");
  assert.equal(backendForModel(base, "gpt-api")?.id, "api");
  assert.equal(backendForModel(base, "gemini-subscription-pro")?.id, "gemini-subscription");
});

interface Captured { backend: GatewayBackend; options: any; body: string; }
function fakeRequester(captured: Captured[]): UpstreamRequester {
  return (backend, options, onResponse) => {
    const chunks: Buffer[] = [];
    const req = new EventEmitter() as any;
    req.write = (c: Buffer) => { chunks.push(Buffer.from(c)); return true; };
    req.end = () => {
      captured.push({ backend, options, body: Buffer.concat(chunks).toString("utf8") });
      const res = Readable.from([Buffer.from(JSON.stringify({ ok: true, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, input_tokens: 1, output_tokens: 1 } }))]) as unknown as IncomingMessage;
      (res as any).statusCode = 200;
      (res as any).headers = { "content-type": "application/json", "set-cookie": ["should-be-dropped"] };
      onResponse(res);
    };
    req.destroy = () => {};
    return req as any;
  };
}

function callServer(port: number, path: string, headers: Record<string, string>, body: string, method = "POST"): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("router sends API, OpenAI subscription, and Gemini subscription models to different trusted backends", async () => {
  const captured: Captured[] = [];
  const server = createGateway(base, fakeRequester(captured));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const common = { authorization: "Bearer CLIENT", "x-api-key": "CLIENT-KEY", "content-type": "application/json" };
    assert.equal((await callServer(port, "/v1/chat/completions", common, JSON.stringify({ model: "gpt-api" }))).status, 200);
    assert.equal((await callServer(port, "/v1/chat/completions", common, JSON.stringify({ model: "gpt-sub" }))).status, 200);
    assert.equal((await callServer(port, "/v1/chat/completions", common, JSON.stringify({ model: "gemini-subscription-pro" }))).status, 200);
    assert.equal(captured[0]!.backend.id, "api");
    assert.equal(captured[0]!.options.headers.authorization, "Bearer sk-secret");
    assert.equal(captured[1]!.backend.id, "subscription");
    assert.equal("authorization" in captured[1]!.options.headers, false);
    assert.equal(captured[2]!.backend.id, "gemini-subscription");
    assert.equal("authorization" in captured[2]!.options.headers, false);
    assert.match(captured[2]!.options.headers["x-llm-gateway-request-id"], /^gw-/);
    assert.equal(JSON.stringify(captured).includes("CLIENT-KEY"), false);
  } finally { server.close(); }
});

test("/v1/models is generated by the router and does not call an upstream", async () => {
  const captured: Captured[] = [];
  const server = createGateway(base, fakeRequester(captured));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/models", {}, "", "GET");
    assert.equal(res.status, 200);
    const ids = JSON.parse(res.body).data.map((m: { id: string }) => m.id).sort();
    assert.deepEqual(ids, ["gemini-subscription-pro", "gpt-api", "gpt-sub"]);
    assert.equal(captured.length, 0);
  } finally { server.close(); }
});



test("gateway exports bounded Prometheus metrics by backend/model and keeps metrics on a separate server", async () => {
  const captured: Captured[] = [];
  const metrics = new GatewayMetrics(base);
  const server = createGateway(base, fakeRequester(captured), metrics);
  const metricsServer = createGatewayMetricsServer(metrics);
  server.listen(0); metricsServer.listen(0);
  await Promise.all([once(server, "listening"), once(metricsServer, "listening")]);
  const port = (server.address() as AddressInfo).port;
  const metricsPort = (metricsServer.address() as AddressInfo).port;
  try {
    const ok = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub" }));
    assert.equal(ok.status, 200);
    const rejected = await callServer(port, "/admin/not-a-real-route", { "content-type": "application/json" }, "{}");
    assert.equal(rejected.status, 404);
    const res = await callServer(metricsPort, "/metrics", {}, "", "GET");
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /text\/plain/);
    assert.match(res.body, /llm_gateway_backend_configured\{backend="subscription"\} 1/);
    assert.match(res.body, /llm_gateway_model_configured\{backend="gemini-subscription",model="gemini-subscription-pro"\} 1/);
    assert.match(res.body, /llm_gateway_upstream_requests_total\{backend="subscription",model="gpt-sub",status_code="200"\} 1/);
    assert.match(res.body, /llm_gateway_requests_in_flight\{backend="subscription"\} 0/);
    assert.match(res.body, /llm_gateway_backend_last_request_success\{backend="subscription",model="gpt-sub"\} 1/);
    assert.match(res.body, /llm_gateway_backend_last_response_status_code\{backend="subscription",model="gpt-sub"\} 200/);
    assert.match(res.body, /llm_gateway_request_duration_seconds_bucket\{backend="subscription",le="\+Inf",model="gpt-sub"\} 1/);
    assert.match(res.body, /llm_gateway_rejected_requests_total\{method="POST",reason="endpoint",route="rejected",status_code="404"\} 1/);
    assert.doesNotMatch(res.body, /CLIENT-KEY|authorization|requestId/);
  } finally { server.close(); metricsServer.close(); }
});
test("disallowed endpoint and method are refused before any upstream call", async () => {
  const captured: Captured[] = [];
  const server = createGateway(base, fakeRequester(captured));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await callServer(port, "/admin", { "content-type": "application/json" }, "{}")).status, 404);
    assert.equal((await callServer(port, "/v1/models", {}, "", "DELETE")).status, 405);
    assert.equal(captured.length, 0);
  } finally { server.close(); }
});


test("output-token policy preserves lower client limits and normalizes to backend-native fields", () => {
  const subscription = applyBodyPolicy("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-sub", max_completion_tokens: 64 })), base);
  assert.equal(subscription.ok, true);
  assert.equal(subscription.outputTokenLimit, 64);
  const subscriptionBody = JSON.parse(subscription.body.toString());
  assert.equal(subscriptionBody.max_tokens, 64);
  assert.equal(subscriptionBody.max_completion_tokens, undefined);
  assert.equal(subscriptionBody.max_output_tokens, undefined);

  const gemini = applyBodyPolicy("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gemini-subscription-pro", max_tokens: 32 })), base);
  assert.equal(gemini.ok, true);
  assert.equal(gemini.outputTokenLimit, 32);
  const geminiBody = JSON.parse(gemini.body.toString());
  assert.equal(geminiBody.max_completion_tokens, 32);
  assert.equal(geminiBody.max_tokens, undefined);
  assert.equal(geminiBody.max_output_tokens, undefined);

  const apiResponses = applyBodyPolicy("/v1/responses", Buffer.from(JSON.stringify({ model: "gpt-api", max_completion_tokens: 12 })), base);
  assert.equal(apiResponses.ok, true);
  assert.equal(apiResponses.outputTokenLimit, 12);
  const responsesBody = JSON.parse(apiResponses.body.toString());
  assert.equal(responsesBody.max_output_tokens, 12);
  assert.equal(responsesBody.max_tokens, undefined);
  assert.equal(responsesBody.max_completion_tokens, undefined);

  const uncapped: GatewayConfig = { ...base, maxOutputTokens: 0 };
  const clientOnly = applyBodyPolicy("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-sub", max_tokens: 17 })), uncapped);
  assert.equal(clientOnly.outputTokenLimit, 17);
});

function staticResponseRequester(
  responseBody: string,
  status = 200,
  responseHeaders: Record<string, string | string[]> = { "content-type": "application/json" },
  captured: Captured[] = [],
): UpstreamRequester {
  return (backend, options, onResponse) => {
    const requestChunks: Buffer[] = [];
    const req = new EventEmitter() as any;
    req.write = (chunk: Buffer) => { requestChunks.push(Buffer.from(chunk)); return true; };
    req.end = () => {
      captured.push({ backend, options, body: Buffer.concat(requestChunks).toString("utf8") });
      const response = Readable.from([Buffer.from(responseBody)]) as unknown as IncomingMessage;
      (response as any).statusCode = status;
      (response as any).headers = responseHeaders;
      onResponse(response);
    };
    req.destroy = () => {};
    return req as any;
  };
}

test("router preserves API upstream response bytes and status exactly while dropping credential headers", async () => {
  const opaque = '  {"answer":"μ\\nline","opaque":[1,2]}  \n';
  const server = createGateway(base, staticResponseRequester(opaque, 207, {
    "content-type": "application/json",
    "x-provider-header": "opaque-value",
    "set-cookie": ["must-not-reach-client=1"],
  }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-api" }));
    assert.equal(res.status, 207);
    assert.equal(res.body, opaque);
    assert.equal(res.headers["x-provider-header"], "opaque-value");
    assert.equal(res.headers["set-cookie"], undefined);
  } finally { server.close(); }
});

test("router preserves verified OpenAI subscription response bytes exactly", async () => {
  const opaque = ' { "choices": [{"message":{"content":"exact"}}], "usage": { "prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12 } } \n';
  const captured: Captured[] = [];
  const server = createGateway(base, staticResponseRequester(opaque, 200, { "content-type": "application/json" }, captured));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", max_completion_tokens: 8 }));
    assert.equal(res.status, 200);
    assert.equal(res.body, opaque);
    const forwarded = JSON.parse(captured[0]!.body);
    assert.equal(forwarded.max_tokens, 8);
    assert.equal(forwarded.max_completion_tokens, undefined);
  } finally { server.close(); }
});

test("OpenAI subscription response fails closed when provider output exceeds the effective client limit", async () => {
  const upstream = JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } });
  const server = createGateway(base, staticResponseRequester(upstream));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /gateway_output_policy_error/);
    assert.match(res.body, /9 > 8/);
    assert.doesNotMatch(res.body, /\"choices\":\[\]/);
  } finally { server.close(); }
});

test("OpenAI subscription response fails closed on untrustworthy zero-fallback usage", async () => {
  const upstream = JSON.stringify({ choices: [{ message: { content: "non-empty" } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  const server = createGateway(base, staticResponseRequester(upstream));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub" }));
    assert.equal(res.status, 502);
    assert.match(res.body, /no trustworthy token usage/);
  } finally { server.close(); }
});

const SSE_OK = [
  'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"he"}}]}',
  "",
  'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"llo"}}]}',
  "",
  'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

test("OpenAI subscription streaming is forwarded, buffered, verified, and replayed byte-exact within the output limit", async () => {
  const captured: Captured[] = [];
  const server = createGateway(base, staticResponseRequester(SSE_OK, 200, { "content-type": "text/event-stream", "transfer-encoding": "chunked" }, captured));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.equal(res.body, SSE_OK);
    assert.match(res.body, /data: \[DONE\]/);
    // The gateway owns framing on buffered replay: no dangling chunked header.
    assert.equal(res.headers["transfer-encoding"], undefined);
    // The forwarded request keeps stream=true and clamps the limit. The gateway
    // no longer injects stream_options: openai-oauth@2.0.0 emits terminal usage
    // unconditionally, so the field would be a no-op.
    const forwarded = JSON.parse(captured[0]!.body);
    assert.equal(forwarded.stream, true);
    assert.equal(forwarded.max_tokens, 8);
    assert.equal("stream_options" in forwarded, false);
  } finally { server.close(); }
});

test("OpenAI subscription streaming does not inject stream_options (openai-oauth emits terminal usage unconditionally)", () => {
  const policy = applyBodyPolicy("/v1/chat/completions", Buffer.from(JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 })), base);
  const forwarded = JSON.parse(policy.body.toString("utf8"));
  assert.equal("stream_options" in forwarded, false);
});

test("OpenAI subscription streaming fails closed when the terminal usage exceeds the output limit", async () => {
  const over = SSE_OK.replace('"completion_tokens":7', '"completion_tokens":9').replace('"total_tokens":12', '"total_tokens":14');
  const server = createGateway(base, staticResponseRequester(over, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /gateway_output_policy_error/);
    assert.match(res.body, /9 > 8/);
    assert.doesNotMatch(res.body, /\[DONE\]/);
  } finally { server.close(); }
});

test("OpenAI subscription streaming fails closed when no terminal usage event is present", async () => {
  const noUsage = [
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const server = createGateway(base, staticResponseRequester(noUsage, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /is not the choices:\[\] usage chunk/);
  } finally { server.close(); }
});

test("OpenAI subscription streaming fails closed when the terminal usage chunk has untrustworthy usage", async () => {
  const zeroUsage = [
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}',
    "",
    'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const server = createGateway(base, staticResponseRequester(zeroUsage, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /no trustworthy terminal token usage/);
  } finally { server.close(); }
});

test("OpenAI subscription streaming fails closed when the stream never terminates with [DONE]", async () => {
  const noDone = 'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}\n\n';
  const server = createGateway(base, staticResponseRequester(noDone, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /without a terminal \[DONE\]/);
  } finally { server.close(); }
});

test("OpenAI subscription streaming rejects an early usage value that is not the terminal event before [DONE]", async () => {
  // usage appears early, then more content, then [DONE] with no real terminal usage.
  const sneaky = [
    'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":5,"total_tokens":10}}',
    "",
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"more and more"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const server = createGateway(base, staticResponseRequester(sneaky, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /is not the choices:\[\] usage chunk/);
  } finally { server.close(); }
});

// Real openai-oauth@2.0.0 Responses usage shape: input/output tokens with
// *_details, and crucially NO total_tokens (raw Codex passthrough).
const RESPONSES_SSE_OK = [
  'event: response.output_text.delta',
  'data: {"type":"response.output_text.delta","delta":"hi"}',
  "",
  'event: response.completed',
  'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":1},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":0}}}}',
  "",
].join("\n");

test("OpenAI subscription Responses API streaming verifies response.completed usage without total_tokens and replays bytes", async () => {
  const server = createGateway(base, staticResponseRequester(RESPONSES_SSE_OK, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/responses", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_output_tokens: 8, input: "x" }));
    assert.equal(res.status, 200);
    assert.equal(res.body, RESPONSES_SSE_OK);
    assert.equal(res.headers["content-type"], "text/event-stream");
  } finally { server.close(); }
});

test("OpenAI subscription Responses API streaming fails closed when output_tokens exceeds the limit", async () => {
  const over = RESPONSES_SSE_OK.replace('"output_tokens":7', '"output_tokens":9');
  const server = createGateway(base, staticResponseRequester(over, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/responses", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_output_tokens: 8, input: "x" }));
    assert.equal(res.status, 502);
    assert.match(res.body, /9 > 8/);
  } finally { server.close(); }
});

test("OpenAI subscription Responses API streaming fails closed when the terminal event is not the last semantic event", async () => {
  const trailing = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    "",
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":1},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":0}}}}',
    "",
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"leak"}',
    "",
  ].join("\n");
  const server = createGateway(base, staticResponseRequester(trailing, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/responses", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_output_tokens: 8, input: "x" }));
    assert.equal(res.status, 502);
    assert.match(res.body, /did not end with a terminal response\.completed/);
  } finally { server.close(); }
});

// Real transport variant: openai-oauth@2.0.0 forwards Codex verbatim, and the
// terminal can be marked by the SSE `event:` field and `response.status` with NO
// JSON `type`. The gateway must accept this and verify output_tokens.
const RESPONSES_SSE_NO_TYPE = [
  'event: response.created',
  'data: {"response":{"id":"resp_1","status":"in_progress"}}',
  "",
  'event: response.completed',
  'data: {"response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"input_tokens_details":{"cached_tokens":1},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":0}}}}',
  "",
].join("\n");

test("OpenAI subscription Responses API streaming accepts a terminal marked only by event: and response.status (no JSON type)", async () => {
  const server = createGateway(base, staticResponseRequester(RESPONSES_SSE_NO_TYPE, 200, { "content-type": "text/event-stream" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/responses", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_output_tokens: 8, input: "x" }));
    assert.equal(res.status, 200);
    assert.equal(res.body, RESPONSES_SSE_NO_TYPE);
  } finally { server.close(); }
});

function abortingStreamRequester(chunk: string, event: "error" | "aborted"): UpstreamRequester {
  return (_backend, _options, onResponse) => {
    const req = new EventEmitter() as any;
    req.write = () => true;
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.headers = { "content-type": "text/event-stream" };
      res.pipe = () => {};
      onResponse(res as unknown as IncomingMessage);
      setImmediate(() => {
        if (chunk) res.emit("data", Buffer.from(chunk));
        res.emit(event, new Error("connection reset"));
      });
    };
    req.destroy = () => {};
    return req as any;
  };
}

for (const event of ["error", "aborted"] as const) {
  test(`OpenAI subscription streaming fails closed when the upstream stream ${event}s mid-flight`, async () => {
    const partial = 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"}}]}\n\n';
    const server = createGateway(base, abortingStreamRequester(partial, event));
    server.listen(0); await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
      assert.equal(res.status, 502);
      assert.match(res.body, /gateway_output_policy_error/);
      assert.match(res.body, /before completion/);
      assert.doesNotMatch(res.body, /choices/);
    } finally { server.close(); }
  });
}

test("OpenAI subscription streaming settles once when the upstream emits both error and aborted", async () => {
  const doubleFail: UpstreamRequester = (_backend, _options, onResponse) => {
    const req = new EventEmitter() as any;
    req.write = () => true;
    req.end = () => {
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      res.headers = { "content-type": "text/event-stream" };
      res.pipe = () => {};
      onResponse(res as unknown as IncomingMessage);
      setImmediate(() => {
        res.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        res.emit("error", new Error("reset"));
        res.emit("aborted");
      });
    };
    req.destroy = () => {};
    return req as any;
  };
  const server = createGateway(base, doubleFail);
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true, max_completion_tokens: 8 }));
    assert.equal(res.status, 502);
    assert.match(res.body, /before completion/);
  } finally { server.close(); }
});

test("OpenAI subscription Responses API validates output_tokens and preserves verified bytes", async () => {
  const opaque = ' { "id":"resp_provider", "output": [], "usage": { "input_tokens": 5, "input_tokens_details": { "cached_tokens": 0 }, "output_tokens": 9, "output_tokens_details": { "reasoning_tokens": 0 } } }\n';
  const server = createGateway(base, staticResponseRequester(opaque));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/responses", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", max_output_tokens: 10, input: "x" }));
    assert.equal(res.status, 200);
    assert.equal(res.body, opaque);
  } finally { server.close(); }
});

test("OpenAI subscription remains raw passthrough when neither gateway nor client requests an output-token limit", async () => {
  const uncapped: GatewayConfig = { ...base, maxOutputTokens: 0 };
  const opaque = 'data: {"opaque":true}\n\ndata: [DONE]\n\n';
  const captured: Captured[] = [];
  const server = createGateway(uncapped, staticResponseRequester(opaque, 200, { "content-type": "text/event-stream" }, captured));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({ model: "gpt-sub", stream: true }));
    assert.equal(res.status, 200);
    assert.equal(res.body, opaque);
    assert.equal(JSON.parse(captured[0]!.body).stream, true);
  } finally { server.close(); }
});

const antigravityConfig: AntigravityAdapterConfig = {
  listenPort: 0,
  maxBodyBytes: 1024 * 1024,
  timeoutMs: 1000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  cliPath: "agy",
  workDir: "/tmp",
  models: ["gemini-subscription-pro"],
  modelMap: { "gemini-subscription-pro": "gemini-3.1-pro-high" },
};

function antigravityRunner(response: string, captures: AntigravityCliInvocation[] = [], overrides: Partial<AntigravityCliResult> = {}) {
  return async (invocation: AntigravityCliInvocation): Promise<AntigravityCliResult> => {
    captures.push(invocation);
    let structured: Record<string, unknown> | undefined;
    try { structured = JSON.parse(response) as Record<string, unknown>; } catch {}
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: "test", init: { cwd: "/tmp", tools: [] } }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS", response, ...(structured ? { structured_output: structured } : {}), usage: { input_tokens: 11, output_tokens: 7 } } }),
      "",
    ].join("\n");
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      timedOut: false,
      overflow: null,
      ...overrides,
    };
  };
}

test("Antigravity CLI runner uses native stream-json, caller schema, isolated workdir, and subscription-only auth env", async () => {
  const root = mkdtempSync(join(tmpdir(), "llm-runtime-antigravity-runner-test-"));
  const cli = join(root, "fake-agy");
  writeFileSync(cli, `#!/usr/bin/env node
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"ok",usage:{input_tokens:1,output_tokens:1,total_tokens:2},observed:{input,cwd:process.cwd(),argv:process.argv.slice(2),apiKey:process.env.GEMINI_API_KEY??null,vertex:process.env.GOOGLE_GENAI_USE_VERTEXAI??null}}})+"\\n")});
`);
  chmodSync(cli, 0o755);
  const oldApiKey = process.env.GEMINI_API_KEY;
  const oldVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  process.env.GEMINI_API_KEY = "must-not-reach-cli";
  process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  try {
    const schema = JSON.stringify({ type: "object", properties: { answer: { type: "integer" } }, required: ["answer"] });
    const result = await runAntigravityCli({
      model: "gemini-3.1-pro-high", prompt: "PROVIDER_PROMPT", jsonSchema: schema, timeoutMs: 5000,
      maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024,
      cliPath: cli, workDir: join(root, "work"),
    });
    assert.equal(result.exitCode, 0);
    const event = JSON.parse(result.stdout.trim()) as { result: { observed: { input: string; cwd: string; argv: string[]; apiKey: string | null; vertex: string | null } } };
    const observed = event.result.observed;
    const inputEvent = JSON.parse(observed.input.trim());
    assert.equal(inputEvent.event, "user");
    assert.equal(inputEvent.message.content, "PROVIDER_PROMPT");
    assert.equal(observed.apiKey, null);
    assert.equal(observed.vertex, null);
    assert.deepEqual(observed.argv.slice(0, 6), ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.1-pro-high"]);
    const schemaIndex = observed.argv.indexOf("--json-schema");
    assert.ok(schemaIndex > 0);
    assert.equal(observed.argv[schemaIndex + 1], schema);
    assert.ok(observed.argv.includes("--sandbox"));
    assert.match(observed.cwd, /request-/);
    assert.equal(existsSync(observed.cwd), false, "per-request Antigravity workdir is removed after execution");
  } finally {
    if (oldApiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldApiKey;
    if (oldVertex === undefined) delete process.env.GOOGLE_GENAI_USE_VERTEXAI; else process.env.GOOGLE_GENAI_USE_VERTEXAI = oldVertex;
  }
});

test("Gemini subscription adapter config supports a stable gateway alias mapped to the Antigravity model selector", () => {
  const config = loadAntigravityAdapterConfigFromEnv({
    ANTIGRAVITY_ADAPTER_MODELS: "gemini-subscription-pro,gemini-subscription-auto",
    ANTIGRAVITY_ADAPTER_MODEL_MAP: "gemini-subscription-pro=gemini-3.1-pro-high,gemini-subscription-auto=gemini-3.7-flash-medium",
  });
  assert.equal(config.modelMap["gemini-subscription-pro"], "gemini-3.1-pro-high");
  assert.equal(config.modelMap["gemini-subscription-auto"], "gemini-3.7-flash-medium");
  assert.throws(() => loadAntigravityAdapterConfigFromEnv({ ANTIGRAVITY_ADAPTER_MODELS: "a", ANTIGRAVITY_ADAPTER_MODEL_MAP: "b=gemini-3.1-pro-high" }), /not present/);
});

test("Gemini adapter preserves provider response text exactly without parsing a gateway envelope", async () => {
  const captures: AntigravityCliInvocation[] = [];
  const exact = '  leading\\n```json\\n{"looks":"structured"}\\n```\\ntrailing  \\n';
  const server = createAntigravityAdapter(antigravityConfig, antigravityRunner(exact, captures));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro",
      messages: [{ role: "system", content: "be exact" }, { role: "user", content: "hello" }],
      max_completion_tokens: 64,
    }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.choices[0].message.content, exact);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.model, "gemini-subscription-pro");
    assert.match(body.id, /^chatcmpl-gateway-gemini-/);
    assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.equal(captures[0]!.model, "gemini-3.1-pro-high");
    assert.match(captures[0]!.prompt, /CONVERSATION_JSON:/);
    assert.match(captures[0]!.prompt, /"role":"user","content":"hello"/);
    assert.doesNotMatch(captures[0]!.prompt, /\{"type":"assistant"/);
    assert.equal(captures[0]!.jsonSchema, undefined);
  } finally { server.close(); }
});

test("Gemini response_format json_schema is enforced through native Antigravity --json-schema", async () => {
  const captures: AntigravityCliInvocation[] = [];
  const response = '{"answer":42}';
  const schema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
  const runner: AntigravityCliRunner = async (invocation) => {
    captures.push(invocation);
    const stdout = `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response, structured_output: { answer: 42 }, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } })}\n`;
    return { exitCode: 0, signal: null, stdout, stderr: "", stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0, timedOut: false, overflow: null };
  };
  const server = createAntigravityAdapter(antigravityConfig, runner);
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro",
      messages: [{ role: "user", content: "json" }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
      max_tokens: 16,
    }));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).choices[0].message.content, response);
    assert.deepEqual(JSON.parse(captures[0]!.jsonSchema!), schema);
  } finally { server.close(); }
});

test("Gemini tools, tool history, and synthetic streaming fail closed before provider invocation", async () => {
  const captures: AntigravityCliInvocation[] = [];
  const runner = antigravityRunner("not reached", captures);
  const server = createAntigravityAdapter(antigravityConfig, runner);
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const tools = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro", messages: [{ role: "user", content: "use tool" }],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    }));
    assert.equal(tools.status, 400);
    assert.match(tools.body, /tools are disabled/);

    const history = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro",
      messages: [{ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "read", arguments: "{}" } }] }],
    }));
    assert.equal(history.status, 400);
    assert.match(history.body, /tool history is disabled/);

    const stream = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }], stream: true,
    }));
    assert.equal(stream.status, 501);
    assert.match(stream.body, /streaming is disabled/);
    assert.equal(captures.length, 0);
  } finally { server.close(); }
});

test("Gemini output-token policy fails closed on over-budget or unverifiable provider usage", async () => {
  const cases: Array<{ usage?: Record<string, number>; pattern: RegExp }> = [
    { usage: { input_tokens: 1, output_tokens: 65, total_tokens: 66 }, pattern: /exceeded gateway token policy/ },
    { pattern: /no token usage required by gateway output-token policy/ },
  ];
  for (const item of cases) {
    const runner: AntigravityCliRunner = async () => {
      const result: Record<string, unknown> = { status: "SUCCESS", response: "x" };
      if (item.usage) result.usage = item.usage;
      const stdout = `${JSON.stringify({ event: "result", result })}\n`;
      return { exitCode: 0, signal: null, stdout, stderr: "", stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0, timedOut: false, overflow: null };
    };
    const server = createAntigravityAdapter(antigravityConfig, runner);
    server.listen(0); await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
        model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 64,
      }));
      assert.equal(res.status, 502);
      assert.match(res.body, item.pattern);
    } finally { server.close(); }
  }
});


test("Gemini subscription adapter reports CLI timeout/overflow instead of hiding the transport failure", async () => {
  const server = createAntigravityAdapter(antigravityConfig, antigravityRunner('', [], { timedOut: true, exitCode: null, signal: "SIGTERM" }));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }],
    }));
    assert.equal(res.status, 502);
    assert.match(res.body, /timed out/);
  } finally { server.close(); }
});

test("Gemini subscription backend deliberately rejects Responses API until its semantics are implemented", async () => {
  const server = createAntigravityAdapter(antigravityConfig, antigravityRunner('{"type":"assistant","content":"x"}'));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/responses", { "content-type": "application/json" }, JSON.stringify({ model: "gemini-subscription-pro", input: "x" }));
    assert.equal(res.status, 501);
    assert.match(res.body, /chat\/completions only/);
  } finally { server.close(); }
});
