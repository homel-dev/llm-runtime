import { spawnSync } from "node:child_process";
import { startAntigravityKeyring } from "./antigravity-keyring.js";

const marker = "LLM_RUNTIME_GEMINI_AUTH_OK";

startAntigravityKeyring();

console.error("Antigravity account authentication runs against a persistent Linux Secret Service keyring.");
console.error("Open the printed Google URL on the laptop, paste the returned code here, then leave the TUI with /exit.");
console.error("Do NOT use /logout; /logout deliberately deletes the cached account credentials.");

const interactive = spawnSync("agy", [], {
  stdio: "inherit",
  env: {
    ...process.env,
    SSH_CONNECTION: process.env.SSH_CONNECTION || "127.0.0.1 1 127.0.0.1 1",
  },
});
if (interactive.error) throw interactive.error;
if (interactive.status !== 0) process.exit(interactive.status ?? 1);

console.error("Verifying the cached subscription credentials with a fresh headless Antigravity process...");
const verify = spawnSync("agy", [
  "-p", `Reply with exactly: ${marker}`,
  "--model", "gemini-3.1-pro-high",
  "--output-format", "json",
  "--print-timeout", "2m",
], {
  encoding: "utf8",
  env: process.env,
});
if (verify.error) throw verify.error;
if (verify.status !== 0) {
  if (verify.stderr) process.stderr.write(verify.stderr);
  process.exit(verify.status ?? 1);
}

let parsed: { status?: unknown; response?: unknown };
try {
  parsed = JSON.parse(verify.stdout) as { status?: unknown; response?: unknown };
} catch (error) {
  throw new Error(`Antigravity auth verification did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (parsed.status !== "SUCCESS" || typeof parsed.response !== "string" || !parsed.response.includes(marker)) {
  throw new Error(`Antigravity auth verification failed: ${verify.stdout.trim()}`);
}

console.log("Gemini subscription authentication persisted in the keyring and headless inference succeeded.");
