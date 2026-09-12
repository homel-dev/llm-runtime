# LLM Gateway

*Trusted subscription-provider gateway — architecture and operations.*

---

## Table of Contents

- [Status and Authority](#status-and-authority)
- [Ownership](#ownership)
- [Backends](#backends)
- [Codex Subscription Transport](#codex-subscription-transport)
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
| `gpt-5.6-sol` | ChatGPT/Codex subscription | Stateful Codex Responses WebSocket transport on `127.0.0.1:10533` |
| `gemini-subscription-pro` | Google AI subscription | Direct Cloud Code Assist HTTP, wire model `gemini-pro-agent` on `127.0.0.1:10532` |
| `gemini-subscription-auto` | Google AI subscription | Direct Cloud Code Assist HTTP, wire model `gemini-3.7-flash-medium` on `127.0.0.1:10532` |

`gemini-subscription-auto` is retained for RR compatibility. It does not mean
dynamic model selection.

Routing authority is constrained by the configured model table. Requests for
unadvertised models fail rather than being forwarded to an arbitrary provider.

[Back to top](#llm-gateway)

---

## Codex Subscription Transport

`gpt-5.6-sol` uses a dedicated loopback Codex transport rather than the generic
Chat Completions compatibility proxy. The transport reads the official Codex
`auth.json` written by `task gateway:openai:login`, refreshes ChatGPT OAuth
credentials when required, and talks directly to the ChatGPT Codex Responses
backend.

The provider path is Responses-only. The transport keeps a WebSocket session per
stable `prompt_cache_key`. After the first full request it records the provider
response ID and output items. If the next client request is an exact extension
of that conversation, the upstream request contains only the new input plus
`previous_response_id`; the full history is not replayed to ChatGPT. A changed
static request body or mismatched history fails back to a full request.

The transport keeps `store: false`, propagates encrypted reasoning state, scopes
cached WebSockets to the authenticated ChatGPT account, serializes turns within
one session, and drops continuation state when the WebSocket is no longer
usable. If WebSocket setup fails before any downstream bytes are emitted, it can
fall back to direct Codex Responses SSE for that request.

`task gateway:check PROVIDER=openai` performs two Responses turns with one cache
key and verifies through loopback transport statistics that the second turn used
delta continuation and sent fewer upstream bytes than the full client request.

[Back to top](#llm-gateway)

---

## Gemini Subscription Transport

Individual Google AI subscription access uses a direct Cloud Code Assist
transport (`antigravity-direct`). The adapter speaks the same wire API the
Antigravity client calls, without running the Antigravity agent loop:

- OpenAI Chat Completions in, native `streamGenerateContent` (`alt=sse`) out;
- an explicit wire model via `ANTIGRAVITY_ADAPTER_MODEL_MAP`; the Pro alias
  resolves to the live `gemini-pro-agent` deployment;
- caller `response_format` JSON Schema mapped to native `responseJsonSchema`;
- OAuth credentials loaded from the login-cached token file or the keyring, with
  single-flight refresh against the Google token endpoint.

The adapter does not ask the model to manufacture a gateway transport envelope
and does not route through the Antigravity agent harness. Native Gemini
`functionCall`/`functionResponse` map to OpenAI `tool_calls`/tool history, and
native SSE is translated to OpenAI streaming chunks.

`agy` (Antigravity CLI) is retained solely for interactive account login
(`task gateway:gemini:login`), which caches the subscription credential the
direct adapter then reads. The login path removes Gemini API-key and Vertex
credential environment variables so the cached credential stays on the intended
subscription authentication path.

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
`gemini-3.1-pro-high` prompt against the cached account state.

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

Validate each subscription path or every advertised gateway model end to end:

```bash
task gateway:openai:check
task gateway:gemini:check
task gateway:check
```

Each check executes inside the router container and sends real OpenAI Chat
Completions requests to `127.0.0.1:8000`. Provider-specific tasks select only
that subscription backend; `gateway:check` discovers `/v1/models` and checks
every advertised model across all registered backends. A check requires HTTP
success, valid JSON, and non-empty assistant content and returns non-zero after
reporting every failed model.

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

Gemini subscription routing supports OpenAI Chat Completions text output,
native function/tool calling, tool-call history, and `stream: true`, mapped
deterministically to the Cloud Code Assist wire API. `response_format: {type: "json_object"}`
and `response_format: {type: "json_schema", ...}` map to native
`responseJsonSchema`. `/v1/responses` returns HTTP 501 for Gemini subscription
models.

The router does not run its output-token verification for the
`gemini-subscription` backend (only for `subscription`), so the Gemini adapter
self-enforces the effective limit: with a limit active it buffers, verifies
terminal usage (reasoning tokens included), and fails closed before releasing
any bytes, because emitted SSE cannot be revoked. With no limit it streams
through unbuffered.

Output-token limits are capability-aware. The effective limit is the smaller of
the client-requested limit and `GATEWAY_MAX_OUTPUT_TOKENS` when the gateway cap
is enabled. ChatGPT/Codex Chat Completions is adapter-backed and therefore keeps
the fail-closed post-response verification path: bounded subscription responses
are buffered until terminal usage proves the effective limit was respected.

ChatGPT/Codex Responses is different: `max_output_tokens` is native to the
Responses transport. When `GATEWAY_MAX_OUTPUT_TOKENS=0`, the gateway forwards
the caller's `max_output_tokens` and streams the upstream SSE response directly;
it does not buffer the entire response merely to re-check that caller-owned
native limit. Setting a non-zero `GATEWAY_MAX_OUTPUT_TOKENS` opts back into the
gateway's fail-closed post-response verification and buffering for Responses as
well.

Gemini's CLI likewise has no native output-token limit, so the adapter verifies
Antigravity usage before releasing a completed response. These checks bound what
reaches the consumer; they do not claim to cap provider-side generation cost for
subscription-backed transports.

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
