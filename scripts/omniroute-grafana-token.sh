#!/usr/bin/env bash
# Maintain the read-only OmniRoute token used by OCO Grafana.
# Credentials stay in Kubernetes Secrets and stdin; never print token values.
set -euo pipefail

secret_name=omniroute-grafana-readonly

# Check the ACTUAL token stored in the Kubernetes Secret against OmniRoute.
# Passing the secret through stdin avoids putting it in a command argument.
verify_secret_token() {
  kubectl -n observability-console get secret "$secret_name" -o jsonpath='{.data.token}' \
    | base64 -d \
    | kubectl -n llm-runtime exec -i deployment/omniroute -c omniroute -- \
        node --input-type=module -e '
          const chunks = [];
          for await (const chunk of process.stdin) chunks.push(chunk);
          const token = Buffer.concat(chunks).toString("utf8");
          if (!/^oma_live_[A-Za-z0-9_-]+$/.test(token)) throw Error("Invalid access-token format");
          const base = "http://127.0.0.1:20128";
          for (const path of ["/api/cli/whoami"]) {
            const response = await fetch(base + path, {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
            if (path === "/api/cli/whoami") {
              const who = await response.json();
              if (who.authenticated !== true || who.viaAccessToken !== true || who.scope !== "read") {
                throw Error("Unexpected token identity or scope");
              }
            }
            console.log(`CHECK ${path}: HTTP ${response.status}`);
          }
        '
}

# Do not mint a new long-lived credential on every execution.
if kubectl -n observability-console get secret "$secret_name" >/dev/null 2>&1 \
  && verify_secret_token; then
  echo 'Existing read-only token is valid; reusing it.'
else
  echo 'Missing/invalid token; minting a fresh read-only token.'
  kubectl -n llm-runtime exec deployment/omniroute -c omniroute -- \
    node --input-type=module -e '
      const password = process.env.INITIAL_PASSWORD;
      if (!password) throw new Error("Missing INITIAL_PASSWORD");
      const response = await fetch("http://127.0.0.1:20128/api/cli/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, scope: "read", name: "oco-grafana-omniroute", expiresInDays: 365 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Token issue failed: HTTP ${response.status}`);
      const data = await response.json();
      if (data.scope !== "read" || typeof data.token !== "string" || !/^oma_live_[A-Za-z0-9_-]+$/.test(data.token)) {
        throw new Error("Unexpected token issue response");
      }
      // Verify BEFORE publishing the token to the K8s Secret.
      const check = await fetch("http://127.0.0.1:20128/api/cli/whoami", {
        headers: { authorization: `Bearer ${data.token}` },
        signal: AbortSignal.timeout(15000),
      });
      const who = check.ok ? await check.json() : null;
      if (!who || who.authenticated !== true || who.viaAccessToken !== true || who.scope !== "read") {
        throw new Error(`Issued token rejected: HTTP ${check.status}`);
      }
      process.stdout.write(data.token);
    ' | kubectl -n observability-console create secret generic "$secret_name" \
      --from-file=token=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -
  verify_secret_token
fi

# Grafana receives this Secret as an environment variable. Only a changed token
# requires a one-time restart; restarting on every invocation logs UI users out.
# No PVC or new credential is necessary when the running token already matches.
expected="$(kubectl -n observability-console get secret "$secret_name" \
  -o jsonpath='{.data.token}' | base64 -d | sha256sum | awk '{print $1}')"
kubectl -n observability-console rollout status deployment/grafana --timeout=300s
actual="$(kubectl -n observability-console exec deployment/grafana -c grafana -- \
  sh -ec 'test -n "$OMNIROUTE_GRAFANA_READ_TOKEN"; printf %s "$OMNIROUTE_GRAFANA_READ_TOKEN" | sha256sum' \
  | awk '{print $1}')"
if [[ "$expected" != "$actual" ]]; then
  echo 'Grafana token changed; restarting once to load the new Secret.'
  kubectl -n observability-console rollout restart deployment/grafana
  kubectl -n observability-console rollout status deployment/grafana --timeout=300s
  actual="$(kubectl -n observability-console exec deployment/grafana -c grafana -- \
    sh -ec 'test -n "$OMNIROUTE_GRAFANA_READ_TOKEN"; printf %s "$OMNIROUTE_GRAFANA_READ_TOKEN" | sha256sum' \
    | awk '{print $1}')"
else
  echo 'Grafana already has the expected token; no restart.'
fi
if [[ "$expected" != "$actual" ]]; then
  echo 'FAIL: Grafana environment and OmniRoute token Secret disagree.' >&2
  exit 1
fi
printf '%s\n' 'CHECK: Grafana environment matches the validated read-only token Secret.'

# The token is now known good. Check BOTH dashboard management API endpoints
# without rotating a credential when an unrelated endpoint fails.
verify_secret_token >/dev/null
kubectl -n observability-console get secret "$secret_name" -o jsonpath='{.data.token}' \
  | base64 -d \
  | kubectl -n llm-runtime exec -i deployment/omniroute -c omniroute -- \
      node --input-type=module -e '
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const token = Buffer.concat(chunks).toString("utf8");
        for (const path of ["/api/providers/health-matrix?range=24h", "/api/models/catalog"]) {
          const response = await fetch("http://127.0.0.1:20128" + path, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
          await response.arrayBuffer();
          console.log(`CHECK ${path}: HTTP ${response.status}`);
        }
      '
printf '%s\n' 'CHECK: Grafana restarted and OmniRoute management APIs accepted the Secret token.'

# Finally exercise the provisioned Infinity datasource through Grafana itself,
# not merely OmniRoute's own API. Never put the token in this request payload:
# Infinity must supply it from its encrypted datasource configuration.
result="$(kubectl -n observability-console exec -i deployment/grafana -c grafana -- \
  sh -ec 'curl -fsS --user "$GF_SECURITY_ADMIN_USER:$GF_SECURITY_ADMIN_PASSWORD" \
    -H "Content-Type: application/json" --data-binary @- \
    http://127.0.0.1:3000/api/ds/query' <<'JSON'
{
  "from": "now-5m",
  "to": "now",
  "queries": [{
    "refId": "A",
    "datasource": {"type": "yesoreyeram-infinity-datasource", "uid": "omniroute-api"},
    "type": "json",
    "format": "table",
    "source": "url",
    "url": "http://omniroute.llm-runtime.svc.cluster.local:20128/api/providers/health-matrix?range=24h",
    "url_options": {"method": "GET"},
    "parser": "backend",
    "root_selector": "$.providers",
    "columns": [{"selector": "provider", "text": "Provider", "type": "string"}],
    "intervalMs": 60000,
    "maxDataPoints": 100
  }]
}
JSON
)"
if ! printf '%s\n' "$result" | jq -e '
  .results.A as $a | $a != null and ($a.error // null) == null and (($a.status // 200) | tonumber < 400)
' >/dev/null; then
  printf 'FAIL: Infinity datasource query: ' >&2
  printf '%s\n' "$result" | jq -r '.results.A.error // .message // .error // "no successful Grafana query result"' >&2
  exit 1
fi
printf '%s\n' 'CHECK: Grafana Infinity query authenticated to OmniRoute.'
