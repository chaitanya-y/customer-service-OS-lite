# ADR-001: Polyglot Runtime and MCP Boundaries

- Status: Accepted
- Date: 2026-07-25
- Decision owners: Customer Service OS project
- Amends: Combined HLD/LLD TypeScript-only online-runtime baseline

## Context

The original LLD selected Node.js and TypeScript for all online services and reserved Python for offline ingestion and evaluation. The implementation now deliberately adopts a polyglot architecture:

- Node.js and TypeScript own transactional APIs, durable workflow coordination, deterministic policy, integrations, MCP servers, human operations, and the control plane.
- Python owns LangGraph agent orchestration, knowledge/RAG processing, and evaluation workloads.
- React and TypeScript own all browser surfaces.

This is an explicit architecture amendment, not an accidental divergence.

## Decision

The seven release and ownership units remain unchanged. Logical applications and workload roles map into them as follows.

| Release unit | Application or workload role | Language | Main responsibility |
|---|---|---|---|
| Edge/API | Customer Chat UI | React + TypeScript | Customer conversation interface and streaming responses |
| Edge/API | Edge API | Node.js + TypeScript | Authentication, trusted tenant context, admission, rate limiting, validation, routing, and SSE |
| Conversation Runtime | Conversation Service | Node.js + TypeScript | Conversations, ordered messages, persistence, response commit, projections, and event delivery |
| Agent Runtime | Agent Runtime | Python | LangGraph orchestration, bounded specialists, context construction, model orchestration, retrieval coordination, and structured proposals |
| Workflow Workers | Workflow and Policy Service | Node.js + TypeScript | Temporal refund state machine, deterministic eligibility, previews, confirmation, approval, retries, and reconciliation coordination |
| Integration Gateway | Integration Gateway | Node.js + TypeScript | Business-system connectors, credentials, authorization enforcement, idempotency, action safety, reconciliation, and auditing |
| Integration Gateway | MCP servers | Node.js + TypeScript | Versioned approved read tools and workflow-authorized commerce operations |
| Human Operations | Human-Agent Console | React + TypeScript | Escalations, approvals, takeover, and conversation review |
| Human Operations | Human Operations Service | Node.js + TypeScript | Cases, queues, assignments, human decisions, takeover, and release-back |
| Control and Knowledge | Admin Console | React + TypeScript | Manage prompts, policies, knowledge releases, models, evaluations, and rollout |
| Control and Knowledge | Control Plane | Node.js + TypeScript | Tenant configuration, release metadata, integration registration, model settings, and publication |
| Control and Knowledge | Knowledge/RAG workloads | Python | Ingestion, parsing, chunking, embeddings, index construction, hybrid retrieval, reranking, and citations |
| Control and Knowledge | Evaluation Runner | Python | RAG, answer, trajectory, tool-selection, policy, and safety evaluations |
| Control and Knowledge | Dataset and Red-Team Workers | Python | Evaluation datasets, synthetic cases, adversarial testing, and experiment analysis |

The three browser surfaces remain:

- `customer-widget`, owned by Edge/API
- `operations-console`, owned by Human Operations
- `admin-console`, owned by Control and Knowledge

Knowledge/RAG may run as multiple Python workload roles, but it remains inside the Control and Knowledge release boundary. Online retrieval reads a region-local published immutable index and must not synchronously call the control-plane publication API.

## MCP boundary

The Python Agent Runtime is an MCP client. The Node.js Integration Gateway publishes controlled MCP servers backed by approved connectors.

```text
Python LangGraph Agent Runtime
        |
        | approved, per-turn read-only MCP projection
        v
Node.js Integration Gateway MCP servers
        |
        | authorized provider request
        v
Order / CRM systems
```

MCP is language-independent, but it does not grant authority. The following constraints are mandatory:

1. The live agent receives only the approved, versioned, per-turn tool projection. Arbitrary runtime tool discovery is prohibited.
2. Agent-accessible MCP tools are read-only. Order lookup may be exposed; identity and customer verification remain deterministic security operations rather than model decisions.
3. The refund write tool is never exposed to the Agent Runtime.
4. The Agent Runtime returns a typed refund proposal; it does not perform the refund.
5. Temporal Workflow Workers validate current business facts, run deterministic policy, construct the canonical preview, capture exact customer confirmation, and wait for approval when required.
6. A Temporal activity calls the Integration Gateway with an opaque, narrow, expiring Action Capability.
7. The Integration Gateway validates authorization, idempotency, policy and contract versions before invoking the refund provider.
8. Completion is reported only after authoritative provider confirmation. Ambiguous outcomes enter reconciliation or human review.

The consequential refund path is:

```text
React Customer UI
        v
Node.js Edge API
        v
Node.js Conversation Service
        v
Python LangGraph Agent Runtime
  - Triage specialist
  - Refund specialist
  - RAG retrieval
  - LLM orchestration
        |
        | typed proposal only
        v
Node.js Temporal Workflow and Policy Service
        |
        | authorized activity
        v
Node.js Integration Gateway / MCP connector boundary
        v
Refund provider
```

## Version and release rules

- Agent, prompt, knowledge, model-route, policy, tool-contract, workflow, and evaluation versions are recorded in an `ExecutionEvidence` record for each applicable turn or action.
- Knowledge release selection is stable within a turn and may advance between turns. Revocation takes effect immediately.
- Business policy is deterministic, versioned, selected using current authoritative facts, and reevaluated before a consequential effect.
- The policy version is bound to the action preview and customer confirmation. A material change invalidates confirmation and requires a new preview.
- MCP tool contracts are versioned and generated from canonical schemas. Python and TypeScript clients must pass cross-language contract tests.
- Temporal workflow code uses explicit versioning and replay tests.
- Release manifests distinguish deployable code identity from product behavior and data-release versions.

## Consequences

Benefits:

- Python provides the strongest LangGraph, RAG, and evaluation ecosystem.
- TypeScript retains transactional and integration consistency.
- Cross-language MCP demonstrates protocol interoperability.
- Seven ownership and release boundaries remain intact.

Costs and mitigations:

- Two production language stacks require separate dependency, security, telemetry, and build pipelines.
- Cross-language contracts must be schema-first and generated; handwritten duplicate DTOs are prohibited.
- Distributed tracing must propagate the same tenant, conversation, workflow, release, and correlation identifiers across Python and TypeScript.
- Integration and replay suites are required before deployment.
