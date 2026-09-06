# Customer Service OS Lite

Customer Service OS Lite is a production oriented learning project for building
governed customer support agents. Its first vertical slice is a locally runnable
refund journey that combines a customer interface, a Python LangGraph agent,
customer safe RAG, safe read only MCP commerce tools, deterministic policy, Temporal,
human operations, and a local Vendure commerce simulator.

The project is deliberately designed so that the model can understand and propose
a refund, but cannot authorize or execute one.

## Current status

The local refund journey is implemented and has been exercised through the
customer and Human Operations browser interfaces.
On 2026-09-06, the photo-gated positive path completed for a disposable local
order: staff requested a clearer photo, accepted its replacement revision, then
the same case moved to supervisor monetary approval and exact customer
confirmation. One Vendure refund for USD 3,122.60 was created and, with separate
owner authorization, that existing refund was settled. Temporal reached
`REFUND_SUCCEEDED`; the customer projection reached `REFUND_COMPLETED` with no
action. See [verification evidence](docs/VERIFICATION_STATUS.md), including the
earlier September 5 proof and the later automated wording-safeguard checks.

| Capability | Status |
|---|---|
| Local customer sign-in and refund intake | Implemented |
| LangGraph proposal generation, read-only order lookup, and grounded answer | Implemented |
| Customer-safe RAG over OpenSearch | Implemented |
| Versioned deterministic refund policy | Implemented |
| Private damage photos and staff evidence review | Local policy v2 slice, including a photo-gated browser-to-provider proof; see the [photo guide](docs/REFUND_PHOTO_EVIDENCE.md) |
| Temporal confirmation, approval, takeover, provider processing, and reconciliation paths | Implemented |
| Signed provider outcome events, replay protection, and retry delivery to Temporal | Implemented |
| Human case queue, claim, decision, and audit trail | Implemented locally |
| Customer and Human Operations interfaces with light, dark, and system themes | Implemented |
| Admin Console | Visual foundation only |
| PostgreSQL Human Operations cases, audit history, idempotency, and decision outbox | Implemented locally |
| Centralized Model Gateway for routing, budgets, fallback, and provider policy | Planned; Agent Runtime currently calls configured models directly |
| Cognito, Kafka, OpenTelemetry, and AWS deployment | Planned |

The running Human Operations service uses PostgreSQL. Case state, audit events,
idempotency records, and pending decisions survive service restarts. Its in-memory
repository remains only as a test and dependency-injection adapter. Production
deployment, backup, high availability, and Kafka delivery are still future work.

## The governed refund boundary

```text
Customer UI
  -> Edge API: authenticates the local customer and signs service-specific context
  -> Python Agent Runtime: LangGraph, customer safe RAG, safe read only MCP lookup
  -> Temporal Workflow Workers: facts refresh, policy, preview, confirmation
  -> Human Operations when policy requires a person
  -> Integration Gateway: authorized Vendure refund action and provider event intake
  -> Vendure simulator or payment provider
```

The principal rules are:

- The agent returns a typed `RefundProposal`, never a refund write.
- The workflow refreshes authoritative commerce facts and evaluates policy
  deterministically.
- A customer must confirm the exact current preview before an eligible refund can
  be submitted.
- Workflow Workers, not the agent, receive the narrow capability that permits a
  refund action.
- A human decision is recorded with staff identity, case version, and an audit
  event.
- A submitted refund remains in processing until an authoritative provider event
  or reconciliation confirms completion. An uncertain outcome is never presented
  as a successful refund.

## Local development

Use Node.js 24, pnpm 11.9.0, Python 3.12, `uv`, Docker, Temporal, and a local
OpenSearch instance.

For the complete setup, service order, URLs, token creation, and manual browser
test, read [the local refund runbook](docs/LOCAL_REFUND_RUNBOOK.md).

Useful checks:

```bash
pnpm check:contracts
pnpm typecheck:frontend
pnpm build:frontend
pnpm --filter @cso/customer-portal test

cd apps/services/edge-api && pnpm typecheck && pnpm test
cd ../integration-gateway && pnpm typecheck && pnpm test
cd ../workflow-workers && pnpm typecheck && pnpm test
cd ../human-operations && pnpm typecheck && pnpm test
cd ../agent-runtime && uv run ruff check . && uv run pytest
cd ../knowledge-rag && uv run ruff check . && uv run pytest
```

## Documentation

- [Project context and contributor handoff](docs/PROJECT_CONTEXT.md), the detailed
  architecture, contracts, environment, tests, and remaining work.
- [Codex handoff](docs/CODEX_HANDOFF.md), the quickest safe entry point for a new
  account or coding agent.
- [Multi-agent working agreement](docs/MULTI_AGENT_WORKING_AGREEMENT.md), bounded
  delegation, file ownership, context, test responsibilities and usage checkpoints.
- [Current HLD and LLD](docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md), the
  authoritative architecture amendment over the preserved original PDF.
- [Final combined HLD and LLD PDF](docs/reference/architecture/Kleem_AI_Combined_HLD_and_LLD_Architecture.pdf),
  the September 3 architecture snapshot and complete version 1.0 baseline appendix;
  current verification updates are in Markdown.
- [Reference document manifest](docs/reference/README.md), precedence, page counts,
  checksums, and the included product PDFs.
- [Local authentication and secrets](docs/LOCAL_AUTH_AND_SECRETS.md), a careful
  explanation of signing secrets, login tokens, internal assertions, and rotation.
- [Verification status](docs/VERIFICATION_STATUS.md), what is automated, what has
  been proved manually, and remaining hardening and production work.
- [Refund photo evidence](docs/REFUND_PHOTO_EVIDENCE.md), upload/review flow,
  code reading order, local setup, limits, and safety boundaries.
- [Decision log](docs/DECISION_LOG.md), accepted, implemented, and planned choices.
- [Local refund runbook](docs/LOCAL_REFUND_RUNBOOK.md), start and test the full
  local stack safely.
- [Frontend refund journey](docs/FRONTEND_CUSTOMER_REFUND_JOURNEY.md), implemented
  browser behavior and the next UI hardening work.
- [Design system](DESIGN.md), shared visual language and theme rules.
- [Application layout](apps/README.md), deployable web and service workloads.
- [Service boundaries](apps/services/README.md), including the planned voice
  workloads and the services they must reuse.
- [Voice-agent boundary](docs/voice/VOICE_AGENT_BOUNDARY.md), planned real-phone
  call architecture and the chat services it will reuse.
- [ADR-001: Polyglot runtime and MCP boundaries](docs/adr/ADR-001-polyglot-runtime-and-mcp-boundaries.md), why Python and TypeScript have different responsibilities.

## Important limitations

This repository is a local, production-shaped learning system. It is not yet a
deployable production service. In particular, it does not yet include Cognito,
Kafka delivery, OpenTelemetry observability, the centralized Model Gateway,
reproducible Vendure seed data, production-grade Human Operations database
operations, or AWS infrastructure.

Delivery-age eligibility is not enforced. The successful September 6 browser run
still generated an unsupported request for a delivery date. The subsequent fix
forbids delivery-date questions and delivery-age windows in `SYSTEM_PROMPT`;
runtime checks reject either wording so the existing graph safely falls back.
The full Agent Runtime suite passed 101 tests with one upstream warning. A fresh
paid live browser recheck has not been run; these automated checks do not add
trusted delivery-age eligibility.
Simulated Vendure settlement does not prove real webhook delivery or bank
settlement. Photo retention deletion remains disabled pending explicit approval.

Never commit `.env` files, local signed tokens, API keys, or Vendure API keys.
