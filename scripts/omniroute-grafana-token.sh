#!/usr/bin/env bash
# Mint a scoped read-only OmniRoute management token inside its Pod and
# provision it as an OCO Grafana Secret. Never print or copy token to host files.
set -euo pipefail
kubectl -n llm-runtime exec deployment/omniroute -c omniroute -- \
  node --input-type=module -e '
  const password = process.env.INITIAL_PASSWORD;
  if (!password) throw new Error("Missing INITIAL_PASSWORD");
  const response = await fetch("http://127.0.0.1:20128/api/cli/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password, scope: "read", name: "oco-grafana-omniroute",
      expiresInDays: 365,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Read-only token issue failed: HTTP ${response.status}`);
  const data = await response.json();
  if (data.scope !== "read" || typeof data.token !== "string" || !data.token.startsWith("oma_")) {
    throw new Error("Read-only token issue returned unexpected payload");
  }
  process.stdout.write(data.token);
' | kubectl -n observability-console create secret generic omniroute-grafana-readonly \
  --from-file=token=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -

printf '%s\n' 'Read-only Grafana token Secret reconciled in observability-console.'
printf '%s\n' 'Restart OCO Grafana after applying the OCO deployment patch to read the token env.'
