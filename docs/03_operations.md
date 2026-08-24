# OPERATIONS GUIDE
## Deployment, Validation, and Runtime Operations
### Operational Procedures Specification

---

## Navigation

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

---

## 0. Status and Scope

**Status:** IMPLEMENTED

This guide documents commands that exist in the current `Taskfile.yml` and
resources present in the current Kubernetes manifests. It covers runtime
infrastructure, not project-specific workflow operations.

[Back to top](#navigation)

---

## 1. Prerequisites

Operator workstation requirements:

- Docker;
- Minikube;
- `kubectl`;
- Task;
- `jq`;
- NVIDIA-capable Minikube setup for GPU tiers.

Start the repository's default Minikube profile when required:

```bash
task miniup
```

`MINIKUBE_PROFILE` may override the profile used by gateway image loading:

```bash
MINIKUBE_PROFILE=my-profile task gateway:image:build
```

[Back to top](#navigation)

---

## 2. Deployment Lifecycles

The repository deliberately has four separate lifecycles.

### Local inference and runtime contract

```bash
task up
task status
```

`task up` applies the root `k8s/` Kustomization. It deploys:

- namespace;
- Hugging Face Secret manifest;
- runtime contract ConfigMap;
- general inference NetworkPolicy;
- `small`, `medium`, and `large` PVCs, Deployments, and Services.

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

Convenience path for gateway telemetry plus OCO publication:

```bash
task gateway:observability:deploy
```

[Back to top](#navigation)

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

Startup diagnostics:

```bash
task llm:diagnose-startup-small
task llm:diagnose-startup-medium
task llm:diagnose-startup-large
```

[Back to top](#navigation)

---

## 4. Gateway Build and Deployment

### Repository verification

```bash
task gateway:verify
```

This runs `npm ci --ignore-scripts` and the gateway package's verification
script, including TypeScript checks/build and unit tests.

### Local Minikube image

```bash
task gateway:image:build
```

The task builds `llm-runtime-gateway:dev` inside the selected Minikube Docker
daemon unless `LLM_GATEWAY_IMAGE` overrides the image value.

A normal Docker-daemon build is also available:

```bash
task gateway:image:build:docker
```

### CI image

GitHub Actions publishes trusted builds to:

```text
ghcr.io/homel-dev/llm-runtime-gateway
```

Production-like promotion should use the image digest emitted by the workflow:

```bash
LLM_GATEWAY_IMAGE='ghcr.io/homel-dev/llm-runtime-gateway@sha256:<digest>' \
  task gateway:deploy
```

The Deployment references `ghcr-pull-secret`. Create it in `llm-runtime` before
pulling a private package.

`gateway:deploy` reapplies `k8s/networkpolicy.yml` before applying gateway
resources. This is required during migration because Kubernetes NetworkPolicy
rules are additive and the older broad selector would otherwise continue to
permit unintended gateway ingress.

[Back to top](#navigation)

---

## 5. Subscription Authentication

Authentication state is persisted independently of gateway Pods.

### ChatGPT/Codex

```bash
task gateway:subscription:login
```

The helper creates/uses PVC `rr-openai-subscription-auth`, runs the interactive
`openai-oauth` login flow, and verifies that `/auth/auth.json` was persisted.

### Google AI

```bash
task gateway:gemini:login
```

The helper creates/uses PVC `rr-gemini-subscription-auth`, runs interactive
Antigravity account authentication, then performs a non-interactive
`gemini-3.1-pro-high` verification prompt against the cached account state.

The legacy `rr-*` PVC names are retained to preserve existing credential state
during ownership migration from RR. They are runtime-owned resources now.

Run these tasks when the PVC is new or cached credentials have expired.

[Back to top](#navigation)

---

## 6. Gateway Validation

Show Deployment, Service, auth PVCs, and advertised models:

```bash
task gateway:status
```

Follow all gateway containers:

```bash
task gateway:logs
```

Fetch raw gateway metrics from local metrics port 9091:

```bash
task gateway:metrics
```

Run the end-to-end Google AI subscription check:

```bash
task gateway:gemini:check
```

This sends an OpenAI Chat Completions request to the gateway router. The router
selects the Antigravity adapter over Pod loopback, and the adapter invokes the
cached Google AI subscription. The script fails if the expected marker is not
returned.

A passing unit suite or healthy Pod is not equivalent to a passing subscription
smoke check. Provider auth/quota failures require the end-to-end check.

[Back to top](#navigation)

---

## 7. Observability and OCO

Deploy Prometheus and DCGM exporter:

```bash
task observability:deploy
```

The task reapplies the ConfigMap and restarts Prometheus so changed scrape jobs
are loaded.

Inspect targets:

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

Current published dashboards include:

- `LLM Runtime`;
- `LLM Runtime Gateway` (`uid=llm-runtime-gateway`).

The gateway dashboard covers health, traffic, p95 latency, errors/timeouts,
last-success age, policy rejects, and process memory.

Expose Prometheus to the host/LAN when needed:

```bash
task observability:expose-start
task observability:expose-status
task observability:urls
```

Stop the proxy with:

```bash
task observability:expose-stop
```

[Back to top](#navigation)

---

## 8. Incident Response

### Local tier unavailable

```bash
kubectl -n llm-runtime get pods,svc,pvc
kubectl -n llm-runtime describe pod <pod>
kubectl -n llm-runtime logs <pod>
```

Then use the tier-specific startup diagnostic task.

Check:

- model/cache availability;
- GPU availability for medium/large;
- memory pressure;
- readiness failures;
- container restart reason.

### Gateway unavailable

```bash
task gateway:status
task gateway:logs
task observability:gateway-target
```

Distinguish:

1. router/Pod failure;
2. provider sidecar failure;
3. expired subscription authentication;
4. provider quota/service failure;
5. NetworkPolicy/connectivity failure.

`/v1/models` readiness proves only that the router is serving. It does not prove
that either external subscription can complete an inference request.

### Gateway latency/error increase

Use:

```bash
task gateway:metrics
task observability:gateway-up
```

Review request-duration histogram, status counters, transport errors/timeouts,
in-flight requests, and last-success/error timestamps in Prometheus/OCO.

### Prometheus target missing

```bash
task observability:targets
task observability:logs-prometheus
```

Verify the Service port, NetworkPolicy, and loaded Prometheus ConfigMap.

[Back to top](#navigation)

---

## 9. Upgrade and Promotion

### Local tiers

1. change manifest implementation;
2. `task up`;
3. wait for readiness;
4. run `llm:list-*`, health, metrics, and smoke tasks;
5. observe Prometheus before accepting the change.

### Gateway

1. change gateway source/manifests;
2. `task gateway:verify`;
3. allow GitHub Actions to build the `linux/amd64` image;
4. promote the exact GHCR digest;
5. `task gateway:deploy`;
6. `task gateway:status`;
7. run provider-specific end-to-end checks;
8. validate `observability:gateway-target` and dashboard signals.

PR jobs build but cannot publish. Registry write permission exists only on the
trusted publish job for non-PR events.

[Back to top](#navigation)

---

## 10. Rollback

Prefer rollback by known-good immutable gateway digest rather than rebuilding an
older git commit:

```bash
LLM_GATEWAY_IMAGE='ghcr.io/homel-dev/llm-runtime-gateway@sha256:<known-good>' \
  task gateway:deploy
```

Then validate:

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

Then rerun tier health/smoke checks.

Subscription PVCs are preserved by `task gateway:delete`; deleting a gateway
Deployment is therefore not an authentication reset.

[Back to top](#navigation)

---

## 11. Restart and Recovery Checks

After a Minikube or host restart, do not infer recovery from Pod phase alone.
Check each lifecycle explicitly:

```bash
task status
task gateway:status
task observability:status
task oco-consumer:status
```

Then validate actual service behavior:

```bash
task llm:health-small
task llm:health-medium
task llm:health-large
task gateway:gemini:check
task observability:vllm-up
task observability:gateway-up
```

The root `task up` cannot recreate gateway/observability/OCO resources because
they are intentionally outside the root Kustomization. If those resources are
not already persisted in the Minikube cluster, run their explicit deploy tasks.

---

**END OF DOCUMENT**
