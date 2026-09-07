import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAntigravityDirectAdapter,
  loadAntigravityDirectConfigFromEnv,
  type AntigravityDirectConfig,
  type AntigravityFetch,
} from "../src/antigravity-direct.js";

const config: AntigravityDirectConfig = {
  listenPort: 1,
  maxBodyBytes: 1024 * 1024,
  timeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  idleTimeoutMs: 5_000,
  proThinkingBudget: 10001,
  models: ["gemini-subscription-pro", "gemini-subscription-auto"],
  modelMap: {
    "gemini-subscription-pro": "gemini-pro-agent",
    "gemini-subscription-auto": "gemini-3.7-flash-medium",
  },
  credentialFile: "/unused",
  controlBaseUrl: "https://control.test",
  inferenceBaseUrls: ["https://daily.test", "https://sandbox.test"],
  oauthTokenUrl: "https://oauth.test/token",
  oauthClientId: "client",
  oauthClientSecret: "secret",
  userAgent: "antigravity/hub/1.1.26 (test)",
};

function callServer(port: number, path: string, body: unknown): Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

function sse(...objects: unknown[]): Response {
  const body = objects.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function baseFetch(captured: Array<{ url: string; init?: RequestInit }>, inference: () => Response): AntigravityFetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({ url, init });
    if (url === "https://control.test/v1internal:loadCodeAssist") return new Response(JSON.stringify({ cloudaicompanionProject: "cca-project" }), { status: 200 });
    if (url.startsWith("https://daily.test/v1internal:streamGenerateContent")) return inference();
    throw new Error(`unexpected URL ${url}`);
  }) as AntigravityFetch;
}

function validCredential() {
  return { accessToken: "access", refreshToken: "refresh", expiresAt: Date.now() + 3600_000 };
}

test("direct config keeps gateway aliases while mapping Pro to the working Cloud Code wire id", () => {
  const loaded = loadAntigravityDirectConfigFromEnv({
    HOME: "/auth",
    ANTIGRAVITY_ADAPTER_OAUTH_CLIENT_ID: "test-client-id",
    ANTIGRAVITY_ADAPTER_OAUTH_CLIENT_SECRET: "test-client-secret",
    ANTIGRAVITY_ADAPTER_MODELS: "gemini-subscription-pro,gemini-subscription-auto",
    ANTIGRAVITY_ADAPTER_MODEL_MAP: "gemini-subscription-pro=gemini-pro-agent,gemini-subscription-auto=gemini-3.7-flash-medium",
  });
  assert.equal(loaded.modelMap["gemini-subscription-pro"], "gemini-pro-agent");
  assert.equal(loaded.timeoutMs, 900000);
  assert.equal(loaded.credentialFile, "/auth/.gemini/antigravity-cli/antigravity-oauth-token");
});

test("direct adapter converts a Cloud Code text completion to OpenAI chat completion", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }, responseId: "resp-1" } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.choices[0].message.content, "hello");
    assert.equal(body.usage.completion_tokens, 2);
    const inference = captured.find((item) => item.url.includes("streamGenerateContent"));
    assert.ok(inference);
    const payload = JSON.parse(String(inference.init?.body));
    assert.equal(payload.project, "cca-project");
    assert.equal(payload.model, "gemini-pro-agent");
    assert.equal(payload.userAgent, "antigravity");
    assert.equal(payload.request.contents[0].role, "user");
    assert.equal(payload.request.generationConfig.maxOutputTokens, 65535);
  } finally { server.close(); }
});

test("direct adapter maps OpenAI function tools to native CCA declarations and native functionCall back to tool_calls", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "README.md" } }, thoughtSignature: "QUJDRA==" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [{ role: "user", content: "read it" }],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } }],
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "read");
    assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { path: "README.md" });
    const inference = captured.find((item) => item.url.includes("streamGenerateContent"));
    const payload = JSON.parse(String(inference?.init?.body));
    assert.equal(payload.request.tools[0].functionDeclarations[0].name, "read");
    assert.equal(payload.request.tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
    assert.equal(payload.request.toolConfig.functionCallingConfig.mode, "VALIDATED");
  } finally { server.close(); }
});

test("direct adapter maps OpenAI response_format json_schema to native CCA responseJsonSchema", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "{\"answer\":42}" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [{ role: "user", content: "json" }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false } } },
    });
    assert.equal(res.status, 200);
    const inference = captured.find((item) => item.url.includes("streamGenerateContent"));
    const payload = JSON.parse(String(inference?.init?.body));
    assert.equal(payload.request.generationConfig.responseMimeType, "application/json");
    assert.equal(payload.request.generationConfig.responseJsonSchema.type, "object");
    assert.equal(payload.request.generationConfig.responseJsonSchema.additionalProperties, undefined);
  } finally { server.close(); }
});

