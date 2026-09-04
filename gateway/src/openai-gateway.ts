import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest } from "node:http";
import { CounterVec, GaugeVec, HistogramVec, renderPrometheus } from "./prometheus.js";
import { checkSubscriptionResponseOutputBudget } from "./subscription-response-policy.js";

/**
 * Trusted OpenAI-compatible policy/router gateway.
 *
 * Hostile agent Pods only see this in-cluster Service. The gateway chooses the
 * trusted backend from the requested model and never accepts an upstream URL or
 * credential from the client.
 *
 * Backends:
 *  - api: api.openai.com with a gateway-owned API key;
 *  - subscription: loopback OpenAI-compatible OAuth proxy (openai-oauth) that
 *    owns the ChatGPT/Codex OAuth session and refresh lifecycle;
 *  - gemini-subscription: loopback Antigravity adapter. The adapter invokes Google Antigravity CLI
 *    using a cached Google-account subscription session;
 *  - local-small/local-medium/local-large: trusted in-cluster OpenAI-compatible
 *    model servers. Consumers never receive these upstream Service addresses.
 */
export type GatewayBackendId = "api" | "subscription" | "gemini-subscription" | "local-small" | "local-medium" | "local-large";

export interface GatewayBackend {
  id: GatewayBackendId;
  protocol: "http" | "https";
  host: string;
  port: number;
  models: string[];
  apiKey?: string;
  modelMap?: Record<string, string>;
}

export interface GatewayConfig {
  listenPort: number;
  metricsPort: number;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  allowedEndpoints: string[];
  maxOutputTokens: number;
  backends: GatewayBackend[];
}

export type UpstreamRequester = (
  backend: GatewayBackend,
  options: RequestOptions,
  onResponse: (res: IncomingMessage) => void,
) => ClientRequest;

