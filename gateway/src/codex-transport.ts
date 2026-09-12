import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import WebSocket, { type RawData } from "ws";

const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_WS_BETA = "responses_websockets=2026-02-06";
const RESPONSE_EXPERIMENTAL_BETA = "responses=experimental";
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface CodexTransportConfig {
  listenHost: string;
  listenPort: number;
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  authFile: string;
  models: string[];
  maxBodyBytes: number;
  requestTimeoutMs: number;
  websocketConnectTimeoutMs: number;
  sessionIdleMs: number;
  sessionMaxAgeMs: number;
}

interface TokenData {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}

interface AuthDotJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: TokenData;
  last_refresh?: string | null;
  [key: string]: unknown;
}

export interface CodexCredential {
  accessToken: string;
  accountId: string;
}

type JsonRecord = Record<string, unknown>;

export interface CodexContinuation {
  lastRequestBody: JsonRecord;
  lastResponseId: string;
  lastResponseItems: unknown[];
}

interface SessionEntry {
  socket: WebSocket;
  accountId: string;
  createdAt: number;
  continuation?: CodexContinuation;
  idleTimer?: NodeJS.Timeout;
}

interface RequestStats {
  fullRequests: number;
  deltaRequests: number;
  continuationMisses: number;
  websocketConnections: number;
  websocketReuses: number;
  websocketRetries: number;
  sseFallbacks: number;
  lastFullRequestBytes: number;
  lastUpstreamRequestBytes: number;
  lastResponseId?: string;
}

interface WsRunResult {
  responseId?: string;
  responseItems: unknown[];
  terminalResponse?: JsonRecord;
}

class CodexUpstreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CodexUpstreamError";
  }
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveInt(label: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function loadCodexTransportConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CodexTransportConfig {
  const listenHost = env.CODEX_TRANSPORT_LISTEN_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(listenHost)) {
    throw new Error("CODEX_TRANSPORT_LISTEN_HOST must be loopback");
  }
  const baseUrl = (env.CODEX_TRANSPORT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const parsedBase = new URL(baseUrl);
  if (parsedBase.protocol !== "https:" || parsedBase.hostname !== "chatgpt.com") {
    throw new Error("CODEX_TRANSPORT_BASE_URL must be https://chatgpt.com/... in runtime configuration");
  }
  const tokenUrl = env.CODEX_TRANSPORT_TOKEN_URL ?? DEFAULT_TOKEN_URL;
  const parsedToken = new URL(tokenUrl);
  if (parsedToken.protocol !== "https:" || parsedToken.hostname !== "auth.openai.com") {
    throw new Error("CODEX_TRANSPORT_TOKEN_URL must be https://auth.openai.com/... in runtime configuration");
  }
  return {
    listenHost,
    listenPort: positiveInt("CODEX_TRANSPORT_LISTEN_PORT", env.CODEX_TRANSPORT_LISTEN_PORT, 10533),
    baseUrl,
    tokenUrl,
    clientId: env.CODEX_TRANSPORT_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    authFile: env.CODEX_TRANSPORT_AUTH_FILE ?? "/auth/auth.json",
    models: csv(env.CODEX_TRANSPORT_MODELS, ["gpt-5.6-sol"]),
    maxBodyBytes: positiveInt("CODEX_TRANSPORT_MAX_BODY_BYTES", env.CODEX_TRANSPORT_MAX_BODY_BYTES, 8 * 1024 * 1024),
    requestTimeoutMs: positiveInt("CODEX_TRANSPORT_TIMEOUT_MS", env.CODEX_TRANSPORT_TIMEOUT_MS, 900_000),
    websocketConnectTimeoutMs: positiveInt("CODEX_TRANSPORT_WS_CONNECT_TIMEOUT_MS", env.CODEX_TRANSPORT_WS_CONNECT_TIMEOUT_MS, 15_000),
    sessionIdleMs: positiveInt("CODEX_TRANSPORT_SESSION_IDLE_MS", env.CODEX_TRANSPORT_SESSION_IDLE_MS, 5 * 60 * 1000),
    sessionMaxAgeMs: positiveInt("CODEX_TRANSPORT_SESSION_MAX_AGE_MS", env.CODEX_TRANSPORT_SESSION_MAX_AGE_MS, 55 * 60 * 1000),
  };
}

function decodeJwtPayload(token: string): JsonRecord | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed as JsonRecord : undefined;
  } catch {
    return undefined;
  }
}