test("direct adapter replays OpenAI tool history as Gemini functionCall/functionResponse without model-authored transport envelopes", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1, totalTokenCount: 21 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [
        { role: "user", content: "read" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.txt\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "contents" },
      ],
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }],
    });
    assert.equal(res.status, 200);
    const inference = captured.find((item) => item.url.includes("streamGenerateContent"));
    const payload = JSON.parse(String(inference?.init?.body));
    const modelTurn = payload.request.contents.find((entry: any) => entry.role === "model");
    const toolTurn = payload.request.contents.find((entry: any) => entry.parts?.some((part: any) => part.functionResponse));
    assert.equal(modelTurn.parts[0].functionCall.name, "read");
    assert.equal(modelTurn.parts[0].thoughtSignature, "skip_thought_signature_validator");
    assert.equal(toolTurn.parts[0].functionResponse.name, "read");
    assert.equal(toolTurn.parts[0].functionResponse.response.output, "contents");
  } finally { server.close(); }
});

test("direct adapter emits functional OpenAI SSE for Gemini streaming", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse(
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "hel" }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } } },
  ));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-auto", messages: [{ role: "user", content: "hi" }], stream: true });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    assert.match(res.body, /"role":"assistant"/);
    assert.match(res.body, /"content":"hel"/);
    assert.match(res.body, /"content":"lo"/);
    assert.match(res.body, /data: \[DONE\]/);
  } finally { server.close(); }
});

test("direct adapter streams native Gemini function calls as OpenAI tool_calls and terminates cleanly", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "pwd" } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [{ role: "user", content: "run pwd" }],
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }],
      stream: true,
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /"tool_calls"/);
    assert.match(res.body, /"name":"bash"/);
    assert.match(res.body, /"finish_reason":"tool_calls"/);
    assert.match(res.body, /data: \[DONE\]/);
  } finally { server.close(); }
});

test("stream with an active output limit buffers and fails closed before leaking over-budget output", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "too much" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 65, totalTokenCount: 66 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }], stream: true, max_completion_tokens: 64 });
    assert.equal(res.status, 502);
    assert.match(res.body, /65 > 64/);
    assert.doesNotMatch(res.body, /too much/);
  } finally { server.close(); }
});

test("reasoning tokens count toward the enforced Gemini output budget", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "reasoned answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 60, thoughtsTokenCount: 5, totalTokenCount: 75 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "think" }], stream: true, max_completion_tokens: 64 });
    assert.equal(res.status, 502);
    assert.match(res.body, /65 > 64/);
    assert.doesNotMatch(res.body, /reasoned answer/);
  } finally { server.close(); }
});

test("project discovery binds an existing Cloud Code project when paidTier is absent", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  let loadCalls = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({ url, init });
    if (url === "https://control.test/v1internal:loadCodeAssist") {
      loadCalls += 1;
      if (loadCalls === 1) return new Response(JSON.stringify({ cloudaicompanionProject: "cca-project" }), { status: 200 });
      const request = JSON.parse(String(init?.body));
      assert.equal(request.cloudaicompanionProject, "cca-project");
      return new Response(JSON.stringify({ cloudaicompanionProject: "cca-project", currentTier: { id: "standard-tier" } }), { status: 200 });
    }
    if (url.startsWith("https://daily.test/v1internal:streamGenerateContent")) return sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } });
    throw new Error(`unexpected URL ${url}`);
  }) as AntigravityFetch;
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal(loadCalls, 2);
  } finally { server.close(); }
});

test("direct adapter fails closed on malformed native function-call terminal status", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "tool" }] });
    assert.equal(res.status, 502);
    assert.match(res.body, /MALFORMED_FUNCTION_CALL/);
  } finally { server.close(); }
});

test("direct adapter rejects a truncated Cloud Code stream without finishReason", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 502);
    assert.match(res.body, /without a terminal finishReason/);
  } finally { server.close(); }
});

test("direct adapter refreshes OAuth and retries a 401 inference without invoking agy", async () => {
  const calls: string[] = [];
  let inferenceAttempts = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === "https://control.test/v1internal:loadCodeAssist") return new Response(JSON.stringify({ cloudaicompanionProject: "cca-project" }), { status: 200 });
    if (url === "https://oauth.test/token") return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200 });
    if (url.startsWith("https://daily.test/v1internal:streamGenerateContent")) {
      inferenceAttempts += 1;
      if (inferenceAttempts === 1) return new Response("expired", { status: 401 });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-access");
      return sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as AntigravityFetch;
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.equal(inferenceAttempts, 2);
    assert.ok(calls.includes("https://oauth.test/token"));
  } finally { server.close(); }
});

