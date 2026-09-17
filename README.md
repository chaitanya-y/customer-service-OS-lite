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
| Evaluation Runner, RAGAS adapters, repeated trials, and deterministic agent intake checks | Implemented; v3 campaign measured 15 trials, five scored and ten rejected; one v4 policy-answer trial failed its blocking check; human calibration pending |
| LangSmith experiments and external Tau retail benchmark | Planned; no export or benchmark run yet |
| Versioned deterministic refund policy | Implemented |
| Private damage photos and staff evidence review | Local policy v2 slice, including a photo-gated browser-to-provider proof; see the [photo guide](docs/REFUND_PHOTO_EVIDENCE.md) |
| Temporal confirmation, approval, takeover, provider processing, and reconciliation paths | Implemented |
| Signed provider outcome events, replay protection, and retry delivery to Temporal | Implemented |
| Human case queue, claim, decision, and audit trail | Implemented locally |
| Customer and Human Operations interfaces with light, dark, and system themes | Implemented |
| Admin Console | Visual foundation only |
| PostgreSQL Human Operations cases, audit history, idempotency, and decision outbox | Implemented locally |
| Centralized Model Gateway for routing, budgets, fallback, and provider policy | Planned; Agent Runtime currently calls configured models directly |
| OpenTelemetry and local Grafana | Edge API, Agent Runtime, RAG phases and Gateway order lookup; [scope and runbook](docs/observability/README.md) |
| Cognito, Kafka, and AWS deployment | Planned |

The running Human Operations service uses PostgreSQL. Case state, audit events,
idempotency records, and pending decisions survive service restarts. Its in-memory
repository remains only as a test and dependency-injection adapter. Production
deployment, backup, high availability, and Kafka delivery are still future work.

September 17 code checkpoint: the local observability foundation is on `main`
at `cc36be6`. The dependency-tracing extension is committed and pushed on `dev`
at `8f976be`; it has not been merged to `main`. The latest focused observability
scope passed 469 tests and a safe synthetic trace crossed Agent Runtime,
Knowledge/RAG, and Integration Gateway with 14 linked spans. This was not a paid
model call or refund execution. See [the verification record](docs/VERIFICATION_STATUS.md)
for exact scope and limitations.

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
- [Evaluation strategy](docs/evaluation/EVALUATION_STRATEGY.md), the current
  RAGAS campaign, human review, LangSmith, and Tau sequence.
- [Evaluation entrypoint](docs/evaluation/README.md), the latest frozen baseline,
  measured limits, and links to the detailed reports.
- [Evaluation Runner guide](apps/services/evaluation-runner/README.md), datasets,
  offline checks, paid-run safeguards, measured usage, and result interpretation.
- [RAGAS reference review](docs/evaluation/RAGAS_DATASET_REVIEW.md) and
  [historical baseline review](docs/evaluation/RAGAS_BASELINE_REVIEW.md), approved
  references versus still-pending human calibration.
- [Refund photo evidence](docs/REFUND_PHOTO_EVIDENCE.md), upload/review flow,
  code reading order, local setup, limits, and safety boundaries.
- [Decision log](docs/DECISION_LOG.md), accepted, implemented, and planned choices.
- [Local observability runbook](docs/observability/README.md), the opt-in
  OpenTelemetry, Grafana, safe-signal and smoke-test setup.
- [Dependency tracing guide](docs/observability/DEPENDENCY_TRACING.md), the
  Agent-to-RAG and Agent-to-Gateway trace boundaries and current limits.
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
Kafka delivery, platform-wide production observability, the centralized Model Gateway,
reproducible Vendure seed data, production-grade Human Operations database
operations, or AWS infrastructure.

Delivery-age eligibility is not enforced. The September 10 answer boundary allows
general delivery-policy explanations only with supporting cited customer-safe
evidence and an application-owned qualification that delivery timing has not been
verified. Delivery-date questions and personalized delivery-eligibility claims
remain prohibited. These are bounded wording checks, not trusted eligibility
decisions. A fresh paid live browser wording recheck remains pending, separately
from the completed photo-gated refund proof. Historical one-case RAGAS trials
on September 11 and 13 produced semantic scores, but neither is a calibrated
release baseline. The measured campaign used `refund-answer-v8`; its September
13 trial failed at the answer guard before judging, as did v7. The later local
answer implementation uses `refund-answer-v9`, a signed shared-policy binding
and purpose-aware presentation. The authorized September 15 v4 trial is the
first live observation against this boundary and failed its blocking reviewed-
policy answer check; the baseline is now frozen with human review unresolved.
See [the closure review](docs/evaluation/RAGAS_CLOSURE_REVIEW.md),
[the baseline review](docs/evaluation/RAGAS_BASELINE_REVIEW.md) and
[the trusted-answer design](docs/superpowers/specs/2026-09-14-trusted-refund-answer-design.md).
The boundary still replaces a small set of complete uncertainty sentences with
an application-owned qualification and rejects unsafe claims. It does not
implement general natural-language eligibility validation.
Opt-in synthetic rejection diagnostics are separate from quality samples; an
answer rejected by the production guard is not sent to RAGAS judges. The September
14 authorized v3 campaign completed all 15 attempts: five were scored, ten were
rejected and no case passed all three repetitions. All recorded provider calls
succeeded; offline replay exposed brittle wording checks, and a scored answer
exposed missed eligibility wording. See
[the v3 measured baseline](docs/evaluation/RAGAS_V3_BASELINE.md).
Human review and judge calibration remain pending. Proceed to LangSmith and Tau
only after notifying the owner and obtaining any required export approval; no
automatic paid retry or export is authorized. Fifteen trials is not a fifteen-call
cost cap.
The Evaluation Runner separates retrieved policy from independent synthetic
application facts when judging answers. Its v2 graders have offline coverage,
but semantic scores are not yet calibrated release gates.
Simulated Vendure settlement does not prove real webhook delivery or bank
settlement. Photo retention deletion remains disabled pending explicit approval.

Never commit `.env` files, local signed tokens, API keys, or Vendure API keys.
