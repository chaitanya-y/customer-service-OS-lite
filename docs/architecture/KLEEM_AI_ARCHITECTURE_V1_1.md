# Kleem AI Combined HLD and LLD Architecture

Version: 1.1 current architecture edition
Date: 2026-09-03
Status: Authoritative for the implemented repository and accepted near-term plan

## Document authority

This document is the current architecture amendment for Customer Service OS Lite,
also referred to as the Kleem AI customer agent platform. It must be read before
the preserved version 1.0 combined HLD/LLD PDF.

If this document or an accepted ADR conflicts with a page in the version 1.0 PDF,
this document and the ADR take precedence. The old PDF remains valuable for
product intent, non-functional requirements, domain decomposition, and detailed
future-state analysis.

The final combined PDF contains this amendment first and the complete version 1.0
document as a baseline appendix.

## Executive summary

The product is a governed platform for creating, operating, evaluating, and
eventually deploying customer support agents. The first end-to-end journey is a
refund because it exercises conversational intake, multi-agent orchestration,
retrieval, tools, deterministic policy, durable workflow, human review, commerce
execution, reconciliation, and audit.

The current system is production-shaped but locally deployed. It proves component
boundaries and safety controls without claiming production scale or reliability.

## Version 1.1 changes from the original PDF

| Area | Original baseline direction | Current authoritative direction |
|---|---|---|
| Online AI runtime | Some sections prescribe TypeScript-only online services | Python/FastAPI Agent Runtime and Knowledge/RAG are accepted and implemented; transactional services remain Node.js/TypeScript |
| Web applications | Vite/React appears in older design | Next.js with same-origin BFF routes is implemented for customer, operations, and admin surfaces |
| Node framework | NestJS appears in target design | Fastify is used in the implemented local service slice |
| Repository layout | Older `deployables` and `surfaces` names | `apps/services`, `apps/web`, `packages`, `contracts`, `infrastructure`, and `tools` are current |
| Internal transport | Broad gRPC/protobuf target | Current application calls are primarily HTTP/JSON with canonical schemas; Temporal uses gRPC and protobuf remains an internal contract option |
| Initial AWS platform | EKS and multi-region target | First deployment is intentionally single-region ECS Fargate; EKS/multi-region are later scale choices, not current implementation |
| Human Operations persistence | Earlier local slice was in memory | Running Human Operations service uses PostgreSQL with RLS, transactions, audit, idempotency, and durable decision outbox |
| Model access | Central routing appears in future-state architecture | Central Model Gateway remains planned; Agent Runtime calls configured models directly today |
| Delivery sequence | Broad platform build-out | Complete and harden the refund walking skeleton before expanding journeys |

## Architecture principles

1. Models propose; deterministic systems authorize.
2. Identity and tenant context are verified outside the model.
3. Agent tools are least privilege and read only where possible.
4. Consequential writes require current trusted facts, versioned policy, exact
   confirmation, and a narrow workflow capability.
5. Long-running work belongs in Temporal, not an HTTP request or LangGraph state.
6. Provider uncertainty remains processing or reconciliation, never success.
7. Cross-language boundaries are schema first.
8. Every governed action records enough version evidence to reproduce it.
9. Customer answers receive only customer-safe knowledge.
10. Add infrastructure only when the walking journey reaches the boundary.

## High-level system

```text
Customer Portal 3100               Operations Console 3101
        | same-origin BFF                    | same-origin BFF
        v                                    v
Edge API 3000                         Human Operations 3003
  |          |                               | PostgreSQL
  |          +--> Conversation Runtime 3004  | decision outbox
  |                    | PostgreSQL           v
  |                    +--> SSE wakeups     Temporal
  v                                         Workflow Workers
Agent Runtime 8000                              |
  | LangGraph                                  | narrow capability
  |                                            v
  +--> Knowledge/RAG 8001 --> OpenSearch    Integration Gateway 3002
  |        customer-safe evidence               |
  +--> read-only MCP order lookup --------------+
                                               v
                                       Vendure 3001 / provider
```

## Release and ownership boundaries

| Boundary | Technology | Responsibility |
|---|---|---|
| Customer Portal | Next.js, React, TypeScript | Customer conversation, preview, confirmation, and truthful lifecycle status |
| Operations Console | Next.js, React, TypeScript | Queue, claim, review, exceptional plan, rejection, and audit display |
| Admin Console | Next.js, React, TypeScript | Current shell; future release/configuration management |
| Edge API | Node.js, TypeScript, Fastify | Customer authentication, trusted context, validation, orchestration entry, and customer-owned workflow reads |
| Conversation Runtime | Node.js, TypeScript, Fastify, PostgreSQL | Conversations, encrypted messages, ordering, workflow links, projections, and event delivery |
| Agent Runtime | Python, FastAPI, LangGraph | Intent, specialist orchestration, context construction, RAG use, model calls, guardrails, and typed proposals |
| Knowledge/RAG | Python, FastAPI, OpenSearch | Ingestion, parsing, chunking, embeddings, publication, hybrid retrieval, reranking, citations, and evaluation |
| Workflow Workers | Node.js, TypeScript, Temporal | Deterministic policy, preview, confirmation, approval, takeover, execution, retries, and reconciliation |
| Integration Gateway | Node.js, TypeScript, Fastify, PostgreSQL | Vendure adapter, MCP server, authorization, idempotency, refund write, provider events, and audit evidence |
| Human Operations | Node.js, TypeScript, Fastify, PostgreSQL | Durable cases, staff authorization, claim/reassign, decisions, audit, and Temporal outbox delivery |