function csvEnv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function validPort(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be a valid TCP port`);
  return value;
}

function validDnsHost(label: string, host: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !host.includes(".")) throw new Error(`${label} must be a DNS host name`);
  return host;
}

function modelMapFromEnv(label: string, value: string | undefined, models: string[]): Record<string, string> {
  const out = Object.fromEntries(models.map((model) => [model, model]));
  if (!value) return out;
  const seen = new Set<string>();
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) throw new Error(`${label} entry '${entry}' must be exposed-model=upstream-model`);
    const exposed = entry.slice(0, eq).trim();
    const upstream = entry.slice(eq + 1).trim();
    if (!models.includes(exposed)) throw new Error(`${label} references undeclared exposed model '${exposed}'`);
    if (seen.has(exposed)) throw new Error(`${label} contains duplicate mapping for '${exposed}'`);
    seen.add(exposed);
    out[exposed] = upstream;
  }
  return out;
}

type LocalTier = "small" | "medium" | "large";
const LOCAL_TIERS: LocalTier[] = ["small", "medium", "large"];

function localBackendFromEnv(env: NodeJS.ProcessEnv, tier: LocalTier): GatewayBackend | undefined {
  const upper = tier.toUpperCase();
  const prefix = `GATEWAY_LOCAL_${upper}_`;
  const models = csvEnv(env[`${prefix}MODELS`], []);
  if (!models.length) return undefined;
  const id = `local-${tier}` as GatewayBackendId;
  return {
    id,
    protocol: "http",
    host: validDnsHost(`${prefix}HOST`, env[`${prefix}HOST`] ?? `llm-${tier}.llm-runtime.svc.cluster.local`),
    port: validPort(`${prefix}PORT`, Number(env[`${prefix}PORT`] ?? "8000")),
    models,
    modelMap: modelMapFromEnv(`${prefix}MODEL_MAP`, env[`${prefix}MODEL_MAP`], models),
  };
}

export function loadGatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const listenPort = validPort("GATEWAY_LISTEN_PORT", Number(env.GATEWAY_LISTEN_PORT ?? "8000"));
  const metricsPort = validPort("GATEWAY_METRICS_PORT", Number(env.GATEWAY_METRICS_PORT ?? "9091"));
  if (metricsPort === listenPort) throw new Error("GATEWAY_METRICS_PORT must differ from GATEWAY_LISTEN_PORT");
  const maxBodyBytes = Number(env.GATEWAY_MAX_BODY_BYTES ?? String(2 * 1024 * 1024));
  const upstreamTimeoutMs = Number(env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? "120000");
  const maxOutputTokens = Number(env.GATEWAY_MAX_OUTPUT_TOKENS ?? "0");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("GATEWAY_MAX_BODY_BYTES must be a positive integer");
  if (!Number.isInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1) throw new Error("GATEWAY_UPSTREAM_TIMEOUT_MS must be a positive integer");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 0) throw new Error("GATEWAY_MAX_OUTPUT_TOKENS must be a non-negative integer");

  const allowedEndpoints = csvEnv(env.GATEWAY_ALLOWED_ENDPOINTS, ["/v1/chat/completions", "/v1/responses", "/v1/models"]);
  for (const endpoint of allowedEndpoints) if (!endpoint.startsWith("/v1/")) throw new Error(`GATEWAY_ALLOWED_ENDPOINTS entries must start with /v1/: ${endpoint}`);

  // Backward-compatible: the old GATEWAY_ALLOWED_MODELS value becomes API models.
  const apiModels = csvEnv(env.GATEWAY_API_MODELS ?? env.GATEWAY_ALLOWED_MODELS, []);
  const subscriptionModels = csvEnv(env.GATEWAY_SUBSCRIPTION_MODELS, []);
  const geminiModels = csvEnv(env.GATEWAY_GEMINI_MODELS, []);
  const localBackends = LOCAL_TIERS.map((tier) => localBackendFromEnv(env, tier)).filter((backend): backend is GatewayBackend => backend !== undefined);
  const assignments = new Map<string, string[]>();
  for (const [backend, models] of [["api", apiModels], ["subscription", subscriptionModels], ["gemini-subscription", geminiModels]] as const) {
    for (const model of models) assignments.set(model, [...(assignments.get(model) ?? []), backend]);
  }
  for (const backend of localBackends) {
    for (const model of backend.models) assignments.set(model, [...(assignments.get(model) ?? []), backend.id]);
  }
  const overlap = [...assignments.entries()].filter(([, owners]) => owners.length > 1).map(([model]) => model);
  if (overlap.length) throw new Error(`models cannot be assigned to multiple gateway backends: ${overlap.join(",")}`);

  const backends: GatewayBackend[] = [];
  if (apiModels.length) {
    const apiKey = env.GATEWAY_UPSTREAM_API_KEY;
    if (!apiKey) throw new Error("GATEWAY_UPSTREAM_API_KEY is required when GATEWAY_API_MODELS is non-empty");
    backends.push({
      id: "api",
      protocol: "https",
      host: validDnsHost("GATEWAY_UPSTREAM_HOST", env.GATEWAY_UPSTREAM_HOST ?? "api.openai.com"),
      port: validPort("GATEWAY_UPSTREAM_PORT", Number(env.GATEWAY_UPSTREAM_PORT ?? "443")),
      models: apiModels,
      apiKey,
    });
  }
  if (subscriptionModels.length) {
    const host = env.GATEWAY_SUBSCRIPTION_HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("GATEWAY_SUBSCRIPTION_HOST must be loopback; OAuth credentials must stay inside the gateway Pod");
    }
    backends.push({
      id: "subscription",
      protocol: "http",
      host,
      port: validPort("GATEWAY_SUBSCRIPTION_PORT", Number(env.GATEWAY_SUBSCRIPTION_PORT ?? "10531")),
      models: subscriptionModels,
    });
  }
  if (geminiModels.length) {
    const host = env.GATEWAY_GEMINI_HOST ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new Error("GATEWAY_GEMINI_HOST must be loopback; Google subscription credentials must stay inside the gateway Pod");
    }
    backends.push({
      id: "gemini-subscription",
      protocol: "http",
      host,
      port: validPort("GATEWAY_GEMINI_PORT", Number(env.GATEWAY_GEMINI_PORT ?? "10532")),
      models: geminiModels,
    });
  }
  backends.push(...localBackends);
  if (!backends.length) throw new Error("at least one gateway backend must be configured via API, subscription, Gemini, or GATEWAY_LOCAL_<TIER>_MODELS");

  return { listenPort, metricsPort, maxBodyBytes, upstreamTimeoutMs, allowedEndpoints, maxOutputTokens, backends };
}

const FORWARDABLE_REQUEST_HEADERS = new Set(["content-type", "accept", "openai-beta"]);

export function sanitizeRequestHeaders(
  incoming: IncomingMessage["headers"],
  backend: GatewayBackend,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (FORWARDABLE_REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  // Client credentials are always stripped. API credentials are injected only
  // for the API backend. Subscription auth is owned by the loopback OAuth proxy.
  if (backend.id === "api") headers.authorization = `Bearer ${backend.apiKey}`;
  headers.host = backend.host;
  return headers;
}

function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

export interface BodyPolicyResult {
  ok: boolean;
  status?: number;
  message?: string;
  body: Buffer;
  model?: string;
  stream?: boolean;
  outputTokenLimit?: number;
}

export function applyBodyPolicy(pathname: string, body: Buffer, config: GatewayConfig): BodyPolicyResult {
  if (!body.length) return { ok: true, body };
  const needsModel = pathname === "/v1/chat/completions" || pathname === "/v1/completions" || pathname === "/v1/responses";
  if (!needsModel && config.maxOutputTokens === 0) return { ok: true, body };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>; }
  catch { return { ok: false, status: 400, message: "invalid JSON body", body }; }

  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  const selectedBackend = model ? config.backends.find((backend) => backend.models.includes(model)) : undefined;
  if (needsModel) {
    if (!model) return { ok: false, status: 400, message: "model is required", body };
    if (!selectedBackend) return { ok: false, status: 403, message: "model not allowed", body };
  }

  const requestedLimits = [parsed.max_tokens, parsed.max_completion_tokens, parsed.max_output_tokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const clientLimit = requestedLimits.length ? Math.min(...requestedLimits) : undefined;
  const outputTokenLimit = config.maxOutputTokens > 0
    ? (clientLimit === undefined ? config.maxOutputTokens : Math.min(config.maxOutputTokens, clientLimit))
    : clientLimit;

  if (outputTokenLimit !== undefined) {
    if (pathname === "/v1/responses") {
      delete parsed.max_tokens;
      delete parsed.max_completion_tokens;
      parsed.max_output_tokens = outputTokenLimit;
    } else if (pathname === "/v1/chat/completions" || pathname === "/v1/completions") {
      delete parsed.max_output_tokens;
      if (selectedBackend?.id === "subscription" || selectedBackend?.id.startsWith("local-")) {
        parsed.max_tokens = outputTokenLimit;
        delete parsed.max_completion_tokens;
      } else {
        parsed.max_completion_tokens = outputTokenLimit;
        delete parsed.max_tokens;
      }
    }
  }
  if (model && selectedBackend?.modelMap?.[model]) parsed.model = selectedBackend.modelMap[model];

  return {
    ok: true,
    body: Buffer.from(JSON.stringify(parsed), "utf8"),
    ...(model ? { model } : {}),
    ...(parsed.stream === true ? { stream: true } : {}),
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
  };
}

export function backendForModel(config: GatewayConfig, model: string): GatewayBackend | undefined {
  return config.backends.find((backend) => backend.models.includes(model));
}

function defaultRequester(backend: GatewayBackend, options: RequestOptions, onResponse: (res: IncomingMessage) => void): ClientRequest {
  return (backend.protocol === "https" ? httpsRequest : httpRequest)(options, onResponse);
}

function modelsResponse(config: GatewayConfig): string {
  const data = config.backends.flatMap((backend) => backend.models.map((id) => ({ id, object: "model", owned_by: `llm-runtime-${backend.id}` })));
  return JSON.stringify({ object: "list", data });
}

function logGatewayEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "llm-runtime-gateway", ...event })}\n`);
}

