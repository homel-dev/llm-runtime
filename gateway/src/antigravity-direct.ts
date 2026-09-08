import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  toGeminiSchema,
  resolveModelProfile,
  AgyRequestSessionStore,
  type AgyRequestSessionContext,
  buildAgyAgentRequestMetadata,
  orderAgyRequestPayloadInPlace,
  buildAntigravityHarnessUserAgent,
  AGY_CLI_VERSION,
} from "./vendor/antigravity-wire.js";

// Module-singleton session store (matches the reference): random-but-stable
// conversation/trajectory ids per session, monotonic timestamps, TTL + LRU.
const requestSessions = new AgyRequestSessionStore("llm-runtime-gateway");

const DEFAULT_CONTROL_BASE = "https://cloudcode-pa.googleapis.com";
const DEFAULT_INFERENCE_BASES = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];
// Default thinking budget for the Pro High wire deployment. This value comes
// from the wire-protocol review and MUST be confirmed against a live Antigravity
// capture; override with ANTIGRAVITY_ADAPTER_PRO_THINKING_BUDGET.
const DEFAULT_PRO_THINKING_BUDGET = 10001;
type SignatureLookup = (id: string) => string | undefined;
const DEFAULT_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_CLIENT_VERSION = AGY_CLI_VERSION;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

export interface AntigravityDirectConfig {
  listenPort: number;
  maxBodyBytes: number;
  timeoutMs: number;
  maxResponseBytes: number;
  idleTimeoutMs: number;
  proThinkingBudget: number;
  models: string[];
  modelMap: Record<string, string>;
  credentialFile: string;
  controlBaseUrl: string;
  inferenceBaseUrls: string[];
  oauthTokenUrl: string;
  oauthClientId: string;
  oauthClientSecret: string;
  userAgent: string;
}

export type AntigravityFetch = typeof fetch;

export interface AntigravityCredential {
  accessToken?: string;
  refreshToken: string;
  expiresAt?: number;
}

export interface AntigravityDirectDependencies {
  fetcher?: AntigravityFetch;
  credentialLoader?: () => AntigravityCredential | Promise<AntigravityCredential>;
  now?: () => number;
}

interface OpenAIToolCall {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

interface OpenAIMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
}

interface OpenAIChatRequest {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  stream?: unknown;
  response_format?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
}

interface CcaPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
}

interface CcaContent {
  role: "user" | "model";
  parts: CcaPart[];
}

