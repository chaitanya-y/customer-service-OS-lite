# Authoritative Refund Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development. The coordinator is intentionally using parallel workers only for paths with exclusive ownership.

**Goal:** Add retry-safe refund, reconciliation, outbox and telemetry-health metrics to the local OpenTelemetry/Grafana stack without changing refund authorization or executing a refund.

**Architecture:** Durable PostgreSQL records remain the business authority. Integration Gateway and Human Operations periodically read bounded aggregate snapshots and publish synchronous OpenTelemetry gauges through one closed shared API. Temporal activity telemetry remains attempt-level tracing; it is never used as a distinct-refund counter. Grafana consumes only the bounded gauges and Collector health signals.

**Tech Stack:** TypeScript, PostgreSQL 17, OpenTelemetry JS, Temporal, Grafana LGTM, Prometheus, Node test runner, Python unittest.

**Spec:** `docs/superpowers/specs/2026-09-16-observability-design.md`

## Global Constraints

- Work on `dev`; do not commit, push, merge, start servers, change tokens/secrets, call paid models or execute refunds.
- Tests must fail for the missing behavior before production code is written.
- Telemetry is diagnostic only; durable audit and authorization remain authoritative.
- Collector/database/metric-export failure must not block a valid request, case action or refund workflow.
- Metrics must never contain tenant, environment, customer, order, workflow, preview, refund, event, case or staff identifiers; no user/model content, SQL, exception text or provider payloads.
- Metric dimensions are limited to the fixed `outcome` values defined below; all other gauges have no attributes.
- Temporal activity attempts and retries are not distinct refunds. No metric export may occur from replayed workflow code.
- Observation interval is 30 seconds, observations never overlap, timers are unref'd, and observer failures emit only a fixed safe diagnostic.
- The local alert rules remain non-notifying. AWS provisioning, alert destinations and production load are deferred and require separate approval.

## Settled shared metric contract

`TelemetryHandle.recordOperationalGauge(observation)` accepts only this closed discriminated union:

```ts
export type OperationalGaugeObservation =
  | Readonly<{ name: 'cso.refund.executions.current'; value: number; outcome: 'IN_PROGRESS' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION' }>
  | Readonly<{ name: 'cso.refund.executions.oldest_age'; value: number; outcome: 'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_RECONCILIATION' }>
  | Readonly<{ name: 'cso.refund.provider_events.pending'; value: number }>
  | Readonly<{ name: 'cso.refund.provider_events.oldest_age'; value: number }>
  | Readonly<{ name: 'cso.human_operations.decision_outbox.pending'; value: number }>
  | Readonly<{ name: 'cso.human_operations.decision_outbox.oldest_age'; value: number }>;
```

All values must be finite and non-negative. Invalid observations are ignored. Disabled telemetry is a no-op. Enabled telemetry also creates `cso.telemetry.heartbeat` with value `1` and no attributes. Metric views allow only `outcome` on the two refund-execution metrics and no attributes on the others.

---

### Task 1: Shared bounded operational gauges

**Files:**
- Modify: `packages/observability-node/index.mjs`
- Modify: `packages/observability-node/index.d.mts`
- Modify: `packages/observability-node/tests/observability.test.mjs`

**Produces:** The exact `OperationalGaugeObservation` and `recordOperationalGauge` interface above.

- [ ] Add a failing test that records every allowed gauge, force-flushes the in-memory reader, and asserts metric names, values and exactly the allowed `outcome` dimensions.
- [ ] Add failing cases for an unknown runtime name, non-finite value, negative value, invalid outcome, canary identifier and disabled telemetry.
- [ ] Run `pnpm --filter @cso/observability-node test` and confirm failure because `recordOperationalGauge` does not exist.
- [ ] Implement the closed instrument registry, the metric views and the no-op disabled method. Record the heartbeat during enabled initialization.
- [ ] Run the focused package tests and confirm they pass.

### Task 2: Integration Gateway authoritative refund snapshot

**Files:**
- Create: `apps/services/integration-gateway/migrations/004_refund_execution_status_entered_at.sql`
- Modify: `apps/services/integration-gateway/src/refund-execution-repository.ts`
- Create: `apps/services/integration-gateway/src/refund-operations-observer.ts`
- Modify: `apps/services/integration-gateway/src/server.ts`
- Create: `apps/services/integration-gateway/tests/refund-operations-observer.test.ts`
- Modify or create focused repository tests under `apps/services/integration-gateway/tests/`

**Consumes:** `TelemetryHandle.recordOperationalGauge` from Task 1.

**Produces:**

```ts
export type RefundOperationsSnapshot = Readonly<{
  executionCounts: Readonly<Record<RefundExecutionStatus, number>>;
  oldestExecutionAgeSeconds: Readonly<Partial<Record<'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_RECONCILIATION', number>>>;
  pendingProviderEventCount: number;
  oldestPendingProviderEventAgeSeconds: number;
}>;

getRefundOperationsSnapshot(): Promise<RefundOperationsSnapshot>;
```

