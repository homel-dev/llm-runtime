#!/bin/sh
# OmniRoute startup configuration through the built-in management REST API.
# Override inputs with env vars; runs alongside the server, not in postStart.
set -eu

# postStart hook output is not automatically part of the container log stream.
# Redirect to the OmniRoute process streams only inside its Pod.
if [ "${OR_LOG_TO_PID1:-0}" = 1 ]; then
  exec >/proc/1/fd/1 2>/proc/1/fd/2
fi

: "${OR_BASE_URL:=http://127.0.0.1:20128}"
: "${OR_WAIT_SECONDS:=240}"
: "${OR_WAIT_INTERVAL:=3}"
: "${OR_MANAGE_SCRIPT:=/etc/omniroute-startup/manage.mjs}"
: "${OR_REQUEST_TIMEOUT_MS:=15000}"
export OR_REQUEST_TIMEOUT_MS

# Native provider IDs, connection names and models.
: "${OR_CODEX_PROVIDER:=codex}"
: "${OR_CODEX_NAME:=llm-runtime Codex}"
: "${OR_CODEX_AUTH_FILE:=/codex-auth/auth.json}"
: "${OR_CODEX_IMPORT_ENDPOINT:=/api/providers/codex-auth/import}"

: "${OR_AGY_PROVIDER:=agy}"
: "${OR_AGY_NAME:=llm-runtime Antigravity}"
: "${OR_AGY_AUTH_FILE:=/agy-auth/.gemini/antigravity-cli/antigravity-oauth-token}"
: "${OR_AGY_IMPORT_ENDPOINT:=/api/providers/agy-auth/import}"

: "${OR_GLM_PROVIDER:=glm}"
: "${OR_GLM_NAME:=llm-runtime GLM Coding Plan}"
: "${OR_GLM_MODEL:=glm-5.3}"
: "${OR_GLM_KEY_ENV:=ZAI_API_KEY}"

: "${OR_OPENCODE_PROVIDER:=opencode-zen}"
: "${OR_OPENCODE_NAME:=llm-runtime OpenCode Zen}"
: "${OR_OPENCODE_MODEL:=}"
: "${OR_OPENCODE_KEY_ENV:=OPENCODE_API_KEY}"

# Aliases are applied through OmniRoute's own settings endpoint.
: "${OR_CODEX_ALIAS:=gpt-5.6-sol}"
: "${OR_CODEX_TARGET:=codex/gpt-5.6-sol}"
: "${OR_GEMINI_PRO_ALIAS:=gemini-subscription-pro}"
: "${OR_GEMINI_PRO_TARGET:=agy/gemini-pro-agent}"
: "${OR_GEMINI_AUTO_ALIAS:=gemini-subscription-auto}"
: "${OR_GEMINI_AUTO_TARGET:=agy/gemini-3.7-flash-medium}"
: "${OR_GLM_ALIAS:=glm-5.3}"
: "${OR_GLM_TARGET:=glm/glm-5.3}"
: "${OR_GLM_FLASH_ALIAS:=glm-5.3-flash}"
: "${OR_GLM_FLASH_TARGET:=glm/glm-5.3-flash}"

helper() { node "$OR_MANAGE_SCRIPT" "$@"; }

printf '%s\n' 'omniroute-config: waiting for local management API'
helper wait "$OR_WAIT_SECONDS" "$OR_WAIT_INTERVAL"
# Prefer the stable operator token if one exists; otherwise mint a short-lived
# startup management token using the configured server password.
OMNIROUTE_API_KEY="$(helper token)"
export OMNIROUTE_API_KEY
[ -n "$OMNIROUTE_API_KEY" ] || { echo 'omniroute-config: no management token' >&2; exit 1; }

upsert_key_provider() {
  helper upsert-key "$1" "$2" "$3" "$4"
}

# A failed provider must not prevent the remaining providers and aliases from
# being configured. Keep an explicit failed exit status and per-step diagnostics.
failed=0
step() {
  label="$1"; shift
  if "$@"; then
    printf 'omniroute-config: OK %s\n' "$label"
  else
    code=$?
    failed=$((failed + 1))
    printf 'omniroute-config: FAILED %s (exit=%s)\n' "$label" "$code" >&2
  fi
}

# Import OAuth credentials only when the provider has no existing connection.
step codex-oauth helper import-oauth "$OR_CODEX_PROVIDER" "$OR_CODEX_NAME" "$OR_CODEX_AUTH_FILE" "$OR_CODEX_IMPORT_ENDPOINT"
step agy-oauth helper import-oauth "$OR_AGY_PROVIDER" "$OR_AGY_NAME" "$OR_AGY_AUTH_FILE" "$OR_AGY_IMPORT_ENDPOINT"
step glm upsert_key_provider "$OR_GLM_PROVIDER" "$OR_GLM_NAME" "$OR_GLM_MODEL" "$OR_GLM_KEY_ENV"
step opencode-zen upsert_key_provider "$OR_OPENCODE_PROVIDER" "$OR_OPENCODE_NAME" "$OR_OPENCODE_MODEL" "$OR_OPENCODE_KEY_ENV"

step alias-codex helper alias "$OR_CODEX_ALIAS" "$OR_CODEX_TARGET"
step alias-gemini-pro helper alias "$OR_GEMINI_PRO_ALIAS" "$OR_GEMINI_PRO_TARGET"
step alias-gemini-auto helper alias "$OR_GEMINI_AUTO_ALIAS" "$OR_GEMINI_AUTO_TARGET"
step alias-glm helper alias "$OR_GLM_ALIAS" "$OR_GLM_TARGET"
step alias-glm-flash helper alias "$OR_GLM_FLASH_ALIAS" "$OR_GLM_FLASH_TARGET"

if [ "$failed" -ne 0 ]; then
  printf 'omniroute-config: FAILED %s step(s); see preceding errors\n' "$failed" >&2
  exit 1
fi
printf '%s\n' 'omniroute-config: configured all four native providers and five aliases'
