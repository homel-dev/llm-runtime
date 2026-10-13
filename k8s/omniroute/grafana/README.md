# OmniRoute provider dashboard for OCO Grafana

Owned by `llm-runtime`; the existing OCO sidecars discover the two labelled
ConfigMaps in `llm-runtime` after the small OCO Grafana Deployment patch.
No extra scraper or data storage is introduced. This is a *live API view*, not
historical provider metrics.

## Installation

1. Apply `omniroute-grafana-oco.patch` in the `homel-dev/oco` repository and
   `omniroute-grafana-llm-runtime.patch` in `homel-dev/llm-runtime`.
   Commit/push desired state and allow Flux to reconcile both repositories.
2. From the `llm-runtime` checkout run
   `./scripts/omniroute-grafana-token.sh`. It provisions a 365-day `read` scope
   `oma_` token in `observability-console/omniroute-grafana-readonly`; it never
   writes the token to host filesystem or plaintext GitOps manifests.
3. Restart the Grafana Deployment to consume the Secret-backed env variable:
   `kubectl -n observability-console rollout restart deployment/grafana`
4. Check OCO Grafana folder **OCO** for
   `LLM Runtime / OmniRoute Providers & Models`.

## Data semantics

- `OmniRoute HTTP` uses OCO VictoriaMetrics (existing Alloy blackbox probe).
- `Provider health` calls OmniRoute `/api/providers/health-matrix?range=24h`
  with a scoped read-only management token. It describes observed provider
  quality, not guaranteed entitlement for every listed model.
- `Available model catalog` calls `/api/models/catalog`; advertised model IDs
  are **not** a guarantee that inference will succeed.
- Auto-refresh is 1m. No active or paid inference probes are generated.
- OmniRoute Pod NetworkPolicy permits only the OCO Grafana Pod in namespace
  `observability-console` on TCP/20128 (not blanket ingress).

The OCO Deployment pins Infinity datasource plugin `3.7.1` to match its current
Grafana `11.4.0` image; current Infinity releases require newer Grafana.
The platform should update Grafana and its plugin together during a separately
verified OCO upgrade. The dashboard deliberately uses OCO's existing standard
`victoriametrics` datasource for HTTP readiness.

Do not confuse a cached provider health status with a live readiness test.
The dashboard does not integrate with stagnation detection or The Dean.