const REQUEST_DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 180];

export class GatewayMetrics {
  readonly httpRequests = new CounterVec("llm_gateway_http_requests_total", "HTTP requests handled by the gateway process.");
  readonly rejectedRequests = new CounterVec("llm_gateway_rejected_requests_total", "Requests rejected locally before reaching an upstream.");
  readonly upstreamRequests = new CounterVec("llm_gateway_upstream_requests_total", "Completed upstream requests routed by backend and model.");
  readonly upstreamErrors = new CounterVec("llm_gateway_upstream_errors_total", "Upstream transport failures routed by backend and model.");
  readonly requestBytes = new CounterVec("llm_gateway_request_bytes_total", "Request bytes sent to upstream backends.");
  readonly responseBytes = new CounterVec("llm_gateway_response_bytes_total", "Response bytes received from upstream backends.");
  readonly inFlight = new GaugeVec("llm_gateway_requests_in_flight", "Current number of in-flight upstream requests.");
  readonly configuredBackends = new GaugeVec("llm_gateway_backend_configured", "Configured gateway backends.");
  readonly configuredModels = new GaugeVec("llm_gateway_model_configured", "Configured gateway models by backend.");
  readonly lastRequestSuccess = new GaugeVec("llm_gateway_backend_last_request_success", "Whether the most recent completed request for a backend/model succeeded (HTTP 2xx/3xx).");
  readonly lastResponseStatus = new GaugeVec("llm_gateway_backend_last_response_status_code", "HTTP status code from the most recent completed request for a backend/model.");
  readonly lastSuccessTimestamp = new GaugeVec("llm_gateway_backend_last_success_timestamp_seconds", "Unix timestamp of the most recent successful request for a backend/model.");
  readonly lastErrorTimestamp = new GaugeVec("llm_gateway_backend_last_error_timestamp_seconds", "Unix timestamp of the most recent failed request for a backend/model.");
  readonly requestDuration = new HistogramVec("llm_gateway_request_duration_seconds", "End-to-end gateway request duration to upstream completion.", REQUEST_DURATION_BUCKETS_SECONDS);
  readonly processUptime = new GaugeVec("llm_gateway_process_uptime_seconds", "Gateway process uptime in seconds.");
  readonly processResidentMemory = new GaugeVec("llm_gateway_process_resident_memory_bytes", "Gateway process resident memory size in bytes.");

