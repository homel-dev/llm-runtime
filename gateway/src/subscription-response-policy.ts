export interface SubscriptionResponseBudgetResult {
  ok: boolean;
  outputTokens?: number;
  message?: string;
}

function usageNumbers(pathname: string, parsed: unknown): { input: number; output: number; total: number } | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const rec = usage as Record<string, unknown>;
  const inputValue = pathname === "/v1/responses" ? rec.input_tokens : rec.prompt_tokens;
  const outputValue = pathname === "/v1/responses" ? rec.output_tokens : rec.completion_tokens;
  const totalValue = rec.total_tokens;
  if (
    typeof inputValue !== "number" || !Number.isFinite(inputValue) || inputValue < 0 ||
    typeof outputValue !== "number" || !Number.isFinite(outputValue) || outputValue < 0 ||
    typeof totalValue !== "number" || !Number.isFinite(totalValue) || totalValue < 0
  ) return undefined;
  if (totalValue < outputValue || totalValue === 0) return undefined;
  return { input: inputValue, output: outputValue, total: totalValue };
}

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

  const usage = usageNumbers(pathname, parsed);
  if (!usage) {
    return { ok: false, message: "subscription upstream response has no trustworthy token usage required to verify the output-token limit" };
  }
  if (usage.output > outputTokenLimit) {
    return { ok: false, outputTokens: usage.output, message: `subscription upstream output exceeded requested token limit: ${usage.output} > ${outputTokenLimit}` };
  }
  return { ok: true, outputTokens: usage.output };
}
