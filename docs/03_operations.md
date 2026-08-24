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

The repository has four independent Desired States.

### Local inference and runtime contract

Deploy and observe:

```bash
task up
task status
```

`task up` applies the root `k8s/` Kustomization. It includes the namespace,
Hugging Face Secret manifest, runtime contract ConfigMap, general inference
NetworkPolicy, and the `small`, `medium`, and `large` resources.

It does **not** deploy the subscription gateway, Prometheus/DCGM, or OCO
consumer ConfigMaps.

### Subscription gateway

```bash
task gateway:deploy
task gateway:status
```

### Runtime metrics

```bash
task observability:deploy
task observability:status
```

### OCO/Grafana consumer contract

```bash
task oco-consumer:deploy
task oco-consumer:status
```

Gateway telemetry and OCO publication can be reconciled together with:

```bash
task gateway:observability:deploy
```

The operator decides which lifecycle to reconcile. Applying one lifecycle does
not imply success of another.

[Back to top](#operations-guide)

---

## 3. Local Inference Validation

List advertised models through cluster DNS:

```bash
task llm:list-small
task llm:list-medium
task llm:list-large
```

Run health checks:

```bash
task llm:health-small
task llm:health-medium
task llm:health-large
```

Verify metrics endpoints:

```bash
task llm:metrics-small
task llm:metrics-medium
task llm:metrics-large
```

Run chat smoke tests:

```bash
task llm:smoke-small
task llm:smoke-medium
task llm:smoke-large
```

Benchmark through cluster DNS when capacity data is required:

```bash
task llm:benchmark-small
task llm:benchmark-medium
task llm:benchmark-large
```

Collect startup diagnostics when readiness does not converge:

```bash
task llm:diagnose-startup-small
task llm:diagnose-startup-medium
task llm:diagnose-startup-large
```

A failed model listing, health check, smoke test, or required metrics check
means the tier is not accepted as healthy.

[Back to top](#operations-guide)

---

## 4. Gateway Build and Deployment

### Repository verification

Run:

```bash
task gateway:verify
```

`gateway:verify` installs the locked package dependencies with scripts disabled
and runs the gateway package verification target, including TypeScript checks,
build, and unit tests.

### Local Minikube image

Build into the selected Minikube Docker daemon:

```bash
task gateway:image:build
```

The default image reference is `llm-runtime-gateway:dev` unless
`LLM_GATEWAY_IMAGE` overrides it.

A build in the current Docker daemon is available through:

```bash
task gateway:image:build:docker
```

### CI image

GitHub Actions publishes trusted builds to:

```text
ghcr.io/homel-dev/llm-runtime-gateway
```

Promote an immutable digest emitted by the workflow:

```bash
LLM_GATEWAY_IMAGE='ghcr.io/homel-dev/llm-runtime-gateway@sha256:<digest>' \
  task gateway:deploy
```

The Deployment references `ghcr-pull-secret`. The Secret must exist in
`llm-runtime` before Kubernetes can pull a private package.

`gateway:deploy` reapplies `k8s/networkpolicy.yml` before gateway resources.
This migration ordering matters because Kubernetes NetworkPolicy rules are
additive; retaining the older broad selector would preserve unintended gateway
ingress.

Failure of image pull, rollout, or post-deploy validation stops promotion.

[Back to top](#operations-guide)

---

## 5. Subscription Authentication

Authentication state is persisted independently of gateway Pods.

### ChatGPT/Codex

Populate or refresh account state with:

```bash
task gateway:subscription:login
```

The helper uses PVC `rr-openai-subscription-auth`, executes interactive
`openai-oauth` authentication, and verifies that `/auth/auth.json` was
persisted.

### Google AI

Populate or refresh account state with:

```bash
task gateway:gemini:login
```

The helper uses PVC `rr-gemini-subscription-auth`, executes interactive
Antigravity account authentication, and then runs a non-interactive
`gemini-3.1-pro-high` verification prompt against cached account state.

The legacy `rr-*` PVC names preserve credential state across ownership
migration; they are runtime-owned resources.

Authentication is accepted only when the helper's verification succeeds.
Expired credentials, quota failure, or provider rejection remain explicit
failures.

[Back to top](#operations-guide)

---

## 6. Gateway Validation

Inspect Deployment, Service, auth PVCs, and advertised models:

```bash
task gateway:status
```

Follow gateway containers:

```bash
task gateway:logs
```

Fetch raw gateway metrics:

```bash
task gateway:metrics
```

Run the end-to-end Google AI subscription check:

```bash
task gateway:gemini:check
```

The end-to-end check sends an OpenAI Chat Completions request to the router,
selects the Antigravity adapter over Pod loopback, and invokes the cached Google
AI subscription. The task exits non-zero unless the expected marker is
returned.

A passing unit suite, ready Pod, or successful `/v1/models` response does not
prove provider authentication, quota, or inference availability. Provider
acceptance requires an end-to-end check.

[Back to top](#operations-guide)

---

## 7. Observability and OCO

Deploy Prometheus and DCGM exporter:

```bash
task observability:deploy
```

The task reapplies the Prometheus ConfigMap and restarts Prometheus so changed
scrape configuration is loaded.

Inspect targets and health:

```bash
task observability:targets
task observability:vllm-targets
task observability:vllm-up
task observability:gateway-target
task observability:gateway-up
```

Publish OCO/Grafana datasource and dashboards:

```bash
task oco-consumer:deploy
task oco-consumer:status
```

Published dashboards include `LLM Runtime` and `LLM Runtime Gateway`
(`uid=llm-runtime-gateway`). Gateway panels expose health, request rate, p95
latency, errors and timeouts, last-success age, policy rejects, and process
memory.

Expose Prometheus to the host or LAN when required:

```bash
task observability:expose-start
task observability:expose-status
task observability:urls
```

Stop the exposure proxy with:

```bash
task observability:expose-stop
```

Missing targets, stale success timestamps, or increasing timeout/error counters
are operational failures and require investigation before accepting a change.

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
task observability:gateway-target
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
task observability:gateway-up
```

Review request-duration histograms, status counters, transport errors and
timeouts, in-flight requests, and last-success/error timestamps.

### Prometheus target missing

Collect:

```bash
task observability:targets
task observability:logs-prometheus
```

Verify Service ports, NetworkPolicy, and the loaded Prometheus ConfigMap.

[Back to top](#operations-guide)

---

## 9. Upgrade and Promotion

### Local tiers

1. change the manifest implementation;
2. run `task up`;
3. wait for readiness;
4. run model discovery, health, metrics, and smoke checks;
5. observe Prometheus before accepting the change.

If validation fails, stop and use section 10.

### Gateway

1. change gateway source or manifests;
2. run `task gateway:verify`;
3. allow GitHub Actions to build the `linux/amd64` image;
4. select the exact GHCR digest;
5. deploy that digest;
6. inspect gateway status;
7. run provider-specific end-to-end checks;
8. validate Prometheus target health and OCO signals.

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
task gateway:gemini:check
task observability:gateway-up
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
task observability:status
task oco-consumer:status
```

Then validate behavior:

```bash
task llm:health-small
task llm:health-medium
task llm:health-large
task gateway:gemini:check
task observability:vllm-up
task observability:gateway-up
```

The root `task up` cannot recreate gateway, observability, or OCO resources
because those resources are outside the root Kustomization. If they are absent,
reconcile their explicit lifecycles.

Do not mark recovery complete from Pod phase alone.

[Back to top](#operations-guide)

---

## 12. Operational Costs and Failure Boundaries

The separated lifecycle model has an operator cost: runtime, gateway,
observability, and OCO Desired State may require independent reconciliation.
That separation prevents one deployment command from mutating unrelated
resources, but recovery requires checking each lifecycle.

Subscription-backed providers add an external dependency that local health
checks cannot validate. End-to-end provider checks consume provider traffic and
must be run deliberately when authentication or provider availability matters.

Prometheus telemetry is passive. A credential can expire during an idle period
without producing a provider failure signal until traffic or an explicit check
uses that credential.

Operational tooling reports and validates infrastructure state. It does not
choose consumer fallback policy.

[Back to top](#operations-guide)

---

**END OF DOCUMENT**
