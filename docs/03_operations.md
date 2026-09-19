# OPERATIONS GUIDE

*Deployment, validation, recovery, and rollback procedures.*

---

## Table of Contents

- [0. Status and Scope](#0-status-and-scope)
- [1. Prerequisites](#1-prerequisites)
- [2. Deployment Lifecycles](#2-deployment-lifecycles)
- [3. Local Inference Validation](#3-local-inference-validation)
- [4. Gateway Build and Deployment](#4-gateway-build-and-deployment)
- [5. Subscription Authentication](#5-subscription-authentication)
- [6. Gateway Validation](#6-gateway-validation)
- [7. Observability and OCO](#7-observability-and-oco)
- [8. Incident Response](#8-incident-response)
- [9. Upgrade and Promotion](#9-upgrade-and-promotion)
- [10. Rollback](#10-rollback)
- [11. Restart and Recovery Checks](#11-restart-and-recovery-checks)
- [12. Operational Costs and Failure Boundaries](#12-operational-costs-and-failure-boundaries)

---

## 0. Status and Scope

**Status:** IMPLEMENTED.

This guide documents commands present in the current `Taskfile.yml` and
resources present in the current Kubernetes manifests. It covers runtime
infrastructure rather than project workflow operations.

**Operator rule:** validate Observed State after every deployment, restart,
authentication change, or rollback. Pod phase alone is not an acceptance
signal. Stop promotion when health, model discovery, provider checks, or
required telemetry fail.

[Back to top](#operations-guide)

---

## 1. Prerequisites

Required operator tools are:

- Docker;
- Minikube;
- `kubectl`;
- Task;
- `jq`;
- NVIDIA-capable Minikube configuration for GPU tiers.

Start the repository's default Minikube profile when required:

```bash
task miniup
```

`MINIKUBE_PROFILE` overrides the profile used by gateway image loading:

```bash
MINIKUBE_PROFILE=my-profile task gateway:image:build
```

If Minikube, Kubernetes DNS, storage, or GPU exposure is unhealthy, correct
that failure before applying runtime changes.

[Back to top](#operations-guide)

---

## 2. Deployment Lifecycles

### Local inference and runtime contract

```bash
task up
task status
```

The active root Desired State includes the namespace, Hugging Face Secret
manifest, runtime contract ConfigMap, `llm-small`, and `llm-large`.

The medium manifests remain in the repository but are not included by the root
Kustomization. `task up` reapplies `k8s/networkpolicy.yml` after Kustomize.

### LLM gateway

```bash
task gateway:deploy
task gateway:status
```

### Parallel OmniRoute gateway

```bash
task omniroute:deploy
task omniroute:status
task omniroute:endpoint:check
```

OmniRoute is exposed separately at
`http://llm-openai-api-gateway-omniroute.llm-runtime.svc.cluster.local:8000`.
Deploying it does not replace or mutate the existing `llm-openai-api-gateway`
Service. The parallel consumer endpoint has `REQUIRE_API_KEY=false`, so RR
switches only the base URL; management operations still use the OmniRoute
operator token.

Configure the non-interactive native providers and stable RR aliases:

```bash
task omniroute:configure-runtime
```

This creates or reconciles direct `glm`, `llama-cpp`, and `vllm` connections.
`glm` uses the existing `rr-zai-coding` API-key Secret and talks directly to
Z.AI Coding Plan. The local connections talk directly to `llm-small:8000` and
`llm-large:8000`. The legacy gateway is not an OmniRoute upstream.

Codex and Antigravity must use independent native OAuth sessions so the legacy
gateway remains a real rollback path. In particular, do not copy the legacy
Codex `auth.json` into OmniRoute: Codex refresh-token rotation can invalidate a
shared token family. Run `task omniroute:ui`, add the `codex` and `agy` providers
through OmniRoute authentication, then validate:

```bash
task omniroute:auth:status
task omniroute:check
```

`omniroute:check` requires both native OAuth connections and verifies that the
parallel `/v1/models` surface advertises all seven RR model IDs.

### MCP gateway

```bash
task mcp:deploy
task mcp:status
```

Delete MCP data-plane resources while preserving shared controllers:

```bash
task mcp:delete
```

Remove shared controllers only through the separately prompted task:

```bash
task mcp:controllers:delete
```

### Runtime telemetry

```bash
task obs:deploy
task obs:status
```

OCO owns the shared telemetry backends and Grafana presentation. `llm-runtime`
does not provision OCO dashboards or datasources.

The operator decides which lifecycle to reconcile. Success of one lifecycle
does not prove success of another.

[Back to top](#operations-guide)

---

## 3. Local Inference Validation

The active tiers are `small` and `large`.

```bash
task llm:list TIER=small
task llm:list TIER=large

task llm:health TIER=small
task llm:health TIER=large

task llm:metrics TIER=small
task llm:metrics TIER=large

task llm:benchmark TIER=small
task llm:benchmark TIER=large
```

Collect the large-tier startup diagnostic when readiness does not converge:

```bash
task llm:diagnose-startup-large
```

The Taskfile does not expose the medium tier through these operator commands.

[Back to top](#operations-guide)

---

## 4. Gateway Build and Deployment

### Repository verification

```bash
task gateway:verify
```

The package verification target executes TypeScript typecheck, build, and unit
tests.

Repository-wide CI is defined by `.github/workflows/main.yml`. On pushes and
pull requests targeting `main`, and on manual dispatch, it invokes the
organization repository-standards workflow pinned to the same reviewed
`homel-dev/.github` commit used by Memory Steward. The reusable workflow checks
repository policy, YAML, Bash syntax, and ShellCheck errors.

On each push to `main`, the same CI workflow also invokes the organization
repository-context workflow. It packages the exact Git revision, complete Git
history, persisted CodeGraph state, probe output, manifest, and pinned CodeGraph
binary as the `repository-context` artifact with three-day retention. This is
separate from the gateway image build/publish lifecycle.

### Local image build

Build in the selected Minikube Docker daemon:

```bash
task gateway:image:build
```

Build in the current Docker daemon:

```bash
task gateway:image:build TARGET=docker
```

The default image reference is:

```text
ghcr.io/homel-dev/llm-runtime-gateway:main
```

Override it with `LLM_GATEWAY_IMAGE`.

### CI image

Promote a trusted immutable digest with:

```bash
LLM_GATEWAY_IMAGE='ghcr.io/homel-dev/llm-runtime-gateway@sha256:<digest>' \
  task gateway:deploy
```

`gateway:deploy` reapplies `k8s/networkpolicy.yml` before gateway resources.

[Back to top](#operations-guide)

---

## 5. Subscription Authentication

Authentication state is persisted independently of gateway Pods.

### ChatGPT/Codex

Populate or refresh account state with:

```bash
task gateway:openai:login
```

The helper uses PVC `rr-openai-subscription-auth`, runs the pinned Codex CLI
device-auth flow, verifies that `/auth/auth.json` was persisted, and checks the
cached login status.

### Google AI

Populate or refresh account state with:

```bash
task gateway:gemini:login
```

The helper uses PVC `rr-gemini-subscription-auth`, executes interactive
Antigravity account authentication, and then runs a non-interactive
`gemini-3.1-pro-high` verification prompt against cached account state.

### Z.AI Coding Plan

Z.AI Coding Plan uses an API key rather than an interactive login flow. Create
or rotate the gateway-owned Secret from the operator shell:

```bash
ZAI_API_KEY='...' task gateway:zai:secret
```

The Deployment reads Secret `rr-zai-coding`, key `api-key`. The credential is
never exposed to RR/Pi agent Pods. After rotation, redeploy or restart the
gateway and run the Z.AI-specific end-to-end check.

The legacy `rr-*` PVC names preserve credential state across ownership
migration; they are runtime-owned resources.

Authentication is accepted only when the helper's verification succeeds.
Expired credentials, quota failure, or provider rejection remain explicit
failures.

[Back to top](#operations-guide)

---

## 6. Gateway Validation

Inspect and validate the LLM gateway:

```bash
task gateway:status
task gateway:logs
task gateway:metrics
task gateway:check
```

Filter model checks by backend class:

```bash
task gateway:check PROVIDER=openai
task gateway:check PROVIDER=gemini
task gateway:check PROVIDER=zai
task gateway:check PROVIDER=local
task gateway:check PROVIDER=api
```

The check begins with `/v1/models`. The ChatGPT/Codex path validates two-turn
Responses continuation. Other selected backends validate non-streaming and
streaming Chat Completions behavior.

Validate the MCP gateway independently:

```bash
task mcp:status
task mcp:check
```

When a project and query are available:

```bash
task mcp:check:retrieval PROJECT_ID='<project-id>' QUERY='<query>'
```

The MCP checker initializes a session, sends `notifications/initialized`, calls
`tools/list`, requires all three published Memory Steward capabilities, and
optionally invokes retrieval operations.

[Back to top](#operations-guide)

---

## 7. Observability and OCO

`llm-runtime` owns only the namespace-local collectors: Alloy and DCGM exporter.
OCO owns VictoriaMetrics, VictoriaLogs, Tempo, and Grafana.

Deploy or reload the runtime collectors:

```bash
task obs:deploy
```

Validate synthetic metrics, logs, and traces end to end through the shared OCO
backends:

```bash
task obs:smoke
```

Inspect collector state or logs:

```bash
task obs:status
task obs:logs
```

Alloy scrapes local inference endpoints, gateway TCP/9091, MCP Envoy TCP/19001,
DCGM TCP/9400, and Alloy itself. Its embedded blackbox exporter probes OmniRoute
`/healthz`. MCP and OmniRoute send OTLP directly to Alloy on TCP/4317 or
TCP/4318. OmniRoute span-derived RED metrics are forwarded only to OCO
VictoriaMetrics.

There is no local Prometheus, Tempo, Loki, OTel Collector, standalone Blackbox
Exporter, or llm-runtime-owned Grafana provisioning. Dashboard and datasource
changes belong to the OCO repository.

The OmniRoute deep management endpoint `/api/monitoring/health` remains an
explicit operator check through `task omniroute:deep-health`; it is not a scrape
target.

[Back to top](#operations-guide)

---

## 8. Incident Response

### Local tier unavailable

Collect Kubernetes state first:

```bash
kubectl -n llm-runtime get pods,svc,pvc
kubectl -n llm-runtime describe pod <pod>
kubectl -n llm-runtime logs <pod>
```

Then run the tier-specific startup diagnostic task.

Check:

- model or cache availability;
- GPU availability for medium and large tiers;
- memory pressure;
- readiness failure;
- container restart reason.

Do not change consumer routing until the infrastructure failure is identified
or a consumer-owned fallback decision is made explicitly.

### Gateway unavailable

Collect:

```bash
task gateway:status
task gateway:logs
task obs:status
```

Distinguish these failure classes:

1. router or Pod failure;
2. provider transport failure;
3. expired subscription authentication;
4. provider quota or service failure;
5. NetworkPolicy or connectivity failure.

`/v1/models` proves router availability only. It does not prove that an external
subscription can complete inference.

### Gateway latency or error increase

Collect:

```bash
task gateway:metrics
task obs:status
```

Review request-duration histograms, status counters, transport errors and
timeouts, in-flight requests, and last-success/error timestamps in the shared
OCO telemetry backends.

### Runtime telemetry missing

Collect:

```bash
task obs:status
task obs:logs
task obs:smoke
```

Verify Service ports, NetworkPolicy, the Alloy ConfigMap, and shared OCO backend
reachability.

[Back to top](#operations-guide)

---

## 9. Upgrade and Promotion

### Local tiers

1. change the manifest implementation;
2. run `task up`;
3. wait for readiness;
4. run model discovery, health, metrics, and smoke checks;
5. validate the shared OCO telemetry before accepting the change.

If validation fails, stop and use section 10.

### Gateway

1. change gateway source or manifests;
2. run `task gateway:verify`;
3. allow GitHub Actions to build the `linux/amd64` image;
4. select the exact GHCR digest;
5. deploy that digest;
6. inspect gateway status;
7. run provider-specific end-to-end checks;
8. validate Alloy collection and OCO signals.

PR jobs build but cannot publish. Registry write permission exists only on the
trusted publish job for non-PR events.

If rollout, provider validation, or required telemetry fails, stop promotion and
rollback.

[Back to top](#operations-guide)

---

## 10. Rollback

For the gateway, deploy a known-good immutable digest rather than rebuilding an
older commit:

```bash
LLM_GATEWAY_IMAGE='ghcr.io/homel-dev/llm-runtime-gateway@sha256:<known-good>' \
  task gateway:deploy
```

Validate the rollback:

```bash
task gateway:status
task gateway:check
task obs:smoke
```

For local tiers, revert the manifest change and reapply:

```bash
git revert <change>
task up
```

Then rerun tier model discovery, health, metrics, and smoke checks.

Subscription PVCs are preserved by `task gateway:delete`; deleting the gateway
Deployment is not an authentication reset.

A rollback is complete only when Observed State matches the selected known-good
Desired State and required validation passes.

[Back to top](#operations-guide)

---

## 11. Restart and Recovery Checks

After a Minikube or host restart, inspect each lifecycle independently:

```bash
task status
task gateway:status
task obs:status
```

Then validate behavior:

```bash
task llm:health TIER=small
task llm:health TIER=large
task gateway:check
task obs:smoke
```

The root `task up` cannot recreate gateway, MCP, or observability resources
because those resources are outside the root Kustomization. If they are absent,
reconcile their explicit lifecycles.

Do not mark recovery complete from Pod phase alone.

[Back to top](#operations-guide)

---

## 12. Operational Costs and Failure Boundaries

The separated lifecycle model has an operator cost: runtime, gateways, and
telemetry collection may require independent reconciliation. OCO has its own
repository and lifecycle for shared storage and presentation.

Subscription-backed providers add an external dependency that local health
checks cannot validate. End-to-end provider checks consume provider traffic and
must be run deliberately when authentication or provider availability matters.

Telemetry is passive. A credential can expire during an idle period without
producing a provider failure signal until traffic or an explicit check uses that
credential.

Operational tooling reports and validates infrastructure state. It does not
choose consumer fallback policy.

[Back to top](#operations-guide)

---

**END OF DOCUMENT**
