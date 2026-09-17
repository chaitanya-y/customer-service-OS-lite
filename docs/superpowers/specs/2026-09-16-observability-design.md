# Observability and monitoring design

Date: 2026-09-16

Status: owner approved. The first local Edge API and Agent Runtime foundation
is being verified. This document also describes later batches that are not yet
implemented; see `docs/observability/README.md` for the current boundary.

## Outcome

Make a customer request explainable: which services handled it, where time was
spent, whether a dependency failed, and whether a successful HTTP response hid a
fallback. Keep customer content and credentials out of telemetry.

Deliver this in verified batches. The first batch is a working local slice across
Edge API and Agent Runtime, not a claim that the entire platform is instrumented.
LangSmith and tau-bench remain deferred; this work does not change the frozen
RAGAS evaluation result or turn it into a passing baseline.

## Decisions and alternatives

Use OpenTelemetry for instrumentation, propagation and export. Use the official
Grafana OpenTelemetry LGTM Docker image for local development, with Grafana,
Collector, Loki, a metrics backend and Tempo. This is a development/test setup,
not the production deployment architecture.

No Grafana Cloud account, new model key or AWS credentials are needed for the
local batch. Docker Desktop is already responding. At inspection time, there
were no listeners on the proposed host ports 3300 and 4318.

Alternatives considered:

1. Grafana Cloud first: less local storage to operate, but introduces an account,
   external telemetry transfer and a separate cost/privacy decision immediately.
2. AWS first: matches the intended production destination, but requires cloud
   access, infrastructure and spending before validating our instrumentation.
3. Local OpenTelemetry and Grafana first: selected for fast, inspectable learning
   and tests without those external dependencies. Dashboard queries and exporter
   configuration will still need adaptation for AWS; portability is not automatic.

The intended AWS destination remains CloudWatch logs, metrics, alarms and tracing
through supported OpenTelemetry integrations. ECS Fargate is the hosting direction;
TypeScript CDK is a recommendation, not implemented infrastructure. AWS provisioning
and its budget require separate approval.

## Signals and trust boundaries

| Signal | Purpose | Authority |
| --- | --- | --- |
| Traces | Time individual operations and connect service calls | Diagnostic only |
| Metrics | Aggregate latency, errors, throughput and backlog | Diagnostic only |
| Structured logs | Search safe event names and error categories | Diagnostic only |
| Existing durable audit | Record claims, approvals and refund actions | Existing business record |

Diagnostic export must use bounded queues and timeouts. An unavailable Collector
must not prevent a valid request or refund from progressing. This does not weaken
transactional business audit requirements or existing authorization checks.

Keep the existing application correlation UUIDs and signed `traceId` claims
unchanged. OpenTelemetry trace IDs and span IDs are separate identifiers. Link
them in safe trace/log fields where necessary; do not change canonical schemas
or place authorization data inside tracing context.

Use W3C trace context between explicitly configured internal services. At a public
ingress, create a server-controlled root context; arbitrary browser trace headers
and baggage must not control internal context. Do not propagate baggage or internal
correlation attributes to model/payment providers. Tracing never authenticates a
caller; current signed assertions and their lifetimes stay unchanged.

## First implementation batch

```text
Synthetic authenticated request with fake business dependencies
    -> Edge API: server span, duration/error metrics, safe correlated log
        -> HTTP client span with internal trace propagation
            -> Agent Runtime: child server span and safe correlated log

Both services -> local OTLP HTTP Collector -> Grafana on port 3300
```

Tests will use a real local HTTP transport and fake adapters. An in-process
Fastify injection test alone cannot prove network propagation or Node module
instrumentation. No paid model call, new customer workflow, provider mutation or
refund execution is part of this batch.

### Local backend and configuration

Create `infrastructure/observability/compose.yaml` as a separate optional stack;
do not replace the existing PostgreSQL Compose file. Pin the selected image
version, use a dedicated named volume, and bind ports only to loopback:

- `127.0.0.1:3300` for Grafana, mapped to its internal port 3000.
- `127.0.0.1:4318` for OTLP HTTP traces, metrics and logs.
- Do not expose OTLP gRPC or backend storage/query ports unless needed later.