export function extractChatGptAccountId(accessToken: string, fallback?: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const claim = payload?.[CHATGPT_AUTH_CLAIM];
  if (claim && typeof claim === "object") {
    const account = (claim as JsonRecord).chatgpt_account_id;
    if (typeof account === "string" && account.trim()) return account;
  }
  return fallback?.trim() || undefined;
}

function accessTokenExpiresSoon(accessToken: string, now = Date.now()): boolean {
  const exp = decodeJwtPayload(accessToken)?.exp;
  return typeof exp === "number" && Number.isFinite(exp)
    ? exp * 1000 <= now + TOKEN_REFRESH_SKEW_MS
    : false;
}

export class CodexAuthStore {
  private refreshInFlight?: Promise<CodexCredential>;

  constructor(
    private readonly config: Pick<CodexTransportConfig, "authFile" | "tokenUrl" | "clientId">,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async credential(forceRefresh = false): Promise<CodexCredential> {
    const auth = await this.readAuth();
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) throw new Error(`Codex auth file ${this.config.authFile} has no tokens.access_token`);
    if (!forceRefresh && !accessTokenExpiresSoon(accessToken)) {
      const accountId = extractChatGptAccountId(accessToken, auth.tokens?.account_id);
      if (!accountId) throw new Error("Codex access token has no ChatGPT account id");
      return { accessToken, accountId };
    }
    return this.refresh();
  }

  private async readAuth(): Promise<AuthDotJson> {
    const raw = await readFile(this.config.authFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error(`Codex auth file ${this.config.authFile} is not an object`);
    return parsed as AuthDotJson;
  }

  private async refresh(): Promise<CodexCredential> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const auth = await this.readAuth();
      const refreshToken = auth.tokens?.refresh_token;
      if (!refreshToken) throw new Error(`Codex auth file ${this.config.authFile} has no tokens.refresh_token`);
      const response = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Codex OAuth refresh failed (${response.status}): ${text.slice(0, 1024)}`);
      let payload: JsonRecord;
      try { payload = JSON.parse(text) as JsonRecord; }
      catch { throw new Error("Codex OAuth refresh returned invalid JSON"); }
      const accessToken = typeof payload.access_token === "string" ? payload.access_token : auth.tokens?.access_token;
      const nextRefresh = typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken;
      const nextIdToken = typeof payload.id_token === "string" ? payload.id_token : auth.tokens?.id_token;
      if (!accessToken) throw new Error("Codex OAuth refresh response has no usable access token");
      const accountId = extractChatGptAccountId(accessToken, auth.tokens?.account_id);
      if (!accountId) throw new Error("Refreshed Codex access token has no ChatGPT account id");
      const next: AuthDotJson = {
        ...auth,
        tokens: {
          ...auth.tokens,
          ...(nextIdToken ? { id_token: nextIdToken } : {}),
          access_token: accessToken,
          refresh_token: nextRefresh,
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      };
      await this.atomicWrite(next);
      return { accessToken, accountId };
    })();
    try { return await this.refreshInFlight; }
    finally { this.refreshInFlight = undefined; }
  }

  private async atomicWrite(auth: AuthDotJson): Promise<void> {
    const temp = join(dirname(this.config.authFile), `.auth.json.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.config.authFile);
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requestWithoutInput(body: JsonRecord): JsonRecord {
  const { input: _input, previous_response_id: _previous, ...rest } = body;
  return rest;
}

function normalizeReplayItem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = { ...(value as JsonRecord) };
  if (item.type === "function_call" || item.type === "custom_tool_call") delete item.status;
  return item;
}

function replayItemsEqual(a: unknown, b: unknown): boolean {
  return jsonEqual(normalizeReplayItem(a), normalizeReplayItem(b));
}

