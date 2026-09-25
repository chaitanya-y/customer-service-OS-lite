# Local observability foundation

Latest update: the authoritative refund observability batch is committed on
`dev` as `082beee` and merged to `main` as `c75dd51`. It adds durable refund and
outbox gauges, telemetry heartbeats, Collector self-monitoring, local Grafana
panels and eleven non-notifying alerts. The migrations and local runtime were
verified on 2026-09-19; this remains a local rollout and has not been deployed to
AWS. Read
[dependency tracing](DEPENDENCY_TRACING.md) for the earlier cross-service trace
scope. Historical evidence below remains dated evidence, not the latest Git
state.

Owner approved 2026-09-16. This is the first batch, not full production monitoring.

## Live local rollout, September 19

Both new PostgreSQL migrations were applied successfully to the local database:
the Gateway execution status timestamp/index and the Human Operations pending
outbox observation index are present. Integration Gateway and Human Operations
run on Node 24. The live Temporal Worker uses Node 22.21.0 because the documented
Apple Silicon Temporal runtime issue still occurs on Node 24; this is a runtime
constraint, not an observability workaround.

The local dashboard is live on port 3300 and the OTLP HTTP receiver is on 4318.
The initial durable snapshot contained four `SUCCEEDED` executions, one
`PENDING_RECONCILIATION` execution and no active `IN_PROGRESS`, `SUBMITTED` or
`FAILED` execution. Provider-event and Human Operations decision outboxes were
empty. Gateway, Human Operations and Workflow Worker heartbeats were present.
The existing pending-reconciliation record was about 2.5 million seconds old;
the critical local rule correctly reported it.

An owner-approved read-only audit proved that record was a legacy local orphan:
it had no provider refund ID or provider event, no matching USD 27.79 Vendure
refund, no Human Operations case and no workflow in the current ephemeral
Temporal development server. The only Vendure refund on that order was a later,
unrelated USD 0.00 `diagnostic-only` record. One guarded local transaction moved
the orphan to `FAILED` and inserted a `LOCAL_OPERATOR` audit event with the
reason and scope. It did not call Vendure or Temporal. The authoritative gauges
then showed four `SUCCEEDED`, one `FAILED` and zero
`PENDING_RECONCILIATION`; the stale alert returned to inactive.

Collector internal telemetry uses the complete Prometheus OTLP metrics path
`/api/v1/otlp/v1/metrics`. Collector uptime is present and the bounded exporter
failure expression evaluates to zero. Every Grafana rule uses an explicit
Prometheus query -> `last` reduction -> threshold chain. All eleven rules were
evaluated live without execution errors. The three deliberate
missing-telemetry rules still return a positive series when previously observed
telemetry actually disappears. All local rules map a healthy empty comparison
result to `OK`, so an earlier firing instance can recover normally.

This work changed no token, signing secret or provider credential, made no paid
model call, created no provider refund and configured no notification
destination. The only refund-state change was the explicitly approved audited
local correction described above.

## Authoritative refund operations batch, September 17

Integration Gateway and Human Operations now observe durable PostgreSQL state
every 30 seconds when telemetry is enabled. These gauges answer business
questions that request counters and Temporal activity attempts cannot answer:

- current refund executions by `IN_PROGRESS`, `SUBMITTED`, `SUCCEEDED`,
  `FAILED`, or `PENDING_RECONCILIATION`;
- the age in seconds of the oldest active execution for each active status;
- pending provider-event deliveries and their oldest age;
- pending Human Operations decision deliveries and their oldest age.

The observers are non-overlapping, stop with their owning service, and emit only
bounded outcome labels. They never include a tenant, customer, order, case,
workflow, provider-refund or staff identifier. Repository queries remain the
source of truth; an exporter outage cannot change refund state.

The exact OpenTelemetry instrument names are:

```text
cso.refund.executions.current
cso.refund.executions.oldest_age
cso.refund.provider_events.pending
cso.refund.provider_events.oldest_age
cso.human_operations.decision_outbox.pending
cso.human_operations.decision_outbox.oldest_age
cso.telemetry.heartbeat
```

Prometheus converts dots to underscores and adds `_seconds` to the three age
gauges. The two database migrations add the status/outbox indexes required for
these bounded aggregate queries. They are applied locally; run the normal
service migration procedures before expecting the PostgreSQL-backed gauges in
another environment.

