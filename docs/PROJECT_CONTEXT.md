# Customer Service OS Lite: Project Context and Contributor Handoff

Last updated: 2026-08-27
Repository: <https://github.com/chaitanya-y/customer-service-OS-lite>
Active implementation branch: `main`

## 1. Why this file exists

This is the portable context for engineers or AI coding agents joining the project.
Read it before changing code. It records:

- the product goal and first end-to-end journey;
- the accepted architecture and safety boundaries;
- what has already been implemented;
- what is committed versus only present in the owner's local working tree;
- how to install, run, and test the current components;
- the next recommended implementation steps;
- the working agreements for making changes.

No credentials or `.env` values belong in this file or in Git.

## 2. Product goal

Customer Service OS Lite is a resume-quality, production-shaped customer-service
platform. The learning goal is to build one complex customer journey end to end,
understand every major concept, test it locally, and then deploy a single-region
version to AWS.

The first journey is a refund journey. It is intentionally selected because it
crosses the important system boundaries:

- customer conversation;
- LangGraph orchestration and bounded specialists;
- RAG with citations;
- read-only MCP tools;
- a real commerce integration through local Vendure;
- deterministic policy and policy versions;
- Temporal durable workflow;
- Kafka events;
- customer confirmation;
- human approval and handoff;
- audit evidence, observability, and evaluation;
- frontend and backend APIs.

The immediate objective is not large-scale infrastructure. It is one correct,
traceable, locally testable journey. AWS comes after the local vertical slice and
will initially be single-region.

## 3. Principal architecture decisions

The accepted decision record is:

- `docs/adr/ADR-001-polyglot-runtime-and-mcp-boundaries.md`

The repository uses seven release and ownership boundaries. A boundary may contain
more than one logical application, and multiple boundaries may initially be
deployed together to keep the first version practical.

| Release boundary | Language | Responsibility |
|---|---|---|
| Edge/API | React + TypeScript and Node.js + TypeScript | Customer UI, authentication, trusted tenant context, validation, rate limiting, routing, SSE |
| Conversation Runtime | Node.js + TypeScript | Conversations, messages, ordering, persistence, projections, and event delivery |
| Agent Runtime | Python | LangGraph, bounded specialists, context construction, online retrieval orchestration, model orchestration, grounding, and typed proposals |
| Workflow Workers | Node.js + TypeScript | Temporal workflow, deterministic policy, preview, confirmation, approval, retries, and reconciliation |
| Integration Gateway | Node.js + TypeScript | Commerce connectors, MCP servers, authorization, idempotency, action safety, and audit |
| Human Operations | React + TypeScript and Node.js + TypeScript | Escalation queues, approvals, takeover, review, and release-back |
| Control and Knowledge | React + TypeScript, Node.js + TypeScript, and Python | Admin, tenant config, prompt/model/policy/knowledge releases, ingestion, index publication, evaluations, and red-team datasets |

The three browser surfaces are:

- `apps/web/customer-portal`
- `apps/web/operations-console`
- `apps/web/admin-console`

### Refund journey data flow

```mermaid
flowchart TD
    UI["Customer Chat UI"] --> EDGE["Edge API"]
    EDGE --> CONV["Conversation Runtime\nencrypted transcript"]
    EDGE --> AGENT["Python LangGraph Agent Runtime"]
    AGENT --> RAG["Retrieval Gateway / OpenSearch evidence"]
    CONTROL["Control and Knowledge"] -->|"published knowledge release"| RAG
    AGENT -->|"read-only lookup_order"| MCP["Node Integration Gateway MCP server"]
    MCP --> VENDURE["Vendure commerce system"]
    AGENT -->|"typed RefundProposal only"| WF["Temporal Workflow + Policy"]
    WF -->|"preview and exact confirmation"| CONV
    WF -->|"approval when required"| HUMAN["Human Operations"]
    WF -->|"narrow authorized activity"| GATEWAY["Integration Gateway"]
    GATEWAY -->|"idempotent refund request"| PROVIDER["Refund provider"]
    WF --> AUDIT["Gateway and Human Operations audit evidence"]
```

## 4. Non-negotiable safety and governance rules

1. The LLM never decides authorization, identity, or refund eligibility.
2. Agent-accessible MCP tools are read-only.
3. The refund write operation is never exposed to the Agent Runtime.
4. The Agent Runtime returns a schema-validated `RefundProposal`; it does not
   execute a refund.
5. Workflow Workers re-read authoritative commerce facts before a consequential
   action.
6. Eligibility and approval are deterministic, versioned policy decisions.
7. The canonical preview, applicable policy version, and exact customer
   confirmation are bound together. Material changes require a new preview and
   confirmation.
8. An authorized Temporal activity calls the Integration Gateway with a narrow,
   opaque, expiring action capability.
9. Refund execution is idempotent. Ambiguous provider outcomes go to
   reconciliation or human review; they are never reported as successful.
10. Trusted tenant context is created and signed by the trusted edge, not supplied
    or altered by the model.
11. Each applicable turn/action records `ExecutionEvidence`: prompt, knowledge,
    model route, policy, tool contract, workflow, and evaluation versions.
12. Cross-language boundaries are schema-first. Do not create competing handwritten
    Python and TypeScript contract definitions without a canonical schema.
13. Sensitive commerce data is projected down to the minimum data required by the
    agent. Customer name, email, and payment transaction reference are currently
    removed from the order context.

## 5. Important concepts already introduced

### Trusted tenant context