  constructor(config: GatewayConfig) {
    for (const backend of config.backends) {
      this.configuredBackends.set({ backend: backend.id }, 1);
      this.inFlight.set({ backend: backend.id }, 0);
      for (const model of backend.models) {
        this.configuredModels.set({ backend: backend.id, model }, 1);
        this.upstreamRequests.inc({ backend: backend.id, model, status_code: "200" }, 0);
        this.upstreamErrors.inc({ backend: backend.id, model, reason: "timeout" }, 0);
        this.upstreamErrors.inc({ backend: backend.id, model, reason: "transport" }, 0);
      }
    }
  }

  recordHttp(method: string, route: string, status: number): void {
    this.httpRequests.inc({ method, route, status_code: String(status) });
  }

  recordRejected(method: string, route: string, status: number, reason: string): void {
    this.recordHttp(method, route, status);
    this.rejectedRequests.inc({ method, route, status_code: String(status), reason });
  }

  startUpstream(backend: GatewayBackend, model: string, bytes: number): void {
    this.inFlight.inc({ backend: backend.id });
    this.requestBytes.inc({ backend: backend.id, model }, bytes);
  }

  finishUpstream(
    backend: GatewayBackend,
    model: string,
    route: string,
    method: string,
    status: number,
    durationMs: number,
    bytes: number,
    downstreamStatus: number = status,
  ): void {
    const labels = { backend: backend.id, model };
    this.inFlight.dec({ backend: backend.id });
    this.upstreamRequests.inc({ ...labels, status_code: String(status) });
    this.responseBytes.inc(labels, bytes);
    this.requestDuration.observe(labels, durationMs / 1000);
    this.recordHttp(method, route, downstreamStatus);
    const now = Date.now() / 1000;
    const success = status >= 200 && status < 400;
    this.lastResponseStatus.set(labels, status);
    this.lastRequestSuccess.set(labels, success ? 1 : 0);
    if (success) this.lastSuccessTimestamp.set(labels, now); else this.lastErrorTimestamp.set(labels, now);
  }

  failUpstream(backend: GatewayBackend, model: string, route: string, method: string, reason: "timeout" | "transport", durationMs: number): void {
    const labels = { backend: backend.id, model };
    this.inFlight.dec({ backend: backend.id });
    this.upstreamErrors.inc({ ...labels, reason });
    this.requestDuration.observe(labels, durationMs / 1000);
    this.lastResponseStatus.set(labels, 502);
    this.lastRequestSuccess.set(labels, 0);
    this.lastErrorTimestamp.set(labels, Date.now() / 1000);
    this.recordHttp(method, route, 502);
  }

