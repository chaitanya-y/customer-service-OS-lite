# Architecture Decision Log

Last updated: 2026-09-14

This is a compact status index. Detailed rationale belongs in ADRs and the current
architecture document.

| Decision | Status | Current interpretation |
|---|---|---|
| First vertical slice is governed refunds | Accepted and implemented | Finish and harden one complex journey before adding broad feature scope |
| Polyglot runtime | Accepted and implemented | Python/FastAPI for Agent and RAG; Node.js/TypeScript for transactional and integration services |
| Supervisor with bounded specialists | Accepted and partially implemented | LangGraph refund specialist path exists; broader specialist catalog remains future work |
| MCP is the agent tool boundary | Accepted and implemented for lookup | Python Agent Runtime is an MCP client; Node Integration Gateway exposes read-only order lookup |
| Temporal owns long-running refund state | Accepted and implemented | Confirmation, approval, takeover, execution, provider processing, and reconciliation live in Workflow Workers |
| Deterministic policy authorizes actions | Accepted and implemented | Model proposal is untrusted input; versioned policy and trusted facts decide the governed path |
| Trusted policy explanations | Accepted; local implementation | Shared immutable policy catalog, agent-specific signed version/hash and application-rendered amount bands; purpose affects wording only, not approval. See the September 14 trusted-answer plan and verification status; no v9 live reliability claim |
| Human Operations persistence | Accepted and implemented locally | PostgreSQL with tenant/environment RLS, audit, idempotency, and transactional decision outbox |
| Conversation persistence | Accepted and implemented locally | PostgreSQL with encrypted message content and workflow linkage |
| OpenSearch for production-shaped RAG | Accepted and implemented locally | Hybrid BM25/vector retrieval, metadata filters, RRF, cross-encoder reranking, citations, and evaluation |
| Separate Python Evaluation Runner | Accepted and implemented offline | RAGAS adapters, versioned datasets, repeated trials, deterministic intake graders, usage reporting and baseline comparison; no calibrated release claim |
| Evaluation before production observability | Accepted current sequence | Authorized v3 campaign measured 15 attempts, five scored and ten rejected; review actual answers and judge disagreements next, freeze the baseline, notify the owner before LangSmith, then add external Tau; human calibration and integrations remain pending |
| Next.js BFF browser boundaries | Accepted and implemented locally | Customer and Operations apps use same-origin server routes and HTTP-only local sessions |
| Local authentication adapters | Temporary and implemented | Customer/staff CLI tokens default to seven days (604800 seconds); internal assertions remain short lived. Replace local login with Cognito/OIDC in production |
| Centralized Model Gateway | Accepted future design | Not implemented; Agent Runtime calls configured models directly today |
| Kafka/MSK event backbone | Accepted future design | Not implemented; transactional outboxes and direct local delivery create the migration point |
| OpenTelemetry and CloudWatch | Accepted future design | Not implemented; add trace context, metrics, logs, dashboards, and alerts before production |
| First AWS target | Accepted future direction | Single-region ECS Fargate first; do not claim EKS or multi-region implementation |
| Voice channel | Planned boundary only | Reuse identity, conversation, agent, RAG, workflow, policy, and Human Operations; no voice code yet |

## Model Gateway decision

The current Agent Runtime owns provider client creation and calls the configured
model directly. This keeps the first vertical slice small, but model selection and
policy are not yet centralized.

The future Model Gateway will own:

- logical task-to-model routing and release-controlled route versions;
- provider and model allowlists;
- token, cost, latency, and concurrency budgets;
- timeouts, retries, circuit breakers, and approved fallback behavior;
- centralized provider credentials and request redaction;
- trace and cost attribution without storing raw sensitive prompts by default;
- evidence linking the resolved route and model to each governed execution.

It will not own business policy, tenant authentication, RAG retrieval, prompt
content construction, or Temporal workflow state. Agent Runtime remains the
orchestrator and consumes a model-client interface; the gateway becomes one
implementation behind that interface.