Disable optional usage reporting where supported by the selected image. No
Grafana Cloud forwarding or external telemetry endpoint will be configured.
Document the image's local login and require changing its initial password if it
is exposed beyond this local machine. Do not commit a user password.

Service telemetry is explicitly opt-in and defaults to disabled. Define a common
enable flag, service name, environment, service version and OTLP HTTP endpoint.
The local endpoint must be validated as loopback; allowing a remote endpoint is a
separate deployment configuration decision. Use `.env.example` documentation, not
automatic edits to real secrets or local login tokens.

First-batch configuration and tests must cover disabled mode, enabled mode and an
unavailable Collector. Export failure must produce a rate-limited safe diagnostic,
not raw exception output or an unbounded retry queue. Shutdown must flush within
a bounded timeout and then exit.

### Node.js owner

Create a small shared ESM package, `packages/observability-node`, following the
repository's existing no-build shared-package pattern. It owns initialization,
safe attribute/log handling and shutdown; service-specific business logic remains
inside the service.

Proposed files:

- `packages/observability-node/package.json`
- `packages/observability-node/index.mjs`
- `packages/observability-node/index.d.mts`
- `packages/observability-node/tests/observability.test.mjs`
- `apps/services/edge-api/src/bootstrap.ts`
- `apps/services/edge-api/src/server.ts`
- `apps/services/edge-api/src/config.ts`
- `apps/services/edge-api/src/app.ts`
- `apps/services/edge-api/tests/observability.test.ts`

Initialize telemetry before dynamically importing the current server entry point.
Static ESM imports load dependencies before executable bootstrap statements, so
adding initialization after the existing imports is insufficient. Verify the
chosen HTTP/Fastify/Undici instrumentation against Node 24 and the actual ESM
startup with a child-process test; use explicit boundary spans if automatic
instrumentation does not support that startup reliably.

Use narrowly selected instrumentation, not a bundle that silently enables SQL or
model-prompt capture. Preserve existing request/correlation-ID behavior. Avoid
refactoring the Edge API routing or authentication while adding instrumentation.

### Python owner

Create `packages/python-observability` with a small reusable `cso_observability`
package for providers, exporters, safe fields and shutdown. Use the existing
editable local-dependency convention; do not introduce a new root Python workspace.

Proposed files:

- `packages/python-observability/pyproject.toml`
- `packages/python-observability/cso_observability/__init__.py`
- `packages/python-observability/cso_observability/bootstrap.py`
- `packages/python-observability/tests/test_bootstrap.py`
- `apps/services/agent-runtime/agent_runtime/observability.py`
- `apps/services/agent-runtime/agent_runtime/main.py`
- `apps/services/agent-runtime/tests/test_observability.py`

Initialize once, before instrumented service dependencies are loaded, and preserve
the existing `app` import contract and test dependency overrides. If an application
factory is required for ordering and shutdown, keep it local to the entry point.
Service identity/settings stay service-owned; shared code must not load another
service's configuration or secrets.

Instrument FastAPI boundaries without bodies, headers or query strings. Do not
enable LangChain/OpenAI automatic instrumentation. Model stage timing and usage
will be added later at explicit client boundaries with fake-provider tests first.

### Coordinator ownership

The coordinator owns the common field contract, all dependency manifests and
lockfiles, Compose configuration, dashboard provisioning, cross-language smoke
test and final integration review. Workers propose dependency requirements but
must not race on locks or change shared contracts independently.

Expected coordinator-owned changes include `pnpm-lock.yaml`, both service
dependency manifests, Agent Runtime's `uv.lock`, `.env.example` documentation,
`infrastructure/observability/`, `docs/observability/README.md`, and a deterministic
integration test under `tools/observability/`.

Provision one foundation dashboard for request volume, error rate and latency by
service/operation, plus trace search and correlated log navigation. This is not
the complete business-operations dashboard.

## Safe field contract

Allow resource fields for service name/version and deployment environment.
Allow span fields for route template, method, status code, bounded operation,
dependency name, outcome and sanitized error category. Correlation UUIDs may be
restricted trace/log fields, never metric labels. Do not add tenant/customer/order
IDs in the initial slice.