  render(): string {
    this.processUptime.set({}, process.uptime());
    this.processResidentMemory.set({}, process.memoryUsage().rss);
    return renderPrometheus([
      this.httpRequests,
      this.rejectedRequests,
      this.upstreamRequests,
      this.upstreamErrors,
      this.requestBytes,
      this.responseBytes,
      this.inFlight,
      this.configuredBackends,
      this.configuredModels,
      this.lastRequestSuccess,
      this.lastResponseStatus,
      this.lastSuccessTimestamp,
      this.lastErrorTimestamp,
      this.requestDuration,
      this.processUptime,
      this.processResidentMemory,
    ]);
  }
}

export function createGatewayMetricsServer(metrics: GatewayMetrics) {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }).end(metrics.render());
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end("not found");
  });
}

export function createGateway(config: GatewayConfig, requester: UpstreamRequester = defaultRequester, metrics: GatewayMetrics = new GatewayMetrics(config)) {
  return createServer((clientReq: IncomingMessage, clientRes: ServerResponse) => {
    const requestId = `gw-${randomUUID()}`;
    const startedAt = Date.now();
    const method = clientReq.method ?? "GET";
    const rawUrl = clientReq.url ?? "/";
    const pathname = pathnameOf(rawUrl);
    const route = config.allowedEndpoints.includes(pathname) ? pathname : "rejected";
    if (method !== "POST" && method !== "GET") { metrics.recordRejected(method, route, 405, "method"); clientRes.writeHead(405).end("method not allowed"); return; }
    if (!config.allowedEndpoints.includes(pathname)) { metrics.recordRejected(method, "rejected", 404, "endpoint"); clientRes.writeHead(404).end("endpoint not allowed"); return; }
    if (pathname === "/v1/models" && method === "GET") {
      metrics.recordHttp(method, pathname, 200);
      clientRes.writeHead(200, { "content-type": "application/json" }).end(modelsResponse(config));
      return;
    }
    if (method !== "POST") { metrics.recordRejected(method, pathname, 405, "method"); clientRes.writeHead(405).end("method not allowed"); return; }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    clientReq.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > config.maxBodyBytes) { aborted = true; metrics.recordRejected(method, pathname, 413, "payload_too_large"); clientRes.writeHead(413).end("payload too large"); clientReq.destroy(); return; }
      chunks.push(chunk);
    });
    clientReq.on("end", () => {
      if (aborted) return;
      const policy = applyBodyPolicy(pathname, Buffer.concat(chunks), config);
      if (!policy.ok) { const status = policy.status ?? 400; metrics.recordRejected(method, pathname, status, "body_policy"); clientRes.writeHead(status).end(policy.message ?? "rejected"); return; }
      if (!policy.model) { metrics.recordRejected(method, pathname, 400, "model_required"); clientRes.writeHead(400).end("model is required"); return; }
      const backend = backendForModel(config, policy.model);
      if (!backend) { metrics.recordRejected(method, pathname, 403, "model_not_allowed"); clientRes.writeHead(403).end("model not allowed"); return; }
      if (backend.id === "subscription" && policy.outputTokenLimit !== undefined && policy.stream === true) {
        metrics.recordRejected(method, pathname, 501, "subscription_stream_output_limit");
        clientRes.writeHead(501).end("OpenAI subscription streaming is disabled while an output-token limit is active");
        return;
      }

      const body = policy.body;
      const headers = sanitizeRequestHeaders(clientReq.headers, backend);
      if (backend.id !== "api") headers["x-llm-gateway-request-id"] = requestId;
      if (body.length) headers["content-length"] = String(body.length);
      logGatewayEvent({ event: "request.start", requestId, method, path: pathname, model: policy.model, backend: backend.id, requestBytes: body.length });
      metrics.startUpstream(backend, policy.model, body.length);
      let upstreamSettled = false;
      const upstream = requester(backend, {
        host: backend.host,
        port: backend.port,
        method,
        path: rawUrl,
        headers,
        timeout: config.upstreamTimeoutMs,
      }, (upstreamRes: IncomingMessage) => {
        const safeHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          if (["set-cookie", "www-authenticate", "authorization"].includes(name.toLowerCase())) continue;
          safeHeaders[name] = value;
        }
        const status = upstreamRes.statusCode ?? 502;
        const validateSubscriptionOutput = backend.id === "subscription" && policy.outputTokenLimit !== undefined;
        if (!validateSubscriptionOutput) {
          clientRes.writeHead(status, safeHeaders);
          let responseBytes = 0;
          upstreamRes.on("data", (chunk: Buffer) => { responseBytes += chunk.length; });
          upstreamRes.on("end", () => {
            const durationMs = Date.now() - startedAt;
            if (!upstreamSettled) { upstreamSettled = true; metrics.finishUpstream(backend, policy.model!, pathname, method, status, durationMs, responseBytes); }
            logGatewayEvent({ event: "request.finish", requestId, model: policy.model, backend: backend.id, status, durationMs, responseBytes });
          });
          upstreamRes.pipe(clientRes);
          return;
        }

        const responseChunks: Buffer[] = [];
        let responseBytes = 0;
        let responseOverflow = false;
        const maxValidatedResponseBytes = Math.max(config.maxBodyBytes * 8, 8 * 1024 * 1024);
        upstreamRes.on("data", (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseOverflow) return;
          if (responseBytes > maxValidatedResponseBytes) { responseOverflow = true; return; }
          responseChunks.push(Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          const durationMs = Date.now() - startedAt;
          const responseBody = Buffer.concat(responseChunks);
          const checked = responseOverflow
            ? { ok: false, message: `subscription upstream response exceeded validation byte limit: ${responseBytes} > ${maxValidatedResponseBytes}` }
            : checkSubscriptionResponseOutputBudget(pathname, status, responseBody, policy.outputTokenLimit);
          const downstreamStatus = checked.ok ? status : 502;

          if (checked.ok) {
            clientRes.writeHead(status, safeHeaders).end(responseBody);
          } else {
            clientRes.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({
              error: {
                message: checked.message ?? "subscription upstream output could not be verified against the requested token limit",
                type: "gateway_output_policy_error",
                request_id: requestId,
              },
            }));
          }

          if (!upstreamSettled) {
            upstreamSettled = true;
            metrics.finishUpstream(backend, policy.model!, pathname, method, status, durationMs, responseBytes, downstreamStatus);
          }
          logGatewayEvent({
            event: "request.finish", requestId, model: policy.model, backend: backend.id, status: downstreamStatus,
            upstreamStatus: status, durationMs, responseBytes, outputPolicyVerified: checked.ok,
            outputTokenLimit: policy.outputTokenLimit, providerOutputTokens: checked.outputTokens,
          });
        });
      });
      upstream.on("timeout", () => {
        const durationMs = Date.now() - startedAt;
        if (!upstreamSettled) { upstreamSettled = true; metrics.failUpstream(backend, policy.model!, pathname, method, "timeout", durationMs); }
        logGatewayEvent({ event: "request.error", requestId, model: policy.model, backend: backend.id, durationMs, error: "upstream timeout" });
        upstream.destroy(new Error("upstream timeout"));
      });
      upstream.on("error", (error) => {
        const durationMs = Date.now() - startedAt;
        if (!upstreamSettled) { upstreamSettled = true; metrics.failUpstream(backend, policy.model!, pathname, method, "transport", durationMs); }
        logGatewayEvent({ event: "request.error", requestId, model: policy.model, backend: backend.id, durationMs, error: error.message.slice(0, 512) });
        if (!clientRes.headersSent) clientRes.writeHead(502).end("upstream error"); else clientRes.end();
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
    clientReq.on("error", () => { if (!clientRes.headersSent) { metrics.recordRejected(method, route, 400, "client_transport"); clientRes.writeHead(400).end("bad request"); } });
  });
}

export function startGateway(config: GatewayConfig = loadGatewayConfigFromEnv()): ReturnType<typeof createGateway> {
  const metrics = new GatewayMetrics(config);
  const server = createGateway(config, defaultRequester, metrics);
  const metricsServer = createGatewayMetricsServer(metrics);
  server.listen(config.listenPort, () => {
    const routes = config.backends.map((backend) => `${backend.id}:${backend.models.join("|")}`).join(",");
    process.stdout.write(`llm-runtime gateway listening on :${config.listenPort} routes=${routes}\n`);
  });
  metricsServer.listen(config.metricsPort, "0.0.0.0", () => {
    process.stdout.write(`llm-runtime gateway metrics listening on :${config.metricsPort}/metrics\n`);
  });
  server.on("close", () => metricsServer.close());
  return server;
}