interface CcaChunk {
  response?: {
    candidates?: Array<{
      content?: { role?: string; parts?: CcaPart[] };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    responseId?: string;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  error?: { code?: number; message?: string; status?: string };
}

interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

interface ProviderToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

interface ProviderResult {
  text: string;
  toolCalls: ProviderToolCall[];
  finishReason: string;
  usage?: ProviderUsage;
  responseId?: string;
}

function positiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function validPort(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be a valid TCP port`);
  return value;
}

function csv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function modelMapFromEnv(value: string | undefined, models: string[]): Record<string, string> {
  if (!value) return Object.fromEntries(models.map((model) => [model, model]));
  const out: Record<string, string> = {};
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) throw new Error(`invalid ANTIGRAVITY_ADAPTER_MODEL_MAP entry '${entry}', expected gateway-model=wire-model`);
    const exposed = entry.slice(0, eq).trim();
    const wire = entry.slice(eq + 1).trim();
    if (!models.includes(exposed)) throw new Error(`ANTIGRAVITY_ADAPTER_MODEL_MAP references model '${exposed}' not present in ANTIGRAVITY_ADAPTER_MODELS`);
    if (out[exposed]) throw new Error(`duplicate ANTIGRAVITY_ADAPTER_MODEL_MAP entry for '${exposed}'`);
    out[exposed] = wire;
  }
  for (const model of models) if (!out[model]) out[model] = model;
  return out;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  // The Antigravity OAuth client MUST be supplied at runtime (env/Secret). It is
  // deliberately NOT hardcoded in source: a literal client_id/secret trips secret
  // scanning and is a credential-in-repo anti-pattern.
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required; provide the Antigravity OAuth client via env/Secret`);
  return value.trim();
}

export function loadAntigravityDirectConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AntigravityDirectConfig {
  const models = csv(env.ANTIGRAVITY_ADAPTER_MODELS ?? env.GATEWAY_GEMINI_MODELS);
  if (!models.length) throw new Error("ANTIGRAVITY_ADAPTER_MODELS is required");
  if (new Set(models).size !== models.length) throw new Error("ANTIGRAVITY_ADAPTER_MODELS must not contain duplicates");
  const modelMap = modelMapFromEnv(env.ANTIGRAVITY_ADAPTER_MODEL_MAP, models);
  const home = env.HOME || "/antigravity-auth";
  const inferenceBaseUrls = csv(env.ANTIGRAVITY_ADAPTER_INFERENCE_BASE_URLS);
  const clientVersion = env.ANTIGRAVITY_ADAPTER_CLIENT_VERSION ?? DEFAULT_CLIENT_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(clientVersion)) throw new Error("ANTIGRAVITY_ADAPTER_CLIENT_VERSION must be semver-like X.Y.Z");
  return {
    listenPort: validPort("ANTIGRAVITY_ADAPTER_LISTEN_PORT", Number(env.ANTIGRAVITY_ADAPTER_LISTEN_PORT ?? "10532")),
    maxBodyBytes: positiveInt("ANTIGRAVITY_ADAPTER_MAX_BODY_BYTES", Number(env.ANTIGRAVITY_ADAPTER_MAX_BODY_BYTES ?? String(2 * 1024 * 1024))),
    timeoutMs: positiveInt("ANTIGRAVITY_ADAPTER_TIMEOUT_MS", Number(env.ANTIGRAVITY_ADAPTER_TIMEOUT_MS ?? "900000")),
    maxResponseBytes: positiveInt("ANTIGRAVITY_ADAPTER_MAX_STDOUT_BYTES", Number(env.ANTIGRAVITY_ADAPTER_MAX_STDOUT_BYTES ?? String(8 * 1024 * 1024))),
    idleTimeoutMs: positiveInt("ANTIGRAVITY_ADAPTER_IDLE_TIMEOUT_MS", Number(env.ANTIGRAVITY_ADAPTER_IDLE_TIMEOUT_MS ?? "120000")),
    proThinkingBudget: positiveInt("ANTIGRAVITY_ADAPTER_PRO_THINKING_BUDGET", Number(env.ANTIGRAVITY_ADAPTER_PRO_THINKING_BUDGET ?? String(DEFAULT_PRO_THINKING_BUDGET))),
    models,
    modelMap,
    credentialFile: env.ANTIGRAVITY_ADAPTER_CREDENTIAL_FILE ?? join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    controlBaseUrl: (env.ANTIGRAVITY_ADAPTER_CONTROL_BASE_URL ?? DEFAULT_CONTROL_BASE).replace(/\/+$/, ""),
    inferenceBaseUrls: (inferenceBaseUrls.length ? inferenceBaseUrls : DEFAULT_INFERENCE_BASES).map((url) => url.replace(/\/+$/, "")),
    oauthTokenUrl: env.ANTIGRAVITY_ADAPTER_OAUTH_TOKEN_URL ?? DEFAULT_OAUTH_TOKEN_URL,
    oauthClientId: requiredEnv(env, "ANTIGRAVITY_ADAPTER_OAUTH_CLIENT_ID"),
    oauthClientSecret: requiredEnv(env, "ANTIGRAVITY_ADAPTER_OAUTH_CLIENT_SECRET"),
    userAgent: env.ANTIGRAVITY_ADAPTER_USER_AGENT ?? buildAntigravityHarnessUserAgent(clientVersion),
  };
}

function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function credentialFromUnknown(raw: unknown): AntigravityCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Antigravity credential is not a JSON object");
  const root = raw as Record<string, unknown>;
  const nested = root.token && typeof root.token === "object" && !Array.isArray(root.token) ? root.token as Record<string, unknown> : undefined;
  const rec = nested ?? root;
  const access = rec.access_token ?? rec.accessToken ?? rec.access;
  const refresh = rec.refresh_token ?? rec.refreshToken ?? rec.refresh;
  const expiry = rec.expiry ?? rec.expiry_date ?? rec.expiryDate ?? rec.expires_at ?? rec.expiresAt ?? rec.expires;
  if (typeof refresh !== "string" || !refresh.trim()) throw new Error("Antigravity credential has no refresh_token");
  return {
    ...(typeof access === "string" && access.trim() ? { accessToken: access } : {}),
    refreshToken: refresh,
    ...(parseExpiry(expiry) !== undefined ? { expiresAt: parseExpiry(expiry)! } : {}),
  };
}

function unwrapKeyringEnvelope(value: string): string {
  // go-keyring (used by agy) may store secrets base64-wrapped as
  // "go-keyring-base64:<base64>". Decode that envelope before JSON parsing.
  const prefix = "go-keyring-base64:";
  if (value.startsWith(prefix)) {
    try { return Buffer.from(value.slice(prefix.length), "base64").toString("utf8").trim(); }
    catch { throw new Error("Antigravity keyring credential has a malformed go-keyring-base64 envelope"); }
  }
  return value;
}

function readCredentialFromDiskOrKeyring(config: AntigravityDirectConfig): AntigravityCredential {
  let raw = "";
  if (existsSync(config.credentialFile)) raw = unwrapKeyringEnvelope(readFileSync(config.credentialFile, "utf8").trim());
  if (!raw) {
    const lookup = spawnSync("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], {
      encoding: "utf8",
      env: process.env,
      timeout: 10_000,
    });
    if (lookup.error) throw new Error(`Antigravity credential file is absent and keyring lookup failed: ${lookup.error.message}`);
    if (lookup.status !== 0 || !lookup.stdout.trim()) throw new Error("No Antigravity OAuth credential found; run task gateway:gemini:login");
    raw = unwrapKeyringEnvelope(lookup.stdout.trim());
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Antigravity OAuth credential is not valid JSON"); }
  return credentialFromUnknown(parsed);
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) return null;
    const rec = part as Record<string, unknown>;
    if ((rec.type === "text" || rec.type === "input_text" || rec.type === "output_text") && typeof rec.text === "string") out.push(rec.text);
    else return null;
  }
  return out.join("\n");
}

