# Customer Service OS Lite: Project Context and Contributor Handoff

Last updated: 2026-08-13
Repository: <https://github.com/chaitanya-y/customer-service-OS-lite>
Active implementation branch: `dev`

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

- `surfaces/customer-widget`
- `surfaces/operations-console`
- `surfaces/admin-console`

### Refund journey data flow

```mermaid
flowchart TD
    UI["Customer Chat UI"] --> EDGE["Edge API"]
    EDGE --> CONV["Conversation Service"]
    CONV --> AGENT["Python LangGraph Agent Runtime"]
    AGENT --> RAG["Retrieval Gateway / OpenSearch evidence"]
    CONTROL["Control and Knowledge"] -->|"published knowledge release"| RAG
    AGENT -->|"read-only lookup_order"| MCP["Node Integration Gateway MCP server"]
    MCP --> VENDURE["Vendure commerce system"]
    AGENT -->|"typed RefundProposal only"| WF["Temporal Workflow + Policy"]
    WF -->|"preview and exact confirmation"| CONV
    WF -->|"approval when required"| HUMAN["Human Operations"]
    WF -->|"narrow authorized activity"| GATEWAY["Integration Gateway"]
    GATEWAY -->|"idempotent refund request"| PROVIDER["Refund provider"]
    WF --> EVENTS["Kafka events + audit evidence"]
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

The current guardrail slice forwards an opaque, short-lived assertion from the
Agent Runtime to the Integration Gateway. The Gateway verifies its HMAC signature,
issuer, audience, tenant, lifetime, purpose, and self-service customer binding
before an order lookup. The assertion never enters LangGraph state or model input.
The Edge API authenticates a local customer token, derives the trusted customer
identity from that token, and issues a separate 60-second internal assertion. The
customer cannot supply or override the trusted tenant or customer identity in the
refund request body.

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
deployables/
  agent-runtime/         Python FastAPI + LangGraph
  control-knowledge/     control-plane contracts and source-document fixtures
  conversation-runtime/ Node/Fastify conversation service and outbox
  edge-api/              Node/Fastify customer auth, context signing, routing
  human-operations/      staff authorization and Temporal decision API
  integration-gateway/  Node/Fastify Vendure adapter, REST projection, MCP server
  knowledge-rag/         Python ingestion, retrieval, reranking, and RAG evaluation
  workflow-workers/      deterministic refund policy and Temporal workflow foundation
surfaces/
  customer-widget/       planned customer UI
  operations-console/    planned human-agent console
  admin-console/         planned administration UI
tests/contract/          cross-boundary JSON contract tests
tools/simulators/
  commerce-sandbox/      local Vendure commerce system
docs/adr/                architecture decisions
infra/                   future local/AWS infrastructure
```

Empty planned directories are intentional architecture boundaries, not completed
services.

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

### Knowledge/RAG: committed and pushed retrieval foundation

`deployables/knowledge-rag` contains the Python knowledge workload. It currently
implements the complete retrieval path, but not yet the Agent Runtime integration
or final answer generation.

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

- durable conversation and message acceptance APIs;
- encrypted message persistence interfaces;
- idempotent mutation handling;
- PostgreSQL migrations for conversation records and the outbox;
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
- durable reconciliation every five minutes after an ambiguous provider outcome;
- `continueAsNew()` after 288 reconciliation checks, roughly one day, to bound
  Temporal workflow history while recovery continues;
- local Temporal integration tests covering confirmation, denial, and approval.

The workflow never retries an uncertain provider write. It first asks the Gateway
to find authoritative Vendure refund evidence. A found provider refund becomes
`REFUND_SUCCEEDED`; otherwise the workflow remains
`PENDING_RECONCILIATION` and retries safely.

### Human Operations: committed and pushed

The Node.js/TypeScript Human Operations service contains:

- staff JWT verification with tenant, environment, and refund-approval roles;
- a protected decision endpoint that derives the staff identity from the assertion,
  never from request JSON;
- Temporal signals for `APPROVE`, `REJECT`, and `RESOLVE_TAKEOVER` decisions;
- tests for missing authorization, spoofed identity, and a valid decision.

### Edge API: committed and pushed

The Node.js/TypeScript Edge API contains:

