docs/03_operations.md
# OPERATIONS GUIDE
## Deployment, Validation, and Runtime Operations
### Operational Procedures Specification

---

## Navigation

- [0. Status, Scope, and Authority](#0-status-scope-and-authority)
- [1. Purpose](#1-purpose)
- [2. Operational Principles](#2-operational-principles)
- [3. Runtime Deployment](#3-runtime-deployment)
- [4. Runtime Validation](#4-runtime-validation)
- [5. Runtime Health Checks](#5-runtime-health-checks)
- [6. Runtime Observability](#6-runtime-observability)
- [7. Capacity Monitoring](#7-capacity-monitoring)
- [8. Incident Response](#8-incident-response)
- [9. Runtime Upgrades](#9-runtime-upgrades)
- [10. Runtime Rollback](#10-runtime-rollback)
- [11. Architectural Boundaries](#11-architectural-boundaries)
- [12. Closing Statement](#12-closing-statement)

---

## 0. Status, Scope, and Authority

**Status:** FOUNDATIONAL

**Audience:**
- Platform operators
- Runtime maintainers
- Infrastructure contributors

**Change policy:**
- Append-only
- No silent edits

This document defines operational procedures for LLM Runtime.

This document focuses on runtime infrastructure.

This document does not define application-specific operational procedures.

[Back to top](#navigation)

---

## 1. Purpose

The purpose of this document is to define repeatable operational procedures for:

- deployment
- validation
- monitoring
- troubleshooting
- upgrades
- rollback

The objective is operational consistency.

[Back to top](#navigation)

---

## 2. Operational Principles

### Infrastructure First

Runtime health should be evaluated independently from project-specific behavior.

### Observable Systems

Operational decisions should be based on observed data.

### Conservative Change Management

Runtime changes should be incremental and observable.

### Stable Contracts

Runtime contracts should remain stable during operational changes whenever practical.

[Back to top](#navigation)

---

## 3. Runtime Deployment

Deploy runtime infrastructure:

```bash
task deploy
```

Validate namespace creation:

```bash
kubectl get namespace llm-runtime
```

Validate runtime resources:

```bash
kubectl -n llm-runtime get all
```

Expected resources include:

```text
llm-small
llm-medium
llm-large
```

[Back to top](#navigation)

---

## 4. Runtime Validation

After deployment, validate service availability.

List services:

```bash
kubectl -n llm-runtime get svc
```

Expected services:

```text
llm-small
llm-medium
llm-large
```

Validate runtime endpoints:

```bash
task list-small
task list-medium
task list-large
```

Successful model enumeration indicates endpoint availability.

[Back to top](#navigation)

---

## 5. Runtime Health Checks

Runtime services should expose OpenAI-compatible endpoints.

Basic health validation:

```bash
curl http://localhost:8000/v1/models
```

Smoke-test validation:

```bash
task smoke-small
task smoke-medium
task smoke-large
```

Expected outcome:

```text
Successful request completion
```

Health validation should occur after:

- deployment
- restart
- upgrade
- rollback

[Back to top](#navigation)

---

## 6. Runtime Observability

Runtime observability focuses on infrastructure behavior.

Examples:

- GPU utilization
- GPU memory usage
- request latency
- request throughput
- queue depth
- timeout rate
- error rate
- pod restart count

These metrics support runtime capacity planning.

Project-specific effectiveness metrics belong to consumer projects.

[Back to top](#navigation)

---

## 7. Capacity Monitoring

Runtime capacity should be monitored continuously.

Indicators of insufficient capacity may include:

- sustained queue growth
- latency increase
- timeout increase
- request rejection
- degraded throughput

Potential responses include:

- increasing runtime capacity
- adding additional GPUs
- introducing additional tiers
- deploying dedicated replicas
- applying concurrency controls

Capacity changes should be driven by observed behavior.

[Back to top](#navigation)

---

## 8. Incident Response

Illustrative runtime incidents:

### Service Unavailable

Symptoms:

```text
Connection failures
Request failures
```

Initial actions:

```bash
kubectl -n llm-runtime get pods
kubectl -n llm-runtime describe pod <pod>
kubectl -n llm-runtime logs <pod>
```

### High Latency

Symptoms:

```text
Increased response times
Queue growth
```

Initial actions:

```text
Review runtime metrics
Review GPU utilization
Review request volume
```

### Model Startup Failure

Symptoms:

```text
Pod restart loop
Readiness probe failures
```

Initial actions:

```bash
kubectl -n llm-runtime logs <pod>
```

Review:

- model download status
- storage availability
- GPU availability

[Back to top](#navigation)

---

## 9. Runtime Upgrades

Runtime upgrades should be incremental.

Recommended process:

1. update manifests
2. deploy updated resources
3. validate endpoint availability
4. execute smoke tests
5. observe runtime metrics
6. validate consumer connectivity

Upgrades should preserve runtime contracts whenever practical.

[Back to top](#navigation)

---

## 10. Runtime Rollback

Rollback should be available for all runtime changes.

Illustrative rollback process:

```bash
git revert <change>
task deploy
```

Post-rollback validation:

```bash
task list-small
task list-medium
task list-large

task smoke-small
task smoke-medium
task smoke-large
```

Rollback success requires restoration of runtime availability.

[Back to top](#navigation)

---

## 11. Architectural Boundaries

This document does not define:

- project prompts
- project schemas
- project workflows
- project authority models
- project persistence
- project-specific quality metrics

This document defines runtime operational procedures only.

[Back to top](#navigation)

---

## 12. Closing Statement

The purpose of runtime operations is maintaining stable and observable inference infrastructure.

Operational procedures should focus on infrastructure behavior rather than project-specific semantics.

Runtime reliability, observability, and capacity management remain the primary operational objectives.

---

**END OF DOCUMENT**