function resolveRefs(root: unknown): unknown {
  if (!root || typeof root !== "object") return root;
  const defs: Record<string, unknown> = {};
  for (const key of ["$defs", "definitions"] as const) {
    const bag = (root as Record<string, unknown>)[key];
    if (bag && typeof bag === "object" && !Array.isArray(bag)) {
      for (const [name, schema] of Object.entries(bag as Record<string, unknown>)) if (!(name in defs)) defs[name] = schema;
    }
  }
  const deref = (ref: string): unknown => {
    const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    const name = match?.[1];
    if (name === undefined) return undefined;
    return defs[name.replace(/~1/g, "/").replace(/~0/g, "~")];
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 64) return node;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    if (!node || typeof node !== "object") return node;
    const rec = node as Record<string, unknown>;
    if (typeof rec.$ref === "string") {
      const target = deref(rec.$ref);
      if (target && typeof target === "object") {
        const { $ref: _drop, ...siblings } = rec;
        return walk({ ...(target as Record<string, unknown>), ...siblings }, depth + 1);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(rec)) {
      if (key === "$defs" || key === "definitions") continue;
      out[key] = walk(entry, depth + 1);
    }
    return out;
  };
  return walk(root, 0);
}

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if ([
      "$schema", "$id", "$ref", "$defs", "definitions", "$dynamicRef", "$dynamicAnchor",
      "examples", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "patternProperties",
      "additionalProperties", "propertyNames", "minItems", "maxItems", "minLength", "maxLength",
      "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "pattern", "format",
      "dependencies", "dependentSchemas", "dependentRequired", "deprecated", "readOnly", "writeOnly",
      "$comment", "x-mcp-header", "minContains", "maxContains",
    ].includes(key)) continue;
    if (key === "const") {
      out.enum = [sanitizeSchema(raw)];
      continue;
    }
    out[key] = sanitizeSchema(raw);
  }
  return out;
}

function normalizeTools(tools: unknown): Array<{ functionDeclarations: Record<string, unknown>[] }> | undefined {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) throw new Error("tools must be an array");
  if (!tools.length) return undefined;
  const declarations = tools.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`tools[${index}] must be an object`);
    const rec = entry as Record<string, unknown>;
    if (rec.type !== "function" || !rec.function || typeof rec.function !== "object" || Array.isArray(rec.function)) throw new Error(`tools[${index}] must be an OpenAI function tool`);
    const fn = rec.function as Record<string, unknown>;
    if (typeof fn.name !== "string" || !fn.name) throw new Error(`tools[${index}].function.name is required`);
    const parameters = fn.parameters === undefined ? { type: "OBJECT", properties: {} } : toGeminiSchema(resolveRefs(fn.parameters));
    return {
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters,
    };
  });
  return [{ functionDeclarations: declarations }];
}

function toolConfig(toolChoice: unknown, toolsPresent: boolean): Record<string, unknown> | undefined {
  if (!toolsPresent) {
    if (toolChoice !== undefined && toolChoice !== null && toolChoice !== "none") throw new Error("tool_choice requires tools");
    return undefined;
  }
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") return { functionCallingConfig: { mode: "VALIDATED" } };
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const rec = toolChoice as Record<string, unknown>;
    const fn = rec.function;
    if (rec.type === "function" && fn && typeof fn === "object" && !Array.isArray(fn) && typeof (fn as Record<string, unknown>).name === "string") {
      return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [(fn as Record<string, unknown>).name] } };
    }
  }
  throw new Error("unsupported tool_choice for Gemini subscription adapter");
}

function parseToolArguments(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") throw new Error(`${label} arguments must be a JSON string`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} arguments are not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} arguments must decode to an object`);
  return parsed as Record<string, unknown>;
}

