#!/bin/sh
set -eu
# Runs inside Flux-managed Job in llm-runtime, NOT on the host.
# No xtrace, no token echoed to stdout/stderr.

kubectl -n llm-runtime wait --for=condition=Available deployment/omniroute --timeout=300s >/dev/null

existing_b64="$(kubectl -n rr get secret omniroute-operator-token -o jsonpath='{.data.token}' 2>/dev/null || true)"
if [ -n "$existing_b64" ]; then
  if printf '%s' "$existing_b64" | base64 -d | \
     kubectl -n llm-runtime exec -i deployment/omniroute -c omniroute -- node -e '
let token = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => token += chunk);
process.stdin.on("end", async () => {
  try {
    const response = await fetch("http://127.0.0.1:20128/api/cli/whoami", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const body = response.ok ? await response.json() : null;
    process.exitCode = response.ok && body?.viaAccessToken === true && body?.scope === "admin" ? 0 : 1;
  } catch { process.exitCode = 1; }
});
' >/dev/null 2>&1; then
    echo 'OmniRoute management token is already valid; preserving Secret.'
    exit 0
  fi
fi

token="$(kubectl -n llm-runtime exec deployment/omniroute -c omniroute -- node -e '
const password = process.env.INITIAL_PASSWORD;
if (!password) { console.error("INITIAL_PASSWORD is missing"); process.exit(2); }
fetch("http://127.0.0.1:20128/api/cli/connect", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ password, name: "rr-omniroute-operator", scope: "admin", expiresInDays: 365 }),
  signal: AbortSignal.timeout(15000),
}).then(async response => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.token !== "string" || !body.token.startsWith("oma_")) {
    console.error(`OmniRoute CLI connect: HTTP ${response.status}, no management token`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(body.token);
}).catch(() => { console.error("OmniRoute CLI connect failed"); process.exitCode = 1; });
')"
case "$token" in
  oma_*) ;;
  *) echo 'No valid management token returned' >&2; exit 1 ;;
esac

# No --from-literal in process argv and no client-side last-applied annotation.
printf '%s' "$token" \
  | kubectl -n rr create secret generic omniroute-operator-token \
      --from-file=token=/dev/stdin --dry-run=client -o yaml \
  | kubectl -n rr apply --server-side --field-manager=omniroute-token-bootstrap --force-conflicts -f - >/dev/null

echo 'OmniRoute management token saved: rr/omniroute-operator-token.'
