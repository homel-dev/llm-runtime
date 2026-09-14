# MCP Gateway — Envoy AI Gateway Integration

*Controlled MCP ingress for shared runtime capabilities.*

---

## Table of Contents

- [0. Status, Scope, and Authority](#0-status-scope-and-authority)
- [1. Architecture Decision](#1-architecture-decision)
- [2. Purpose](#2-purpose)
- [3. High-Level Architecture](#3-high-level-architecture)
- [4. Ownership Boundary](#4-ownership-boundary)
- [5. Client Contract](#5-client-contract)
- [6. Backend Model](#6-backend-model)
- [7. Capability Exposure](#7-capability-exposure)
- [8. Initial Backend — Memory Steward](#8-initial-backend--memory-steward)
- [9. Network Boundary](#9-network-boundary)
- [10. Authentication and Credentials](#10-authentication-and-credentials)
- [11. Observability](#11-observability)
- [12. Deployment and Configuration](#12-deployment-and-configuration)
- [13. Validation and Acceptance](#13-validation-and-acceptance)
- [14. Failure Semantics](#14-failure-semantics)
- [15. Versioning and Upgrade Policy](#15-versioning-and-upgrade-policy)
- [16. Non-Goals](#16-non-goals)
- [17. Tradeoffs and Known Constraints](#17-tradeoffs-and-known-constraints)
- [18. Core Invariants](#18-core-invariants)

---

## 0. Status, Scope, and Authority

**Status:** IMPLEMENTED.

**Scope:** `llm-runtime`.

**Selected implementation:** Envoy AI Gateway using `MCPRoute`.

This document defines how `llm-runtime` exposes MCP capabilities.

It does **not** define a custom MCP gateway implementation.

`llm-runtime` has authority over:

- deployment of the MCP ingress;
- Envoy AI Gateway configuration owned by this repository;
- `Gateway`, `MCPRoute`, backend-routing, and related policy resources;
- public MCP capability exposure;
- network boundaries;
- runtime-level authentication and backend credential handling;
- runtime-level telemetry;
- deployment, validation, upgrade, and rollback procedures.

Backend services retain authority over their own domain semantics, validation, data, persistence, and business logic.

Executable Kubernetes configuration becomes authoritative after implementation.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 1. Architecture Decision

`llm-runtime` will use **Envoy AI Gateway** as the MCP ingress implementation.

The runtime will **not** implement its own:

- MCP protocol server;
- capability registry service;
- backend router;
- backend adapter framework;
- session manager;
- authentication framework;
- MCP multiplexing layer;
- administration API;
- administration UI.

The architectural unit owned by `llm-runtime` is configuration around the selected gateway, not a new gateway codebase.

The primary MCP routing primitive is:

```text
MCPRoute
```

The required abstraction is:

```text
MCP Client
    -> Envoy AI Gateway
        -> explicitly configured MCP backend
```

Adding another backend means changing declarative gateway configuration and network policy.

It does not mean adding another client-visible endpoint or writing another routing integration inside `llm-runtime`.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 2. Purpose

Consumers require one stable MCP ingress for tools and resources provided by independently owned services.

Without a shared ingress, each consumer would need direct knowledge of:

- backend service addresses;
- backend namespaces;
- backend ports;
- backend credentials;
- backend-specific network access;
- backend lifecycle changes.

`llm-runtime` centralizes that infrastructure boundary.

The MCP gateway exists to provide:

```text
stable ingress
+ explicit capability exposure
+ deterministic backend routing
+ infrastructure security controls
+ infrastructure observability
```

It does not own backend application meaning.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 3. High-Level Architecture

Model inference and MCP capability access remain separate runtime planes.

```mermaid
flowchart LR
    C[Agent / MCP Client]

    L[LLM Gateway]
    M[Envoy AI Gateway<br/>MCPRoute]

    B1[Memory Steward]
    B2[Backend 2]
    BN[Backend N]

    C -->|Model inference| L
    C -->|MCP| M

    M --> B1
    M --> B2
    M --> BN
```

`LLM Gateway` owns model-provider access.

`Envoy AI Gateway` owns MCP ingress and transport routing.

Backend services own their domain behavior.

These responsibilities MUST remain separate.

The MCP gateway is not placed in the inference request path.

The LLM gateway is not placed in the MCP request path.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 4. Ownership Boundary

### `llm-runtime` owns

```text
Envoy AI Gateway deployment
Gateway resources
MCPRoute resources
backend routing configuration
tool exposure policy
gateway-facing NetworkPolicy
backend credential attachment
runtime telemetry
health and validation procedures
version pinning
upgrade and rollback
```

### Backend services own

```text
domain semantics
domain validation
domain authorization below the gateway boundary
domain data
persistence
ranking
retrieval
mutation semantics
idempotency semantics
backend-specific correctness
```

### Consumers own

```text
when a capability is invoked
workflow semantics
agent policy
application retry policy
application fallback policy
interpretation of returned data
```

**Invariant:** transport routing does not transfer domain authority to the gateway.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 5. Client Contract

Stable MCP base endpoint:

```text
http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000
```

Stable request URL:

```text
http://llm-runtime-mcp.llm-runtime.svc.cluster.local:8000/mcp
```

The runtime validation client currently defaults to MCP protocol version:

```text
2025-06-18
```

A client depends on the runtime MCP endpoint, supported protocol behavior, and
capabilities returned by `tools/list`.

A client must not require backend Service names, namespaces, URLs, ports,
credentials, Envoy Backend resources, routing topology, or controller topology.

Current Envoy AI Gateway controller configuration maps optional request headers:

```text
x-project-id   -> project.id
x-run-id       -> run.id
x-objective-id -> objective.id
x-agent-role   -> agent.role
```

Those fields are transport metadata, not universal MCP identity fields.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 6. Backend Model

A backend is an independently owned MCP capability provider reachable through Envoy AI Gateway.

Memory Steward is Backend #1.

Future backends may include:

- artifact services;
- repository-analysis services;
- infrastructure inspection services;
- deterministic analysis services;
- documentation services;
- source-control integrations;
- other explicitly approved MCP services.

Backend destinations are declared by runtime-owned configuration.

Clients MUST NOT supply arbitrary backend destinations.

Dynamic forward-proxy behavior is outside this architecture.

A newly reachable network destination does not become a publicly exposed MCP backend automatically.

Backend addition requires deliberate configuration and validation.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 7. Capability Exposure

Public capability exposure is allowlist-based.

The current Memory Steward route allowlists:

```text
memory.retrieve_context
memory.reference.search
memory.reference.get
```

Backend reachability and public exposure are separate decisions.

A newly implemented backend tool does not become public until the runtime
`MCPRoute` is changed deliberately.

Clients use `tools/list` to discover the public multiplexed names exposed by
Envoy AI Gateway. They must not guess a gateway-added backend prefix.

Capability filtering remains declarative Envoy configuration.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 8. Initial Backend — Memory Steward

The first backend is Memory Steward.

Current backend destination:

```text
memory-steward-mcp.ms.svc.cluster.local:8081
```

The current public backend capability set is:

```text
memory.retrieve_context
memory.reference.search
memory.reference.get
```

```mermaid
sequenceDiagram
    participant C as MCP Client
    participant G as Envoy AI Gateway
    participant S as Memory Steward

    C->>G: initialize
    G-->>C: session
    C->>G: tools/list
    G-->>C: exposed Memory Steward capabilities
    C->>G: tools/call(...)
    G->>S: MCP request
    S-->>G: Backend result or backend error
    G-->>C: MCP result or MCP error
```

Memory Steward remains responsible for Reference Memory, Dynamic Memory,
retrieval semantics, metadata filtering, ranking, provenance, admission,
validation, and storage.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 9. Network Boundary

The intended network relationship is:

```mermaid
flowchart LR
    A[Consumer workload]

    G[Envoy AI Gateway]

    M[Memory Steward]
    B2[Backend 2]
    BN[Backend N]

    A --> G

    G --> M
    G --> B2
    G --> BN
```

Consumer workloads receive MCP access to the gateway.

They do not receive backend access merely because a backend has been registered.

NetworkPolicy MUST restrict:

```text
approved consumers -> MCP ingress
MCP data plane -> configured backends
required DNS
required telemetry paths
```

Adding Backend N should normally require changing gateway-side egress rather than every consumer workload.

Backend references and gateway-owned routing objects SHOULD remain local to the gateway configuration namespace.

Where the actual backend workload lives in another namespace, runtime configuration may represent that destination through an explicitly configured Envoy backend using the backend service FQDN.

Arbitrary dynamic destination resolution MUST NOT be enabled as a substitute for explicit backend registration.

Public Internet exposure is not implied by this architecture.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 10. Authentication and Credentials

Authentication has two separate boundaries:

```text
Client -> MCP Gateway
MCP Gateway -> Backend
```

The current deployment relies on its Kubernetes network boundary rather than
production user authentication at the MCP ingress.

Backend credentials, when required, remain behind the gateway.

Envoy AI Gateway session encryption uses Kubernetes Secret:

```text
llm-runtime-mcp-session
```

`task mcp:controllers:deploy` creates the Secret when absent, generates a random
32-byte hex seed with `openssl`, and passes the seed into the Envoy AI Gateway
Helm release.

The seed is runtime infrastructure state, not a client credential or public
runtime-contract value.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 11. Observability

MCP traffic is part of runtime infrastructure and MUST be observable from the first deployment.

Required signals include:

```text
request count
success/failure count
request duration
backend duration where available
active requests
backend failures
timeouts
request/response sizes where available
selected backend
selected capability/tool
gateway health
```

Distributed traces should cover:

```text
MCP Client
    -> Envoy AI Gateway
    -> Backend
    -> Envoy AI Gateway
    -> MCP Client
```

Trace context SHOULD propagate into a backend when supported.

The MCP ingress should integrate with the existing runtime observability stack:

```text
Prometheus
Grafana / OCO
Tempo
Loki where applicable
```

Exact metric names are implementation details and MUST be validated against the pinned Envoy AI Gateway release.

The architecture does not create a second custom metrics implementation when upstream telemetry already provides the required signal.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 12. Deployment and Configuration

Pinned defaults are defined in `taskfiles/mcp.yml`:

```text
Envoy Gateway:    v1.8.1
Envoy AI Gateway: v1.0.0
```

Deploy with:

```bash
task mcp:deploy
```

The task installs pinned controller prerequisites, creates or reuses the MCP
session-encryption Secret, reconciles the observability prerequisites required
by the task, applies `k8s/mcp`, waits for the Gateway to become Programmed, and
waits for the proxy Pod to become Ready.

Runtime MCP configuration is declarative under `k8s/mcp/`.

Changing public capability exposure does not require rebuilding the LLM gateway
image.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 13. Validation and Acceptance

Run:

```bash
task mcp:check
```

The automated check currently proves:

1. MCP initialization completes through the runtime ingress;
2. a session ID is returned;
3. `notifications/initialized` is accepted;
4. `tools/list` succeeds;
5. `memory.retrieve_context` is visible;
6. `memory.reference.search` is visible;
7. `memory.reference.get` is visible.

With `PROJECT_ID` and `QUERY`, the script also invokes retrieval and reference
search. With `REFERENCE_CHUNK_ID`, it can invoke reference get.

Operator convenience for retrieval is:

```bash
task mcp:check:retrieval PROJECT_ID='<project-id>' QUERY='<query>'
```

The current automated script does not prove every architecture invariant.
Routing, NetworkPolicy, controller-version, failure-path, and telemetry changes
require validation of the affected boundary.

A ready Pod, accepted CRD, or Programmed Gateway alone is insufficient.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 14. Failure Semantics

Gateway infrastructure failures remain failures.

The runtime MUST preserve meaningful distinction between:

```text
unknown capability
capability not exposed
malformed MCP request
client authentication failure
client authorization failure
gateway routing failure
backend unavailable
backend connection failure
backend timeout
backend protocol failure
backend application rejection
invalid backend response
gateway internal failure
```

The MCP gateway MUST NOT manufacture successful tool results when backend execution failed.

The gateway MUST NOT silently route a request to another backend unless such behavior is explicitly part of the configured public contract.

Error responses must not expose:

```text
backend credentials
Kubernetes Secrets
unrelated runtime configuration
arbitrary environment variables
unbounded stack traces
```

Backend business errors remain backend-owned.

Transport and routing failures remain gateway-visible.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 15. Versioning and Upgrade Policy

Envoy AI Gateway, Envoy Gateway, CRDs, and the supported MCP protocol behavior are versioned runtime dependencies.

The repository MUST pin the selected versions.

An upgrade is not accepted from controller readiness alone.

Before promotion, the implementation MUST rerun the MCP acceptance checks from section 13.

In particular, upgrades must verify:

```text
MCP initialization
tools/list behavior
tool filtering
tool invocation
backend routing
backend authentication where used
failure propagation
telemetry
NetworkPolicy behavior
```

MCP protocol compatibility MUST be tested against the actual runtime clients and backends.

The runtime MUST NOT infer compatibility solely from an upstream release number.

Breaking upstream behavior requires explicit migration or rollback.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 16. Non-Goals

`llm-runtime` will not build:

```text
a custom MCP gateway
a custom MCP server framework
a custom capability-registry service
a custom backend adapter framework
a custom MCP session implementation
a custom MCP authorization framework
an MCP administration UI
an MCP database
a memory database
an artifact database
a generic HTTP proxy
a generic TCP proxy
a generic shell execution gateway
an unrestricted Kubernetes API proxy
```

The runtime also does not move backend business logic into Envoy configuration.

Envoy configuration determines exposure and transport policy.

Backends determine domain behavior.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 17. Tradeoffs and Known Constraints

Selecting Envoy AI Gateway removes a substantial custom implementation burden but introduces dependency on Envoy AI Gateway, Envoy Gateway, Gateway API resources, and their release compatibility.

Declarative CRDs make runtime behavior reviewable and GitOps-friendly, but they couple the deployment to upstream API semantics.

Explicit tool allowlisting creates operational work when backend capabilities change. That cost is intentional. New backend functionality should not become public accidentally.

Centralizing MCP ingress creates a shared dependency. Gateway failure can affect multiple MCP consumers even when individual backends remain healthy.

The gateway can enforce transport, exposure, identity, and infrastructure policy. It cannot determine whether a backend result is semantically correct.

Backend and MCP protocol compatibility can change independently. Version pinning and end-to-end tests are therefore required even when Kubernetes reconciliation succeeds.

Cross-namespace backend topology must not be assumed to work through arbitrary direct route references. Backend addressing must use a topology supported and tested by the pinned Envoy release.

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

## 18. Core Invariants

### 18.1 One stable MCP ingress

Consumers integrate with the runtime MCP endpoint rather than every backend independently.

### 18.2 Envoy is the implementation

`llm-runtime` configures Envoy AI Gateway.

It does not implement a competing MCP gateway.

### 18.3 Explicit exposure only

Every public backend capability is deliberately allowlisted.

### 18.4 No arbitrary destinations

Clients cannot choose backend URLs, Services, namespaces, or network destinations.

### 18.5 Backend semantics remain backend-owned

Routing infrastructure does not reproduce backend application logic.

### 18.6 Backend credentials remain behind the gateway

Clients do not receive backend credentials.

### 18.7 Consumer-specific metadata remains optional

RR execution concepts do not become universal MCP gateway fields.

### 18.8 Observability is mandatory

MCP routing must be visible through runtime telemetry.

### 18.9 Failure remains failure

Gateway or backend failure is not converted into synthetic success.

### 18.10 Backend growth does not change client ingress

Adding Backend N means:

```text
deploy backend
    -> configure backend destination
    -> explicitly allow capabilities
    -> permit required gateway egress
    -> validate
```

It does not mean:

```text
modify every MCP client
    -> expose backend directly
    -> distribute backend credentials
```

### 18.11 The gateway remains infrastructure

Envoy AI Gateway owns:

```text
MCP ingress
+ capability exposure
+ routing
+ transport policy
+ infrastructure security
+ infrastructure telemetry
```

Backends own:

```text
domain semantics
+ domain validation
+ domain state
+ persistence
+ correctness
```

[Back to top](#mcp-gateway--envoy-ai-gateway-integration)

---

**END OF DOCUMENT**