- `POST /v1/refunds/intake` on port `3000`;
- strict customer-supplied refund input validation;
- signed local customer tokens for development only;
- server-derived tenant, environment, and customer identity;
- a separate, short-lived trusted context assertion for internal calls;
- forwarding to the Agent Runtime without exposing the customer token;
- stable authentication and downstream-failure responses;
- startup guards that reject local authentication in production and reject key
  reuse between customer tokens and internal assertions;
- unit, route, client, and Edge-to-Gateway compatibility tests.

Current local work on `dev`, not committed at the time of this handoff, adds
audience-separated assertions for Agent Runtime integration:

- Edge API creates two short-lived assertions from the same authenticated customer
  identity, request ID, and trace ID;
- `x-cso-agent-context-assertion` is intended only for Agent Runtime, with
  audience `agent-runtime`;
- `x-cso-context-assertion` remains intended only for Integration Gateway, with
  audience `integration-gateway`;
- Agent Runtime receives both headers. It will verify the first before using its
  tenant and environment for RAG, and will forward the second only to the MCP order
  lookup client.

Audience verification prevents a token issued for the Integration Gateway from
being accepted as an Agent Runtime authorization token. The current local design
uses one shared HMAC secret for both verifiers, so it does not isolate services if
one verifier is compromised. Before deployment, use separate per-audience signing
keys or Edge-held asymmetric signing keys with service-specific public verifiers.
The Agent Runtime verification and RAG call are the next implementation step.

The production AWS authentication adapter is not implemented yet. It will replace
the local token verifier with Cognito while preserving the route, identity,
assertion, and downstream client interfaces.

## 8. Current Git state

At the time of this handoff:

- implementation branch: `dev`
- release branch: `main`
- remote: `origin`
- remote URL: `https://github.com/chaitanya-y/customer-service-OS-lite.git`
- branch workflow: implement and test on `dev`, then merge verified changes to
  `main`;
- `main` contains the governed refund execution, reconciliation, and the
  Knowledge/RAG retrieval and evaluation foundation;
- `dev` has the tested but uncommitted Edge API audience-separation changes;
- the next planned capability is Agent Runtime verification of its dedicated
  assertion, followed by RAG augmentation and grounded answer generation.

## 9. Prerequisites

Use these major versions:

- Git
- Node.js 24.x
- pnpm 11.9.0
- Python 3.12.x
- `uv`

Node 20.11 previously failed while starting the Vendure/Vite development stack.
Use Node 24 for this repository.

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
cd deployables/agent-runtime
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

`deployables/integration-gateway/.env` needs:

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
```

`deployables/edge-api/.env` needs:

```dotenv
NODE_ENV=development
AUTH_MODE=local
HOST=127.0.0.1
PORT=3000
AGENT_RUNTIME_BASE_URL=http://127.0.0.1:8000
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
```

`deployables/agent-runtime/.env` needs these values before a real model-backed
refund extraction:

```dotenv
OPENAI_API_KEY=<create-an-openai-api-key>
REFUND_INTENT_MODEL=<approved-openai-model>
AGENT_RELEASE_ID=agent-runtime-0.1.0
MODEL_ROUTE_ID=refund-intent-openai-v1
KNOWLEDGE_RELEASE_ID=knowledge-not-used
GUARDRAIL_VERSION=refund-proposal-guardrails-v1
EVALUATION_VERSION=evaluation-not-released
ORDER_LOOKUP_TOOL_VERSION=lookup-order-v1
```

Never commit these environment files.

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

Use separate terminals and start dependencies from the bottom up.

### Terminal 0: PostgreSQL

```bash
docker compose -f infra/local/compose.yaml up -d postgres
cd deployables/integration-gateway
pnpm migrate
```

The migration command uses `MIGRATION_DATABASE_URL`. The running Gateway uses
the restricted `DATABASE_URL` account. For an existing local database created
before this repository version, create the local `cso_integration_app` role from
`infra/local/postgres/001_roles.sql` once before running the migration.

### Terminal 1: Vendure

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

### Terminal 2: Integration Gateway

```bash
cd deployables/integration-gateway
pnpm dev
```

Expected URLs:

- health: `http://127.0.0.1:3002/health`
- safe order REST projection:
  `http://127.0.0.1:3002/v1/orders/<ORDER_REFERENCE>`
- MCP Streamable HTTP endpoint: `http://127.0.0.1:3002/mcp`

### Terminal 3: Agent Runtime

```bash
cd deployables/agent-runtime
uv run uvicorn agent_runtime.main:app --reload --host 127.0.0.1 --port 8000
```

