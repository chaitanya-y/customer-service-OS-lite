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

| Capability | Status |
|---|---|
| Local customer sign-in and refund intake | Implemented |
| LangGraph proposal generation, read-only order lookup, and grounded answer | Implemented |
| Customer-safe RAG over OpenSearch | Implemented |
| Versioned deterministic refund policy | Implemented |
| Temporal confirmation, approval, takeover, provider processing, and reconciliation paths | Implemented |
| Signed provider outcome events, replay protection, and retry delivery to Temporal | Implemented |
| Human case queue, claim, decision, and audit trail | Implemented locally |
| Customer and Human Operations interfaces with light, dark, and system themes | Implemented |
| Admin Console | Visual foundation only |
| Cognito, Kafka, OpenTelemetry, persistent Human Operations storage, AWS deployment | Planned |

The Human Operations repository is deliberately in memory for local development.
Restarting that service clears local cases. It is not a production persistence
implementation.

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
Kafka delivery, OpenTelemetry observability, a persistent Human Operations store,
reproducible Vendure seed data, or AWS infrastructure.

Never commit `.env` files, local signed tokens, API keys, or Vendure API keys.