`TenantContext` identifies the tenant, actor, scopes, conversation, region, and
correlation data for a request. It is trusted metadata carried between services.
It must be signed or otherwise integrity-protected by the edge. The model may read
an allowed projection, but it cannot create or modify the authoritative context.

Canonical contract:

- `contracts/internal-api/proto/customer_service_os/context/v1/trusted_tenant_context.proto`
- `contracts/internal-api/trusted-context-assertion/v1/context-assertion-claims.schema.json`

The Edge API authenticates a local customer token, derives the trusted customer
identity from that token, and creates three separate short-lived assertions from
that one trusted identity:

- `x-cso-context-assertion` is for the Integration Gateway only;
- `x-cso-agent-context-assertion` is for the Agent Runtime only;
- `x-cso-knowledge-context-assertion` is for the Knowledge/RAG service only.

Each receiving service verifies signature, issuer, audience, tenant, lifetime,
purpose, and self-service customer binding before using the assertion. The Agent
Runtime verifies its own assertion, forwards the Gateway assertion only to the
read-only MCP order lookup client, and forwards the RAG assertion only to the
customer-evidence client. Assertions never enter LangGraph state or model input.
The customer cannot supply or override the trusted tenant or customer identity in
the refund request body.

### Order context

The Integration Gateway converts a provider-specific Vendure order into a small,
provider-neutral `OrderContext`. The agent therefore does not depend on Vendure's
GraphQL response shape.

Canonical contract:

- `contracts/tools/order-context/v1/order-context.schema.json`

### `factsVersion`

`factsVersion` is a SHA-256 fingerprint of the normalized authoritative order
facts. It is not a second database and does not prove that a refund occurred. It
allows the workflow to detect that eligibility-relevant facts changed between
proposal, preview, confirmation, and execution.

The provider remains the source of truth. After a write, the system must query the
provider to confirm the outcome.

### Execution evidence

Execution evidence records exactly which behavior and data releases affected a
turn or action. It makes incidents and evaluations reproducible and supports
governance without putting business decisions inside the LLM.

Canonical contract:

- `contracts/ai-io/execution-evidence/v1/execution-evidence.schema.json`

## 6. Repository map

```text
contracts/
  ai-io/                 AI inputs/outputs and execution evidence
  internal-api/          trusted internal protobuf contracts
  tools/                 MCP/tool contracts
  workflows/             proposal and policy decision contracts
apps/
  services/
    agent-runtime/       Python FastAPI + LangGraph
    control-knowledge/   control-plane contracts and source-document fixtures
    conversation-runtime/ Node/Fastify conversation service and outbox
    edge-api/            Node/Fastify customer auth, context signing, routing
    human-operations/    staff authorization and Temporal decision API
    integration-gateway/ Node/Fastify Vendure adapter, REST projection, MCP server
    knowledge-rag/       Python ingestion, retrieval, reranking, and RAG evaluation
    workflow-workers/    deterministic refund policy and Temporal workflow foundation
    telephony-gateway/   future phone-provider boundary; no implementation yet
    voice-runtime/       future speech orchestration; no implementation yet
    voice-evaluation/    future call-quality evaluation; no implementation yet
  web/
    customer-portal/     Next.js customer BFF and refund journey UI
    operations-console/  Next.js Human Operations BFF and case-review UI
    admin-console/       Next.js administration UI shell
tests/contract/          cross-boundary JSON contract tests
tools/simulators/
  commerce-sandbox/      local Vendure commerce system
docs/adr/                architecture decisions
infrastructure/          future local/AWS infrastructure
```

Some directories remain intentional architecture boundaries rather than completed
services. Check the implementation-status sections below instead of inferring
completion from a directory name.

## 7. What is implemented

### Canonical contracts

The repository contains schemas for:

- trusted tenant context;
- trusted context assertion claims;
- execution evidence;
- provider-neutral order context;
- refund proposal;
- provider-neutral refund context;
- refund policy input;
- policy decision.

The root test suite validates JSON examples and lints the protobuf contract.

### Integration Gateway: committed and pushed

The Node.js/TypeScript Integration Gateway contains:

- a Vendure Admin GraphQL client;
- a provider-neutral `CommerceOrder`;
- the safe `OrderContext` projection;
- the trusted `RefundContext` projection for Workflow Workers;
- a `getOrderContext` use case;
- a `getRefundContext` use case;
- `GET /v1/orders/:orderReference`;
- `POST /internal/v1/refund-contexts`, protected by trusted context and not
  exposed as an MCP tool;
- a stateless MCP Streamable HTTP endpoint at `POST /mcp`;
- the read-only MCP tool `lookup_order`;
- validation and stable error responses;
- unit/integration tests.

It also contains the protected refund action boundary:

- `POST /internal/v1/refunds`, available only to a Worker assertion with the
  `refund_execute` purpose;
- `POST /internal/v1/refund-reconciliations`, a read-only recovery lookup with
  the separate `refund_reconcile` purpose;
- `POST /internal/v1/provider-refund-events`, a signed provider adapter endpoint
  that records replay-safe terminal outcomes before they are delivered to Temporal;
- a Vendure `refundOrder` adapter, which the Agent Runtime cannot access;
- PostgreSQL-backed idempotency and append-only refund audit events;
- a migration runner and the limited `cso_integration_app` database role.

The unique database key is `(tenant_id, environment_id, idempotency_key)`. A
Gateway restart or a second Gateway instance therefore returns the already stored
result rather than issuing a second refund. Execution state and its matching audit
event are written in the same database transaction.

