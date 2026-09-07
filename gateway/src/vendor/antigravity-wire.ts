/**
 * Vendored Antigravity / Cloud Code Assist wire layer.
 *
 * Faithful TypeScript port of the reverse-engineered wire protocol from
 *   @cortexkit/antigravity-auth-core@2.2.1
 * (dist/transform/gemini.js, dist/agy-request-metadata.js, dist/fingerprint.js,
 *  dist/transform/model-resolver.js, dist/model-registry.js).
 *
 * PINNED to that exact version on purpose: this is the fragile, undocumented
 * surface that Google rotates. Update ONLY by an explicit, reviewed bump of the
 * upstream version below and a re-port — never by implicit drift. Do not edit the
 * ported constants ad hoc; they are captured wire values, not free parameters.
 *
 * Upstream: https://github.com/cortexkit/antigravity-auth   npm: 2.2.1
 */

import * as crypto from "node:crypto";
import { Buffer } from "node:buffer";

// ------------------------------------------------------------------ schema ----
// Ported from transform/gemini.js. Tool functionDeclarations[].parameters must be
// Gemini protobuf Schema (UPPERCASE types, unsupported keywords stripped) — NOT
// plain JSON Schema. (responseJsonSchema stays lowercase JSON Schema elsewhere.)

const UNSUPPORTED_SCHEMA_FIELDS = new Set<string>([
  "additionalProperties", "$schema", "$id", "$comment", "$ref", "$defs",
  "definitions", "const", "contentMediaType", "contentEncoding", "if", "then",
  "else", "not", "patternProperties", "unevaluatedProperties", "unevaluatedItems",
  "dependentRequired", "dependentSchemas", "propertyNames", "minContains", "maxContains",
]);