## Governed refund sequence

```text
1. Customer signs in locally and sends a conversation turn.
2. Edge verifies identity and creates audience-specific short-lived assertions.
3. Conversation Runtime persists the customer message.
4. Agent Runtime verifies its assertion and runs the LangGraph refund path.
5. Agent uses read-only MCP to obtain minimized authoritative OrderContext.
6. Agent asks Knowledge/RAG for CUSTOMER_SAFE evidence.
7. Model produces a schema-validated RefundProposal and grounded answer.
8. Edge commits the safe assistant response and starts Temporal only when ready.
9. Workflow refreshes RefundContext and evaluates versioned deterministic policy.
10. Workflow creates a bound preview or opens a Human Operations case.
11. A human may approve, reject, resolve takeover, or approve an exceptional plan.
12. Customer confirms the exact current preview.
13. Workflow refreshes facts again and issues a narrow expiring capability.
14. Integration Gateway performs one idempotent provider mutation.
15. Provider acceptance becomes REFUND_PROCESSING, not success.
16. Signed provider outcome or authoritative reconciliation determines completion.
17. Customer and staff projections show the truthful terminal state.
```

## Agent architecture

The implemented multi-agent pattern is supervisor routing with bounded specialists.
LangGraph manages online reasoning state, but it does not replace Temporal.

- LangGraph owns bounded conversational reasoning within a request.
- Temporal owns durable business state across minutes, hours, restarts, approvals,
  provider callbacks, and reconciliation.
- The refund specialist emits a typed `RefundProposal`.
- Guardrails validate structure and safe content before downstream use.
- No agent node receives a refund-write tool.

The current Agent Runtime calls configured OpenAI models directly through its
model client. This is the explicit current-state exception to the future Model
Gateway design.

## Model Gateway future module

Status: planned, not implemented.

```text
Agent Runtime
  -> logical route request plus tenant, task, sensitivity, and budget metadata
  -> Model Gateway
       -> route release lookup
       -> allowlist and policy enforcement
       -> token/cost/concurrency budgets
       -> timeout, circuit breaker, and approved fallback
       -> provider credential isolation
       -> trace, cost, and resolved-model evidence
  -> approved model provider
```

The gateway must be introduced behind the existing Agent Runtime model-client
interface. It must not absorb LangGraph orchestration, prompts, retrieval, business
policy, customer identity, or Temporal state. `MODEL_ROUTE_ID` currently records
intended route evidence; it does not mean the gateway exists.

## RAG architecture

### Ingestion

```text
Registered source
  -> content hash and classification
  -> PDF, DOCX, Markdown, HTML, or database parser
  -> normalized document and sections
  -> structure-aware chunks with bounded overlap
  -> OpenAI embeddings
  -> release-scoped OpenSearch index
  -> publication pointer
```

Each chunk identity is document-scoped. Metadata includes tenant, environment,
knowledge release, document ID, classification, locale, validity dates, source,
parser/chunking versions, content hash, and embedding model.

### Retrieval

```text
Query plus verified tenant context
  -> metadata filters
  -> BM25 keyword search
  -> vector semantic search
  -> reciprocal rank fusion
  -> cross-encoder reranking
  -> evidence and citations
  -> grounded answer composer
```

Customer-answer retrieval allows only `CUSTOMER_SAFE`. Internal-only policy and
playbooks may be used only by an explicitly authorized internal path. Retrieval and
answer evaluation are separate so failures can be diagnosed as retrieval quality,
reranking quality, grounding, citation, or final answer problems.

## Policy and workflow architecture

`RefundProposal` is model-produced, typed, and untrusted. `RefundPolicyInput`
combines the accepted proposal with current authoritative `RefundContext` and an
explicit policy release. `PolicyDecision` is deterministic and can be:

- `ALLOW`
- `APPROVAL_REQUIRED`
- `TAKEOVER_REQUIRED`
- `DENY`
- `NEEDS_FACTS`

The decision feeds the Temporal workflow. It never directly calls a provider.
Preview identity binds material facts, proposal, amount, policy version, and
customer confirmation. A material fact change invalidates the preview.

Temporal states cover intake, preview, confirmation, human review, authorized
submission, processing, reconciliation, success, failure, and safe closure. The
workflow uses `continueAsNew` during long reconciliation to bound history.

## Human Operations persistence

The running service uses PostgreSQL, not the in-memory adapter.