- [ ] Add failing repository tests for all five zero-filled statuses, active-state ages, pending provider-event count/age, status-transition timestamp changes, and deterministic in-memory behavior.
- [ ] Add failing observer tests for immediate observation, exact gauge mapping, disabled telemetry, overlap suppression, fixed safe failure text and stop cleanup.
- [ ] Run the focused tests and confirm the expected missing-method failures.
- [ ] Add `status_entered_at timestamptz NOT NULL`, backfill existing rows from `updated_at`, and update it only when the execution status changes.
- [ ] Implement one aggregate PostgreSQL snapshot using database time; validate all numeric mappings and clamp ages at zero. Use zero for an empty backlog.
- [ ] Implement the 30-second non-blocking observer and wire start after `app.listen` and stop before pool shutdown.
- [ ] Run Gateway focused tests, full tests, typecheck and build.

### Task 3: Human Operations authoritative decision-outbox snapshot

**Files:**
- Create: `apps/services/human-operations/migrations/004_decision_outbox_observation_index.sql`
- Modify: `apps/services/human-operations/src/human-case-repository.ts`
- Modify: `apps/services/human-operations/src/postgres-human-case-repository.ts`
- Create: `apps/services/human-operations/src/decision-outbox-observer.ts`
- Modify: `apps/services/human-operations/src/server.ts`
- Create: `apps/services/human-operations/tests/decision-outbox-observer.test.ts`
- Modify: `apps/services/human-operations/tests/postgres-human-case-repository.test.ts`

**Consumes:** `TelemetryHandle.recordOperationalGauge` from Task 1.

**Produces:**

```ts
export type PendingDecisionOutboxSnapshot = Readonly<{
  pendingCount: number;
  oldestPendingAgeSeconds: number;
}>;

getPendingDecisionOutboxSnapshot(
  input: Readonly<{ tenantId: string; environmentId: string }>,
): Promise<PendingDecisionOutboxSnapshot>;
```

- [ ] Add failing repository tests proving full aggregate count/age, delivery reduction to zero, RLS scope separation and deterministic in-memory behavior.
- [ ] Add failing observer tests for exact unlabelled gauges, disabled telemetry, overlap suppression, fixed safe failure text and stop cleanup.
- [ ] Run focused tests and confirm expected failures.
- [ ] Add the scoped partial pending-age index, implement the aggregate with `statement_timestamp()` under the existing RLS transaction, and safely map PostgreSQL bigint/double values.
- [ ] Implement the observer and wire its lifecycle independently of the existing five-second delivery loop.
- [ ] Run Human Operations focused tests, full tests, typecheck and build.

### Task 4: Collector health, dashboards and non-notifying alerts

**Files:**
- Modify: `infrastructure/observability/collector.yaml`
- Modify: `infrastructure/observability/grafana/foundation.json`
- Modify: `infrastructure/observability/grafana/alerts.yaml`
- Modify: `tools/observability/test_dashboard_config.py`
- Modify as needed: `tools/observability/smoke.py`

**Consumes:** Prometheus names generated from the settled shared metric contract.

- [ ] First extend static tests to require refund status/backlog panels, human outbox panels, heartbeat visibility, Collector failed/dropped export visibility, and stale-backlog/missing-telemetry alert rules.
- [ ] Assert every new query excludes forbidden identifiers and uses only emitted or pinned Collector self-metric names.
- [ ] Assert absence alerts require a previously observed heartbeat and local alert provisioning contains no contact point or external URL.
- [ ] Run `python -m unittest tools/observability/test_dashboard_config.py` and confirm failure on the old dashboard/config.
- [ ] Enable bounded Collector internal metrics through the existing local metrics path and add the required dashboard panels.
- [ ] Add non-notifying local rules for stale pending reconciliation, stale provider/decision outbox, failed/dropped Collector export, and a previously-observed then missing Gateway/worker heartbeat.
- [ ] Run static tests and `docker compose -f infrastructure/observability/compose.yaml config --quiet`.

### Task 5: Integrated verification and documentation

**Files:**
- Modify: `docs/observability/README.md`
- Modify after evidence exists: `docs/VERIFICATION_STATUS.md`

- [ ] Review the combined diff for overlapping edits, leaked identifiers, unbounded labels, dynamic exception logging and authorization/refund behavior changes.
- [ ] Run all affected package tests/typechecks/builds once on the combined tree.
- [ ] Run the observability smoke without paid models or refund execution; when Docker is available, verify Grafana/Prometheus receive the new safe metrics and Collector health signals.
- [ ] Document what is authoritative, what is attempt-level, exact start/verification commands, the 30-second staleness bound, and failure semantics.
- [ ] State explicitly that alert routing, production SLO thresholds, sampling/retention/access enforcement, AWS export/deployment and production load/failure validation remain separate work.

## Acceptance checks

1. Durable database snapshots, not activity attempts, drive refund and outbox business metrics.
2. Metric names/dimensions are closed and canary identifiers never export.
3. Database or Collector failure cannot block business execution.
4. Dashboard panels show current refund states and backlog ages; local alerts are non-notifying and include owners/runbooks.
5. No Temporal workflow code emits telemetry and existing replay tests remain green.
6. No external service, paid model or refund provider is called; no Git mutation occurs.
