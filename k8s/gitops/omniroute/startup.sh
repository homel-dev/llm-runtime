#!/bin/sh
# Native OmniRoute startup configuration. Set overrides in deployment.yml.
# This script runs in the server container's postStart hook, NOT in another proxy.
set -eu

: "${OR_BASE_URL:=http://127.0.0.1:20128}"
: "${OR_CLI:=/app/bin/omniroute.mjs}"
: "${OR_WAIT_SECONDS:=240}"
: "${OR_WAIT_INTERVAL:=3}"

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

helper() { node /etc/omniroute-startup/manage.mjs "$@"; }
cli() { node "$OR_CLI" --base-url "$OR_BASE_URL" "$@"; }

printf '%s\n' 'omniroute-config: waiting for local management API'
helper wait "$OR_WAIT_SECONDS" "$OR_WAIT_INTERVAL"
# Prefer the stable operator token if one exists; otherwise mint a short-lived
# startup management token using the configured server password.
OMNIROUTE_API_KEY="$(helper token)"
export OMNIROUTE_API_KEY
[ -n "$OMNIROUTE_API_KEY" ] || { echo 'omniroute-config: no management token' >&2; exit 1; }

require_key() {
  key_name="$1"
  node -e '
    const name = process.argv[1];
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !process.env[name]) {
      console.error(`omniroute-config: required ${name} is missing`);
      process.exit(1);
    }
  ' "$key_name"
}

upsert_key_provider() {
  provider="$1"; name="$2"; model="$3"; key_env="$4"
  require_key "$key_env"
  existing_id="$(helper find "$provider" "$name")"
  if [ -n "$existing_id" ]; then
    if [ -n "$model" ]; then
      cli providers edit "$existing_id" --default-model "$model" --credential-env "$key_env"
    else
      cli providers edit "$existing_id" --credential-env "$key_env"
    fi
  else
    if [ -n "$model" ]; then
      cli providers add "$provider" --name "$name" --default-model "$model" --credential-env "$key_env" --yes
    else
      cli providers add "$provider" --name "$name" --credential-env "$key_env" --yes
    fi
  fi
  printf 'omniroute-config: API key provider %s configured\n' "$provider"
}

# Import existing OAuth sessions once. Do not replace refreshed token families
# from the OmniRoute database on every Pod restart.
helper import-oauth "$OR_CODEX_PROVIDER" "$OR_CODEX_NAME" "$OR_CODEX_AUTH_FILE" "$OR_CODEX_IMPORT_ENDPOINT"
helper import-oauth "$OR_AGY_PROVIDER" "$OR_AGY_NAME" "$OR_AGY_AUTH_FILE" "$OR_AGY_IMPORT_ENDPOINT"
upsert_key_provider "$OR_GLM_PROVIDER" "$OR_GLM_NAME" "$OR_GLM_MODEL" "$OR_GLM_KEY_ENV"
upsert_key_provider "$OR_OPENCODE_PROVIDER" "$OR_OPENCODE_NAME" "$OR_OPENCODE_MODEL" "$OR_OPENCODE_KEY_ENV"

helper alias "$OR_CODEX_ALIAS" "$OR_CODEX_TARGET"
helper alias "$OR_GEMINI_PRO_ALIAS" "$OR_GEMINI_PRO_TARGET"
helper alias "$OR_GEMINI_AUTO_ALIAS" "$OR_GEMINI_AUTO_TARGET"
helper alias "$OR_GLM_ALIAS" "$OR_GLM_TARGET"
helper alias "$OR_GLM_FLASH_ALIAS" "$OR_GLM_FLASH_TARGET"

printf '%s\n' 'omniroute-config: four native providers configured'