Core tables:

- `human_operations.refund_cases`
- `human_operations.case_audit_events`
- `human_operations.action_idempotency`
- `human_operations.decision_outbox`

Every repository transaction sets tenant and environment session context. Row-level
security enforces that scope in addition to application authorization. Claim,
reassign, and decision mutations use expected case version plus idempotency key.
A human decision, its audit event, and its pending outbox record commit together.
The service attempts direct Temporal delivery and retries pending rows every five
seconds.

This is durable local storage. Production still needs managed PostgreSQL, backups,
point-in-time recovery, high availability, capacity planning, monitoring, and a
Kafka-backed event/projection path.

## Security and identity boundaries

The local development system has two manually generated login JWTs:

- customer login token, verified by Edge API;
- Human Operations staff token, verified by Human Operations.

All service assertions are generated automatically and are short lived. Audiences
separate Agent Runtime, Knowledge/RAG, Integration Gateway, Conversation Runtime,
Workflow Workers, and Human Operations purposes. Separate secrets protect customer
login, staff login, Edge service writes, workflow capabilities, human case calls,
and provider events.

Production replaces local login tokens with Cognito/OIDC, stores secrets in AWS
Secrets Manager with KMS, and uses workload identity and separate/asymmetric keys.
See `docs/LOCAL_AUTH_AND_SECRETS.md` for the complete relationship map.

## Data ownership

| Data | Authoritative owner |
|---|---|
| Customer and order commerce facts | Vendure or production commerce provider |
| Conversation and message ordering | Conversation Runtime PostgreSQL |
| Refund durable state | Temporal |
| Policy release and deterministic decision | Workflow/Control boundary |
| Agent proposal | Agent Runtime output persisted as workflow input/evidence |
| Knowledge source and release | Control/Knowledge boundary and OpenSearch publication |
| Integration idempotency and provider events | Integration Gateway PostgreSQL |
| Human case, audit, and decision delivery | Human Operations PostgreSQL |

No derived store replaces the provider source of truth. `factsVersion` is a hash
of normalized relevant facts used for change detection, not proof of execution.

## Interfaces and contracts

Canonical schemas live under `contracts/`. Important contracts include:

- trusted tenant context and assertion claims;
- order context and refund context;
- refund proposal;
- refund policy input and policy decision;
- execution evidence;
- refund workflow and provider lifecycle messages.

External effects are behind injected clients or repositories. Python and
TypeScript do not maintain unrelated handwritten versions of the same boundary
without a canonical schema and compatibility tests.

## Observability and evaluation

Current code records version evidence and structured service outcomes, and the RAG
service includes focused retrieval and answer evaluation components. Full
production observability is not implemented.

Planned observability:

- OpenTelemetry trace propagation across browser BFF, Edge, Agent, RAG, Temporal,
  Human Operations, Gateway, and provider adapters;
- CloudWatch logs, metrics, dashboards, and alarms in AWS;
- business metrics for completion, escalation, approval, failure, reconciliation,
  latency, token usage, and cost;
- audit projections with sensitive-data controls.

Planned evaluation includes retrieval recall and rank metrics, reranker quality,
answer grounding and citation correctness, specialist and supervisor routing,
tool selection, trajectory, deterministic policy regression, guardrail/safety,
human handoff, adversarial cases, and release gates.

## Initial AWS target

Status: planned, not implemented.

The first deployment target is a single AWS region:

- CloudFront and an application load balancer for web/API entry;
- ECS Fargate for web and service containers;
- Amazon RDS for PostgreSQL;
- Amazon OpenSearch Service;
- Amazon MSK or another explicitly approved Kafka deployment when event delivery is
  introduced;
- Cognito for customer and staff authentication;
- Secrets Manager and KMS;
- CloudWatch plus OpenTelemetry;
- S3 for source documents and build artifacts;
- a managed or carefully operated Temporal deployment decision made separately.

EKS, Helm, Argo CD, multi-region active-active, and very large scale are future
options, not claims about the current repository.

## Current verification and remaining work

Implemented and substantially exercised locally:

- customer conversation and refund intake;
- typed agent proposal and grounded customer answer;
- OpenSearch ingestion, hybrid retrieval, reranking, citations, and evaluation;
- read-only MCP order lookup;
- deterministic policy and Temporal workflow;
- PostgreSQL Human Operations and exceptional refund plan;
- authorized idempotent Vendure refund path;
- signed provider outcome, processing, and reconciliation;
- customer and operations browser projections.

Still pending:

- one final positive browser-to-provider proof on a fresh disposable order;
- reproducible Vendure/OpenSearch bootstrap and one-command stack startup;
- broad browser end-to-end coverage;
- centralized Model Gateway;
- Kafka/MSK event delivery;
- OpenTelemetry/CloudWatch;
- production Cognito identity and AWS infrastructure;
- Admin Control Plane release workflows;
- real-phone voice implementation.

The authoritative checklist is `docs/VERIFICATION_STATUS.md`.
