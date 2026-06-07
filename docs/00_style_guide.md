# LLM Runtime Documentation Style Guide
Canonical rules for tone, structure, formatting, and architectural writing

---

## Table of Contents

- [Purpose](#purpose)
- [1. Document Categories](#1-document-categories)
  - [1.1 README (Top-Level)](#11-readme-top-level)
  - [1.2 Adversarial / Architecture Review Docs](#12-adversarial--architecture-review-docs)
  - [1.3 Architecture / Design Docs](#13-architecture--design-docs)
  - [1.4 Operational Docs](#14-operational-docs)
- [2. Formatting Rules (Strict)](#2-formatting-rules-strict)
  - [2.1 Outer Container for Copy-Paste-Safe Documents](#21-outer-container-for-copy-paste-safe-documents)
  - [2.2 Code Blocks Inside Documents](#22-code-blocks-inside-documents)
  - [2.3 Headings](#23-headings)
  - [2.4 Table of Contents](#24-table-of-contents)
- [3. Language and Tone Rules](#3-language-and-tone-rules)
  - [3.1 Forbidden Language (Hand-Waving Markers)](#31-forbidden-language-hand-waving-markers)
  - [3.2 Allowed Emphasis](#32-allowed-emphasis)
  - [3.3 Claims and Honesty Rules](#33-claims-and-honesty-rules)
- [4. Architectural Writing Rules](#4-architectural-writing-rules)
  - [4.1 Always Answer “Who Decides?”](#41-always-answer-who-decides)
  - [4.2 Explicit Tradeoffs Are Mandatory](#42-explicit-tradeoffs-are-mandatory)
  - [4.3 Time Is First-Class](#43-time-is-first-class)
- [5. Consistency Across Repositories](#5-consistency-across-repositories)
  - [5.1 Canonical Terms](#51-canonical-terms)
  - [5.2 Cross-Document Stability](#52-cross-document-stability)
- [6. Diagrams (When Used)](#6-diagrams-when-used)
- [7. What This Style Is Optimized For](#7-what-this-style-is-optimized-for)
- [Final Rule](#final-rule)

---

## Purpose

This file defines **non-negotiable standards** for all UNICOP documentation.

Goals:
- consistency across repositories
- architectural clarity
- credibility with senior engineers, SREs, architects, and auditors
- elimination of ambiguity and accidental marketing tone

If a document violates this guide, it is **incorrect**, regardless of content quality.

[Back to top](#unicop-documentation-style-guide)

---

## 1. Document Categories

### 1.1 README (Top-Level)

Purpose:
- explain *why* UNICOP exists
- define the problem space
- establish the architectural stance

Rules:
- short
- thesis-driven
- no deep mechanics
- no implementation detail
- no tutorials

Tone:
- calm
- declarative
- falsifiable where possible

[Back to top](#unicop-documentation-style-guide)

---

### 1.2 Adversarial / Architecture Review Docs

Purpose:
- challenge the system
- expose failure modes
- answer hostile senior questions

Rules:
- question-driven
- explicit tradeoffs
- no marketing language
- weaknesses stated plainly

Tone:
- ruthless
- technical
- intellectually honest

[Back to top](#unicop-documentation-style-guide)

---

### 1.3 Architecture / Design Docs

Purpose:
- explain *how* something works
- define invariants, contracts, flows

Rules:
- deterministic language
- explicit assumptions
- explicit authority boundaries
- explicit failure behavior

Tone:
- precise
- mechanical
- boring (by design)

[Back to top](#unicop-documentation-style-guide)

---

### 1.4 Operational Docs

Purpose:
- explain how to run, debug, recover

Rules:
- step-by-step
- failure-first mindset
- explicit rollback paths
- no hidden “magic”

Tone:
- pragmatic
- defensive
- operator-centric

[Back to top](#unicop-documentation-style-guide)

---

## 2. Formatting Rules (Strict)

### 2.1 Outer Container for Copy-Paste-Safe Documents

When you need a document to be copy/paste-safe in chat, wrap the **entire document** in a tilde fence:

- opening line: three tildes followed by `md`  
  example: `~~~md`
- closing line: three tildes  
  example: `~~~`

Do not use backtick fences as the outer container in chat.

[Back to top](#unicop-documentation-style-guide)

---

### 2.2 Code Blocks Inside Documents

Inside Markdown documents (in the repo), use triple backticks for code blocks.

In this guide, backticks are referenced as text:
- triple backticks: ` ``` `
- triple tildes: ` ~~~ `

Rules:
- prefer backticks for code blocks in repo Markdown
- avoid nesting fences inside fences in chat output
- use text references when describing fences

[Back to top](#unicop-documentation-style-guide)

---

### 2.3 Headings

Rules:
- use ATX headings only (`#`, `##`, `###`, …)
- do not skip levels
- keep headings stable

Reason:
- stable anchor links
- stable Table of Contents

[Back to top](#unicop-documentation-style-guide)

---

### 2.4 Table of Contents

Rules:
- always use linked anchors
- no numbered-only TOCs
- link text must match the section heading
- anchors must be stable

Correct pattern:
- `[Tier 4 — Bounded Roots and Concurrency](#tier-4--bounded-roots-and-concurrency)`

Incorrect pattern:
- `1. Tier 4 — Bounded Roots and Concurrency`

[Back to top](#unicop-documentation-style-guide)

---

## 3. Language and Tone Rules

### 3.1 Forbidden Language (Hand-Waving Markers)

Do not use:
- “simple”
- “easy”
- “just”
- “basically”
- “obviously”
- “magic”
- “seamless”

[Back to top](#unicop-documentation-style-guide)

---

### 3.2 Allowed Emphasis

Allowed:
- **bold** for invariants and hard claims
- *italics* for short clarifications
- blockquotes for adversarial framing

Avoid:
- hype adjectives
- persuasion through punctuation

[Back to top](#unicop-documentation-style-guide)

---

### 3.3 Claims and Honesty Rules

Every strong claim must be supported by at least one:
- enforced by schema
- enforced by protocol
- enforced by process (explicitly stated)
- enforced by failure

If none apply:
- soften the claim, or
- delete it

[Back to top](#unicop-documentation-style-guide)

---

## 4. Architectural Writing Rules

### 4.1 Always Answer “Who Decides?”

For every mechanism, state:
- who has authority
- when they have it
- how it is enforced
- what happens on failure

If unclear, the design is incomplete.

[Back to top](#unicop-documentation-style-guide)

---

### 4.2 Explicit Tradeoffs Are Mandatory

Every serious architecture document must include:
- at least one weakness
- at least one operational cost
- at least one failure mode

Absence of tradeoffs reduces credibility.

[Back to top](#unicop-documentation-style-guide)

---

### 4.3 Time Is First-Class

When writing about state, distinguish:
- intent vs observed
- current vs historical
- attempt vs outcome

Prefer explicit terms:
- Desired State
- Observed State
- Drift
- Reconciliation
- Audit Spine

[Back to top](#unicop-documentation-style-guide)

---

## 5. Consistency Across Repositories

### 5.1 Canonical Terms

Use consistently:
- Root
- Control Plane
- Desired State
- Observed State
- Drift
- Reconciliation
- Audit Spine

Do not introduce synonyms casually.

[Back to top](#unicop-documentation-style-guide)

---

### 5.2 Cross-Document Stability

Rules:
- do not renumber tiers casually
- do not rename headings without updating links
- treat anchors as APIs

[Back to top](#unicop-documentation-style-guide)

---

## 6. Diagrams (When Used)

Rules:
- reduce complexity
- one diagram = one idea
- prefer multiple small diagrams
- label flows explicitly

If a diagram needs justification, delete it.

[Back to top](#unicop-documentation-style-guide)

---

## 7. What This Style Is Optimized For

Optimized for:
- senior engineers
- architects
- SREs
- security reviewers
- compliance auditors

Not optimized for:
- beginners
- marketing
- quick-starts

This separation is intentional.

[Back to top](#unicop-documentation-style-guide)

---

## Final Rule

When unsure whether something belongs in a document:

Remove it.

UNICOP documentation values:
- restraint
- precision
- survivability under scrutiny

This style guide is part of the architecture.
