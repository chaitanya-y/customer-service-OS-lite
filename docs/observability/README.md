# Local observability foundation

Latest update: the dependency batch adds Knowledge/RAG, Integration Gateway and
Agent Runtime client propagation. It is committed and pushed on `dev` as
`8f976be` but is not yet merged to `main`. Read
[dependency tracing](DEPENDENCY_TRACING.md) for the scope, code walkthrough and
synthetic test. The first-batch evidence below remains historical. The owner
approved local opt-in for all four services on 2026-09-17; this is still not a
production deployment.

Owner approved 2026-09-16. This is the first batch, not full production monitoring.

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

The dashboard uses only the current emitted Prometheus series:
`cso_operation_completed_total`, `cso_operation_duration_seconds_bucket`, and
`cso_model_tokens_total`. The refund-path panel and fallback alert count
operation events, **not distinct refunds**. Temporal activity attempts can retry,
so their TraceQL panel is deliberately not treated as a business counter.

Grafana provisions four local rules: model guard/failure event rate, RAG
server-error rate, refund-path fallback event rate, and platform server-error
rate. Each evaluates a 15- to 30-minute sample window, requires at least
20, 30 or 50 emitted events, and remains true for 10 minutes before firing.
They have bounded owner/severity/scope labels and no contact point, notification
policy, webhook, cloud destination or other delivery configuration. They are
local diagnostic rules, not an escalation path.

There is no collector/exporter health metric or independent traffic baseline in
this slice. Accordingly, no absence alert is configured: a service with no
traffic cannot be distinguished from a service with broken telemetry. Inspect
the telemetry-health panel while sending known synthetic traffic instead.

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
6. `infrastructure/observability/collector.yaml` filters before local storage;
   `grafana/foundation.json` defines the initial dashboard.
7. `tools/observability/smoke.py` proves the cross-language contract through real
   HTTP and examines the emitted telemetry, not only mocked function calls.

## Remaining batches

Not implemented here: durable distinct-refund, outbox-age and reconciliation-age
metrics; Temporal activity metrics; collector/exporter health metrics; production
sampling, retention, access controls, notification routing, CloudWatch/AWS/CDK
deployment; and production SLOs. LangSmith export and an official Tau run remain
separate, explicitly approved evaluation work.
Operational telemetry is not a replacement for durable business audit records.

The [approved design](../superpowers/specs/2026-09-16-observability-design.md)
describes those later batches. The implementation plan records this batch's tests
and review findings. Do not interpret the full design as completed code.
