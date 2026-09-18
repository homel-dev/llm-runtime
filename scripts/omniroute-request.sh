#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 METHOD PATH [JSON_BODY] [--no-auth]" >&2
  exit 2
}

method="${1:-}"
path="${2:-}"
body="${3:-}"
no_auth=false
[[ "${3:-}" == "--no-auth" ]] && { body=""; no_auth=true; }
[[ "${4:-}" == "--no-auth" ]] && no_auth=true
[[ -n "$method" && "$path" == /* ]] || usage

case "$method" in
  GET|POST|PUT|PATCH|DELETE) ;;
  *) usage ;;
esac

token="${OMNIROUTE_TOKEN:-}"
if [[ "$no_auth" != true && -z "$token" ]]; then
  token="$(kubectl -n llm-runtime get secret omniroute-operator-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
fi
if [[ "$no_auth" != true && -z "$token" ]]; then
  echo "OmniRoute operator token missing; run: task omniroute:operator-token" >&2
  exit 2
fi

body_b64=""
if [[ -n "$body" ]]; then
  body_b64="$(printf '%s' "$body" | base64 | tr -d '\n')"
fi

kubectl -n llm-runtime exec deployment/omniroute -c omniroute -- \
  env OR_METHOD="$method" OR_PATH="$path" OR_TOKEN="$token" OR_BODY_B64="$body_b64" OR_NO_AUTH="$no_auth" \
  node -e '
const method = process.env.OR_METHOD;
const path = process.env.OR_PATH;
const noAuth = process.env.OR_NO_AUTH === "true";
const token = process.env.OR_TOKEN || "";
const bodyB64 = process.env.OR_BODY_B64 || "";
const headers = { accept: "application/json" };
if (!noAuth) headers.authorization = `Bearer ${token}`;
let body;
if (bodyB64) {
  body = Buffer.from(bodyB64, "base64").toString("utf8");
  headers["content-type"] = "application/json";
}
fetch(`http://127.0.0.1:20128${path}`, { method, headers, body })
  .then(async (response) => {
    const text = await response.text();
    if (text) process.stdout.write(`${text}\n`);
    if (!response.ok) process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
'
