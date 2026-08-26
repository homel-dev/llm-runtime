import { spawnSync } from "node:child_process";
import { startAntigravityKeyring } from "./antigravity-keyring.js";

const marker = "LLM_RUNTIME_GEMINI_AUTH_OK";

startAntigravityKeyring();

function verifyCachedAuthentication(verbose: boolean): boolean {
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
    if (verbose && verify.stderr) process.stderr.write(verify.stderr);
    return false;
  }

  let parsed: { status?: unknown; response?: unknown };
  try {
    parsed = JSON.parse(verify.stdout) as { status?: unknown; response?: unknown };
  } catch (error) {
    if (verbose) {
      console.error(`Antigravity auth verification did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
      if (verify.stdout.trim()) console.error(verify.stdout.trim());
    }
    return false;
  }

  const ok = parsed.status === "SUCCESS"
    && typeof parsed.response === "string"
    && parsed.response.includes(marker);
  if (!ok && verbose) console.error(`Antigravity auth verification failed: ${verify.stdout.trim()}`);
  return ok;
}

console.error("Checking the persistent Antigravity account session with a fresh headless process...");
if (verifyCachedAuthentication(false)) {
  console.log("Gemini subscription authentication is already valid; headless inference succeeded.");
  process.exit(0);
}

console.error("No usable cached Antigravity session was found.");
console.error("Antigravity will now start in SSH mode. Do not type 'login', 'agy auth login', or any shell command into the TUI prompt.");
console.error("If authentication is required, Antigravity itself will print the Google URL and ask for the browser code during startup.");
console.error("Complete that URL/code flow on the laptop. When the authenticated account header is visible, exit with Ctrl-D on an empty prompt or /exit.");
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

console.error("Verifying the cached subscription credentials with a new headless Antigravity process...");
if (!verifyCachedAuthentication(true)) process.exit(1);

console.log("Gemini subscription authentication persisted in the keyring and headless inference succeeded.");