The MCP tool accepts only `orderReference`. Its annotations declare that it is
read-only, non-destructive, idempotent, and open-world.

### Agent Runtime: committed and pushed Refund Proposal slice

The Python Agent Runtime contains:

- strict Pydantic models for `OrderContext`;
- an `OrderLookup` protocol;
- an asynchronous `McpOrderLookupClient`;
- stable mappings for not found, provider unavailable, and invalid tool output;
- dependency injection through `build_refund_graph(...)`;
- an async LangGraph `lookup_order` node;
- a structured-output LangChain refund-intent specialist;
- deterministic construction of the canonical `RefundProposal`;
- authoritative validation of model-selected item IDs against `OrderContext`;
- verification of its audience-specific Edge assertion before a refund graph runs;
- a typed client for the Knowledge/RAG customer-evidence API;
- a retrieval node after intent extraction that supplies customer-safe evidence to
  the graph but does not make a policy decision;
- a grounded answer composer that can cite only chunks returned by that retrieval;
- a separately configured answer-model deadline, defaulting to 30 seconds through
  `REFUND_ANSWER_MODEL_TIMEOUT_SECONDS`, with no automatic retry on the
  synchronous customer turn;
- safe fallback customer answers when retrieval or answer generation is unavailable;
- execution evidence containing honest prompt, model-route, knowledge, guardrail,
  evaluation, and tool-contract versions;
- refund graph statuses:
  - `awaiting_order_reference`
  - `awaiting_refund_details`
  - `refund_proposal_ready`
  - `intent_extraction_unavailable`
  - `order_not_found`
  - `order_lookup_unavailable`
- fake-client and fake-model tests for graph behavior;
- canonical JSON Schema compatibility tests;
- API and MCP client tests.

Its tests do not call a paid model. A real OpenAI call still requires local
configuration and explicit approval.

### Knowledge/RAG: committed and pushed retrieval foundation and online evidence API

`apps/services/knowledge-rag` contains the Python knowledge workload. It currently
implements the retrieval path and the online customer-evidence boundary used by
the Agent Runtime.

- parsers for Markdown, HTML, PDF, DOCX, and text source documents;
- structure-aware parent/child chunking with stable local chunk IDs;
- trusted source registration and immutable knowledge-release manifests;
- SHA-256 validation of each registered source before ingestion;
- OpenAI `text-embedding-3-small` embeddings with 1,536 dimensions;
- OpenSearch index mappings, HNSW vector search, and metadata filters;
- hybrid semantic-vector and lexical-keyword retrieval, fused with reciprocal
  rank fusion (RRF);
- a local `cross-encoder/ms-marco-MiniLM-L6-v2` reranker;
- citation-ready evidence containing `knowledge_document_id`, `chunk_id`, and
  globally unique `index_document_id`;
- document-scoped retrieval evaluation metrics and governed safety datasets;
- release compilation before publication, so a failed source or embedding step
  does not partially publish a release.
- `POST /v1/customer-evidence`, which accepts only `query_text` plus the
  audience-specific trusted assertion;
- service-owned selection of tenant, environment, active knowledge release, locale,
  effective time, index, and `CUSTOMER_SAFE` classification;
- rejection of invalid or misdirected assertions before retrieval.

The customer-evidence API deliberately does not accept tenant IDs, release IDs,
classification filters, or OpenSearch index names from the client. This keeps
internal documents and another tenant's documents outside the customer request
surface.

The first local knowledge release contains three synthetic documents for tenant
`acme` and environment `local`:

| Document | Classification | Effective period |
|---|---|---|
| Current refund policy | `CUSTOMER_SAFE` | From 2026-08-01 |
| Internal escalation playbook | `INTERNAL` | From 2026-08-01 |
| Superseded refund policy | `CUSTOMER_SAFE` | 2026-07-01 to 2026-08-01 |

Metadata filtering is mandatory for tenant, environment, knowledge release,
classification, locale, and effective dates. A customer-safe request cannot
retrieve internal evidence. A historical July request can retrieve the superseded
policy, while an August request cannot.

The active local runtime configuration uses tenant `tenant-local`, release
`refund-policy-2026-08-01`, and index
`cso-knowledge-tenant-local-local-v1`. That published index contains 18 chunks,
including both customer-safe and internal material. The online customer-evidence
API always filters the latter out; the `acme` corpus above remains a separate
learning and retrieval-evaluation fixture.

The real local governed evaluation ran against the OpenSearch index containing 18
indexed chunks
using five synthetic questions, OpenAI query embeddings, hybrid retrieval, and the
local cross-encoder. It produced Recall@3 `1.0`, MRR `1.0`, and a forbidden-evidence
rate of `0.0`. This is a small learning corpus, not sufficient evidence of
production retrieval quality on a large real corpus.

Local RAG tests do not make paid API calls. A real evaluation or release
compilation with `OpenAIEmbeddingProvider` does, so it requires explicit approval
and a local `OPENAI_API_KEY`.

### Conversation Runtime: committed and pushed

The Node.js/TypeScript Conversation Runtime contains:

- customer-scoped conversation creation, message acceptance, and ordered
  transcript-read APIs;
- an Edge-only assistant-message commit API guarded by a distinct short-lived
  service assertion, not by customer context;
- encrypted customer and assistant message persistence with AES-256-GCM;
- idempotent mutation handling;
- PostgreSQL migrations for conversation records and the transactional outbox;
- customer-message and assistant-message outbox events;
- trusted context verification and tenant/customer scoping;
- unit and route tests.