Allow only fixed event names/messages in logs. Include timestamp, severity,
service, operation and the active OpenTelemetry trace/span IDs. Preserve the
existing useful safe intent error categories. Reject raw exception text, stack
events and status descriptions at export; console serializers must also be safe.

Explicitly exclude:

- Authorization, cookies, JWTs, signed assertions and signing secrets.
- Customer messages, conversation history, prompts and model completions.
- Retrieved document content, private photos and signed attachment URLs.
- Payment data, SQL statements/parameters and provider response bodies.
- URL query strings, request/response bodies and arbitrary HTTP headers.

Allowlisting happens before export, with Collector filtering as defense in depth.
No generic exception recorder or debug content capture may bypass it. Do not
assume a redaction test on span attributes also protects span events or logs.

Metrics use bounded operation/route/outcome labels. No UUID, user text, full URL,
unbounded model string or tenant-per-customer dimensions. Use consistent duration
units and histogram boundaries across languages. A business denial is not an
HTTP/server failure; a safe fallback must be distinguishable from normal success.

## Acceptance checks for the first batch

1. Existing relevant Edge and Agent Runtime tests, type checks, lint and builds
   pass without a running telemetry backend.
2. Initialization is idempotent; disabled mode does not export.
3. A real HTTP synthetic call links the Edge and Python spans into one trace,
   without modifying signed application correlation identifiers.
4. Authentication and authorization failures retain their existing behavior;
   tracing headers do not grant access or replace signed context.
5. Canary credentials, fake customer content, raw exception text and provider
   bodies are absent from spans, events, status messages, logs and metric labels.
6. Requests still complete when the Collector is unavailable. Queues/retries and
   shutdown are bounded; no duplicate providers or exports occur on initialization.
7. The local Grafana UI shows the synthetic trace, at least one duration/count
   metric and a correlated safe log. Report measured values, not estimates.
8. The runbook explains start/stop, ports, enable/disable, verification, storage
   and how to return to normal development without deleting project data.

Passing this batch means the foundation works. It does not prove model latency,
all refund paths, production reliability or AWS deployment readiness.

## Subsequent batches and completion boundary

1. Extend customer-turn tracing through Conversation Runtime, Knowledge/RAG and
   the read-only MCP Integration Gateway. Time embedding, retrieval, reranking,
   proposal/answer and guard/fallback boundaries separately. Capture provider
   token usage where returned, with unknown cost shown as unknown rather than zero.
2. Add short linked traces for Temporal activities, staff actions, customer
   confirmation, refund submission and reconciliation. Never export from replayed
   workflow code or hold one HTTP span open for a multi-day workflow. Activity
   attempts are not distinct refunds; authoritative business totals require
   durable deduplication rather than counting retries.
3. Add platform, refund-operations, agent/RAG and telemetry-health dashboards.
   Include outbox age, queue/worker availability, pending reconciliation age and
   guard/fallback rates. Define alerts with minimum traffic, windows, owners and
   runbooks; test failure/recovery without issuing a real refund.
4. Configure the approved AWS export/deployment path and notification destination.
   Validate IAM, networking, retention and cost before cloud deployment. Keep
   diagnostic retention separate from business audit and private-photo retention.

These are separate reviewed batches, not permission to provision AWS or expand
this initial implementation indefinitely. Kafka, Model Gateway and voice remain
future modules. Do not create speculative instrumentation for services that do
not exist.

## Parallel execution and learning

Use two Sol medium workers: one Node owner and one Python owner. The coordinator
owns infrastructure and integration. No nested agents, overlapping edits,
duplicated full-suite runs or agent-managed service restarts.

Review after ten minutes or an observed five-point allowance increase; pause
expansion after twenty minutes or an observed ten-point increase and report a
safe checkpoint. Allowance is account-wide, not exact task cost attribution.

Explain the data flow and each changed file's main function, show representative
code changes and a safe trace/log example after verification. Ask separately
before paid calls, token renewal, provider mutations, Git actions or deployment.

## Reference

The official [Grafana OpenTelemetry LGTM documentation](https://grafana.com/docs/opentelemetry/docker-lgtm/)
describes the local development/test backend and default OTLP HTTP endpoint. Its
default Grafana port is remapped here to avoid the project's Edge API port.
