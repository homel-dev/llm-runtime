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
  type AntigravityAdapterConfig, type AntigravityCliInvocation, type AntigravityCliResult,
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
      const res = Readable.from([Buffer.from(JSON.stringify({ ok: true }))]) as unknown as IncomingMessage;
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

test("Antigravity CLI runner uses stream-json stdin, structured output, an isolated workdir, and subscription-only auth env", async () => {
  const root = mkdtempSync(join(tmpdir(), "llm-runtime-antigravity-runner-test-"));
  const cli = join(root, "fake-agy");
  writeFileSync(cli, `#!/usr/bin/env node
let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const result={type:"assistant",content:"ok"};process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:JSON.stringify(result),structured_output:result,usage:{input_tokens:1,output_tokens:1},observed:{input,cwd:process.cwd(),argv:process.argv.slice(2),apiKey:process.env.GEMINI_API_KEY??null,vertex:process.env.GOOGLE_GENAI_USE_VERTEXAI??null}}})+"\\n")});
`);
  chmodSync(cli, 0o755);
  const oldApiKey = process.env.GEMINI_API_KEY;
  const oldVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  process.env.GEMINI_API_KEY = "must-not-reach-cli";
  process.env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  try {
    const result = await runAntigravityCli({
      model: "gemini-3.1-pro-high", protocolPrompt: "GATEWAY_PROTOCOL_PAYLOAD", timeoutMs: 5000,
      maxStdoutBytes: 1024 * 1024, maxStderrBytes: 1024 * 1024,
      cliPath: cli, workDir: join(root, "work"),
    });
    assert.equal(result.exitCode, 0);
    const event = JSON.parse(result.stdout.trim()) as { result: { observed: { input: string; cwd: string; argv: string[]; apiKey: string | null; vertex: string | null } } };
    const observed = event.result.observed;
    const inputEvent = JSON.parse(observed.input.trim());
    assert.equal(inputEvent.event, "user");
    assert.equal(inputEvent.message.content, "GATEWAY_PROTOCOL_PAYLOAD");
    assert.equal(observed.apiKey, null);
    assert.equal(observed.vertex, null);
    assert.deepEqual(observed.argv.slice(0, 6), ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.1-pro-high"]);
    assert.ok(observed.argv.includes("--json-schema"));
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

test("Gemini subscription adapter converts a text completion and passes the protocol over stdin to the Antigravity CLI runner", async () => {
  const captures: AntigravityCliInvocation[] = [];
  const server = createAntigravityAdapter(antigravityConfig, antigravityRunner('{"type":"assistant","content":"hello from Gemini"}', captures));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro",
      messages: [{ role: "system", content: "be terse" }, { role: "user", content: "hello" }],
    }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.choices[0].message.content, "hello from Gemini");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.deepEqual(body.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    assert.equal(captures[0]!.model, "gemini-3.1-pro-high");
    assert.match(captures[0]!.protocolPrompt, /stateless language-model backend/);
    assert.match(captures[0]!.protocolPrompt, /"role":"user","content":"hello"/);
  } finally { server.close(); }
});

test("Gemini subscription adapter emulates OpenAI function calling without giving Antigravity local tools", async () => {
  const captures: AntigravityCliInvocation[] = [];
  const server = createAntigravityAdapter(antigravityConfig, antigravityRunner('{"type":"tool_calls","calls":[{"name":"read","arguments":{"path":"README.md"}}]}', captures));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro",
      messages: [{ role: "user", content: "inspect README" }],
      tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "read");
    assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"path":"README.md"}');
    assert.match(captures[0]!.protocolPrompt, /ALLOWED_TOOL_NAMES=\["read"\]/);
  } finally { server.close(); }
});

test("Gemini subscription adapter fails closed if a tool-enabled response breaks the transport envelope or invents a tool", async () => {
  for (const response of ["not protocol json", '{"type":"tool_calls","calls":[{"name":"bash","arguments":{}}]}']) {
    const server = createAntigravityAdapter(antigravityConfig, antigravityRunner(response));
    server.listen(0); await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
        model: "gemini-subscription-pro",
        messages: [{ role: "user", content: "use read" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
      }));
      assert.equal(res.status, 502);
    } finally { server.close(); }
  }
});

test("Gemini subscription adapter buffers internally but honors OpenAI stream=true with an SSE completion", async () => {
  const server = createAntigravityAdapter(antigravityConfig, antigravityRunner('{"type":"assistant","content":"streamed"}'));
  server.listen(0); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await callServer(port, "/v1/chat/completions", { "content-type": "application/json" }, JSON.stringify({
      model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }], stream: true,
    }));
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    assert.match(res.body, /chat\.completion\.chunk/);
    assert.match(res.body, /streamed/);
    assert.match(res.body, /data: \[DONE\]/);
  } finally { server.close(); }
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