The database-backed persistence integration test requires
`CONVERSATION_TEST_DATABASE_URL`; it is skipped when that local test database is
not configured.

### Workflow Workers: deterministic refund policy, execution, and recovery

The Node.js/TypeScript Workflow Workers package contains:

- the immutable `refund-policy-v1` release;
- deterministic `evaluateRefundPolicy(...)` decisions: `ALLOW`,
  `APPROVAL_REQUIRED`, `TAKEOVER_REQUIRED`, `DENY`, and `NEEDS_FACTS`;
- proposal and trusted-refund-context binding through
  `createRefundPolicyInput(...)`;
- deterministic risk assessment from trusted completed prior-refund counts:
  zero is low risk, one is elevated risk, and two or more require takeover;
- SHA-256 policy-input evidence and stable fact references;
- policy boundary tests for amounts, currencies, reasons, approval, takeover,
  missing facts, and mismatched trusted facts.
- a Temporal `refundWorkflow(...)` that refreshes facts, requests a policy
  decision, exposes durable state, and waits for an exact customer-confirmation
  signal when policy allows a refund;
- activity contracts that keep Gateway I/O and deterministic policy evaluation
  outside the Temporal workflow sandbox;
- a short-lived, Worker-only assertion for Gateway fact refreshes; it carries
  tenant, customer, workflow, request, and trace identifiers but no customer
  credential;
- a Gateway client that validates returned refund facts before policy evaluation;
- a canonical preview bound to the policy decision, trusted facts, and exact
  customer confirmation;
- `refund.human-decision` signals for approve, reject, and takeover resolution;
- a narrow authorized refund activity, which refreshes facts immediately before
  execution;
- a `REFUND_PROCESSING` state after a provider accepts a refund, before final
  settlement is known;
- `refund.provider-outcome` signals for signed provider completion or failure
  events, with Gateway persistence and delivery retry before the signal;
- durable reconciliation every five minutes after an ambiguous or pending provider
  outcome;
- `continueAsNew()` after 288 reconciliation checks, roughly one day, to bound
  Temporal workflow history while recovery continues;
- local Temporal integration tests covering confirmation, denial, and approval.

The workflow never retries an uncertain provider write. A provider acceptance first
becomes `REFUND_PROCESSING`, not success. A signed provider event or authoritative
Vendure reconciliation can move it to `REFUND_SUCCEEDED` or `REFUND_FAILED`.
Otherwise it remains in processing or reconciliation and retries safely.

### Human Operations: local functional slice

The Node.js/TypeScript Human Operations service now owns a local refund review
case lifecycle:

- separate signed assertions for staff access and Worker-only case operations;
- role-based case visibility and decisions: `REFUND_APPROVER` can approve or
  reject approval cases, while `REFUND_SUPERVISOR` can resolve or reject takeover
  cases;
- Worker-only case open and close endpoints, plus staff list, read, claim,
  reassign, and decision endpoints;
- optimistic case-version checks and idempotency keys for staff mutations;
- minimized review packets containing proposal, policy, preview, and evidence IDs,
  but not raw customer messages or payment credentials;
- append-only local audit events for case opening, claim, decision, and close;
- a decision outbox record. It is delivered directly to Temporal in the local
  slice and is retained for a future durable Kafka/outbox dispatcher if delivery
  fails;
- Temporal signals for `APPROVE`, `REJECT`, and `RESOLVE_TAKEOVER` decisions;
- tests for authentication, tenant/role permissions, spoofed identity,
  idempotency, stale case versions, and valid decisions.

`InMemoryHumanCaseRepository` is deliberately the current local adapter. A Human
Operations restart clears all cases and audit history. A transactional PostgreSQL
repository and durable outbox dispatcher are required before deployment.

### Edge API: committed and pushed

The Node.js/TypeScript Edge API contains:

- `POST /v1/refunds/intake` on port `3000`;
- conversation create, read, and chat-turn routes on `/v1/conversations`;
- chat-turn orchestration that persists the customer message, calls the Agent
  Runtime, commits only the safe customer answer, and starts a workflow only for
  a ready refund proposal;
- strict customer-supplied refund input validation;
- signed local customer tokens for development only;
- server-derived tenant, environment, and customer identity;
- a separate, short-lived trusted context assertion for internal calls;
- a separately keyed Edge-only service assertion for Conversation Runtime
  assistant-message commits;
- forwarding to the Agent Runtime without exposing the customer token;
- stable authentication and downstream-failure responses;
- starts the Temporal refund workflow after a schema-valid proposal, and exposes
  customer-owned workflow read and exact-preview confirmation routes;
- startup guards that reject local authentication in production and reject key
  reuse between customer tokens and internal assertions;
- unit, route, client, and Edge-to-Gateway compatibility tests.

The committed Edge-to-Agent-Runtime path uses audience-separated assertions:

- Edge API creates three short-lived assertions from the same authenticated customer
  identity, request ID, and trace ID;
- `x-cso-agent-context-assertion` is intended only for Agent Runtime, with
  audience `agent-runtime`;
- `x-cso-context-assertion` remains intended only for Integration Gateway, with
  audience `integration-gateway`;
- `x-cso-knowledge-context-assertion` is intended only for Knowledge/RAG, with
  audience `knowledge-rag`;
- Agent Runtime receives all three headers, verifies its own header, forwards the
  Gateway header only to the MCP order lookup client, and forwards the RAG header
  only to the customer-evidence API.

