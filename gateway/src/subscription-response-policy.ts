export interface SubscriptionResponseBudgetResult {
  ok: boolean;
  outputTokens?: number;
  message?: string;
}

/**
 * Chat Completions / Completions usage is built by openai-oauth's `toUsage` with
 * prompt/completion/total token fields, so we require the full, coherent shape:
 * all three present, total >= completion, total != 0. A zero/absent total is
 * treated as untrustworthy. Returns the completion (output) token count.
 */
function chatUsageOutput(parsed: unknown): number | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const rec = usage as Record<string, unknown>;
  const prompt = rec.prompt_tokens;
  const completion = rec.completion_tokens;
  const total = rec.total_tokens;
  if (
    typeof prompt !== "number" || !Number.isFinite(prompt) || prompt < 0 ||
    typeof completion !== "number" || !Number.isFinite(completion) || completion < 0 ||
    typeof total !== "number" || !Number.isFinite(total) || total < 0
  ) return undefined;
  if (total < completion || total === 0) return undefined;
  return completion;
}

/**
 * Responses API usage comes through openai-oauth@2.0.0 as a raw passthrough of
 * the OpenAI/Codex `/responses` reply, whose usage is
 * `{ input_tokens, input_tokens_details, output_tokens, output_tokens_details }`
 * with NO `total_tokens`. So we require only a finite, non-negative
 * `output_tokens` and never depend on a total. `responseObj` is the response
 * object itself (non-stream) or the `response` field of a terminal streaming
 * event.
 */
function responseUsageOutput(responseObj: unknown): number | undefined {
  if (!responseObj || typeof responseObj !== "object" || Array.isArray(responseObj)) return undefined;
  const usage = (responseObj as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const output = (usage as Record<string, unknown>).output_tokens;
  return typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : undefined;
}

/**
 * Fail-closed output-token enforcement for a buffered NON-streaming JSON reply
 * from the OpenAI subscription backend. Chat and Responses use distinct usage
 * shapes (see the two extractors above).
 */
export function checkSubscriptionResponseOutputBudget(
  pathname: string,
  upstreamStatus: number,
  body: Buffer,
  outputTokenLimit: number | undefined,
): SubscriptionResponseBudgetResult {
  if (outputTokenLimit === undefined || upstreamStatus < 200 || upstreamStatus >= 400) return { ok: true };

  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); }
  catch { return { ok: false, message: "subscription upstream returned non-JSON success response; output-token limit cannot be verified" }; }

  const output = pathname === "/v1/responses" ? responseUsageOutput(parsed) : chatUsageOutput(parsed);
  if (output === undefined) {
    return { ok: false, message: "subscription upstream response has no trustworthy token usage required to verify the output-token limit" };
  }
  if (output > outputTokenLimit) {
    return { ok: false, outputTokens: output, message: `subscription upstream output exceeded requested token limit: ${output} > ${outputTokenLimit}` };
  }
  return { ok: true, outputTokens: output };
}

/**
 * Parse a buffered SSE body into an ordered list of events. Each event is either
 * the terminal `[DONE]` sentinel or a `data:` JSON payload. Events are delimited
 * by blank lines; multiple `data:` lines inside one event are concatenated with
 * newlines, per the SSE spec. Comment lines (`:`) and non-`data:` fields are
 * ignored. Order is preserved so callers can reason about the terminal event.
 */
type SseEvent = { done: true } | { done: false; event?: string; payload: string };

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  let dataLines: string[] = [];
  let eventName: string | undefined;
  const flush = (): void => {
    if (dataLines.length === 0) { eventName = undefined; return; }
    const payload = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = undefined;
    if (payload === "[DONE]") events.push({ done: true });
    else events.push({ done: false, ...(name ? { event: name } : {}), payload });
  };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") { flush(); continue; }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      const value = line.slice(6);
      eventName = value.startsWith(" ") ? value.slice(1) : value;
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  flush();
  return events;
}

/**
 * Chat Completions / Completions streaming terminal semantics.
 *
 * openai-oauth@2.0.0 unconditionally emits the usage chunk (choices: [] +
 * full usage) as the last data event immediately before `data: [DONE]`. We
 * require exactly that shape: any malformed data event, a missing terminal
 * `[DONE]`, or a non-usage event in the terminal slot fails closed, so an early
 * stray usage value can never be mistaken for the real total.
 */
