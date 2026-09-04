# LLM Gateway

*Trusted subscription-provider gateway — architecture and operations.*

---

## Table of Contents

- [Status and Authority](#status-and-authority)
- [Ownership](#ownership)
- [Backends](#backends)
- [Gemini Subscription Transport](#gemini-subscription-transport)
- [Build and Verify](#build-and-verify)
- [Authenticate Google AI Subscription](#authenticate-google-ai-subscription)
- [Deploy and Smoke-Test](#deploy-and-smoke-test)
- [Migration Compatibility](#migration-compatibility)
- [Observability](#observability)
- [API Limitations](#api-limitations)
- [Tradeoffs and Failure Modes](#tradeoffs-and-failure-modes)

---

## Status and Authority

**Status:** IMPLEMENTED.

Executable sources of truth are the gateway source and tests under `gateway/`,
`k8s/gateway/`, `k8s/networkpolicy.yml`, the Taskfile gateway targets, and the
GitHub Actions image workflow.

`llm-runtime` has authority over provider transport, provider authentication
storage, gateway routing for advertised model IDs, gateway network policy, and
runtime telemetry. Consumer projects decide when a gateway model is used and
what application fallback policy applies.

A provider or transport failure produces an explicit gateway failure. The
gateway does not silently select a different provider or consumer policy.

[Back to top](#llm-gateway)

---

## Ownership

`llm-runtime` owns:

- gateway source and tests under `gateway/`;
- gateway image build and publication;
- `llm-openai-api-gateway` Deployment and Service;
- gateway NetworkPolicy and RR service-discovery RBAC;
- ChatGPT/Codex and Google subscription auth PVCs;
- temporary interactive login Pods;
- the optional API-key Secret example;
- operational login, deployment, smoke, and telemetry tasks.

RR is a consumer. It retains endpoint and model aliases but does not own gateway
source, provider credentials, images, or Kubernetes gateway resources.

Stable endpoint:

```text
http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000
```

[Back to top](#llm-gateway)

---

## Backends

The router exposes configured model IDs and routes them to trusted loopback
backends in the same Pod.

| Gateway model | Backend | Transport |
| --- | --- | --- |
| `gpt-5.6-sol` | ChatGPT/Codex subscription | `openai-oauth` on `127.0.0.1:10531` |
| `gemini-subscription-pro` | Google AI subscription | Antigravity CLI model `gemini-3.1-pro-high` on `127.0.0.1:10532` |
| `gemini-subscription-auto` | Google AI subscription | compatibility alias pinned to `gemini-3.7-flash-medium` on `127.0.0.1:10532` |

`gemini-subscription-auto` is retained for RR compatibility. It does not mean
dynamic model selection.

Routing authority is constrained by the configured model table. Requests for
unadvertised models fail rather than being forwarded to an arbitrary provider.

[Back to top](#llm-gateway)

---

## Gemini Subscription Transport

Individual Google AI subscription access uses Antigravity CLI (`agy`). The
adapter uses these headless interfaces:

- `--input-format stream-json` with NDJSON prompt input;
- `--output-format stream-json`;
- an explicit `--model` slug;
- caller `response_format` JSON Schema mapped directly to Antigravity `--json-schema` when structured output is requested;
- cached account authentication created by an interactive login.

The adapter does not ask the model to manufacture a gateway transport envelope.
For plain text completions, the provider `result.response` string becomes the
OpenAI-compatible assistant content without trimming, fence removal, JSON
parsing, or other interpretation. Function/tool calling and token-streaming are
rejected until deterministic native mappings exist rather than being emulated by
a model prompt or synthetic SSE.

The adapter removes Gemini API-key and Vertex credential environment variables
before spawning `agy`. This prevents an inherited parent environment from
changing the intended subscription authentication path.

The Antigravity settings file denies file, command, URL, unsandboxed, and MCP
actions. The provider container has no project workspace mount. Kubernetes runs
the provider container with the security context declared by the Deployment and
restricts external egress to the policy-defined TCP/443 path.

`useG1Credits` is disabled. Exhausting normal plan quota therefore surfaces as a
failure instead of consuming personal AI credits through that setting.

[Back to top](#llm-gateway)

---

## Build and Verify

Run repository and gateway checks before image promotion:

```bash
task gateway:verify
```

Build a local Minikube image with:

```bash
task gateway:image:build
```

The gateway image verifies the pinned `agy` artifact checksum, version, and required headless flags during image construction.

### GitHub Actions image build

`.github/workflows/gateway-image.yml` is the canonical remote image build for
`homel-dev/llm-runtime`.

Pull requests run verification and a full `linux/amd64` BuildKit build without
registry write permission. `main`, `v*` tags, and manual dispatch publish to:

```text
ghcr.io/homel-dev/llm-runtime-gateway
```

Published metadata includes the full commit-SHA tag, branch or release tags,
BuildKit provenance, and an SBOM. `main` updates `latest`.

Deployments that promote a specific build use the immutable digest:

```bash
LLM_GATEWAY_IMAGE='ghcr.io/homel-dev/llm-runtime-gateway@sha256:<digest>' \
  task gateway:deploy
```

The Deployment references `imagePullSecrets: [{name: ghcr-pull-secret}]`.
Private GHCR packages therefore require that Secret in `llm-runtime` before
image pull.

The Dockerfile pins Antigravity CLI `1.1.26` build `5550154686791680` by
its official Google Storage artifact and verifies the Linux x86_64 SHA-256
before installation. The image build also checks that the required headless CLI
flags are present. Updating Antigravity therefore requires an explicit source
change and produces a reviewable gateway-image diff.

[Back to top](#llm-gateway)

---

## Authenticate Google AI Subscription

For a new or expired auth PVC, run:

```bash
task gateway:gemini:login
```

The task creates a temporary Pod, launches `agy` with interactive account
authentication, and persists credential state on
`rr-gemini-subscription-auth`. After authentication it runs a non-interactive
`gemini-3.1-pro-high` prompt and fails unless Antigravity reports success and
returns the expected marker.

The auth PVC names remain `rr-openai-subscription-auth` and
`rr-gemini-subscription-auth` so an existing RR-owned installation can be
adopted without discarding cached state. Current ownership is `llm-runtime`.

Authentication success is Observed State at the time of verification. It does
not guarantee future quota or credential freshness.

[Back to top](#llm-gateway)

---

## Deploy and Smoke-Test

Deploy and inspect:

```bash
task gateway:deploy
task gateway:status
```

Validate the Google AI provider path end to end:

```bash
task gateway:gemini:check
```

The check executes inside the router container, sends an OpenAI Chat
Completions request to `127.0.0.1:8000`, routes it to the Antigravity adapter
over Pod loopback, and invokes the authenticated subscription model. It exits
non-zero unless the expected marker is returned.

A ready Deployment or successful `/v1/models` response is insufficient to
accept provider health.

[Back to top](#llm-gateway)

---

## Migration Compatibility

The Deployment retains the legacy immutable selector
`app: llm-openai-api-gateway`. This permits `kubectl apply` to adopt an existing
RR-created Deployment without attempting to mutate the immutable selector.

Pods also carry `app.kubernetes.io/name: llm-openai-api-gateway`; the Service and
new NetworkPolicy use that standardized label.

`gateway:deploy` reapplies `k8s/networkpolicy.yml` before the gateway policy.
This narrows the existing `allow-runtime-consumers` policy to inference Pods.
Without that reconciliation, Kubernetes NetworkPolicy union semantics would
leave the gateway covered by the older broad TCP/8000 ingress rule.

Migration failure is visible as Kubernetes apply, rollout, or connectivity
failure. The deployment procedure does not delete authentication PVCs as an
implicit recovery action.

[Back to top](#llm-gateway)

---

## Observability

The gateway exposes Prometheus metrics on dedicated TCP/9091. RR consumers are
allowed only to TCP/8000; gateway NetworkPolicy permits TCP/9091 from runtime
Prometheus.

Prometheus job `llm-gateway` scrapes `:9091/metrics`. Exported metrics include:

- request totals by backend, model, and status;
- request-duration histogram;
- in-flight requests;
- upstream transport errors and timeouts;
- request and response byte counters;
- local policy rejections by reason;
- configured backend and model gauges;
- last request success, last response status, and last success/error timestamps;
- gateway process uptime and RSS.

The OCO consumer contract publishes `LLM Runtime Gateway`
(`uid=llm-runtime-gateway`) for gateway health, request rate, p95 latency,
errors and timeouts, last-success age, traffic, policy rejections, and process
memory.

Reconcile monitoring with:

```bash
task gateway:observability:deploy
```

Validate the metrics path with:

```bash
task gateway:metrics
task observability:gateway-target
task observability:gateway-up
```

Telemetry is passive. During an idle period, expired credentials can remain
undetected until traffic or an explicit provider check exercises them.

[Back to top](#llm-gateway)

---

## API Limitations

Gemini subscription routing supports non-streaming OpenAI Chat Completions
for text output. `response_format: {type: "json_object"}` and
`response_format: {type: "json_schema", ...}` are enforced with Antigravity's
native `--json-schema` facility. `/v1/responses` returns HTTP 501 for Gemini
subscription models.

Gemini function/tool calling, tool-call history, and `stream: true` fail closed
until deterministic native mappings exist. The gateway does not synthesize tool
calls or buffered SSE and does not ask the model to emit a transport envelope.

Output-token limits are capability-aware. The effective limit is the smaller of
the client-requested limit and `GATEWAY_MAX_OUTPUT_TOKENS` when the gateway cap
is enabled. ChatGPT/Codex OAuth rejects native `max_output_tokens`, so
subscription non-streaming responses are buffered only until their upstream
usage can be verified; verified responses retain their exact upstream body
bytes. Missing/untrustworthy usage or an over-limit result fails closed, and
subscription streaming fails closed while a limit is active because already
emitted SSE bytes cannot be revoked. With no client or gateway limit,
subscription responses remain raw passthrough. Gemini's CLI likewise has no
native output-token limit, so the adapter verifies Antigravity usage before
releasing a completed response. These checks bound what reaches the consumer;
they do not claim to cap provider-side generation cost for subscription-backed
transports.

Unsupported paths or provider capabilities fail explicitly.

[Back to top](#llm-gateway)

---

## Tradeoffs and Failure Modes

The gateway centralizes provider credentials and transport logic. That reduces
credential duplication but creates a shared dependency for subscription-backed
consumers.

The loopback sidecar model isolates provider transports from consumers but adds
process and operational complexity inside one Pod.

Account-backed subscription transport depends on external provider behavior,
quota, and credential freshness. Kubernetes readiness cannot prove those
properties.

Antigravity is version- and checksum-pinned in the gateway image. Provider
transport upgrades are therefore explicit source changes rather than implicit
rebuild-time dependency changes.

The gateway does not implement consumer fallback authority. Authentication
failure, provider rejection, quota exhaustion, timeout, unsupported API shape,
or unknown model ID produces failure for the caller and telemetry for the
operator.

[Back to top](#llm-gateway)

---

**END OF DOCUMENT**