Temporal activity spans intentionally remain attempt-level trace evidence. An
activity may retry, so it must not be counted as a distinct refund. Durable
Gateway execution rows are the authoritative source for refund outcome counts.

## Current readiness batch, September 17

The later local readiness batch extends the same opt-in, content-minimized
telemetry boundary without changing refund authorization or durable audit:

- Agent Runtime records bounded model intent/answer outcomes, guard rejections
  and fallback events. When a provider supplies token usage, it emits the
  `cso_model_tokens_total` counter. Cost remains unknown unless a versioned
  price and provider usage are both available; unknown cost is never reported
  as zero.
- Workflow Workers record short Temporal activity spans at activity boundaries.
  They do not export from replayed workflow code or keep a span open over a
  durable wait. Activity telemetry is trace-only today, not a Prometheus
  counter or a count of distinct refunds.
- Human Operations and Conversation Runtime use the shared Node boundary for
  opt-in request traces, operation counters, duration histograms and fixed
  completion logs. Their database-backed behavior and authorization remain
  separate from telemetry.

The later static checks passed without a local rollout: Python observability
tests (**16**) and Agent Runtime (**203**) passed with Ruff clean; shared Node
telemetry (**11**) passed; Workflow Workers typechecked and its focused activity
tests (**2**) plus local non-network workflow tests (**44**) passed. Human
Operations typechecked and passed **23** tests, with four database tests skipped
because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was unset. Conversation Runtime
typechecked and passed **26** tests, with one database test skipped because
`CONVERSATION_TEST_DATABASE_URL` was unset. The `TestWorkflowEnvironment`
integration suite was not freshly run because it requires Temporal's external
test-server artifact.

## What is implemented

Edge API and Agent Runtime emit opt-in OpenTelemetry traces, operation counters,
duration histograms in seconds, and fixed `request.completed` logs. A trace follows
one request across service boundaries; metrics summarize many requests; logs
record individual completions with the same trace ID.

```text
Edge HTTP request (new trace root)
  -> Edge Agent Runtime client span
    -> Python Agent Runtime server span
  -> local OTel Collector
    -> Tempo traces, Prometheus metrics, Loki logs
      -> Grafana dashboard
```

The public request cannot choose the Edge trace ID. Internal `traceparent`
propagation does not grant access: signed tenant assertions still authorize the
request. Baggage is ignored. No real token or secret changes are required.

Raw prompts, answers, retrieved content, request headers/bodies/query strings,
photos and raw exception messages are excluded from these signals. Metric labels
use bounded operations, outcomes and HTTP status, not customer or order IDs.
The Collector adds allowlist filtering; safety does not depend solely on it.

## Start and stop the backend

From the repository root, with Docker running:

```sh
docker compose -f infrastructure/observability/compose.yaml up -d
docker compose -f infrastructure/observability/compose.yaml ps
```

Open <http://127.0.0.1:3300/d/cso-foundation>. The new local Grafana instance uses
the image's initial `admin` / `admin` login. Change that password yourself when
prompted; do not reuse a real account password. No Grafana Cloud account is needed.
Anonymous access is disabled. Only loopback ports 3300 (Grafana) and 4318 (OTLP
HTTP) are published. Do not expose this development container publicly.

```sh
docker compose -f infrastructure/observability/compose.yaml stop
```

Stopping preserves its dedicated telemetry volume and does not stop the project.
The pinned official `grafana/otel-lgtm` image bundles local development services;
it is not the AWS production deployment. Prometheus has seven-day/512 MB retention.
Other backend retention and disk alerts are not production hardened yet.

## Grafana views and local alerts

The provisioned `cso-foundation` dashboard now groups local signals into four
views:

1. **Platform observability**: operation throughput, p95 duration, server-error
   ratio and fixed correlated logs.
2. **Model and RAG**: provider-reported model-token rate, model
   failure/guard-rejection ratio, RAG phase p95 and RAG server-error ratio.
3. **Refund operations**: emitted refund-path operation events and a Tempo
   TraceQL view of Temporal activity spans.
4. **Telemetry health**: operation samples by service and the local coverage
   boundary.