function buildContents(messages: unknown, signatureLookup?: SignatureLookup): { systemInstruction?: { role: "user"; parts: Array<{ text: string }> }; contents: CcaContent[] } {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array");
  const systemParts: string[] = [];
  const contents: CcaContent[] = [];
  const toolNames = new Map<string, string>();

  const appendUserPart = (part: CcaPart): void => {
    const last = contents[contents.length - 1];
    if (last?.role === "user" && last.parts.some((existing) => existing.functionResponse) && part.functionResponse) last.parts.push(part);
    else contents.push({ role: "user", parts: [part] });
  };

  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`messages[${index}] must be an object`);
    const msg = entry as OpenAIMessage;
    if (typeof msg.role !== "string") throw new Error(`messages[${index}].role is required`);

    if (msg.role === "system" || msg.role === "developer") {
      const content = textContent(msg.content);
      if (content === null) throw new Error(`messages[${index}] contains unsupported non-text content`);
      if (content.trim()) systemParts.push(`${msg.role.toUpperCase()}:\n${content}`);
      continue;
    }

    if (msg.role === "user") {
      const content = textContent(msg.content);
      if (content === null) throw new Error(`messages[${index}] contains unsupported non-text content`);
      if (content.trim()) contents.push({ role: "user", parts: [{ text: content }] });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: CcaPart[] = [];
      const content = textContent(msg.content);
      if (content === null) throw new Error(`messages[${index}] contains unsupported non-text content`);
      if (content.trim()) parts.push({ text: content });
      if (msg.tool_calls !== undefined) {
        if (!Array.isArray(msg.tool_calls)) throw new Error(`messages[${index}].tool_calls must be an array`);
        let firstToolCall = true;
        for (let callIndex = 0; callIndex < msg.tool_calls.length; callIndex += 1) {
          const rawCall = msg.tool_calls[callIndex] as OpenAIToolCall;
          if (!rawCall || typeof rawCall !== "object" || rawCall.type !== "function" || !rawCall.function) throw new Error(`messages[${index}].tool_calls[${callIndex}] is invalid`);
          const name = rawCall.function.name;
          if (typeof name !== "string" || !name) throw new Error(`messages[${index}].tool_calls[${callIndex}].function.name is required`);
          const args = parseToolArguments(rawCall.function.arguments, `messages[${index}].tool_calls[${callIndex}]`);
          const callId = typeof rawCall.id === "string" && rawCall.id ? rawCall.id : undefined;
          if (callId) toolNames.set(callId, name);
          // Prefer the exact provider-issued thoughtSignature for this call; the
          // sentinel is a last-resort ONLY for imported history where no real
          // signature was ever captured (i.e. a store miss on the first call).
          const realSignature = callId ? signatureLookup?.(callId) : undefined;
          const part: CcaPart = { functionCall: { name, args, ...(callId ? { id: callId } : {}) } };
          if (realSignature) part.thoughtSignature = realSignature;
          else if (firstToolCall) part.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
          firstToolCall = false;
          parts.push(part);
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    if (msg.role === "tool") {
      if (typeof msg.tool_call_id !== "string" || !msg.tool_call_id) throw new Error(`messages[${index}].tool_call_id is required`);
      const name = toolNames.get(msg.tool_call_id);
      if (!name) throw new Error(`messages[${index}] references unknown tool_call_id '${msg.tool_call_id}'`);
      const content = textContent(msg.content);
      if (content === null) throw new Error(`messages[${index}] contains unsupported non-text tool content`);
      // Preserve native structure: if the tool returned a JSON object, pass it
      // through as the structured functionResponse rather than flattening it to a
      // string; only wrap genuine text in { output }.
      // Mechanical translation only: an OpenAI tool result is a string. Do NOT
      // reinterpret a string that happens to be JSON as a structured object;
      // preserve the original text under { output } exactly.
      appendUserPart({ functionResponse: { name, ...(msg.tool_call_id ? { id: msg.tool_call_id } : {}), response: { output: content } } });
      continue;
    }

    throw new Error(`messages[${index}].role '${msg.role}' is not supported by the Gemini subscription adapter`);
  }

  if (!contents.length) throw new Error("conversation has no user/model content after normalization");
  return {
    ...(systemParts.length ? { systemInstruction: { role: "user" as const, parts: systemParts.map((text) => ({ text })) } } : {}),
    contents,
  };
}

function requestedOutputTokenLimit(request: OpenAIChatRequest): number | undefined {
  const values = [request.max_tokens, request.max_completion_tokens, request.max_output_tokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return values.length ? Math.min(...values) : undefined;
}

function responseSchema(responseFormat: unknown): Record<string, unknown> | undefined {
  if (responseFormat === undefined || responseFormat === null) return undefined;
  if (!responseFormat || typeof responseFormat !== "object" || Array.isArray(responseFormat)) throw new Error("response_format must be an object");
  const rec = responseFormat as Record<string, unknown>;
  if (rec.type === "text") return undefined;
  if (rec.type === "json_object") return { type: "object" };
  if (rec.type === "json_schema") {
    const descriptor = rec.json_schema;
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error("response_format.json_schema must be an object");
    const schema = (descriptor as Record<string, unknown>).schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("response_format.json_schema.schema must be a JSON Schema object");
    return sanitizeSchema(resolveRefs(schema)) as Record<string, unknown>;
  }
  throw new Error(`response_format.type '${String(rec.type)}' is not supported by the Gemini subscription adapter`);
}

function stableSessionId(messages: unknown): string {
  if (Array.isArray(messages)) {
    for (const entry of messages) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      if (rec.role !== "user") continue;
      const content = textContent(rec.content);
      if (!content) continue;
      const digest = createHash("sha256").update(content).digest();
      const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
      return `-${value}`;
    }
  }
  return `-${BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 16)}`) & 0x7fffffffffffffffn}`;
}

function normalizeWireModel(wireModel: string): string {
  // Antigravity discovery still advertises gemini-3.1-pro-high, but the direct
  // streamGenerateContent deployment rejects it. gemini-pro-agent is the live
  // high-effort wire deployment for the same Gemini 3.1 Pro tier.
  return wireModel === "gemini-3.1-pro-high" ? "gemini-pro-agent" : wireModel;
}

function requestEnvelope(request: OpenAIChatRequest, wireModel: string, projectId: string, opts: { signatureLookup?: SignatureLookup; session?: AgyRequestSessionContext; timestamp?: number } = {}): Record<string, unknown> {
  const normalized = buildContents(request.messages, opts.signatureLookup);
  const tools = normalizeTools(request.tools);
  const generationConfig: Record<string, unknown> = {};
  if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) generationConfig.temperature = request.temperature;
  if (typeof request.top_p === "number" && Number.isFinite(request.top_p)) generationConfig.topP = request.top_p;
  const outputLimit = requestedOutputTokenLimit(request);
  const profile = resolveModelProfile(wireModel);
  if (profile) {
    // Thinking deployment: send the model-safe output cap and thinking budget
    // (includeThoughts) from the pinned wire profile; the gateway still enforces
    // any smaller caller limit from terminal usage. Sending a tiny caller cap
    // would starve the reasoning budget and yield an invalid provider request.
    generationConfig.maxOutputTokens = profile.maxOutputTokens;
    generationConfig.thinkingConfig = { includeThoughts: profile.includeThoughts, thinkingBudget: profile.thinkingBudget };
  } else if (outputLimit !== undefined) {
    generationConfig.maxOutputTokens = outputLimit;
  }
  const schema = responseSchema(request.response_format);
  if (schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseJsonSchema = schema;
  }
  const req: Record<string, unknown> = {
    contents: normalized.contents,
    ...(normalized.systemInstruction ? { systemInstruction: normalized.systemInstruction } : {}),
    ...(tools ? { tools, toolConfig: toolConfig(request.tool_choice, true) } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
  // Session-scoped Antigravity metadata (trajectory/conversation/monotonic step/
  // model_enum) + captured inner field order, ported from the pinned wire layer.
  const session = opts.session ?? requestSessions.getOrCreate(stableSessionId(request.messages));
  const timestamp = opts.timestamp ?? Date.now();
  const metadata = buildAgyAgentRequestMetadata(session, req, wireModel, timestamp);
  req.sessionId = metadata.sessionId;
  req.labels = metadata.labels;
  orderAgyRequestPayloadInPlace(req);
  return {
    project: projectId,
    requestId: metadata.requestId,
    request: req,
    model: wireModel,
    userAgent: "antigravity",
    requestType: "agent",
  };
}

function usageFromChunk(chunk: CcaChunk): ProviderUsage | undefined {
  const usage = chunk.response?.usageMetadata;
  if (!usage) return undefined;
  const prompt = usage.promptTokenCount;
  const candidates = usage.candidatesTokenCount;
  const thoughts = usage.thoughtsTokenCount ?? 0;
  if (
    typeof prompt !== "number" || !Number.isFinite(prompt) || prompt < 0 ||
    typeof candidates !== "number" || !Number.isFinite(candidates) || candidates < 0 ||
    typeof thoughts !== "number" || !Number.isFinite(thoughts) || thoughts < 0
  ) return undefined;

  // Google accounts reasoning/thought tokens as generated output. Enforcing only
  // candidatesTokenCount would let a reasoning-heavy response exceed the caller's
  // output budget while the gateway reported it as compliant.
  const completion = candidates + thoughts;
  const providerTotal = usage.totalTokenCount;
  const total = typeof providerTotal === "number" && Number.isFinite(providerTotal) && providerTotal >= prompt + completion
    ? providerTotal
    : prompt + completion;
  const cached = usage.cachedContentTokenCount;
  if (cached !== undefined && (typeof cached !== "number" || !Number.isFinite(cached) || cached < 0 || cached > prompt)) return undefined;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    ...(typeof cached === "number" ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(thoughts > 0 ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {}),
  };
}

function openAIFinishReason(providerReason: string, hasToolCalls: boolean): string {
  if (!providerReason) throw new Error("Antigravity stream ended without a terminal finishReason");
  if (["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "OTHER", "FINISH_REASON_UNSPECIFIED"].includes(providerReason)) {
    throw new Error(`Antigravity provider ended with failure finishReason ${providerReason}`);
  }
  if (hasToolCalls && (providerReason === "STOP" || providerReason === "MAX_TOKENS")) return "tool_calls";
  if (providerReason === "MAX_TOKENS") return "length";
  if (["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"].includes(providerReason)) return "content_filter";
  if (providerReason === "STOP") return "stop";
  throw new Error(`Antigravity provider returned unsupported finishReason ${providerReason}`);
}

function sseData(value: unknown): string {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}

async function* readSseJson(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal, idleMs: number): AsyncGenerator<CcaChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  // Idle/first-byte watchdog: if the provider sends headers and then stalls,
  // reject after idleMs of no data instead of hanging until the total deadline.
  const readWithIdleTimeout = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Antigravity upstream idle for ${idleMs}ms without data`)), idleMs);
      (timer as { unref?: () => void }).unref?.();
      reader.read().then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); reject(error); });
    });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Antigravity upstream request aborted");
      const { done, value } = await readWithIdleTimeout();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Antigravity upstream stream exceeded byte limit: ${bytes} > ${maxBytes}`);
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data || data === "[DONE]") continue;
        let parsed: unknown;
        try { parsed = JSON.parse(data); }
        catch { throw new Error(`Antigravity upstream emitted malformed SSE JSON: ${data.slice(0, 512)}`); }
        yield parsed as CcaChunk;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data && data !== "[DONE]") {
        let parsed: unknown;
        try { parsed = JSON.parse(data); }
        catch { throw new Error(`Antigravity upstream emitted malformed terminal SSE JSON: ${data.slice(0, 512)}`); }
        yield parsed as CcaChunk;
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function logEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "llm-runtime-antigravity-direct", ...event })}\n`);
}

