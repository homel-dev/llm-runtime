import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface AntigravityKeyringSession {
  busAddress: string;
  controlDirectory: string;
  passwordFile: string;
  runtimeDirectory: string;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function ensurePasswordFile(path: string): string {
  try {
    if (statSync(path).size > 0) {
      chmodSync(path, 0o600);
      return readFileSync(path, "utf8").trim();
    }
  } catch {}

  const password = randomBytes(48).toString("base64url");
  writeFileSync(path, `${password}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return password;
}

function runChecked(command: string, args: string[], options: { input?: string } = {}): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    input: options.input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed with exit code ${String(result.status)}${detail ? `: ${detail}` : ""}`);
  }
}

export function startAntigravityKeyring(env: NodeJS.ProcessEnv = process.env): AntigravityKeyringSession {
  const home = env.HOME || "/antigravity-auth";
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const keyringDirectory = join(dataHome, "keyrings");
  const passwordFile = env.ANTIGRAVITY_KEYRING_PASSWORD_FILE || join(home, ".antigravity-keyring-password");
  const runtimeDirectory = env.ANTIGRAVITY_KEYRING_RUNTIME_DIR || join("/tmp", `antigravity-keyring-${process.pid}`);
  const controlDirectory = join(runtimeDirectory, "control");
  const busSocket = join(runtimeDirectory, "bus");
  const busAddress = `unix:path=${busSocket}`;

  ensurePrivateDirectory(dataHome);
  ensurePrivateDirectory(keyringDirectory);
  ensurePrivateDirectory(runtimeDirectory);
  ensurePrivateDirectory(controlDirectory);
  const password = ensurePasswordFile(passwordFile);

  try { rmSync(busSocket, { force: true }); } catch {}

  process.env.HOME = home;
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_RUNTIME_DIR = runtimeDirectory;
  process.env.DBUS_SESSION_BUS_ADDRESS = busAddress;
  process.env.GNOME_KEYRING_CONTROL = controlDirectory;

  runChecked("dbus-daemon", [
    "--session",
    "--fork",
    "--nopidfile",
    `--address=${busAddress}`,
  ]);

  runChecked("gnome-keyring-daemon", [
    "--unlock",
    "--components=secrets",
    `--control-directory=${controlDirectory}`,
  ], { input: `${password}\n` });

  return { busAddress, controlDirectory, passwordFile, runtimeDirectory };
}
