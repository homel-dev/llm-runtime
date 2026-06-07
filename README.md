README.md
# LLM Runtime

## Shared LLM Inference Runtime

*Repository Guide and Infrastructure Proposal*

---

## Navigation

- [0. Status and Scope](#0-status-and-scope)
- [1. Purpose](#1-purpose)
- [2. What This Repository Provides](#2-what-this-repository-provides)
- [3. What This Repository Does Not Provide](#3-what-this-repository-does-not-provide)
- [4. Repository Layout](#4-repository-layout)
- [5. Runtime Model](#5-runtime-model)
- [6. Kubernetes Deployment](#6-kubernetes-deployment)
- [7. Consumer Projects](#7-consumer-projects)
- [8. Operations](#8-operations)
- [9. Documentation](#9-documentation)

---

## 0. Status and Scope

**Status:** Proposal

This repository defines shared LLM inference infrastructure for Homel projects.

The repository owns:

- shared model-serving runtime
- runtime service contracts
- deployment manifests
- operational tooling
- runtime observability

The repository does not own:

- project prompts
- project schemas
- project workflows
- project authority models
- project persistence
- project-specific behavior

[Back to top](#navigation)

---

## 1. Purpose

Multiple Homel projects require access to local or local-first LLM inference.

Examples include:

- Memory Steward
- Relentless Rekrow
- Intent Steward
- The Dean

Without a shared runtime, every project tends to deploy its own model-serving stack.

The purpose of this repository is to provide a reusable inference platform that can be consumed by multiple projects simultaneously.

The runtime is shared.

Projects remain independent.

[Back to top](#navigation)

---

## 2. What This Repository Provides

This repository provides:

- Kubernetes namespace
- vLLM deployments
- stable runtime service endpoints
- runtime service contracts
- shared operational tooling
- observability integration
- deployment automation
- runtime documentation

The runtime exposes OpenAI-compatible APIs.

Consumer projects connect to these APIs through stable service endpoints.

[Back to top](#navigation)

---

## 3. What This Repository Does Not Provide

This repository does not provide:

- Memory Steward logic
- Relentless Rekrow logic
- Intent Steward logic
- The Dean logic
- prompts
- schemas
- admission control
- planning logic
- review logic
- orchestration logic
- persistence logic

Sharing model-serving infrastructure does not imply shared project semantics.

Projects remain independent.

[Back to top](#navigation)

---

## 4. Repository Layout

```text
.
├── README.md
├── Taskfile.yml
├── .gitignore
│
├── docs/
│   ├── 00_style_guide.md
│   ├── 01_overview.md
│   ├── 02_runtime_contract.md
│   └── 03_operations.md
│
├── k8s/
│   ├── kustomization.yml
│   ├── namespace.yml
│   ├── runtime-contract.yml
│   ├── networkpolicy.yml
│   │
│   ├── small/
│   ├── medium/
│   └── large/
│
├── scripts/
│   ├── list-models.sh
│   └── smoke-chat.sh
│
└── hack/
    ├── benchmark-small.sh
    ├── benchmark-medium.sh
    └── benchmark-large.sh
```

[Back to top](#navigation)

---

## 5. Runtime Model

The runtime provides capacity-oriented inference tiers.

Initial tiers:

```text
small
medium
large
```

Each tier exposes an OpenAI-compatible endpoint.

Illustrative services:

```text
llm-small.llm-runtime.svc.cluster.local
llm-medium.llm-runtime.svc.cluster.local
llm-large.llm-runtime.svc.cluster.local
```

Consumer projects decide how to map their own workloads to runtime tiers.

The runtime provides inference capacity only.

The runtime does not define project roles.

[Back to top](#navigation)

---

## 6. Kubernetes Deployment

Deploy runtime:

```bash
task deploy
```

View status:

```bash
task status
```

List available models:

```bash
task list-large
```

Run smoke tests:

```bash
task smoke-small
task smoke-medium
task smoke-large
```

Delete runtime:

```bash
task delete
```

[Back to top](#navigation)

---

## 7. Consumer Projects

Consumer projects configure their own runtime assignments.

Illustrative example:

```yaml
STEWARD_LLM_BASE_URL: http://llm-large.llm-runtime.svc.cluster.local:8000

AUDITOR_LLM_BASE_URL: http://llm-small.llm-runtime.svc.cluster.local:8000
```

Projects remain responsible for:

- prompts
- schemas
- role definitions
- workflow behavior
- authority boundaries
- persistence

The runtime remains responsible for inference capacity only.

[Back to top](#navigation)

---

## 8. Operations

The runtime should be monitored as infrastructure.

Important signals include:

- GPU utilization
- GPU memory consumption
- request latency
- request throughput
- queue depth
- timeout rate
- error rate
- pod health

Project effectiveness metrics remain the responsibility of individual projects.

[Back to top](#navigation)

---

## 9. Documentation

Canonical documentation is stored under:

```text
docs/
```

Initial documents:

- `00_style_guide.md`
- `01_overview.md`
- `02_runtime_contract.md`
- `03_operations.md`

The overview document defines architecture.

The runtime contract document defines service contracts.

The operations document defines deployment and operational procedures.

[Back to top](#navigation)

---

**END OF DOCUMENT**