function providerError(message: string, requestId: string): Record<string, unknown> {
  return { error: { message, type: "gemini_subscription_error", request_id: requestId } };
}

export function createAntigravityDirectAdapter(config: AntigravityDirectConfig, deps: AntigravityDirectDependencies = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const loadCredential = deps.credentialLoader ?? (() => readCredentialFromDiskOrKeyring(config));
  // Bounded store of provider-issued thoughtSignatures, keyed by the OpenAI
  // tool_call id we surfaced. Replayed assistant turns look up the exact
  // signature here so it round-trips to Cloud Code Assist instead of the sentinel.
  const SIGNATURE_STORE_MAX = 1024;
  const signatureStore = new Map<string, string>();
  const rememberSignature = (id: string, signature: string): void => {
    if (signatureStore.has(id)) signatureStore.delete(id);
    signatureStore.set(id, signature);
    while (signatureStore.size > SIGNATURE_STORE_MAX) {
      const oldest = signatureStore.keys().next().value;
      if (oldest === undefined) break;
      signatureStore.delete(oldest);
    }
  };
  const signatureLookup: SignatureLookup = (id) => signatureStore.get(id);
  let credential: AntigravityCredential | undefined;
  let projectId: string | undefined;
  let refreshPromise: Promise<string> | undefined;
  let projectPromise: Promise<string> | undefined;

  const getCredential = async (): Promise<AntigravityCredential> => {
    credential ??= await loadCredential();
    return credential;
  };

  const refreshAccessToken = (): Promise<string> => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const current = await getCredential();
      const body = new URLSearchParams({
        client_id: config.oauthClientId,
        client_secret: config.oauthClientSecret,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      });
      const response = await fetcher(config.oauthTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Antigravity OAuth refresh failed: HTTP ${response.status}: ${text.slice(0, 1024)}`);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; }
      catch { throw new Error("Antigravity OAuth refresh returned non-JSON"); }
      if (typeof parsed.access_token !== "string" || !parsed.access_token) throw new Error("Antigravity OAuth refresh returned no access_token");
      const expiresNumeric = typeof parsed.expires_in === "number" ? parsed.expires_in : Number(parsed.expires_in);
      const expiresIn = Number.isFinite(expiresNumeric) && expiresNumeric > 0 ? expiresNumeric : 3600;
      credential = {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : current.refreshToken,
        expiresAt: now() + expiresIn * 1000,
      };
      return parsed.access_token;
    })().finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  };

  const accessToken = async (forceRefresh = false): Promise<string> => {
    const current = await getCredential();
    if (!forceRefresh && current.accessToken && (current.expiresAt === undefined || current.expiresAt > now() + 60_000)) return current.accessToken;
    return refreshAccessToken();
  };

  const cloudCodeJson = async (path: string, body: Record<string, unknown>, allowRefresh = true): Promise<Record<string, unknown>> => {
    const token = await accessToken(false);
    const response = await fetcher(`${config.controlBaseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": config.userAgent },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 60_000)),
    });
    if (response.status === 401 && allowRefresh) {
      await accessToken(true);
      return cloudCodeJson(path, body, false);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Antigravity control-plane ${path} failed: HTTP ${response.status}: ${text.slice(0, 2048)}`);
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error(`Antigravity control-plane ${path} returned non-JSON`); }
  };

  const discoverProject = (): Promise<string> => {
    if (projectId) return Promise.resolve(projectId);
    if (projectPromise) return projectPromise;
    projectPromise = (async () => {
      const metadata = { ideType: "ANTIGRAVITY" };
      let loaded = await cloudCodeJson("/v1internal:loadCodeAssist", { metadata });
      const extract = (value: Record<string, unknown>): string | undefined => {
        const field = value.cloudaicompanionProject;
        if (typeof field === "string" && field) return field;
        // Real second form: cloudaicompanionProject: { id: "..." }
        if (field && typeof field === "object" && !Array.isArray(field)) {
          const id = (field as Record<string, unknown>).id;
          if (typeof id === "string" && id) return id;
        }
        return undefined;
      };
      let project = extract(loaded);

      // The native Antigravity/Cloud Code flow binds an already-discovered project
      // back into loadCodeAssist when paidTier is absent. This second call resolves
      // the account/tier state used by consumer subscriptions before inference.
      if (project && (loaded.paidTier === undefined || loaded.paidTier === null)) {
        loaded = await cloudCodeJson("/v1internal:loadCodeAssist", { cloudaicompanionProject: project, metadata });
        project = extract(loaded) ?? project;
      }

      // Inference does NOT change account state. Login/onboarding is the job of
      // `task gateway:gemini:login` (agy). If the account has no resolved tier or
      // project here, fail closed rather than silently onboarding a free tier.
      if (!project) throw new Error("Antigravity loadCodeAssist did not return cloudaicompanionProject");
      projectId = project;
      return project;
    })().finally(() => { projectPromise = undefined; });
    return projectPromise;
  };

  const callInference = async (wireModel: string, request: OpenAIChatRequest, signal: AbortSignal): Promise<Response> => {
    const project = await discoverProject();
    const sessionKey = stableSessionId(request.messages);
    const { session, timestamp } = requestSessions.beginRequest(sessionKey);
    const payload = requestEnvelope(request, wireModel, project, { signatureLookup, session, timestamp });
    let lastError: Error | undefined;
    let forcedRefresh = false;
    for (const base of config.inferenceBaseUrls) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await accessToken(forcedRefresh);
        forcedRefresh = false;
        let response: Response;
        try {
          response = await fetcher(`${base}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "text/event-stream",
              "user-agent": config.userAgent,
            },
            body: JSON.stringify(payload),
            signal,
          });
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          break;
        }
        if (response.ok) return response;
        const text = await response.text();
        if (response.status === 401 && attempt === 0) {
          forcedRefresh = true;
          continue;
        }
        lastError = new Error(`Antigravity inference ${base} failed: HTTP ${response.status}: ${text.slice(0, 2048)}`);
        if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) throw lastError;
        break;
      }
    }
    throw lastError ?? new Error("Antigravity inference failed on every configured endpoint");
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = typeof req.headers["x-llm-gateway-request-id"] === "string" ? req.headers["x-llm-gateway-request-id"] : `agy-direct-${randomUUID()}`;
    const started = now();
    if (req.method === "GET" && req.url === "/healthz") { sendJson(res, 200, { ok: true, transport: "cloud-code-assist-direct", models: config.models }); return; }
    if (req.method !== "POST" || (req.url !== "/v1/chat/completions" && req.url !== "/v1/responses")) { sendJson(res, 404, { error: { message: "endpoint not supported by Gemini subscription adapter" } }); return; }
    if (req.url === "/v1/responses") { sendJson(res, 501, { error: { message: "Gemini subscription direct adapter currently supports /v1/chat/completions only" } }); return; }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > config.maxBodyBytes) {
        aborted = true;
        sendJson(res, 413, { error: { message: "payload too large" } });
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", async () => {
      if (aborted) return;
      let body: OpenAIChatRequest;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OpenAIChatRequest; }
      catch { sendJson(res, 400, { error: { message: "invalid JSON body" } }); return; }
      const model = typeof body.model === "string" ? body.model : "";
      if (!config.models.includes(model)) { sendJson(res, 403, { error: { message: "model not allowed" } }); return; }
      const wireModel = normalizeWireModel(config.modelMap[model]!);
      try {
        buildContents(body.messages);
        normalizeTools(body.tools);
        responseSchema(body.response_format);
        toolConfig(body.tool_choice, Array.isArray(body.tools) && body.tools.length > 0);
      } catch (error) {
        sendJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
        return;
      }

      const stream = body.stream === true;
      const outputLimit = requestedOutputTokenLimit(body);
      const bufferForPolicy = stream && outputLimit !== undefined;
      logEvent({ event: "request.start", requestId, model, providerModel: wireModel, requestBytes: bytes, stream, bufferedForOutputPolicy: bufferForPolicy });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`Antigravity direct request timed out after ${config.timeoutMs}ms`)), config.timeoutMs);
      timer.unref();
      req.once("aborted", () => controller.abort(new Error("client aborted request")));
      res.once("close", () => { if (!res.writableEnded) controller.abort(new Error("client connection closed")); });

      try {
        const upstream = await callInference(wireModel, body, controller.signal);
        if (!upstream.body) throw new Error("Antigravity inference returned no response body");
        const result: ProviderResult = { text: "", toolCalls: [], finishReason: "" };
        const pendingSse: string[] = [];
        const completionId = `chatcmpl-gateway-gemini-${randomUUID()}`;
        let created = Math.floor(now() / 1000);
        let terminalUsage: ProviderUsage | undefined;
        const emit = (payload: Record<string, unknown>): void => {
          const encoded = sseData(payload);
          if (bufferForPolicy) pendingSse.push(encoded);
          else res.write(encoded);
        };
        if (stream && !bufferForPolicy) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (stream) emit({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

        // Antigravity emits a batch thoughtSignature on a preceding empty signed
        // thought part; carry it onto the first functionCall of the batch.
        let pendingThoughtSignature: string | undefined;
        for await (const chunk of readSseJson(upstream.body, config.maxResponseBytes, controller.signal, config.idleTimeoutMs)) {
          if (chunk.error) throw new Error(`Antigravity stream error${chunk.error.code ? ` ${chunk.error.code}` : ""}: ${chunk.error.message ?? chunk.error.status ?? "unknown"}`);
          const responseData = chunk.response;
          if (!responseData) continue;
          if (responseData.promptFeedback?.blockReason) throw new Error(`Antigravity request blocked (${responseData.promptFeedback.blockReason})${responseData.promptFeedback.blockReasonMessage ? `: ${responseData.promptFeedback.blockReasonMessage}` : ""}`);
          if (responseData.responseId) result.responseId = responseData.responseId;
          const usage = usageFromChunk(chunk);
          if (usage) terminalUsage = usage;
          const candidate = responseData.candidates?.[0];
          for (const part of candidate?.content?.parts ?? []) {
            if (part.thought === true && !part.text && part.thoughtSignature) { pendingThoughtSignature = part.thoughtSignature; continue; }
            if (typeof part.text === "string" && part.text && part.thought !== true) {
              result.text += part.text;
              if (stream) emit({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }] });
            }
            if (part.functionCall?.name) {
              const id = part.functionCall.id || `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
              const signature = part.thoughtSignature ?? pendingThoughtSignature;
              pendingThoughtSignature = undefined;
              const tool: ProviderToolCall = { id, name: part.functionCall.name, args: part.functionCall.args ?? {}, ...(signature ? { thoughtSignature: signature } : {}) };
              if (signature) rememberSignature(id, signature);
              result.toolCalls.push(tool);
              if (stream) emit({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: result.toolCalls.length - 1, id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }, finish_reason: null }] });
            }
          }
          if (candidate?.finishReason) result.finishReason = candidate.finishReason;
        }

        result.usage = terminalUsage;
        if (!result.text && result.toolCalls.length === 0) throw new Error("Antigravity stream ended without assistant content or tool calls");
        if (outputLimit !== undefined) {
          if (!terminalUsage) throw new Error("Antigravity response has no trustworthy token usage required by gateway output-token policy");
          // Enforce the caller's limit on VISIBLE output only. Reasoning/thought
          // tokens are separately bounded by the model thinkingBudget and reported
          // under reasoning_tokens; counting them here would fail a legitimate
          // thinking-model answer whose visible output is within budget.
          const visibleOutput = terminalUsage.completion_tokens - (terminalUsage.completion_tokens_details?.reasoning_tokens ?? 0);
          if (visibleOutput > outputLimit) throw new Error(`Antigravity visible output exceeded gateway token policy: ${visibleOutput} > ${outputLimit}`);
        }
        const finishReason = openAIFinishReason(result.finishReason, result.toolCalls.length > 0);
        if (stream) {
          emit({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(terminalUsage ? { usage: terminalUsage } : {}) });
          const done = sseData("[DONE]");
          if (bufferForPolicy) pendingSse.push(done); else res.end(done);
          if (bufferForPolicy) {
            const completeBody = pendingSse.join("");
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "content-length": String(Buffer.byteLength(completeBody)) }).end(completeBody);
          }
        } else {
          sendJson(res, 200, {
            id: completionId,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: result.text || null, ...(result.toolCalls.length ? { tool_calls: result.toolCalls.map((tool) => ({ id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : {}) }, finish_reason: finishReason }],
            ...(terminalUsage ? { usage: terminalUsage } : {}),
          });
        }
        requestSessions.completeExecution(stableSessionId(body.messages));
        logEvent({ event: "request.finish", requestId, model, providerModel: wireModel, status: 200, durationMs: now() - started, providerResponseId: result.responseId, providerOutputTokens: terminalUsage?.completion_tokens, toolCalls: result.toolCalls.length, stream });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logEvent({ event: "request.error", requestId, model, providerModel: wireModel, status: 502, durationMs: now() - started, error: message.slice(0, 2048) });
        if (!res.headersSent) sendJson(res, 502, providerError(message, requestId));
        else {
          try { res.write(sseData({ error: { message, type: "gemini_subscription_error", request_id: requestId } })); } catch {}
          res.end();
        }
      } finally {
        clearTimeout(timer);
      }
    });
    req.on("error", () => { if (!res.headersSent) sendJson(res, 400, { error: { message: "bad request" } }); });
  });
}

export function startAntigravityDirectAdapter(config: AntigravityDirectConfig = loadAntigravityDirectConfigFromEnv()): ReturnType<typeof createAntigravityDirectAdapter> {
  const server = createAntigravityDirectAdapter(config);
  server.listen(config.listenPort, "127.0.0.1", () => {
    logEvent({ event: "startup", listen: `127.0.0.1:${config.listenPort}`, models: config.models, modelMap: config.modelMap, inferenceBaseUrls: config.inferenceBaseUrls });
  });
  return server;
}