Audience verification prevents a token issued for the Integration Gateway from
being accepted as an Agent Runtime authorization token. The current local design
uses one shared HMAC secret for both verifiers, so it does not isolate services if
one verifier is compromised. Before deployment, use separate per-audience signing
keys or Edge-held asymmetric signing keys with service-specific public verifiers.
The production AWS authentication adapter is not implemented yet. It will replace
the local token verifier with Cognito while preserving the route, identity,
assertion, and downstream client interfaces.

### Browser surfaces: customer and human review are implemented locally

The repository contains three Next.js applications that share `@cso/ui` theme
tokens and `@cso/auth` local-session helpers.

- `apps/web/customer-portal` runs on port `3100`. It creates a development-only
  HTTP-only session cookie, submits an authenticated refund request through
  same-origin BFF routes, renders customer-safe workflow status, displays an
  exact preview, and sends customer confirmation or decline.
- `apps/web/operations-console` runs on port `3101`. It creates a local staff
  session, shows a filtered refund case queue, renders the review packet and
  audit trail, and submits idempotent claim and decision mutations through its
  same-origin BFF routes.
- `apps/web/admin-console` runs on port `3102`. It currently provides the shared
  theme and visual shell only. Release-management screens are not implemented.

Customer and operations BFFs accept only their own local development origin for
mutations. They proxy to Edge API or Human Operations respectively, so browser
code never calls Temporal, Vendure, OpenSearch, MCP, or service assertions
directly. The initial journey page refreshes after a customer confirmation; SSE
and polling after an external human decision remain future work.

## 8. Current Git state

The repository workflow is:

- implementation branch: `dev`
- release branch: `main`
- remote: `origin`
- remote URL: `https://github.com/chaitanya-y/customer-service-OS-lite.git`
- branch workflow: implement and test on `dev`, then merge verified changes to
  `main`;
- `dev` is the implementation branch. Build and test a change here before moving
  it to `main`.
- `main` is the verified release branch. Do not assume it contains unmerged `dev`
  work; check `git log main..dev` before describing the release state.
- The current local slice includes the customer browser journey, Human Operations
  browser journey, Temporal workflow, and Vendure simulator integration.

## 9. Prerequisites

Use these major versions:

- Git
- Node.js 24.x
- pnpm 11.9.0
- Python 3.12.x
- `uv`
- Docker Desktop
- Temporal CLI or a local Temporal server
- a local OpenSearch instance for the Knowledge/RAG service

Node 20.11 previously failed while starting the Vendure/Vite development stack.
Use Node 24 for this repository.

Current macOS Apple Silicon workaround: if the Temporal Worker fails under Node
24 with `RangeError: Invalid atomic access index`, run only
`apps/services/workflow-workers` under Node `22.21.0`. This is a local Temporal
Worker compatibility issue, not the intended repository or deployment version.

The Agent Runtime currently constrains Python to `>=3.12,<3.13`.

## 10. Clone and install

```bash
git clone https://github.com/chaitanya-y/customer-service-OS-lite.git
cd customer-service-OS-lite
git switch dev
```