function checkChatStreamBudget(events: SseEvent[], outputTokenLimit: number): SubscriptionResponseBudgetResult {
  for (const event of events) {
    if (event.done) continue;
    try { JSON.parse(event.payload); }
    catch { return { ok: false, message: "subscription upstream streaming response had malformed SSE data events; output-token limit cannot be verified" }; }
  }
  const last = events[events.length - 1];
  if (!last || !last.done) {
    return { ok: false, message: "subscription upstream stream ended without a terminal [DONE] event; output-token limit cannot be verified" };
  }
  const terminal = events[events.length - 2];
  if (!terminal || terminal.done) {
    return { ok: false, message: "subscription upstream streaming response has no trustworthy terminal token usage immediately before [DONE]" };
  }
  const terminalParsed = JSON.parse(terminal.payload) as unknown;
  const choices = terminalParsed && typeof terminalParsed === "object" && !Array.isArray(terminalParsed)
    ? (terminalParsed as Record<string, unknown>).choices
    : undefined;
  if (!Array.isArray(choices) || choices.length !== 0) {
    return { ok: false, message: "subscription upstream streaming response terminal event is not the choices:[] usage chunk required immediately before [DONE]" };
  }
  const output = chatUsageOutput(terminalParsed);
  if (output === undefined) {
    return { ok: false, message: "subscription upstream streaming response has no trustworthy terminal token usage immediately before [DONE]" };
  }
  if (output > outputTokenLimit) {
    return { ok: false, outputTokens: output, message: `subscription upstream output exceeded requested token limit: ${output} > ${outputTokenLimit}` };
  }
  return { ok: true, outputTokens: output };
}

/**
 * Responses API streaming terminal semantics.
 *
 * openai-oauth@2.0.0 forwards the Responses stream verbatim (raw passthrough), so
 * the terminal marker is whatever OpenAI/Codex puts on the wire. That can be the
 * SSE `event:` field (`event: response.completed`), a JSON `type`, and/or
 * `response.status`. We accept any of those signals on the LAST semantic data
 * event, then still require a trustworthy `response.usage.output_tokens` — so
 * detection is transport-tolerant while enforcement stays fail-closed.
 */
function checkResponsesStreamBudget(events: SseEvent[], outputTokenLimit: number): SubscriptionResponseBudgetResult {
  const dataEvents = events.filter((event): event is { done: false; event?: string; payload: string } => !event.done);
  for (const event of dataEvents) {
    try { JSON.parse(event.payload); }
    catch { return { ok: false, message: "subscription upstream streaming response had malformed SSE data events; output-token limit cannot be verified" }; }
  }
  const last = dataEvents[dataEvents.length - 1]!;
  const parsed = JSON.parse(last.payload) as unknown;
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  const response = record?.response;
  const status = response && typeof response === "object" && !Array.isArray(response) ? (response as Record<string, unknown>).status : undefined;
  const isTerminal =
    last.event === "response.completed" || last.event === "response.incomplete" ||
    record?.type === "response.completed" || record?.type === "response.incomplete" ||
    status === "completed" || status === "incomplete";
  if (!isTerminal) {
    return { ok: false, message: "subscription upstream Responses stream did not end with a terminal response.completed event; output-token limit cannot be verified" };
  }
  const output = responseUsageOutput(response);
  if (output === undefined) {
    return { ok: false, message: "subscription upstream streaming response has no trustworthy terminal response.completed usage required to verify the output-token limit" };
  }
  if (output > outputTokenLimit) {
    return { ok: false, outputTokens: output, message: `subscription upstream output exceeded requested token limit: ${output} > ${outputTokenLimit}` };
  }
  return { ok: true, outputTokens: output };
}

/**
 * Fail-closed output-token enforcement for a buffered streaming (SSE) reply from
 * the OpenAI subscription backend. The gateway forwards the streaming request to
 * the loopback OAuth proxy, buffers the whole SSE reply, and only releases it to
 * the client once the terminal usage event proves the output stayed within the
 * effective limit. Every uncertainty resolves to a rejection (caller returns 502)
 * so no unmetered output leaks. Chat and Responses use distinct terminal
 * semantics; see the two helpers above.
 */
export function checkSubscriptionStreamOutputBudget(
  pathname: string,
  upstreamStatus: number,
  body: Buffer,
  outputTokenLimit: number | undefined,
): SubscriptionResponseBudgetResult {
  if (outputTokenLimit === undefined || upstreamStatus < 200 || upstreamStatus >= 400) return { ok: true };

  const events = parseSseEvents(body.toString("utf8"));
  if (!events.some((event) => !event.done)) {
    return { ok: false, message: "subscription upstream streaming response contained no SSE data events; output-token limit cannot be verified" };
  }
  return pathname === "/v1/responses"
    ? checkResponsesStreamBudget(events, outputTokenLimit)
    : checkChatStreamBudget(events, outputTokenLimit);
}