Expected URLs:

- health: `http://127.0.0.1:8000/health`
- refund intake: `POST http://127.0.0.1:8000/refunds/intake`

The refund intake endpoint is an internal endpoint and requires the trusted
context assertion created by the Edge API. Do not call it directly from a browser
or customer client.

### Terminal 4: Edge API

```bash
cd deployables/edge-api
pnpm dev
```

Expected URLs:

- health: `http://127.0.0.1:3000/health`
- customer refund intake: `POST http://127.0.0.1:3000/v1/refunds/intake`

Generate a one-hour local customer access token:

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

## 13. Test commands

Run contract tests from the repository root:

```bash
pnpm check:contracts
```

Last verified result: 21 contract tests passed. Run `pnpm lint:proto` separately
when the Buf CLI is installed.

Run the Integration Gateway checks:

```bash
cd deployables/integration-gateway
pnpm typecheck
pnpm test
```

Last verified result: TypeScript passed and 42 Gateway tests passed, including the
protected execution and reconciliation routes.

Run the Edge API checks:

```bash
cd deployables/edge-api
pnpm typecheck
pnpm test
```

Last verified result: TypeScript passed and 19 tests passed.

Run the Agent Runtime checks:

```bash
cd deployables/agent-runtime
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

Last verified result with the Refund Proposal slice: Ruff passed and 25 tests
passed. There was one existing FastAPI/httpx deprecation warning, not a test
failure.

Run the Knowledge/RAG checks:

```bash
cd deployables/knowledge-rag
uv run ruff check .
uv run pytest
```

Last verified result: Ruff passed and 87 tests passed. These tests use
deterministic local embedding and reranking providers where appropriate and do not
call OpenAI.

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

The current owner environment successfully executed:

```text
Python LangGraph
  -> Python MCP client
  -> Node MCP server
  -> Integration Gateway
  -> Vendure Admin API
  -> safe OrderContext
  -> LangGraph status order_context_loaded
```

The local test order was:

- order reference: `AVV8JSZH8G6ZZDMX`
- order state: `Delivered`
- amount: `168880` minor units, `USD`
- payment: `Settled`
- fulfillment: `Delivered`
- shipping method: `Test Courier`
- tracking code: `TEST-TRACK-001`
- facts version:
  `sha256:d25c3a2180202ce1cbb40d6d24f2ce6f17ba648fd7c9b556387105458da69be9`

This is evidence from one local database, not portable seed data. The safe
projection did not expose customer name, email, or payment transaction reference.

## 15. What is not built yet

Do not mistake directory names or schemas for completed functionality. These major
parts remain:

- production customer authentication through Cognito;
- workforce delegation and case-bound order authorization;
- Edge streaming and rate limiting;
- customer chat UI;
- a verified Agent Runtime context assertion and tenant-safe RAG request;
- RAG augmentation inside the refund specialist;
- final response generation grounded in retrieved evidence and citations;
- answer-grounding, citation, specialist, supervisor, tool-selection, trajectory,
  and guardrail evaluations;
- triage specialist and RAG-grounded refund reasoning;
- live model evaluation and release gating for the refund specialist;
- human approval and takeover browser console;
- Kafka topics, event schemas, consumers, and outbox delivery;
- OpenTelemetry traces, metrics, logs, and audit projections;
- evaluation datasets, trajectory/tool/policy/safety evaluations, and gates;
- admin/control plane for version publication;
- reproducible Vendure migration/seed/bootstrap;
- local container orchestration;
- AWS single-region infrastructure and deployment.

## 16. Recommended next sequence

The shortest safe path to the first vertical slice is:

1. Verify the Agent Runtime-specific assertion and derive its trusted tenant and
   environment context. Do not accept RAG governance filters from customer input.
2. Add a RAG retrieval node to the LangGraph refund flow. It must request only
   `CUSTOMER_SAFE` evidence for customer turns and return citations or an explicit
   no-evidence result.
3. Add a grounded response-drafting step. It may explain policy evidence but may
   not promise authorization, eligibility, or refund completion.
4. Add answer and agent evaluations, then connect RAG evidence to execution
   evidence for reproducible traces.
5. Add reproducible Vendure initialization and seed data so another clone can run
   the same end-to-end lookup.
6. Add Kafka event publication through an outbox for journey/audit projections.
7. Add traces and a compact evaluation dataset before deploying the single-region
   AWS slice.

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
