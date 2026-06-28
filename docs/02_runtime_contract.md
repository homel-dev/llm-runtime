docs/02_runtime_contract.md
# RUNTIME CONTRACT
## Shared Runtime Service Contract
### Infrastructure Contract Specification

---

## Navigation

- [0. Status, Scope, and Authority](#0-status-scope-and-authority)
- [1. Purpose](#1-purpose)
- [2. Contract Philosophy](#2-contract-philosophy)
- [3. Contract Stability Rules](#3-contract-stability-rules)
- [4. Service Endpoints](#4-service-endpoints)
- [5. API Compatibility](#5-api-compatibility)
- [6. Consumer Responsibilities](#6-consumer-responsibilities)
- [7. Runtime Responsibilities](#7-runtime-responsibilities)
- [8. Configuration Model](#8-configuration-model)
- [9. Versioning Policy](#9-versioning-policy)
- [10. Architectural Boundaries](#10-architectural-boundaries)
- [11. Closing Statement](#11-closing-statement)

---

## 0. Status, Scope, and Authority

**Status:** FOUNDATIONAL

**Audience:**
- Runtime contributors
- Platform contributors
- Consumer project maintainers

**Change policy:**
- Append-only
- No silent edits

This document defines the runtime service contract exposed by the LLM Runtime platform.

[Back to top](#navigation)

---

## 1. Purpose

Consumer projects require a stable mechanism for accessing shared inference services.

The purpose of this contract is to define:

- service discovery
- endpoint stability
- API compatibility expectations
- ownership boundaries

The contract intentionally remains minimal.

[Back to top](#navigation)

---

## 2. Contract Philosophy

The runtime contract should expose only information required to consume inference services.

The runtime contract should avoid exposing deployment implementation details.

Examples of implementation details:

- model names
- quantization strategy
- GPU allocation
- batching configuration
- container topology

Consumer projects should not depend on implementation details.

Consumer projects should depend only on stable runtime interfaces.

[Back to top](#navigation)

---

## 3. Contract Stability Rules

The following items are considered stable:

- namespace name
- service names
- API compatibility
- endpoint structure

The following items are not considered stable:

- deployed model
- model version
- quantization method
- deployment topology
- runtime implementation details

Consumer projects must not assume implementation stability.

[Back to top](#navigation)

---

## 4. Service Endpoints

The runtime publishes three initial capacity tiers.

### Small Tier

```text
http://llm-small.llm-runtime.svc.cluster.local:8000
```

### Medium Tier

```text
http://llm-medium.llm-runtime.svc.cluster.local:8000
```

### Large Tier

```text
http://llm-large.llm-runtime.svc.cluster.local:8000
```

The endpoint names are part of the runtime contract.

Consumers should treat these endpoints as stable.

[Back to top](#navigation)

---

## 5. API Compatibility

Runtime services expose OpenAI-compatible APIs.

Illustrative endpoints:

```text
GET  /v1/models

POST /v1/chat/completions

POST /v1/completions

POST /v1/embeddings
```

Actual endpoint availability depends on deployed runtime capabilities.

OpenAI compatibility is the primary interoperability goal.

[Back to top](#navigation)

---

## 6. Consumer Responsibilities

Consumer projects own:

- prompts
- schemas
- workflow behavior
- role assignment
- retry logic
- timeout policies
- authority boundaries

Consumers are responsible for selecting which runtime tier should be used for a particular workload.

The runtime does not make workload decisions.

[Back to top](#navigation)

---

## 7. Runtime Responsibilities

The runtime owns:

- endpoint availability
- deployment health
- service discovery
- runtime metrics endpoints and runtime metrics ownership
- model serving
- infrastructure lifecycle

The runtime is not responsible for project-specific behavior.

[Back to top](#navigation)

---

## 8. Configuration Model

Illustrative configuration:

```yaml
STEWARD_LLM_BASE_URL: http://llm-large.llm-runtime.svc.cluster.local:8000

AUDITOR_LLM_BASE_URL: http://llm-small.llm-runtime.svc.cluster.local:8000

CODER_LLM_BASE_URL: http://llm-medium.llm-runtime.svc.cluster.local:8000
```

Projects define their own mappings.

The runtime remains unaware of project semantics.

[Back to top](#navigation)

---

## 9. Versioning Policy

The runtime contract should evolve conservatively.

Breaking changes should be avoided whenever practical.

Preferred evolution pattern:

```text
additive changes
```

rather than:

```text
breaking replacement changes
```

Service names should remain stable.

[Back to top](#navigation)

---

## 10. Architectural Boundaries

This contract does not define:

- prompts
- project roles
- project workflows
- planning systems
- review systems
- admission systems
- persistence systems

This document defines connectivity and interoperability only.

[Back to top](#navigation)

---

## 11. Closing Statement

The runtime contract exists to provide stable access to shared inference capacity.

Consumer projects remain fully responsible for application semantics.

The runtime remains responsible for infrastructure behavior.

---

**END OF DOCUMENT**
