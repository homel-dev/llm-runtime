#!/usr/bin/env bash
set -euo pipefail

kubectl -n llm-runtime rollout status deployment/omniroute --timeout=300s >/dev/null

existing_token="$(kubectl -n llm-runtime get secret omniroute-operator-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d || true)"
if [[ -n "$existing_token" ]]; then
  if kubectl -n llm-runtime exec deployment/omniroute -c omniroute -- \
    env OR_TOKEN="$existing_token" node -e '
fetch("http://127.0.0.1:20128/api/cli/whoami", {
  headers: { authorization: `Bearer ${process.env.OR_TOKEN}`, accept: "application/json" },
}).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1));
' >/dev/null 2>&1; then
    echo "OmniRoute operator token already exists and is valid"
    exit 0
  fi
  echo "Existing OmniRoute operator token is stale; minting a replacement" >&2
fi

token="$(kubectl -n llm-runtime exec deployment/omniroute -c omniroute -- node -e '
const password = process.env.INITIAL_PASSWORD;
if (!password) {
  console.error("INITIAL_PASSWORD is not set in the OmniRoute container");
  process.exit(2);
}
fetch("http://127.0.0.1:20128/api/cli/connect", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ password, name: "llm-runtime-operator", scope: "admin" }),
}).then(async (response) => {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || !body?.token) {
    console.error(text || `HTTP ${response.status}`);
    process.exit(1);
  }
  process.stdout.write(body.token);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
')"

test -n "$token" || { echo "failed to mint OmniRoute operator token" >&2; exit 1; }

kubectl -n llm-runtime create secret generic omniroute-operator-token \
  --from-literal=token="$token" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "OmniRoute operator token stored in secret/omniroute-operator-token"