The dashboard keeps the existing operation series and adds authoritative
`cso_refund_executions_current`, `cso_refund_executions_oldest_age_seconds`,
provider-event backlog, Human Operations outbox backlog, service heartbeat and
Collector exporter-failure series. The refund-path event panel still counts
operation events, **not distinct refunds**. Temporal activity attempts can retry,
so their TraceQL panel is deliberately not treated as a business counter.

Grafana provisions the four existing rate rules plus seven operational rules:
stale reconciliation, stale provider-event delivery, stale human-decision
delivery, Collector export failure, and missing Collector, Gateway or Worker
telemetry. Missing-telemetry rules only activate after a process previously
emitted its safe health signal, avoiding a false alert for a process that has
never run. A healthy missing-telemetry query returns no series and is explicitly
treated as `OK`. All rules use a separate reduce expression before their
threshold and have bounded
owner/severity/scope labels and no contact point, notification policy, webhook,
cloud destination or other delivery configuration. They are local diagnostic
rules, not an escalation path.

The Collector now exports its own internal metrics to the local Prometheus OTLP
endpoint. The telemetry-health view shows application heartbeats and Collector
enqueue/export failures. This proves local signal continuity; it is not a
production synthetic check or an AWS availability guarantee.

## Safe test with no paid calls

Node 24 must be on PATH; install the normal workspace and Agent Runtime development
dependencies first. This starts and closes only ephemeral test service processes:

```sh
apps/services/agent-runtime/.venv/bin/python tools/observability/smoke.py
apps/services/agent-runtime/.venv/bin/python tools/observability/smoke.py --grafana
```

The first command uses only an in-process OTLP receiver. The second additionally
forwards synthetic telemetry to local Grafana. It calls the actual missing-order
intake path, with synthetic signed authentication, no provider credentials, and
tripwires if model or refund functions are reached. It also verifies a 401 for
an unauthenticated request. Canary strings must be absent before export.

Verified example from this batch:

```json
{
  "success": true,
  "elapsed_ms": 37,
  "auth_rejection": 401,
  "trace_id": "bc6963ced4e7b904ec335109ee30d5ad",
  "linked_spans": 3,
  "signals": ["traces", "metrics", "logs"],
  "canaries_absent": true,
  "grafana_forwarded": true
}
```

The 37 ms measures the synthetic request checks, not a real LLM/refund latency
benchmark. Tempo's stored trace contained Edge server -> Edge client -> Python
server; Prometheus contained both services' operation counters; Loki contained
`request.completed` with the same trace ID. Metric names were verified as
`cso_operation_completed_total` and `cso_operation_duration_seconds_bucket`.
Rate/p95 panels require multiple export samples; one short smoke can leave them
empty. Empty data is not proof of zero errors or production health.

Final regression checks: Node shared 4 passed, Edge 91 passed, Agent Runtime 197
passed, focused Python telemetry 12 passed (10 shared and 2 service tests); Edge typecheck/build and scoped Ruff
checks passed. One existing Starlette/httpx deprecation warning remains. A final
synthetic run after review also passed (44 ms, trace
`e4087f3c33caefe697be9e805ca62bf1`). Independent review findings were fixed.
The later approved rollout recreated only the observability container while
preserving its named volume. Browser verification showed the new RAG phase p95
panel and all four service series.

## Alert acceptance test

The repository now owns an executable acceptance suite for all eleven local
Grafana alerts. It reads the real PromQL from `grafana/alerts.yaml`; it does not
maintain a second approximation of the alert expressions.

Run the offline contract check first:

```sh
apps/services/agent-runtime/.venv/bin/python tools/observability/acceptance.py --check
```

This verifies that every expected alert still has one scenario and three phase
assertions: healthy, firing after the configured ten-minute hold, and recovered.
It does not start Docker or write telemetry.

With Docker and the local observability backend available, run the complete safe
acceptance proof:

```sh
apps/services/agent-runtime/.venv/bin/python tools/observability/acceptance.py --run
```

The runner uses `promtool` from the exact digest-pinned `grafana/otel-lgtm`
image. The disposable container has no network, a read-only root filesystem, a
read-only fixture mount, dropped capabilities and no-new-privileges. Promtool
evaluates each real alert independently against synthetic time series. The
runner then invokes the existing dependency smoke and forwards only synthetic
signals to the loopback Collector.