Install the root Node workspace:

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
```

If Corepack is unavailable, install the pinned pnpm version using the normal
package-management policy for your machine.

Install the Vendure simulator separately because `tools/simulators` is not part of
the root pnpm workspace:

```bash
cd tools/simulators/commerce-sandbox
pnpm install
cd ../../..
```

Install the Python Agent Runtime:

```bash
cd apps/services/agent-runtime
uv sync --dev
cd ../knowledge-rag
uv sync --dev
cd ../..
```

## 11. Local environment files

`.env` files are intentionally ignored. Create them locally and exchange real
credentials only through an approved secret channel.

`tools/simulators/commerce-sandbox/.env` needs:

```dotenv
APP_ENV=dev
PORT=3001
COOKIE_SECRET=<local-random-secret>
SUPERADMIN_USERNAME=<local-admin-username>
SUPERADMIN_PASSWORD=<local-admin-password>
```

`apps/services/integration-gateway/.env` needs:

```dotenv
PORT=3002
DATABASE_URL=postgresql://cso_integration_app:cso_integration_local@127.0.0.1:5432/customer_service_os
MIGRATION_DATABASE_URL=postgresql://cso_local:cso_local@127.0.0.1:5432/customer_service_os
VENDURE_ADMIN_API_URL=http://127.0.0.1:3001/admin-api
VENDURE_API_KEY=<api-key-created-in-vendure>
TENANT_ID=tenant-local
ENVIRONMENT_ID=local
CONTEXT_ASSERTION_HMAC_SECRET=<generate-at-least-32-random-bytes>
CONTEXT_ASSERTION_ISSUER=customer-service-os-edge
WORKFLOW_ACCESS_HMAC_SECRET=<a-different-at-least-32-byte-random-secret>
WORKFLOW_ACCESS_ISSUER=customer-service-os-workflow-workers
```

`apps/services/edge-api/.env` needs:

```dotenv
NODE_ENV=development
AUTH_MODE=local
HOST=127.0.0.1
PORT=3000
AGENT_RUNTIME_BASE_URL=http://127.0.0.1:8000
AGENT_RUNTIME_TIMEOUT_MILLISECONDS=60000
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_TASK_QUEUE=refund-workflows
TENANT_ID=tenant-local
ENVIRONMENT_ID=local
LOCAL_AUTH_HMAC_SECRET=<a-separate-at-least-32-byte-random-secret>
LOCAL_AUTH_ISSUER=customer-service-os-local-auth
LOCAL_AUTH_AUDIENCE=customer-service-os-edge
LOCAL_CUSTOMER_ID=<vendure-customer-id-for-the-test-order>
CONTEXT_ASSERTION_HMAC_SECRET=<same-secret-as-integration-gateway>
CONTEXT_ASSERTION_ISSUER=customer-service-os-edge
CONTEXT_ASSERTION_AUDIENCE=integration-gateway
AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE=agent-runtime
KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE=knowledge-rag
```

`apps/services/workflow-workers/.env` needs:

```dotenv
TEMPORAL_ADDRESS=127.0.0.1:7233
TEMPORAL_TASK_QUEUE=refund-workflows
INTEGRATION_GATEWAY_BASE_URL=http://127.0.0.1:3002
HUMAN_OPERATIONS_BASE_URL=http://127.0.0.1:3003
TENANT_ID=tenant-local
ENVIRONMENT_ID=local
WORKFLOW_ACCESS_HMAC_SECRET=<same-secret-as-integration-gateway>
WORKFLOW_ACCESS_ISSUER=customer-service-os-workflow-workers
HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET=<a-different-at-least-32-byte-secret>
HUMAN_OPERATIONS_WORKFLOW_ISSUER=customer-service-os-workflow-workers
```

`apps/services/human-operations/.env` needs:

```dotenv
HOST=127.0.0.1
PORT=3003
TEMPORAL_ADDRESS=127.0.0.1:7233
TENANT_ID=tenant-local
ENVIRONMENT_ID=local
HUMAN_ACCESS_HMAC_SECRET=<a-unique-at-least-32-byte-secret>
HUMAN_ACCESS_ISSUER=customer-service-os-human-operations
HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET=<same-secret-as-workflow-workers>
HUMAN_OPERATIONS_WORKFLOW_ISSUER=customer-service-os-workflow-workers
LOCAL_HUMAN_STAFF_ID=local-refund-supervisor
LOCAL_HUMAN_ROLE=REFUND_SUPERVISOR
```

`apps/services/agent-runtime/.env` needs these values before a real model-backed
refund extraction and grounded customer answer:

```dotenv
OPENAI_API_KEY=<create-an-openai-api-key>
REFUND_INTENT_MODEL=<approved-openai-model>
REFUND_ANSWER_MODEL=<approved-openai-model>
REFUND_ANSWER_MODEL_TIMEOUT_SECONDS=30
TENANT_ID=tenant-local
ENVIRONMENT_ID=local
CONTEXT_ASSERTION_HMAC_SECRET=<same-secret-as-edge-api-and-knowledge-rag>
CONTEXT_ASSERTION_ISSUER=customer-service-os-edge
AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE=agent-runtime
KNOWLEDGE_RAG_BASE_URL=http://127.0.0.1:8001
KNOWLEDGE_RAG_TIMEOUT_SECONDS=10
AGENT_RELEASE_ID=agent-runtime-0.1.0
MODEL_ROUTE_ID=refund-intent-openai-v1
KNOWLEDGE_RELEASE_ID=refund-policy-2026-08-01
GUARDRAIL_VERSION=refund-proposal-guardrails-v1
EVALUATION_VERSION=evaluation-not-released
ORDER_LOOKUP_TOOL_VERSION=lookup-order-v1
```

`apps/services/knowledge-rag/.env` needs:

```dotenv
OPENAI_API_KEY=<create-an-openai-api-key>
TENANT_ID=tenant-local
ENVIRONMENT_ID=local
CONTEXT_ASSERTION_HMAC_SECRET=<same-secret-as-edge-api-and-agent-runtime>
CONTEXT_ASSERTION_ISSUER=customer-service-os-edge
KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE=knowledge-rag
KNOWLEDGE_RELEASE_ID=refund-policy-2026-08-01
KNOWLEDGE_INDEX_NAME=cso-knowledge-tenant-local-local-v1
```

For local development, the same context-assertion HMAC secret is used by Edge API,
Agent Runtime, Integration Gateway, and Knowledge/RAG. The assertions are still
separated by audience. Before AWS deployment, replace this local shared-secret
design with separate per-audience keys or Edge-held asymmetric signing keys.

Never commit these environment files.

The Customer Widget and Operations Console have their own `.env.example` files.
Populate them only with freshly generated local tokens. The complete token steps
are in [the local refund runbook](LOCAL_REFUND_RUNBOOK.md).

### Fresh-clone Vendure limitation

`tools/simulators/commerce-sandbox/vendure.sqlite` is ignored, as it should be, and
the current repository does not yet include a committed initial migration and seed
workflow. Therefore:

- a fresh clone does not contain the owner's products, customers, API key, or test
  orders;
- the sample order reference in this document will not exist in another clone;
- local unit and contract tests can still run;
- reproducible Vendure bootstrap is a known onboarding task that should be added
  before claiming one-command end-to-end setup.

Until that task is completed, a collaborator must initialize their own Vendure
database, create an API key with the necessary read permissions, and create/fulfill
a local order through the Vendure Dashboard.

## 12. Start the local stack

Use separate terminals and start dependencies from the bottom up. The canonical
current instructions, including local token creation and the browser test, are in
[the local refund runbook](LOCAL_REFUND_RUNBOOK.md). The commands below remain a
service reference.

The Knowledge/RAG service expects a local OpenSearch instance on port `9200` and
the configured release index to be published before it can serve evidence. The
repository does not yet provide one-command OpenSearch orchestration.

### Terminal 0: Temporal

```bash
temporal server start-dev
```

Temporal serves gRPC on `127.0.0.1:7233` and the local UI on
`http://127.0.0.1:8233`.