export function buildContinuationRequest(
  fullBody: JsonRecord,
  continuation: CodexContinuation | undefined,
): { body: JsonRecord; usedContinuation: boolean } {
  if (!continuation) return { body: fullBody, usedContinuation: false };
  if (!jsonEqual(requestWithoutInput(fullBody), requestWithoutInput(continuation.lastRequestBody))) {
    return { body: fullBody, usedContinuation: false };
  }
  const current = Array.isArray(fullBody.input) ? fullBody.input : undefined;
  const previous = Array.isArray(continuation.lastRequestBody.input) ? continuation.lastRequestBody.input : undefined;
  if (!current || !previous) return { body: fullBody, usedContinuation: false };
  const baselineLength = previous.length + continuation.lastResponseItems.length;
  if (current.length < baselineLength) return { body: fullBody, usedContinuation: false };
  for (let i = 0; i < previous.length; i++) {
    if (!jsonEqual(current[i], previous[i])) return { body: fullBody, usedContinuation: false };
  }
  for (let i = 0; i < continuation.lastResponseItems.length; i++) {
    if (!replayItemsEqual(current[previous.length + i], continuation.lastResponseItems[i])) {
      return { body: fullBody, usedContinuation: false };
    }
  }
  return {
    usedContinuation: true,
    body: {
      ...fullBody,
      previous_response_id: continuation.lastResponseId,
      input: current.slice(baselineLength),
    },
  };
}

export function normalizeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  if (/^[A-Za-z0-9._:-]{1,64}$/.test(value)) return value;
  return `rr-${createHash("sha256").update(value).digest("hex").slice(0, 61)}`;
}

function resolveCodexUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function resolveCodexWsUrl(baseUrl: string): string {
  const url = new URL(resolveCodexUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeUpstreamBody(body: JsonRecord, sessionId?: string): JsonRecord {
  const upstream = { ...body };
  // ChatGPT's Codex Responses backend does not accept the public Responses
  // max-token request fields. The gateway may receive them from generic
  // OpenAI-Responses clients, but the dedicated Codex transport must not
  // forward them to /backend-api/codex/responses.
  delete upstream.max_output_tokens;
  delete upstream.max_completion_tokens;
  delete upstream.max_tokens;

  const include = Array.isArray(upstream.include) ? [...upstream.include] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  return {
    ...upstream,
    store: false,
    stream: true,
    ...(sessionId ? { prompt_cache_key: sessionId } : {}),
    ...(include.length ? { include } : {}),
  };
}

function buildWsHeaders(credential: CodexCredential, requestId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    "chatgpt-account-id": credential.accountId,
    originator: "llm-runtime",
    "User-Agent": "llm-runtime-codex-transport/0.1",
    "OpenAI-Beta": CODEX_WS_BETA,
    "x-client-request-id": requestId,
    "session-id": requestId,
  };
}

function buildSseHeaders(credential: CodexCredential, sessionId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    "chatgpt-account-id": credential.accountId,
    originator: "llm-runtime",
    "User-Agent": "llm-runtime-codex-transport/0.1",
    "OpenAI-Beta": RESPONSE_EXPERIMENTAL_BETA,
    accept: "text/event-stream",
    "content-type": "application/json",
    ...(sessionId ? { "x-client-request-id": sessionId, "session-id": sessionId } : {}),
  };
}

function rawDataToText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function parseErrorCode(event: JsonRecord): { code?: string; message?: string } {
  const nested = event.error && typeof event.error === "object" ? event.error as JsonRecord : undefined;
  return {
    code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
    message: typeof event.message === "string" ? event.message : typeof nested?.message === "string" ? nested.message : undefined,
  };
}

function responseFailure(event: JsonRecord): CodexUpstreamError {
  const response = event.response && typeof event.response === "object" ? event.response as JsonRecord : undefined;
  const err = response?.error && typeof response.error === "object" ? response.error as JsonRecord : undefined;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const message = typeof err?.message === "string" ? err.message : "Codex response failed";
  return new CodexUpstreamError(message, code);
}

class SessionLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try { return await fn(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class CodexTransport {
  private readonly auth: CodexAuthStore;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly locks = new SessionLocks();
  private readonly stats: RequestStats = {
    fullRequests: 0,
    deltaRequests: 0,
    continuationMisses: 0,
    websocketConnections: 0,
    websocketReuses: 0,
    websocketRetries: 0,
    sseFallbacks: 0,
    lastFullRequestBytes: 0,
    lastUpstreamRequestBytes: 0,
  };

  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly config: CodexTransportConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl;
    this.auth = new CodexAuthStore(config, fetchImpl);
  }

  createServer() {
    return createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log({ event: "request.error", error: message.slice(0, 1024) });
        if (!res.headersSent) {
          const status = error instanceof CodexUpstreamError && error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "codex_transport_error", message } }));
        } else {
          res.end();
        }
      });
    });
  }

  close(): void {
    for (const entry of this.sessions.values()) this.disposeEntry(entry, "shutdown");
    this.sessions.clear();
  }

  getStats(): Readonly<RequestStats> {
    return { ...this.stats };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, sessions: this.sessions.size }));
      return;
    }
    if (req.method === "GET" && pathname === "/debug/stats") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...this.stats, sessions: this.sessions.size }));
      return;
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
        error: {
          type: "codex_transport_responses_required",
          message: "ChatGPT/Codex subscription transport requires /v1/responses",
        },
      }));
      return;
    }
    if (req.method !== "POST" || pathname !== "/v1/responses") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    const body = await this.readJsonBody(req);
    const model = typeof body.model === "string" ? body.model : undefined;
    if (!model || !this.config.models.includes(model)) {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "model not allowed" } }));
      return;
    }
    const sessionId = normalizeSessionId(body.prompt_cache_key);
    const clientWantsStream = body.stream === true;
    const fullBody = normalizeUpstreamBody(body, sessionId);
    const gatewayRequestId = safeString(req.headers["x-llm-gateway-request-id"], `codex-${randomUUID()}`);
    await this.locks.run(sessionId, async () => {
      await this.handleResponsesRequest(fullBody, sessionId, gatewayRequestId, clientWantsStream, res);
    });
  }

  private async readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > this.config.maxBodyBytes) throw new CodexUpstreamError("payload too large", undefined, 413);
      chunks.push(buffer);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new CodexUpstreamError("invalid JSON body", undefined, 400); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CodexUpstreamError("request body must be an object", undefined, 400);
    return parsed as JsonRecord;
  }

  private async handleResponsesRequest(
    fullBody: JsonRecord,
    sessionId: string | undefined,
    requestId: string,
    clientWantsStream: boolean,
    res: ServerResponse,
  ): Promise<void> {
    const stream = clientWantsStream;
    const fullBytes = Buffer.byteLength(JSON.stringify(fullBody));
    this.stats.lastFullRequestBytes = fullBytes;
    let credential = await this.auth.credential();
    let entry = await this.acquireSession(sessionId, credential, requestId);
    let continuation = buildContinuationRequest(fullBody, entry?.continuation);
    if (entry?.continuation && !continuation.usedContinuation) this.stats.continuationMisses++;

    const run = async (targetEntry: SessionEntry | undefined, body: JsonRecord, usedContinuation: boolean): Promise<WsRunResult> => {
      const upstreamBytes = Buffer.byteLength(JSON.stringify({ type: "response.create", ...body }));
      this.stats.lastUpstreamRequestBytes = upstreamBytes;
      if (usedContinuation) this.stats.deltaRequests++; else this.stats.fullRequests++;
      this.log({
        event: "codex.request",
        requestId,
        sessionId,
        mode: usedContinuation ? "delta" : "full",
        fullRequestBytes: fullBytes,
        upstreamRequestBytes: upstreamBytes,
        inputItems: Array.isArray(body.input) ? body.input.length : undefined,
        previousResponseId: body.previous_response_id,
      });
      return this.runWebSocketRequest(targetEntry!.socket, body, stream ? (event) => this.writeSseEvent(res, event) : undefined);
    };

    try {
      let result: WsRunResult;
      try {
        result = await run(entry, continuation.body, continuation.usedContinuation);
      } catch (error) {
        const upstream = error instanceof CodexUpstreamError ? error : undefined;
        const retryFull = !res.headersSent && (
          upstream?.code === "previous_response_not_found" ||
          upstream?.code === "websocket_connection_limit_reached" ||
          upstream?.status === 401
        );
        if (!retryFull) throw error;
        this.stats.websocketRetries++;
        if (entry) this.disposeEntry(entry, upstream.code ?? (upstream.status === 401 ? "unauthorized" : "retry"));
        if (sessionId) this.sessions.delete(sessionId);
        credential = await this.auth.credential(upstream.status === 401);
        entry = await this.acquireSession(sessionId, credential, requestId);
        continuation = { body: fullBody, usedContinuation: false };
        result = await run(entry, fullBody, false);
      }

      if (entry && result.responseId) {
        entry.continuation = {
          lastRequestBody: fullBody,
          lastResponseId: result.responseId,
          lastResponseItems: result.responseItems,
        };
        this.stats.lastResponseId = result.responseId;
        this.scheduleIdle(sessionId, entry);
      } else if (!sessionId && entry) {
        this.disposeEntry(entry, "one-shot");
      }

      if (stream) {
        if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.end();
      } else {
        if (!result.terminalResponse) throw new Error("Codex stream ended without a terminal response object");
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result.terminalResponse));
      }
    } catch (error) {
      if (entry && sessionId) {
        entry.continuation = undefined;
        this.disposeEntry(entry, "request-error");
        this.sessions.delete(sessionId);
      }
      if (!res.headersSent) {
        await this.fallbackSse(fullBody, sessionId, stream, res, error);
      } else {
        throw error;
      }
    }
  }

  private async acquireSession(sessionId: string | undefined, credential: CodexCredential, requestId: string): Promise<SessionEntry> {
    if (sessionId) {
      const cached = this.sessions.get(sessionId);
      if (cached) {
        if (cached.idleTimer) clearTimeout(cached.idleTimer);
        if (cached.accountId === credential.accountId && cached.socket.readyState === WebSocket.OPEN && Date.now() - cached.createdAt < this.config.sessionMaxAgeMs) {
          this.stats.websocketReuses++;
          return cached;
        }
        this.disposeEntry(cached, "expired");
        this.sessions.delete(sessionId);
      }
    }
    const socket = await this.connectWebSocket(credential, sessionId ?? requestId);
    const entry: SessionEntry = { socket, accountId: credential.accountId, createdAt: Date.now() };
    this.stats.websocketConnections++;
    if (sessionId) {
      this.sessions.set(sessionId, entry);
      socket.once("close", () => {
        if (this.sessions.get(sessionId)?.socket === socket) this.sessions.delete(sessionId);
      });
    }
    return entry;
  }

  private async connectWebSocket(credential: CodexCredential, requestId: string): Promise<WebSocket> {
    const url = resolveCodexWsUrl(this.config.baseUrl);
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: buildWsHeaders(credential, requestId),
        handshakeTimeout: this.config.websocketConnectTimeoutMs,
        maxPayload: this.config.maxBodyBytes * 8,
        perMessageDeflate: false,
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpected);
        socket.off("close", onClose);
        if (error) {
          try { socket.terminate(); } catch {}
          reject(error);
        } else {
          resolve(socket);
        }
      };
      const onOpen = () => finish();
      const onError = (error: Error) => finish(error);
      const onUnexpected = (_request: unknown, response: IncomingMessage) => {
        finish(new CodexUpstreamError(`Codex WebSocket handshake failed (${response.statusCode ?? 0})`, undefined, response.statusCode));
      };
      const onClose = (code: number, reason: Buffer) => finish(new CodexUpstreamError(`Codex WebSocket closed during handshake (${code}) ${reason.toString("utf8")}`));
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("unexpected-response", onUnexpected);
      socket.once("close", onClose);
    });
  }

  private async runWebSocketRequest(socket: WebSocket, body: JsonRecord, onEvent?: (event: JsonRecord) => void): Promise<WsRunResult> {
    const responseItems: unknown[] = [];
    let terminalResponse: JsonRecord | undefined;
    let responseId: string | undefined;
    return new Promise<WsRunResult>((resolve, reject) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fail(new Error(`Codex WebSocket idle timeout after ${this.config.requestTimeoutMs}ms`)), this.config.requestTimeoutMs);
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const succeed = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ responseId, responseItems, terminalResponse });
      };
      const fail = (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };
      const onMessage = (raw: RawData) => {
        resetTimer();
        let event: JsonRecord;
        try {
          const parsed = JSON.parse(rawDataToText(raw));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
          event = parsed as JsonRecord;
        } catch (error) {
          fail(new Error(`Invalid Codex WebSocket JSON: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "error") {
          const { code, message } = parseErrorCode(event);
          fail(new CodexUpstreamError(message || code || "Codex error", code));
          return;
        }
        if (type === "response.failed") {
          fail(responseFailure(event));
          return;
        }
        if (type === "response.output_item.done" && event.item !== undefined) responseItems.push(event.item);
        let forwarded = event;
        if (type === "response.done") forwarded = { ...event, type: "response.completed" };
        onEvent?.(forwarded);
        if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
          const response = event.response && typeof event.response === "object" ? event.response as JsonRecord : undefined;
          terminalResponse = response;
          if (typeof response?.id === "string") responseId = response.id;
          if (Array.isArray(response?.output) && response.output.length > 0) {
            responseItems.splice(0, responseItems.length, ...response.output);
          }
          succeed();
        }
      };
      const onError = (error: Error) => fail(error);
      const onClose = (code: number, reason: Buffer) => fail(new CodexUpstreamError(`Codex WebSocket closed before terminal response (${code}) ${reason.toString("utf8")}`));
      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      resetTimer();
      try { socket.send(JSON.stringify({ type: "response.create", ...body })); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private writeSseEvent(res: ServerResponse, event: JsonRecord): void {
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private async fallbackSse(fullBody: JsonRecord, sessionId: string | undefined, stream: boolean, res: ServerResponse, cause: unknown): Promise<void> {
    this.stats.sseFallbacks++;
    this.log({ event: "codex.fallback_sse", sessionId, cause: cause instanceof Error ? cause.message.slice(0, 512) : String(cause).slice(0, 512) });
    let credential = await this.auth.credential();
    const request = async (cred: CodexCredential) => this.fetchImpl(resolveCodexUrl(this.config.baseUrl), {
      method: "POST",
      headers: buildSseHeaders(cred, sessionId),
      body: JSON.stringify(fullBody),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    let response = await request(credential);
    if (response.status === 401) {
      credential = await this.auth.credential(true);
      response = await request(credential);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new CodexUpstreamError(`Codex SSE fallback failed (${response.status}): ${text.slice(0, 1024)}`, undefined, response.status);
    }
    if (!response.body) throw new Error("Codex SSE fallback returned no body");
    if (!stream) {
      const text = await response.text();
      const terminal = this.extractTerminalResponseFromSse(text);
      if (!terminal) throw new Error("Codex SSE fallback had no terminal response");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(terminal));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    res.end();
  }

  private extractTerminalResponseFromSse(text: string): JsonRecord | undefined {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const event = JSON.parse(raw) as JsonRecord;
        const type = event.type;
        if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
          return event.response && typeof event.response === "object" ? event.response as JsonRecord : undefined;
        }
      } catch {}
    }
    return undefined;
  }

  private scheduleIdle(sessionId: string | undefined, entry: SessionEntry): void {
    if (!sessionId) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.sessions.get(sessionId) !== entry) return;
      this.disposeEntry(entry, "idle-timeout");
      this.sessions.delete(sessionId);
    }, this.config.sessionIdleMs);
    entry.idleTimer.unref?.();
  }

  private disposeEntry(entry: SessionEntry, reason: string): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.socket.close(1000, reason.slice(0, 120)); }
    catch { try { entry.socket.terminate(); } catch {} }
  }

  private log(event: JsonRecord): void {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), component: "llm-codex-transport", ...event })}\n`);
  }
}

export function startCodexTransport(config: CodexTransportConfig = loadCodexTransportConfigFromEnv()) {
  const transport = new CodexTransport(config);
  const server = transport.createServer();
  server.listen(config.listenPort, config.listenHost, () => {
    process.stdout.write(`llm-runtime Codex transport listening on ${config.listenHost}:${config.listenPort} models=${config.models.join("|")}\n`);
  });
  server.on("close", () => transport.close());
  return { server, transport };
}
