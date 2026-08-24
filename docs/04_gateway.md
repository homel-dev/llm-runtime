# LLM gateway

## Ownership

`llm-runtime` owns the trusted OpenAI-compatible gateway used by RR and other
cluster consumers. This repository owns:

- gateway source and tests under `gateway/`;
- the gateway image build;
- `llm-openai-api-gateway` Deployment and Service;
- gateway NetworkPolicy and RR service-discovery RBAC;
- ChatGPT/Codex and Google subscription auth PVCs;
- temporary interactive login Pods;
- the optional API-key Secret example;
- operational login/deploy/smoke tasks.

RR is a consumer. It keeps endpoint/model aliases but does not own gateway
source, provider credentials, images, or Kubernetes gateway resources.

Stable endpoint:

```text
http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000
```

## Backends

The router exposes only configured model IDs and routes them to trusted
loopback backends in the same Pod.

| Gateway model | Backend | Transport |
| --- | --- | --- |
| `gpt-5.6-sol` | ChatGPT/Codex subscription | `openai-oauth` on `127.0.0.1:10531` |
| `gemini-subscription-pro` | Google AI subscription | Antigravity CLI model `gemini-3.1-pro-high` on `127.0.0.1:10532` |
| `gemini-subscription-auto` | Google AI subscription | compatibility alias pinned to `gemini-3.7-flash-medium` on `127.0.0.1:10532` |

The `gemini-subscription-auto` name is retained for RR compatibility. It is not
dynamic model auto-selection.

## Gemini subscription transport

Individual Google AI subscription access uses Antigravity CLI (`agy`), not the
legacy Gemini CLI individual-account path. The adapter uses documented
headless features:

- `--input-format stream-json` and NDJSON prompt input;
- `--output-format stream-json`;
- an explicit `--model` slug;
- `--json-schema` for the adapter transport envelope;
- cached account authentication created by one interactive login.

The adapter removes Gemini API-key/Vertex credential environment variables
before spawning `agy`, so a contaminated parent environment cannot silently
change the intended subscription billing/auth path.

The Antigravity settings file denies all file, command, URL, unsandboxed, and
MCP actions. The sidecar has no project workspace mount. Kubernetes also runs
it non-root with a read-only root filesystem and limits external egress to TCP
443. RR/Pi remains responsible for actual declared tool execution.

`useG1Credits` is disabled. Exhausting normal plan quota therefore does not
silently consume personal AI credits.

## Build and verify

```bash
task gateway:verify
task gateway:image:build
```

`gateway:verify` runs strict TypeScript type checking plus gateway unit tests.
The image installs the current official Antigravity CLI using Google's Linux
installer and verifies `agy --version` during the image build.

## Authenticate Google AI subscription

Run once for a new/expired auth PVC:

```bash
task gateway:gemini:login
```

The task creates a temporary Pod, launches `agy` with remote/SSH-style OAuth,
and leaves the credential state on `rr-gemini-subscription-auth`. After the
interactive session exits it runs a non-interactive `gemini-3.1-pro-high`
prompt and fails unless Antigravity reports `SUCCESS` and returns the expected
marker.

The auth PVC names intentionally remain `rr-openai-subscription-auth` and
`rr-gemini-subscription-auth` so an existing RR-owned installation can be
adopted without discarding cached login state. Ownership is now `llm-runtime`
regardless of those legacy-stable names.

## Deploy and smoke-test

```bash
task gateway:deploy
task gateway:status
task gateway:gemini:check
```

`gateway:gemini:check` is end-to-end: it executes inside the router container,
POSTs an OpenAI Chat Completions request to `127.0.0.1:8000`, the router sends
that request to the Antigravity adapter over Pod loopback, and the adapter calls
the authenticated subscription model. The task exits non-zero unless the model
returns the expected marker.

## Migration compatibility

The Deployment deliberately retains the legacy immutable selector
`app: llm-openai-api-gateway`, which permits `kubectl apply` to adopt an
existing RR-created Deployment in place. Pods also carry
`app.kubernetes.io/name: llm-openai-api-gateway`, and the Service plus new
NetworkPolicy use that standardized label.

`gateway:deploy` also reapplies `k8s/networkpolicy.yml`, narrowing the existing
`allow-runtime-consumers` policy to inference Pods before the gateway policy is
created. Without that migration step, Kubernetes NetworkPolicy union semantics
would leave the gateway covered by the older broad port-8000 ingress rule.

## Observability

The gateway exposes Prometheus metrics on a dedicated container/Service port
`9091`. RR consumers are allowed only to port `8000`; the gateway NetworkPolicy
allows port `9091` only from the `prometheus` Pod in `llm-runtime`.

Prometheus job `llm-gateway` scrapes `:9091/metrics`. Exported metrics include:

- request totals by backend, model, and status;
- request-duration histogram for p50/p95/p99 queries;
- in-flight requests;
- upstream transport errors and timeouts;
- request/response byte counters;
- local policy rejections by reason;
- configured backend/model gauges;
- last request success, last response status, and last success/error timestamps;
- gateway process uptime and RSS.

The OCO consumer contract publishes a separate Grafana dashboard named
`LLM Runtime Gateway` (`uid=llm-runtime-gateway`) with gateway health, request
rate, p95 latency, errors/timeouts, subscription last-success age, traffic,
policy rejections, and process memory.

Apply or refresh the monitoring contract with:

```bash
task gateway:observability:deploy
```

`observability:deploy` restarts Prometheus after applying its ConfigMap, so a
changed scrape configuration is actually loaded. Useful checks are:

```bash
task gateway:metrics
task observability:gateway-target
task observability:gateway-up
```

## API limitations

Gemini subscription routing currently supports OpenAI Chat Completions.
`/v1/responses` returns HTTP 501 for Gemini subscription models. OpenAI function
calling is represented through a schema-constrained transport envelope and
validated against the declared function names. `stream: true` returns
OpenAI-compatible SSE framing after the Antigravity result completes; it is not
upstream token-by-token streaming.