### Terminal 1: PostgreSQL

```bash
docker compose -f infrastructure/local/compose.yaml up -d postgres
cd apps/services/integration-gateway
pnpm migrate
```

The migration command uses `MIGRATION_DATABASE_URL`. The running Gateway uses
the restricted `DATABASE_URL` account. For an existing local database created
before this repository version, create the local `cso_integration_app` role from
`infrastructure/local/postgres/001_roles.sql` once before running the migration.

### Terminal 2: Vendure

```bash
cd tools/simulators/commerce-sandbox
pnpm dev
```

Expected local URLs:

- Vendure health: `http://127.0.0.1:3001/health`
- Shop API: `http://127.0.0.1:3001/shop-api`
- Admin API: `http://127.0.0.1:3001/admin-api`
- Dashboard route: `http://127.0.0.1:3001/dashboard`
- Vite Dashboard during development: `http://127.0.0.1:5173/dashboard`

The Vendure worker does not expose an HTTP port.

### Terminal 3: Integration Gateway

```bash
cd apps/services/integration-gateway
pnpm dev
```

Expected URLs:

- health: `http://127.0.0.1:3002/health`
- safe order REST projection:
  `http://127.0.0.1:3002/v1/orders/<ORDER_REFERENCE>`
- MCP Streamable HTTP endpoint: `http://127.0.0.1:3002/mcp`

### Terminal 4: Knowledge/RAG

```bash
cd apps/services/knowledge-rag
uv run uvicorn knowledge_rag.main:app --reload --host 127.0.0.1 --port 8001
```

Expected URLs:

- health: `http://127.0.0.1:8001/health`
- internal customer evidence: `POST http://127.0.0.1:8001/v1/customer-evidence`

The customer-evidence endpoint requires the RAG-specific trusted assertion from
the Edge API. Do not call it from a browser or customer client.

### Terminal 5: Agent Runtime

```bash
cd apps/services/agent-runtime
uv run uvicorn agent_runtime.main:app --reload --host 127.0.0.1 --port 8000
```

Expected URLs:

- health: `http://127.0.0.1:8000/health`
- refund intake: `POST http://127.0.0.1:8000/refunds/intake`

The refund intake endpoint is an internal endpoint and requires the trusted
context assertion created by the Edge API. Do not call it directly from a browser
or customer client.

### Terminal 6: Human Operations

```bash
cd apps/services/human-operations
pnpm dev
```

Expected URL:

- health: `http://127.0.0.1:3003/health`

### Terminal 7: Workflow Workers

```bash
cd apps/services/workflow-workers
pnpm dev
```

Workflow Workers do not expose an HTTP endpoint. Verify their registration in
Temporal UI and keep this process running before submitting a customer request.

### Terminal 8: Edge API

```bash
cd apps/services/edge-api
pnpm dev
```

Expected URLs:

- health: `http://127.0.0.1:3000/health`
- customer refund intake: `POST http://127.0.0.1:3000/v1/refunds/intake`

Generate a local customer access token, valid for at most 48 hours:

```bash
pnpm local:token
```

Copy the printed token, then call the customer-facing endpoint:

```bash
curl -sS http://127.0.0.1:3000/v1/refunds/intake \
  -H 'authorization: Bearer <PASTE_LOCAL_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{
    "customer_message": "Refund my full order because the items are damaged",
    "order_reference": "<ORDER_REFERENCE>"
  }'
```

Expected graph status for a complete model extraction is `refund_proposal_ready`.
Incomplete reason, scope, or item information produces `awaiting_refund_details`.

### Terminals 9 and 10: Browser surfaces

Generate fresh local tokens, save them to the two browser `.env` files, then start
the applications from the repository root:

```bash
cd apps/services/edge-api
pnpm --silent local:token

cd ../human-operations
pnpm --silent local:token

cd ../..
pnpm dev:customer
pnpm dev:operations
```

The Customer Widget runs at `http://127.0.0.1:3100/sign-in` and the Operations
Console at `http://127.0.0.1:3101/sign-in`. The Admin Console shell is started
separately with `pnpm dev:admin` on port `3102`.

## 13. Test commands

Run contract tests from the repository root:

```bash
pnpm check:contracts
```

`check:contracts` includes protobuf linting, so Buf must be available in the root
workspace before this command can pass.

Run the Integration Gateway checks:

```bash
cd apps/services/integration-gateway
pnpm typecheck
pnpm test
```

These cover MCP order lookup, protected fact refresh, refund execution,
reconciliation, idempotency, and the Vendure adapter.

Run the Edge API checks:

```bash
cd apps/services/edge-api
pnpm typecheck
pnpm test
```

These cover local customer authentication, audience-specific assertions, agent
intake, workflow ownership, and exact-preview confirmation.

Run the Workflow Workers checks:

```bash
cd apps/services/workflow-workers
pnpm typecheck
pnpm test
```

These cover policy effects, Temporal confirmation and approval paths, human
takeover, execution, and reconciliation recovery.

Run the Human Operations checks:

```bash
cd apps/services/human-operations
pnpm typecheck
pnpm test
```

These cover staff and Worker assertions, roles, cases, audit records, idempotency,
and Temporal decision delivery.

Run the Agent Runtime checks:

