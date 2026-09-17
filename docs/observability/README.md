# Local observability foundation

Latest update: the dependency batch adds Knowledge/RAG, Integration Gateway and
Agent Runtime client propagation. Read [dependency tracing](DEPENDENCY_TRACING.md)
for the new scope, code walkthrough and synthetic test. The first-batch evidence
below remains historical. The owner approved local opt-in for all four services
on 2026-09-17; this is still not a production deployment.

Owner approved 2026-09-16. This is the first batch, not full production monitoring.

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

Not implemented here: remaining services and Temporal activity spans, model
phase timing, token/cost/fallback metrics, refund business metrics, operational
alerts and SLOs, production sampling/retention/access controls, CloudWatch/AWS/CDK
deployment. LangSmith and Tau remain separate deferred evaluation work.
Operational telemetry is not a replacement for durable business audit records.

The [approved design](../superpowers/specs/2026-09-16-observability-design.md)
describes those later batches. The implementation plan records this batch's tests
and review findings. Do not interpret the full design as completed code.
