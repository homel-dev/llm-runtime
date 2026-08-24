# RUNTIME CONTRACT
## Shared Runtime Service Contract
### Infrastructure Contract Specification

---

## Navigation

- [0. Status and Authority](#0-status-and-authority)
- [1. Purpose](#1-purpose)
- [2. Stable Contract](#2-stable-contract)
- [3. Service Endpoints](#3-service-endpoints)
- [4. API Compatibility](#4-api-compatibility)
- [5. Gateway Model Contract](#5-gateway-model-contract)
- [6. Consumer Responsibilities](#6-consumer-responsibilities)
- [7. Runtime Responsibilities](#7-runtime-responsibilities)
- [8. ConfigMap Contract](#8-configmap-contract)
- [9. Versioning and Change Rules](#9-versioning-and-change-rules)
- [10. Non-Contract Implementation Details](#10-non-contract-implementation-details)

---

## 0. Status and Authority

**Status:** IMPLEMENTED
**Contract version:** `v1`

`k8s/runtime-contract.yml`, Kubernetes Services, and the gateway's advertised
model list are executable sources of truth for this contract.

[Back to top](#navigation)

---

## 1. Purpose

Consumer projects need stable service discovery without depending on model
server topology or provider credential mechanics.

This contract defines:

- namespace and Service endpoints;
- OpenAI API compatibility expectations;
- the gateway model IDs intended for consumers;
- runtime/consumer ownership boundaries;
- rules for compatible contract evolution.

[Back to top](#navigation)

---

## 2. Stable Contract

Stable fields in contract version `v1` are:

- namespace: `llm-runtime`;
- local Service names: `llm-small`, `llm-medium`, `llm-large`;
- trusted gateway Service name: `llm-openai-api-gateway`;
- service HTTP port: `8000`;
- API compatibility declaration: `openai`;
- ConfigMap keys listed in section 8.

Gateway model IDs are also consumer-facing interfaces. Removing or changing the
meaning of an advertised gateway model ID is a contract change even if the
underlying provider implementation changes.

[Back to top](#navigation)

---

## 3. Service Endpoints

### Local tiers

```text
http://llm-small.llm-runtime.svc.cluster.local:8000
http://llm-medium.llm-runtime.svc.cluster.local:8000
http://llm-large.llm-runtime.svc.cluster.local:8000
```

### Trusted subscription gateway

```text
http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000
```

Consumers should use Kubernetes Service discovery instead of Pod IPs.

The gateway also exposes TCP/9091 for Prometheus metrics, but that port is an
operations interface, not a general consumer API. Gateway NetworkPolicy permits
that port only from runtime Prometheus.

[Back to top](#navigation)

---

## 4. API Compatibility

Local model servers and the trusted gateway expose OpenAI-compatible HTTP APIs.

The universally expected discovery endpoint is:

```text
GET /v1/models
```

Chat-oriented consumers should use:

```text
POST /v1/chat/completions
```

Endpoint support beyond that depends on the selected backend. Consumers must
not infer support for `/v1/completions`, `/v1/embeddings`, or other OpenAI APIs
merely from the `openai` compatibility declaration.

For the gateway specifically:

- allowed paths are `/v1/models`, `/v1/chat/completions`, and `/v1/responses`;
- Gemini subscription models currently support Chat Completions;
- `/v1/responses` returns HTTP 501 for Gemini subscription models;
- `stream: true` for Gemini returns OpenAI-compatible SSE framing after the
  Antigravity result completes, not upstream token-by-token streaming.

[Back to top](#navigation)

---

## 5. Gateway Model Contract

Current gateway model IDs:

| Consumer model ID | Current trusted implementation |
| --- | --- |
| `gpt-5.6-sol` | ChatGPT/Codex subscription through `openai-oauth` |
| `gemini-subscription-pro` | Antigravity model `gemini-3.1-pro-high` |
| `gemini-subscription-auto` | Antigravity model `gemini-3.7-flash-medium` |

`gemini-subscription-auto` is a compatibility alias. The current implementation
is pinned; the name does not promise provider-side automatic model selection.

Consumers should discover currently advertised gateway models with:

```text
GET http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000/v1/models
```

Provider credential format, OAuth state, sidecar ports, and Antigravity settings
are intentionally outside the consumer contract.

[Back to top](#navigation)

---

## 6. Consumer Responsibilities

Consumer projects own:

- mapping workloads/roles to runtime endpoints or gateway model IDs;
- prompts and schemas;
- request budgets and application timeout policy;
- retry and fallback policy;
- tool execution;
- workflow semantics and authority;
- persistence;
- correctness and quality evaluation.

Consumers must not require direct access to subscription credentials.

[Back to top](#navigation)

---

## 7. Runtime Responsibilities

`llm-runtime` owns:

- Kubernetes Services and endpoint availability;
- local model-serving Deployments;
- gateway router and trusted provider transports;
- subscription login helpers and auth PVCs;
- runtime NetworkPolicy and gateway-specific consumer RBAC;
- gateway CI image build/publication;
- runtime health and metrics endpoints;
- Prometheus/DCGM infrastructure;
- OCO datasource/dashboard publication;
- operational tasks for deploy, validation, diagnostics, and rollback.

The runtime does not decide which project role should use which model.

[Back to top](#navigation)

---

## 8. ConfigMap Contract

`k8s/runtime-contract.yml` publishes:

```yaml
LLM_SMALL_BASE_URL: "http://llm-small.llm-runtime.svc.cluster.local:8000"
LLM_MEDIUM_BASE_URL: "http://llm-medium.llm-runtime.svc.cluster.local:8000"
LLM_LARGE_BASE_URL: "http://llm-large.llm-runtime.svc.cluster.local:8000"
LLM_GATEWAY_BASE_URL: "http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000"
LLM_RUNTIME_NAMESPACE: "llm-runtime"
LLM_API_COMPATIBILITY: "openai"
CONTRACT_VERSION: "v1"
```

A consumer may copy these values into its own configuration or read the
ConfigMap through explicitly granted RBAC. The ConfigMap is not a secret store.

[Back to top](#navigation)

---

## 9. Versioning and Change Rules

Compatible `v1` changes include:

- changing the concrete model behind a capacity tier;
- changing quantization or GPU topology;
- replacing provider transport internals while preserving the consumer model ID
  and API behavior;
- adding new metrics;
- adding new opt-in model IDs or endpoints.

Changes that require deliberate migration include:

- removing/renaming a stable Service;
- changing the namespace;
- removing/renaming a ConfigMap contract key;
- changing the meaning of an existing gateway model ID;
- removing an API behavior on which consumers are documented to rely.

Breaking contract changes should increment `CONTRACT_VERSION` rather than
silently mutating `v1`.

[Back to top](#navigation)

---

## 10. Non-Contract Implementation Details

The following are current implementation details and may change without a
contract version bump when the stable interface remains intact:

- current Hugging Face repository/model identity behind `small`, `medium`, or
  `large`;
- quantization format;
- GPU UUID/allocation;
- tensor/pipeline parallel topology;
- container image implementation;
- backend loopback ports;
- OAuth/PVC on-disk layout;
- Prometheus scrape implementation;
- CI action versions.

---

**END OF DOCUMENT**
