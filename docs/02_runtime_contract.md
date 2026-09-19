# RUNTIME CONTRACT

*Shared runtime service contract — infrastructure contract specification.*

---

## Table of Contents

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
- [11. Tradeoffs and Failure Behavior](#11-tradeoffs-and-failure-behavior)

---

## 0. Status and Authority

**Status:** IMPLEMENTED.

**Contract version:** `v2`.

`k8s/runtime-contract.yml`, Kubernetes Services, and the gateway's advertised
model list are executable sources of truth for this contract.

`llm-runtime` owns the runtime side of the contract. Consumers decide how and
when to use the exposed interfaces. A consumer cannot alter provider credential
handling or runtime network policy through this contract.

Contract violation is enforced by failure: missing Services, missing contract
keys, unavailable model IDs, or unsupported API behavior must be treated as
runtime/contract failures rather than inferred away by consumers.

[Back to top](#runtime-contract)

---

## 1. Purpose

Consumer projects require stable service discovery without depending on model
server topology or provider credential mechanics.

This contract defines:

- namespace and Service endpoints;
- OpenAI API compatibility expectations;
- gateway model IDs intended for consumers;
- runtime and consumer ownership boundaries;
- compatible and breaking contract evolution.

[Back to top](#runtime-contract)

---

## 2. Stable Contract

Stable contract version `v2` fields are:

- namespace: `llm-runtime`;
- consumer-facing LLM Service:
  `llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000`;
- consumer-facing MCP base Service:
  `llm-runtime-mcp.llm-runtime.svc.cluster.local:8000`;
- MCP request path: `/mcp`;
- API compatibility declaration: `openai`;
- ConfigMap keys listed in section 8.

The current active local tier aliases are:

```text
llm-small
llm-large
```

The medium tier has no active model alias in `v2`.

Gateway model IDs and public MCP capabilities are consumer-facing interfaces.

[Back to top](#runtime-contract)

---

## 3. Service Endpoints

### LLM gateway

```text
http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000
```

All `LLM_*_BASE_URL` contract keys terminate at this gateway.

The upstream local Services are runtime implementation interfaces rather than
consumer endpoints in contract version `v2`.

### MCP gateway

```text
http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000/mcp
```

Consumers use the stable runtime ingress and discover public tools through MCP
initialization and `tools/list`.

[Back to top](#runtime-contract)

---

## 4. API Compatibility

Local model servers and the trusted gateway expose OpenAI-compatible HTTP APIs.

The expected discovery endpoint is:

```text
GET /v1/models
```

Chat-oriented consumers use:

```text
POST /v1/chat/completions
```

Endpoint support beyond those interfaces depends on the selected backend.
Consumers must not infer `/v1/completions`, `/v1/embeddings`, or other OpenAI
APIs from the `openai` compatibility declaration.

For the gateway:

- allowed paths are `/v1/models`, `/v1/chat/completions`, and `/v1/responses`;
- the ChatGPT/Codex subscription model supports `/v1/responses`; its transport is
  Responses-only and rejects Chat Completions;
- Gemini subscription models support Chat Completions;
- `/v1/responses` returns HTTP 501 for Gemini subscription models;
- `stream: true` for Gemini returns OpenAI-compatible SSE framing after the
  Antigravity result completes; it is not upstream token-by-token streaming.

Unsupported behavior fails explicitly rather than being translated to another
API shape.

[Back to top](#runtime-contract)

---

## 5. Gateway Model Contract

Current gateway model IDs are:

| Consumer model ID | Current trusted implementation |
| --- | --- |
| `llm-small` | local `Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M` through the gateway |
| `llm-large` | local `Qwen2.5-72B-Instruct-AWQ` through the gateway |
| `gpt-5.6-sol` | ChatGPT/Codex subscription through the stateful Responses transport |
| `gemini-subscription-pro` | direct Cloud Code Assist transport using `gemini-pro-agent` |
| `gemini-subscription-auto` | direct Cloud Code Assist transport using `gemini-3.7-flash-medium` |
| `glm-5.3` | Z.AI Coding Plan through native Pi-compatible Chat Completions |
| `glm-5.3-flash` | Z.AI Coding Plan through native Pi-compatible Chat Completions |

`gemini-subscription-auto` is a compatibility alias. It does not promise
provider-side automatic model selection.

Consumers discover Observed State through:

```text
GET http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000/v1/models
```

Provider credential format, OAuth state, local upstream addresses, and
provider wire details are outside the consumer contract.

The MCP route currently allowlists:

```text
memory.retrieve_context
memory.reference.search
memory.reference.get
```

The stable MCP URL is:

```text
http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000/mcp
```

Memory Steward retains authority over retrieval semantics, filtering, ranking,
provenance, admission, validation, and storage.

[Back to top](#runtime-contract)

---

## 6. Consumer Responsibilities

Consumer projects own:

- mapping workloads and roles to runtime endpoints or gateway model IDs;
- prompts and schemas;
- request budgets and application timeout policy;
- retry and fallback policy;
- tool execution;
- workflow semantics and authority;
- persistence;
- correctness and quality evaluation.

Consumers do not require direct subscription credential access. Failure of a
runtime endpoint does not transfer runtime authority to the consumer or
consumer policy authority to the runtime.

[Back to top](#runtime-contract)

---

## 7. Runtime Responsibilities

`llm-runtime` owns:

- Kubernetes Services and runtime endpoint publication;
- local model-serving Deployments;
- gateway router and trusted provider transports;
- subscription login helpers and auth PVCs;
- runtime NetworkPolicy and gateway-specific consumer RBAC;
- gateway CI image build and publication;
- runtime health and metrics endpoints;
- Alloy and DCGM telemetry collection;
- forwarding telemetry to the OCO shared backends;
- operational tasks for deployment, validation, diagnostics, and rollback.

The runtime does not decide which project role should use which model.

[Back to top](#runtime-contract)

---

## 8. ConfigMap Contract

`k8s/runtime-contract.yml` publishes:

```yaml
LLM_SMALL_BASE_URL: "http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000"
LLM_MEDIUM_BASE_URL: "http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000"
LLM_LARGE_BASE_URL: "http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000"
LLM_GATEWAY_BASE_URL: "http://llm-openai-api-gateway.llm-runtime.svc.cluster.local:8000"

MCP_GATEWAY_BASE_URL: "http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000"
MCP_GATEWAY_URL: "http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000/mcp"
MCP_RETRIEVE_TOOL: "memory.retrieve_context"

LLM_SMALL_MODEL: "llm-small"
LLM_MEDIUM_MODEL: ""
LLM_LARGE_MODEL: "llm-large"

LLM_RUNTIME_NAMESPACE: "llm-runtime"
LLM_API_COMPATIBILITY: "openai"
CONTRACT_VERSION: "v2"
```

A consumer may copy these values into its own configuration or read the
ConfigMap through explicitly granted RBAC. The ConfigMap is not a secret store.

[Back to top](#runtime-contract)

---

## 9. Versioning and Change Rules

Compatible `v2` changes include:

- changing the concrete model behind a capacity tier;
- changing quantization or GPU topology;
- replacing provider transport internals while preserving the consumer model ID
  and documented API behavior;
- adding metrics;
- adding opt-in model IDs or endpoints.

Changes that require deliberate migration include:

- removing or renaming a stable Service;
- changing the namespace;
- removing or renaming a ConfigMap contract key;
- changing the meaning of an existing gateway model ID;
- removing documented API behavior.

Breaking contract changes increment `CONTRACT_VERSION`; they do not silently
mutate `v2`.

[Back to top](#runtime-contract)

---

## 10. Non-Contract Implementation Details

The following are current implementation details and may change without a
contract version bump while the stable interface remains intact:

- current Hugging Face model identity behind `small`, `medium`, or `large`;
- quantization format;
- GPU UUID or allocation;
- tensor or pipeline parallel topology;
- container image implementation;
- backend loopback ports;
- OAuth or PVC on-disk layout;
- telemetry scrape implementation;
- CI action versions.

[Back to top](#runtime-contract)

---

## 11. Tradeoffs and Failure Behavior

The contract favors stable service names over stable implementation identity.
That reduces consumer coupling but means a tier name alone cannot prove which
model is currently serving.

The gateway model IDs provide a stronger consumer-facing identity, which makes
renaming or changing their meaning more expensive because such a change
requires contract migration.

The contract does not promise provider availability, quota, credential
freshness, or performance. These are Observed State. Consumers and operators
must use health checks, model discovery, end-to-end provider checks, and
telemetry to detect Drift from Desired State.

On contract failure, the correct outcome is an explicit error or failed
validation. Neither runtime nor consumer may silently substitute an undocumented
endpoint, provider, model identity, or API behavior.

[Back to top](#runtime-contract)

---

**END OF DOCUMENT**
