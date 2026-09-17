# Observability Expansion and Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Complete the remaining local observability layers, improve local reproducibility, and prepare evaluation integrations without paid calls or external exports.

**Architecture:** Extend the existing opt-in OpenTelemetry SDKs at explicit application boundaries. Temporal emits only short worker/activity spans; no exporter runs inside replayed workflow code and no span remains open across a durable wait. Operational telemetry remains diagnostic and never replaces signed authorization or durable audit.

**Tech Stack:** Python 3.12, FastAPI, LangGraph, Node.js 24, Fastify, Temporal, OpenTelemetry, Grafana LGTM, PostgreSQL, Docker Compose, RAGAS evaluation runner.

**Spec:** `docs/superpowers/specs/2026-09-16-observability-design.md`

## Global constraints

- Preserve all existing local work and untracked `.superpowers/`.
- Do not commit, push, merge, switch branches or edit real `.env` files.
- Do not call paid models, export to LangSmith, run an external Tau benchmark, issue a refund, renew tokens, migrate databases or restart owner services.
- Never emit prompts, answers, customer messages, retrieved text, photos, SQL, identifiers, tokens, signed assertions, provider bodies or raw exceptions.
- Use bounded static operation names and low-cardinality metric attributes.
- Cost is unknown unless a versioned price and provider usage are both available; never record an unknown cost as zero.
- Each production behavior begins with a focused failing test and recorded RED result.

---

### Task 1: Model and guard telemetry

**Files:**
- Modify: `packages/python-observability/cso_observability/bootstrap.py`
- Modify: `packages/python-observability/tests/test_bootstrap.py`
- Modify: `apps/services/agent-runtime/agent_runtime/refund/graph.py`
- Modify: `apps/services/agent-runtime/agent_runtime/refund/answer.py`
- Modify: focused Agent Runtime observability/model tests

**Produces:** Bounded proposal, answer and guard/fallback spans plus provider-usage metrics when usage is returned.

- [ ] Write focused tests proving disabled behavior, success/failure/fallback outcomes, token counters, unknown-cost omission and content exclusion.
- [ ] Run those tests and record the expected missing-instrumentation failure.
- [ ] Add the minimum bounded telemetry API and wire it around existing model/guard boundaries.
- [ ] Run focused tests, shared Python telemetry tests, Agent Runtime Ruff and the full Agent Runtime suite.

### Task 2: Temporal worker and activity telemetry

**Files:**
- Modify: `packages/observability-node/index.mjs` and its tests only when the existing API is insufficient
- Modify: `apps/services/workflow-workers/src/refund-worker.ts`
- Modify: `apps/services/workflow-workers/src/refund-workflow-activities.ts`
- Modify: Workflow Worker dependency clients and focused tests

**Produces:** Short worker/activity and dependency spans for facts refresh, human review delivery, refund submission and reconciliation.

- [ ] Write focused tests proving no workflow-replay exporter side effect, bounded names, disabled behavior, retry-safe semantics and content exclusion.
- [ ] Run the tests and record the expected failure.
- [ ] Instrument activity/client boundaries only; never hold a span across a Temporal wait.
- [ ] Run focused tests, Workflow Worker typecheck and the full service suite.

### Task 3: Human Operations and Conversation Runtime telemetry

**Files:**
- Modify: `apps/services/human-operations/src/bootstrap.ts`, server/app wiring and focused tests
- Modify: `apps/services/conversation-runtime/src/bootstrap.ts`, server/app wiring and focused tests

**Produces:** Opt-in request traces, bounded metrics and fixed correlated logs for both transactional services.

- [ ] Write real service-boundary tests for success, authorization failure, disabled mode and content exclusion.
- [ ] Record the expected RED result before production wiring.
- [ ] Reuse `@cso/observability-node`; do not duplicate an SDK.
- [ ] Run both focused and full service tests plus both typechecks.

### Task 4: Business dashboards and local alerts

**Files:**
- Modify: `infrastructure/observability/grafana/foundation.json`
- Create: `infrastructure/observability/grafana/alerts.yaml`
- Create: `tools/observability/test_dashboard_config.py`
- Modify: observability provisioning only as required by the tests

**Produces:** Platform, model/RAG, refund-operations and telemetry-health views with minimum-traffic alert windows.

- [ ] Write configuration tests for bounded PromQL labels, required panels, alert windows/thresholds and forbidden content.
- [ ] Record RED before changing dashboard/provisioning.
- [ ] Add panels and local non-notifying alert rules; no cloud notification destination.
- [ ] Validate JSON/YAML, Compose configuration and dashboard tests.

### Task 5: Reproducible local dependency startup

**Files:**
- Modify: `infrastructure/local/compose.yaml`
- Create: `tools/local/start-dependencies.mjs`
- Create: `tools/local/check-readiness.mjs`
- Create: focused Node tests under `tools/local/tests/`

**Produces:** One command that starts/checks only repository-owned local dependencies without embedding secrets or mutable owner data.

- [ ] Test command construction, readiness timeouts, idempotent rerun and non-destructive stop behavior.
- [ ] Record RED before implementing scripts.
- [ ] Add PostgreSQL and observability orchestration plus readiness checks; keep Vendure seed data and OpenSearch publication explicit when they cannot be reproduced safely.
- [ ] Run script tests and `docker compose config`; do not start or destroy owner services.

### Task 6: Evaluation integration preparation

**Files:**
- Create: framework-neutral LangSmith export adapter and tests under `apps/services/evaluation-runner/`
- Create: Tau retail compatibility manifest/adapter and offline tests under the same service
- Modify: Evaluation Runner README and evaluation strategy only after code verification

**Produces:** Content-minimized, opt-in export records and an offline Tau compatibility boundary. It does not perform an export or public benchmark run.

- [ ] Test default-off behavior, allowlisted fields, private-content exclusion, version preservation and official-versus-adapted benchmark labeling.
- [ ] Record RED before adapter implementation.
- [ ] Implement offline adapters without credentials or network calls.
- [ ] Run Evaluation Runner Ruff and full tests. Ask separately before installing external benchmark dependencies, exporting data or making paid calls.

### Task 7: Integration verification

- [ ] Review every worker diff against the safe-field contract and file ownership.
- [ ] Run affected shared, service, typecheck, lint and configuration checks once on settled code.
- [ ] Run deterministic synthetic observability smoke tests only; no model/provider/refund calls.
- [ ] Update the check ledger and explain changed files, functions, examples, limitations and remaining external approvals.