This test never uses application tokens or secrets, calls OpenAI, Vendure or a
payment provider, writes business data, creates a refund, or stops/restarts an
application service. The full acceptance run on September 20, 2026 passed 11
alert scenarios and 33 phase assertions. Its dependency smoke produced one
14-span cross-service trace in 65 ms with traces, metrics and logs, and with all
sensitive canaries absent. That timing is a synthetic local measurement, not a
production SLO.

The behavior tests are in `tools/observability/test_acceptance.py`. If an alert
is added or its hold/query changes, the suite deliberately fails until a safe
healthy/firing/recovery scenario is reviewed and added.

## Local service opt-in

Telemetry defaults to off. Examples are in each service's `.env.example`. The
ignored local `.env` files for Edge API, Agent Runtime, Knowledge/RAG and
Integration Gateway now supply these settings before process startup:

```sh
export CSO_TELEMETRY_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_SERVICE_VERSION=0.1.0
```

Use a distinct `OTEL_SERVICE_NAME` for each process and the existing
`ENVIRONMENT_ID=local`. Node services initialize through their bootstrap. Python
services were restarted with uvicorn `--env-file .env` so telemetry is configured
before application import. Do not put auth tokens in OTLP settings. Only loopback
HTTP exporter endpoints are accepted in this slice.

The four real health endpoints passed after restart. A deterministic dependency
smoke then produced 14 linked spans in 73 ms with traces, metrics and logs,
canaries absent and Grafana forwarding enabled. This proves local wiring, not
real model, OpenSearch, provider or end-to-end refund performance.

## Repository-owned dependency startup

With Docker available, the one-command helper starts only the repository-owned
PostgreSQL and local observability services, then waits for both health checks:

```sh
node tools/local/start-dependencies.mjs
```

`node tools/local/check-readiness.mjs` performs only the bounded readiness
check. Re-running the starter is non-destructive: it uses `docker compose up -d`
for the two named services and never stops, removes, seeds or resets anything.

Vendure is not started or seeded. OpenSearch and a published knowledge release
are not started or created. Temporal is not started. Those gaps are intentional
and require their own setup and authorization. The helper itself was not run
during this readiness batch; its five Node tests, syntax checks, and both local
and observability `docker compose ... config --quiet` checks passed without
starting or stopping services.

## Read the code in this order

1. `apps/services/edge-api/src/bootstrap.ts` initializes telemetry before the server.
2. `packages/observability-node/index.mjs` owns providers, `startServerRequest`,
   `withClientRequest`, fixed completion logs and bounded shutdown.
3. Edge `src/app.ts` hooks start/finish server spans; `src/agent-runtime-client.ts`
   wraps the configured Agent Runtime call and injects its trace parent.
4. `apps/services/agent-runtime/agent_runtime/main.py` preserves the app import and
   attaches the shared runtime to the ASGI app and lifecycle.
5. `packages/python-observability/cso_observability/bootstrap.py` owns Python
   initialization, the ASGI boundary and safe completion/export behavior.
6. Integration Gateway's `refund-operations-observer.ts` and repository snapshot
   query publish authoritative execution/outbox gauges; Human Operations uses the
   equivalent `decision-outbox-observer.ts` and repository snapshot query.
7. Workflow Worker activity wrappers emit short attempt-level spans, while
   service heartbeat helpers prove bounded local signal continuity.
8. `infrastructure/observability/collector.yaml` filters before local storage;
   `grafana/foundation.json` defines the initial dashboard.
9. The provisioned alert YAML defines eleven local diagnostic rules with no
   notification destination.
10. `tools/observability/acceptance.py` evaluates those real queries through
    healthy, firing and recovery phases in an isolated Prometheus rule test.
11. `tools/observability/smoke.py` proves the cross-language contract through real
   HTTP and examines the emitted telemetry, not only mocked function calls.

## Remaining batches

Still not implemented here: workflow-level Temporal business metrics beyond
trace-only activity attempts; finalized production SLO thresholds; real
notification routing; production sampling, retention and access-control
enforcement; CloudWatch/AWS/CDK export and dashboards; and production load,
failure and recovery validation. The migrations are applied locally but still
require the normal deployment-time migration procedure in every other
environment.
LangSmith export and an official Tau run remain separate, explicitly approved
evaluation work.
Operational telemetry is not a replacement for durable business audit records.

The [approved design](../superpowers/specs/2026-09-16-observability-design.md)
describes those later batches. The implementation plan records this batch's tests
and review findings. Do not interpret the full design as completed code.