test("provider thoughtSignature round-trips on the next request instead of the sentinel", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  let step = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({ url, init });
    if (url === "https://control.test/v1internal:loadCodeAssist") return new Response(JSON.stringify({ cloudaicompanionProject: "cca-project", currentTier: { id: "standard-tier" } }), { status: 200 });
    if (url.startsWith("https://daily.test/v1internal:streamGenerateContent")) {
      step += 1;
      if (step === 1) return sse({ response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "pwd" } }, thoughtSignature: "SIG-1" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 } } });
      return sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 } } });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as AntigravityFetch;
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
    const first = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "run pwd" }], tools });
    const toolCall = JSON.parse(first.body).choices[0].message.tool_calls[0];
    const second = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [
        { role: "user", content: "run pwd" },
        { role: "assistant", content: null, tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: "/home" },
      ],
      tools,
    });
    assert.equal(second.status, 200);
    const secondInference = captured.filter((c) => c.url.startsWith("https://daily.test/v1internal:streamGenerateContent")).pop();
    const payload = JSON.parse(String(secondInference?.init?.body));
    const modelTurn = payload.request.contents.find((e: any) => e.role === "model");
    assert.equal(modelTurn.parts[0].functionCall.name, "bash");
    assert.equal(modelTurn.parts[0].functionCall.id, toolCall.id);
    assert.equal(modelTurn.parts[0].thoughtSignature, "SIG-1");
  } finally { server.close(); }
});

test("project discovery accepts the object form cloudaicompanionProject: { id }", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({ url, init });
    if (url === "https://control.test/v1internal:loadCodeAssist") return new Response(JSON.stringify({ cloudaicompanionProject: { id: "obj-project" }, currentTier: { id: "standard-tier" } }), { status: 200 });
    if (url.startsWith("https://daily.test/v1internal:streamGenerateContent")) return sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } });
    throw new Error(`unexpected URL ${url}`);
  }) as AntigravityFetch;
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const inference = captured.find((c) => c.url.includes("streamGenerateContent"));
    assert.equal(JSON.parse(String(inference?.init?.body)).project, "obj-project");
  } finally { server.close(); }
});

test("tool result text is preserved verbatim under output; $ref params are dereferenced", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [
        { role: "user", content: "list" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "{\"files\":[\"a\",\"b\"]}" },
      ],
      tools: [{ type: "function", function: { name: "ls", parameters: { type: "object", properties: { item: { $ref: "#/$defs/Item" } }, $defs: { Item: { type: "object", properties: { name: { type: "string" } } } } } } }],
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(String(captured.find((c) => c.url.includes("streamGenerateContent"))?.init?.body));
    const toolTurn = payload.request.contents.find((e: any) => e.parts?.some((p: any) => p.functionResponse));
    // Verbatim string, NOT reinterpreted into a structured object.
    assert.deepEqual(toolTurn.parts[0].functionResponse.response, { output: "{\"files\":[\"a\",\"b\"]}" });
    // $ref/$defs are resolved before schema conversion (no dangling refs remain).
    const params = payload.request.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.properties.item.$ref, undefined);
    assert.equal(params.$defs, undefined);
    assert.ok(params.properties.item.properties.name);
  } finally { server.close(); }
});
<<<<<<< HEAD

test("P0: tool parameters are emitted as Gemini protobuf Schema (UPPERCASE types)", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "ls", parameters: { type: "object", properties: { path: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["path"] } } }],
    });
    assert.equal(res.status, 200);
    const params = JSON.parse(String(captured.find((c) => c.url.includes("streamGenerateContent"))?.init?.body)).request.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.type, "OBJECT");
    assert.equal(params.properties.path.type, "STRING");
    assert.equal(params.properties.tags.type, "ARRAY");
    assert.equal(params.properties.tags.items.type, "STRING");
    assert.deepEqual(params.required, ["path"]);
  } finally { server.close(); }
});