const NUMERIC_SCHEMA_CONSTRAINTS = new Set<string>([
  "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);

export function toGeminiSchema(schema: unknown, options: { moveNumericConstraintsToDescription?: boolean } = {}): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const inputSchema = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const numericConstraintHints: string[] = [];

  const propertyNames = new Set<string>();
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    for (const propName of Object.keys(inputSchema.properties as Record<string, unknown>)) propertyNames.add(propName);
  }

  for (const [key, value] of Object.entries(inputSchema)) {
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
    if (key === "type" && typeof value === "string") {
      result[key] = value.toUpperCase();
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) props[propName] = toGeminiSchema(propSchema, options);
      result[key] = props;
    } else if (key === "items" && typeof value === "object") {
      result[key] = toGeminiSchema(value, options);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      result[key] = value.map((item) => toGeminiSchema(item, options));
    } else if (key === "enum" && Array.isArray(value)) {
      result[key] = value;
    } else if (options.moveNumericConstraintsToDescription && NUMERIC_SCHEMA_CONSTRAINTS.has(key)) {
      if (typeof value === "string" || typeof value === "number") numericConstraintHints.push(`${key}: ${value}`);
    } else if (key === "default" || key === "examples") {
      result[key] = value;
    } else if (key === "required" && Array.isArray(value)) {
      if (propertyNames.size > 0) {
        const validRequired = value.filter((prop) => typeof prop === "string" && propertyNames.has(prop));
        if (validRequired.length > 0) result[key] = validRequired;
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  if (numericConstraintHints.length > 0) {
    const hint = numericConstraintHints.join(", ");
    result.description = typeof result.description === "string" && result.description ? `${result.description} (${hint})` : hint;
  }
  // Gemini requires ARRAY schemas to carry an items field.
  if (result.type === "ARRAY" && !result.items) result.items = { type: "STRING" };
  return result;
}

// ------------------------------------------------------- model_enum + profile -
// model_enum table ported from agy-request-metadata.js; per-model thinking budget
// and output cap ported from model-resolver.js + model-registry.js for the two
// wire models this gateway routes to.

const AGY_MODEL_ENUM_BY_WIRE_MODEL: Record<string, string> = {
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
  "gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
  "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  "gemini-3.1-flash-image": "MODEL_PLACEHOLDER_M21",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

export function getAgyModelEnum(model: string): string | undefined {
  return AGY_MODEL_ENUM_BY_WIRE_MODEL[model.toLowerCase()];
}

export interface AntigravityModelProfile {
  /** Model-safe output cap sent to the provider. The gateway still enforces any
   * smaller caller limit from terminal usage; a thinking model cannot honor a cap
   * below its reasoning budget. (model-registry.js limit.output) */
  maxOutputTokens: number;
  /** Numeric thinking budget (model-resolver.js). */
  thinkingBudget: number;
  includeThoughts: true;
}

// gemini-pro-agent == gemini-3.1-pro (tier high): output 65535, budget 10001.
// gemini-3.7-flash-medium: output 65536, budget 4000.
const ANTIGRAVITY_MODEL_PROFILES: Record<string, AntigravityModelProfile> = {
  "gemini-pro-agent": { maxOutputTokens: 65535, thinkingBudget: 10001, includeThoughts: true },
  "gemini-3.7-flash-medium": { maxOutputTokens: 65536, thinkingBudget: 4000, includeThoughts: true },
};

export function resolveModelProfile(wireModel: string): AntigravityModelProfile | undefined {
  return ANTIGRAVITY_MODEL_PROFILES[wireModel.toLowerCase()];
}

// ------------------------------------------------------- request session store -
// Ported verbatim from agy-request-metadata.js. Random-but-stable conversationId
// and trajectoryId per session (NOT derived from prompt), FNV-1a numeric session
// id, monotonic per-request timestamp, last_execution_id after a completed
// execution, TTL + LRU eviction.

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const DEFAULT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_STATES = 256;

const AGY_REQUEST_FIELD_ORDER = [
  "contents", "systemInstruction", "tools", "toolConfig", "labels", "generationConfig", "sessionId",
] as const;

export function fnv1a64Signed(input: string): string {
  let hash = FNV1A_64_OFFSET_BASIS;
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV1A_64_PRIME);
  }
  return BigInt.asIntN(64, hash).toString();
}

export interface AgyRequestSessionContext {
  conversationId: string;
  trajectoryId: string;
  numericSessionId: string;
  lastExecutionId?: string;
  usedClaude?: boolean;
  usedNonGeminiModel?: boolean;
}

function createAgyRequestSessionContext(workspaceUri: string, ids: { conversationId?: string; trajectoryId?: string } = {}): AgyRequestSessionContext {
  return {
    conversationId: ids.conversationId ?? crypto.randomUUID(),
    trajectoryId: ids.trajectoryId ?? crypto.randomUUID(),
    numericSessionId: fnv1a64Signed(workspaceUri),
  };
}

interface SessionEntry { context: AgyRequestSessionContext; lastAccessedAt: number; lastRequestTimestamp: number; }

export class AgyRequestSessionStore {
  private entries = new Map<string, SessionEntry>();
  private workspaceUri: string;
  private ttlMs: number;
  private maxEntries: number;
  private now: () => number;

  constructor(workspaceUri: string, options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.workspaceUri = workspaceUri;
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_STATE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_SESSION_STATES;
    this.now = options.now ?? Date.now;
  }

  getOrCreate(key: string): AgyRequestSessionContext {
    const timestamp = this.now();
    this.prune(timestamp, key);
    const existing = this.entries.get(key);
    if (existing) { existing.lastAccessedAt = timestamp; return existing.context; }
    const context = createAgyRequestSessionContext(this.workspaceUri);
    this.entries.set(key, { context, lastAccessedAt: timestamp, lastRequestTimestamp: 0 });
    return context;
  }

  beginRequest(key: string): { session: AgyRequestSessionContext; timestamp: number } {
    const session = this.getOrCreate(key);
    const stored = this.entries.get(key)!;
    const timestamp = Math.max(stored.lastAccessedAt, stored.lastRequestTimestamp + 1);
    stored.lastRequestTimestamp = timestamp;
    return { session, timestamp };
  }

  completeExecution(key: string): void {
    const stored = this.entries.get(key);
    if (stored) stored.context.lastExecutionId = crypto.randomUUID();
  }

  get size(): number { return this.entries.size; }

  private prune(timestamp: number, preservedKey: string): void {
    const expiry = timestamp - this.ttlMs;
    for (const [key, value] of this.entries) {
      if (key !== preservedKey && value.lastAccessedAt < expiry) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries && !this.entries.has(preservedKey)) {
      let oldestKey: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.entries) {
        if (key !== preservedKey && value.lastAccessedAt < oldestAccess) { oldestKey = key; oldestAccess = value.lastAccessedAt; }
      }
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}

// ------------------------------------------------------- request metadata ------
// Ported from agy-request-metadata.js.

export function orderAgyRequestPayloadInPlace(payload: Record<string, unknown>): void {
  const ordered: Record<string, unknown> = {};
  const remaining = new Set(Object.keys(payload));
  for (const key of AGY_REQUEST_FIELD_ORDER) {
    if (key in payload) { ordered[key] = payload[key]; remaining.delete(key); }
  }
  for (const key of remaining) ordered[key] = payload[key];
  for (const key of Object.keys(payload)) delete payload[key];
  Object.assign(payload, ordered);
}

export function countAgyRequestSteps(payload: Record<string, unknown>, mode: "parts" | "contents" | "cli" = "parts"): number {
  const contents = payload.contents;
  if (!Array.isArray(contents)) return 1;
  if (mode === "contents") return Math.max(1, contents.length);
  let partCount = 0;
  let functionResponseCount = 0;
  for (const content of contents) {
    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const parts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) continue;
    partCount += parts.length;
    if (mode === "cli") {
      functionResponseCount += parts.filter((part) => part && typeof part === "object" && !Array.isArray(part) && "functionResponse" in (part as Record<string, unknown>)).length;
    }
  }
  if (mode === "cli") return Math.max(1, contents.length + functionResponseCount);
  return Math.max(1, partCount);
}

export interface AgyRequestMetadata { requestId: string; sessionId: string; labels: Record<string, string>; lastStepIndex: number; }

export function buildAgyAgentRequestMetadata(
  session: AgyRequestSessionContext,
  payload: Record<string, unknown>,
  model: string,
  timestamp: number = Date.now(),
  options: { stepCountMode?: "parts" | "contents" | "cli" } = {},
): AgyRequestMetadata {
  const lastStepIndex = countAgyRequestSteps(payload, options.stepCountMode) + (session.lastExecutionId ? 1 : 0);
  const isClaude = model.toLowerCase().startsWith("claude-");
  const isNonGemini = isClaude || model.toLowerCase().startsWith("gpt-");
  session.usedClaude = session.usedClaude === true || isClaude;
  session.usedNonGeminiModel = session.usedNonGeminiModel === true || isNonGemini;
  const modelEnum = getAgyModelEnum(model);
  const labels: Record<string, string> = {
    ...(session.lastExecutionId ? { last_execution_id: session.lastExecutionId } : {}),
    last_step_index: String(lastStepIndex),
    ...(modelEnum ? { model_enum: modelEnum } : {}),
    trajectory_id: session.trajectoryId,
    used_claude: session.usedClaude ? "true" : "false",
    used_claude_conservative: session.usedClaude ? "true" : "false",
    used_non_gemini_model: session.usedNonGeminiModel ? "true" : "false",
  };
  return {
    requestId: `agent/${session.conversationId}/${timestamp}/${session.trajectoryId}/${lastStepIndex + 1}`,
    sessionId: session.numericSessionId,
    labels,
    lastStepIndex,
  };
}

// ------------------------------------------------------- user agent ------------
// Ported from fingerprint.js. cl= is appended only for the captured agy CLI
// version (1.1.24); any other version omits it. Default is the captured,
// backend-accepted identity.

export const AGY_CLI_VERSION = "1.1.24";
export const AGY_CLI_CHANGE_LIST = "974782877";

function normalizeHarnessPlatform(platform: string = process.platform): string {
  return platform === "win32" ? "windows" : platform || "unknown";
}

function normalizeHarnessArch(arch: string = process.arch): string {
  switch (arch) {
    case "x64": return "amd64";
    case "ia32": return "386";
    default: return arch || "unknown";
  }
}

export function buildAntigravityHarnessUserAgent(
  version: string = AGY_CLI_VERSION,
  platform: string = process.platform,
  arch: string = process.arch,
  authMethod: string = "consumer",
): string {
  const osType = normalizeHarnessPlatform(platform);
  const normalizedArch = normalizeHarnessArch(arch);
  const changeList = version === AGY_CLI_VERSION ? `; cl=${AGY_CLI_CHANGE_LIST}` : "";
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${normalizedArch}${changeList}; auth_method=${authMethod})`;
}