```bash
cd apps/services/agent-runtime
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

The tests use fakes for model and tool behavior. They do not make a paid OpenAI
request.

Run the Knowledge/RAG checks:

```bash
cd apps/services/knowledge-rag
uv run ruff check .
uv run pytest
```

These tests use deterministic local embedding and reranking providers where
appropriate and do not call OpenAI.

Run the browser-surface checks from the repository root:

```bash
pnpm typecheck:frontend
pnpm build:frontend
```

The current surface work has type checking and production builds. Browser-level
end-to-end and accessibility suites are a follow-up hardening task.

Useful focused test commands:

```bash
# Python MCP client only
uv run pytest tests/test_order_lookup.py -v

# Python refund graph only
uv run pytest tests/test_refund_graph.py -v

# Python refund intent and proposal only
uv run pytest tests/test_refund_intent.py tests/test_refund_proposal.py -v

# Gateway MCP behavior only
cd ../integration-gateway
pnpm test -- tests/mcp.test.ts
```

## 14. Last real local end-to-end proof

The owner environment successfully exercised the safe browser takeover path:

```text
Customer Widget
  -> Edge API local customer authentication and signed context
  -> Agent Runtime, read-only MCP/Vendure order lookup, and customer-safe RAG
  -> Temporal facts refresh and deterministic takeover decision
  -> Human Operations case creation
  -> Operations Console claim and RESOLVE_TAKEOVER decision
  -> Temporal workflow close and customer-safe completion state
```

The order reference used during the owner test is intentionally documented only
in [the local runbook](LOCAL_REFUND_RUNBOOK.md), because it belongs to one local
Vendure database and is not portable seed data. The agent's safe commerce
projection excluded customer name, email, and payment transaction reference.

The safe takeover path does not submit a refund. The automatic and approval
execution paths have workflow and Gateway tests, and must be exercised only with a
disposable local Vendure order.

A separate isolated Agent Runtime integration check also verified the online
grounding path after the browser proof: Edge-signed context reached Knowledge/RAG,
OpenSearch returned three `CUSTOMER_SAFE` policy chunks, and the answer composer
returned citations only for those retrieved chunks. The check did not start a
Temporal workflow or execute a refund. It established that the prior generic
customer answer was caused by the 15-second answer-model deadline, not a RAG
retrieval failure. The default is now one bounded 30-second answer attempt.

## 15. What is not built yet

Do not mistake directory names or schemas for completed functionality. These major
parts remain:

- production customer authentication through Cognito;
- durable Human Operations storage, durable outbox delivery, and workforce
  delegation beyond the local role model;
- Edge streaming, rate limiting, and an Edge-owned customer journey projection;
- end to end browser coverage for live customer and staff updates;
- broader answer-grounding, citation, specialist, supervisor, tool-selection,
  trajectory, and guardrail evaluations;
- live model evaluation and release gating for the refund specialist;
- Kafka topics, event schemas, consumers, and outbox delivery;
- OpenTelemetry traces, metrics, logs, and audit projections;
- evaluation datasets, trajectory/tool/policy/safety evaluations, and gates;
- Admin Console release-management screens and control-plane publication APIs;
- reproducible Vendure migration/seed/bootstrap;
- one-command local orchestration for Temporal, OpenSearch, and the application
  stack;
- AWS single-region infrastructure and deployment;
- a real-phone voice channel. Its planned boundaries are documented in
  `docs/voice/VOICE_AGENT_BOUNDARY.md`; no voice implementation exists yet.

## 16. Recommended next sequence

The first local vertical slice is complete. The recommended hardening sequence is:

1. Make the local stack reproducible: commit a Vendure bootstrap/seed path and
   one-command dependency orchestration. A contributor should not need the owner's
   local database to run the browser test.
2. Add browser component, accessibility, and end-to-end tests for customer intake,
   confirmation, approval, takeover, and reconciliation status.
3. Persist Human Operations cases and its outbox transactionally, then introduce
   Kafka delivery for workflow and audit projections.
4. Add OpenTelemetry traces, metrics, structured logs, and the remaining governed
   evaluation suites before introducing more journeys.
5. Build the Control Plane and Admin Console release views, then replace local
   authentication with Cognito and deploy the single-region AWS slice.

Do not start by building every empty service. Extend the walking refund slice and
add a boundary only when the journey reaches it.

## 17. Working agreement for contributors and coding agents

Before writing application code:

1. Read this file and the accepted ADR.
2. Inspect the relevant canonical schema and existing tests.
3. Explain the proposed behavior in simple language.
4. List the exact files that would be created or changed.
5. Ask the repository owner for explicit permission through the available approval
   prompt before editing application code.
6. Call out any important architectural or security concept before proceeding.

While implementing:

- prefer the smallest complete vertical change;
- avoid speculative abstractions, placeholder services, and duplicated DTOs;
- use dependency injection at external boundaries;
- keep model outputs typed and untrusted;
- keep business rules deterministic;
- add focused tests with each behavior;
- preserve unrelated working-tree changes;
- explain the call flow and what the owner should observe after each step.

Before handing off:

- run the relevant linter, type checker, and tests;
- report what passed and what was not run;
- distinguish committed work from local work;
- never claim a provider write succeeded without authoritative confirmation;
- never include secrets in logs, screenshots, fixtures, documentation, or commits.

## 18. Immediate handoff warning

Refund execution is now safe across Gateway restarts and multiple Gateway instances
only when PostgreSQL migrations have been applied. Do not run the Integration
Gateway against a real refund provider with an un-migrated database.