test("P0: batch thoughtSignature on an empty thought part lands on the first functionCall and round-trips", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  let step = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    captured.push({ url, init });
    if (url === "https://control.test/v1internal:loadCodeAssist") return new Response(JSON.stringify({ cloudaicompanionProject: "cca-project" }), { status: 200 });
    if (url.startsWith("https://daily.test/v1internal:streamGenerateContent")) {
      step += 1;
      if (step === 1) return sse({ response: { candidates: [{ content: { role: "model", parts: [
        { thought: true, thoughtSignature: "BATCH-SIG" },
        { functionCall: { name: "a", args: {} } },
        { functionCall: { name: "b", args: {} } },
      ] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } } });
      return sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 } } });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as AntigravityFetch;
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const tools = [{ type: "function", function: { name: "a", parameters: { type: "object", properties: {} } } }, { type: "function", function: { name: "b", parameters: { type: "object", properties: {} } } }];
    const first = await callServer(port, "/v1/chat/completions", { model: "gemini-subscription-pro", messages: [{ role: "user", content: "go" }], tools });
    const calls = JSON.parse(first.body).choices[0].message.tool_calls;
    assert.equal(calls.length, 2);
    const second = await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: calls },
        { role: "tool", tool_call_id: calls[0].id, content: "ra" },
        { role: "tool", tool_call_id: calls[1].id, content: "rb" },
      ],
      tools,
    });
    assert.equal(second.status, 200);
    const payload = JSON.parse(String(captured.filter((c) => c.url.startsWith("https://daily.test/v1internal:streamGenerateContent")).pop()?.init?.body));
    const modelTurn = payload.request.contents.find((e: any) => e.role === "model");
    assert.equal(modelTurn.parts[0].functionCall.name, "a");
    assert.equal(modelTurn.parts[0].thoughtSignature, "BATCH-SIG");
    assert.equal(modelTurn.parts[1].functionCall.name, "b");
    assert.equal(modelTurn.parts[1].thoughtSignature, undefined);
  } finally { server.close(); }
});

test("P0: Pro and Flash carry the correct wire profile (budget, cap, includeThoughts, model_enum)", async () => {
  for (const [model, wire, cap, budget, enumId] of [
    ["gemini-subscription-pro", "gemini-pro-agent", 65535, 10001, "MODEL_PLACEHOLDER_M16"],
    ["gemini-subscription-auto", "gemini-3.7-flash-medium", 65536, 4000, "MODEL_PLACEHOLDER_M299"],
  ] as const) {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } }));
    const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
    server.listen(0); await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await callServer(port, "/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const payload = JSON.parse(String(captured.find((c) => c.url.includes("streamGenerateContent"))?.init?.body));
      assert.equal(payload.model, wire);
      assert.equal(payload.request.generationConfig.maxOutputTokens, cap);
      assert.equal(payload.request.generationConfig.thinkingConfig.thinkingBudget, budget);
      assert.equal(payload.request.generationConfig.thinkingConfig.includeThoughts, true);
      assert.equal(payload.request.labels.model_enum, enumId);
      assert.ok("last_step_index" in payload.request.labels && "trajectory_id" in payload.request.labels);
    } finally { server.close(); }
  }
});

test("P1: inner request preserves the captured Antigravity field order", async () => {
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = baseFetch(captured, () => sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } }));
  const server = createAntigravityDirectAdapter(config, { fetcher, credentialLoader: validCredential });
  server.listen(0); await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    await callServer(port, "/v1/chat/completions", {
      model: "gemini-subscription-pro",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "a", parameters: { type: "object", properties: {} } } }],
    });
    const keys = Object.keys(JSON.parse(String(captured.find((c) => c.url.includes("streamGenerateContent"))?.init?.body)).request);
    assert.deepEqual(keys, ["contents", "systemInstruction", "tools", "toolConfig", "labels", "generationConfig", "sessionId"]);
  } finally { server.close(); }
});

test("P1: default User-Agent is the captured agy CLI identity", () => {
  const loaded = loadAntigravityDirectConfigFromEnv({
    HOME: "/auth",
    ANTIGRAVITY_ADAPTER_OAUTH_CLIENT_ID: "id",
    ANTIGRAVITY_ADAPTER_OAUTH_CLIENT_SECRET: "sec",
    ANTIGRAVITY_ADAPTER_MODELS: "gemini-subscription-pro",
    ANTIGRAVITY_ADAPTER_MODEL_MAP: "gemini-subscription-pro=gemini-pro-agent",
  });
  assert.ok(loaded.userAgent.startsWith("antigravity/cli/1.1.24 (aidev_client;"), loaded.userAgent);
  assert.ok(loaded.userAgent.includes("cl=974782877"));
  assert.ok(loaded.userAgent.includes("auth_method=consumer"));
});
=======
>>>>>>> 17ed15cc1ab596f962a0cb123099a495023780e5
