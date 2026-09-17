# Observability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Demonstrate safe linked Edge API and Agent Runtime telemetry in local Grafana without paid calls or refund effects.

**Architecture:** Two independent language adapters use the same signal names and safety contract. The coordinator owns dependency installation, the local backend and the cross-language synthetic check. Existing authentication and signed correlation contracts are unchanged.

**Tech Stack:** Node 24, Fastify, Python 3.12, FastAPI, OpenTelemetry SDKs and OTLP HTTP, local Grafana LGTM.

**Spec:** `docs/superpowers/specs/2026-09-16-observability-design.md` (approved by owner in chat).

The task lists below preserve the original execution checklist. The final
verification ledger at the end is authoritative for completed and pending checks.

## Global Constraints

- Work in the existing `dev` checkout; preserve `.superpowers/` and all existing local work. No commits, branch changes, merges or pushes.
- Owner explicitly requested two parallel agents. Their edit paths are disjoint; coordinator owns manifests, locks, installation and integration.
- No paid calls, provider actions, new refund workflows, real secrets or token renewal. Tests use synthetic credentials and fake business dependencies.
- No raw messages, model/RAG content, headers, query strings, photos, SQL or exception text in logs, span events, status descriptions or metrics.
- Telemetry is opt-in with `CSO_TELEMETRY_ENABLED=true`; otherwise no export. Endpoint defaults to `http://127.0.0.1:4318` and accepts loopback HTTP only for this local slice, without credentials/query/fragment.
- Resource: `service.name`, `service.version`, `deployment.environment.name`. Use `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION` and `ENVIRONMENT_ID` with bounded safe values.
- Metrics: `cso.operation.completed` (counter), `cso.operation.duration` (histogram, seconds). Dimensions: `operation`, `outcome`, `http.response.status_code`. Allowed outcomes: `success`, `client_error`, `server_error`. Route templates supply operation names; unknown routes use `unmatched`.
- Completion log body is the fixed string `request.completed`, with safe attributes and active trace/span IDs. No customer or tenant identifiers in first-batch metrics.
- Bounded export queues/timeouts and shutdown. Collector failure cannot change an application result. SDK/export failures emit only a rate-limited fixed diagnostic.
- Public Edge requests start a new telemetry root, ignoring incoming baggage and trace identity. Python accepts internal W3C parent context for tracing only. All existing auth still runs.
- Checkpoint at ten minutes; at twenty minutes stop expansion and reach a safe checkpoint.

## Task 1: Node telemetry and Edge wiring

**Owner:** Sol medium Node worker. Exclusive edits: `packages/observability-node/` except its manifest; Edge `src/bootstrap.ts`, `src/server.ts`, `src/app.ts`, `src/agent-runtime-client.ts`, new `src/observability.ts` if needed, `tests/observability.test.ts` and test-only fixtures. Do not edit manifests, locks or other services.

**Interfaces:** export `initializeTelemetry(options)` returning a handle with `shutdown(): Promise<void>` and a narrow request/client instrumentation interface documented in `index.d.mts`. Coordinator smoke imports the production `buildApp` and `createAgentRuntimeClient`; business dependencies are injected. Use explicit boundary instrumentation if safer than ESM auto-patching; no broad bundle.

- [ ] Read applicable instructions, existing app/client/server/tests and assertion schema. Send exact dependencies to coordinator immediately.
- [ ] Write focused failing tests. Example behavioral contract:

```js
const app = await makeInstrumentedTestApp({ exporter });
await app.inject({ method: 'GET', url: '/health?secret=CANARY', headers: { authorization: 'Bearer CANARY' } });
await telemetry.shutdown();
assert.equal(exporter.spans.some(s => s.name.includes('/health')), true);
assert.equal(JSON.stringify(exporter.spans).includes('CANARY'), false);
```

`makeInstrumentedTestApp` is a test-local helper constructing real production wiring with injected exporters; do not add test-only production routes. Also test public-context replacement, invalid traceparent, UUID independence, no exception events/messages, bounded labels, disabled/idempotent initialization and unavailable collector behavior. Record the initial failing output.
- [ ] Implement minimal SDK setup and safe exporter/log boundary. Initialize before server imports:

```ts
import { initializeTelemetry } from '@cso/observability-node';
const telemetry = initializeTelemetry({ serviceName: 'edge-api' });
await import('./server.js');
```

Adapt lifecycle ownership to expose graceful shutdown without duplicate signal handlers. Preserve signed UUID behavior. Propagate only to the configured Agent Runtime origin using a client span, not globally to providers. Sanitize console logging as well as OTLP records.
- [ ] Prove propagation with a real ephemeral HTTP receiver and child-process startup, not only `app.inject()`. Run focused Node tests and Edge typecheck. Report commands, red/green evidence and API signatures. Do not run other services' suites.
- [ ] Self-review and hand back files for independent review; no commit.

## Task 2: Python telemetry and Agent Runtime wiring

**Owner:** Sol medium Python worker. Exclusive edits: `packages/python-observability/` except manifest; `apps/services/agent-runtime/agent_runtime/main.py`, new `observability.py`, new `tests/test_observability.py` and test-only fixtures. Do not edit manifests, locks or Node files.

**Interfaces:** shared `initialize_telemetry(...)` returns a runtime with `shutdown()` and ASGI instrumentation attachment. The production `agent_runtime.main:app` remains importable. Coordinator smoke runs that app with fake graph dependencies and synthetic signed assertions. Standard `traceparent` is the only required cross-language wire contract.

- [ ] Read applicable instructions, existing main/router/auth/health tests and assertion schema. Send exact dependencies to coordinator immediately.
- [ ] Write failing behavior tests for disabled/no export, idempotency, success/error span creation, internal parent context, auth unchanged, safe log correlation, no headers/body/query/exception disclosure and bounded shutdown. Example:

```python
response = client.get('/health?secret=CANARY', headers={'authorization': 'CANARY'})
assert response.status_code == 200
runtime.force_flush()
assert any(span.name.endswith('/health') for span in exporter.get_finished_spans())
assert 'CANARY' not in serialize_exported_signals(exporter)
```

The serialization helper belongs in tests and must inspect events/status/logs as well as attributes. Record the expected initial failure.
- [ ] Implement SDK providers and application-owned ASGI boundaries without prompt/model instrumentation. Avoid generic exception recording. Use:

```python
with tracer.start_as_current_span(operation, record_exception=False, set_status_on_exception=False):
    await app(scope, receive, send)
```

Complete status/timing on response finish, mark sanitized failure codes on errors, and always clean up context. Resolve route templates, never raw user paths, for operation labels. Preserve health route and dependency overrides. Configure explicit resources without environment detectors exporting process arguments.
- [ ] Run focused tests and Ruff, then the Agent Runtime suite once code is settled. Tell coordinator how to inject the runtime/exporters for the cross-language check. No service restarts or paid requests.
- [ ] Self-review and hand back files for independent review; no commit.

## Task 3: Local backend, dependencies and integrated proof

**Owner:** coordinator. Files: dependency manifests/locks; `.env.example` additions; `infrastructure/observability/compose.yaml`, Collector filter config, Grafana provisioning/dashboard JSON; `tools/observability/` smoke harness/tests; `docs/observability/README.md`.

- [ ] Resolve official compatible SDK versions, pin dependencies and install serially. No global upgrade. Node dev/start use approved bootstrap; Python editable dependency maps to `../../../packages/python-observability`.
- [ ] Create a behavioral smoke harness first that starts ephemeral synthetic services with real production wiring. Use built-in missing-order-reference flow or fake graph dependencies; it must never use live credentials/models/Temporal. Assert HTTP success, a single shared trace ID, distinct parent/child span IDs and no canary content. Let it fail before the telemetry code exists.
- [ ] Add optional standalone Compose LGTM with an explicitly pinned image, loopback `3300:3000` and `4318:4318`, dedicated volume, optional usage reporting disabled and Collector attribute filtering. Check `docker compose ... config` before startup. Start only this new backend, never the entire project stack.
- [ ] Provision foundation panels with PromQL equivalent to:

```promql
sum by (service_name) (rate(cso_operation_completed_total[5m]))
histogram_quantile(0.95, sum by (le, service_name) (rate(cso_operation_duration_seconds_bucket[5m])))
```

Verify actual exported metric names before retaining queries. Add correlated Tempo and Loki navigation. Logs must be safe before Collector ingestion, not merely hidden by queries.
- [ ] Run the synthetic harness against local Collector; verify stored trace parentage, metric samples and correlated logs through backend/Grafana APIs. Inspect rendered dashboard and record actual timing evidence, clearly synthetic.
- [ ] Run relevant final tests/builds once, reuse unchanged worker results, perform scoped code review and fix defects with new regression coverage. Do not claim completion if Grafana data verification is blocked.
- [ ] Document start/stop, opt-in configuration, ports, data safety, test commands and deferred services. Link to the runbook from README. Update this ledger with actual checks and remaining limits. No commit or push.

## Progress ledger

Baseline: `69dc0354f626ec42bf84e28f8b76545579ad8c01`, branch `dev`. Existing untracked `.superpowers/` and observability spec preserved.

Ruling: use the owner's established dev checkout with exclusive paths rather than create a new branch/worktree; this preserves their requested workflow. Cost if wrong: integration conflicts must be resolved in the same checkout, so edit ownership is mandatory.

Ruling: implement the two independent language tasks in parallel as explicitly requested, overriding the subagent skill's generic sequential-worker default. Cost if wrong: cross-language integration rework; common signal and wire contracts are fixed above.

| Check | Result |
| --- | --- |
| Task 1 self-consistency | Real Edge/client transport tests cover bootstrap, propagation and safe export; no schema/auth changes |
| Task 2 self-consistency | Real ASGI tests cover parent propagation and safe export; public app import preserved |
| Tasks 1 and 2 | No shared editable files; W3C traceparent and signal fields are the shared contract |
| Tasks 1 and 3 | Coordinator owns manifests/locks; worker reports API for smoke |
| Tasks 2 and 3 | Coordinator owns manifest/lock; worker reports API for smoke |
| Task 3 self-consistency | Docker validation and stored signal checks establish local outcome; AWS excluded |

## Final verification ledger, 2026-09-16 local time

- [x] Node and Python implementation completed in exclusive paths by two Sol medium workers.
- [x] Independent Astra high review completed; all three Important findings and one Minor finding resolved and rechecked.
- [x] Node shared package: 4 passing tests.
- [x] Edge API: 91 passing tests, typecheck and build passed.
- [x] Agent Runtime: 197 passing tests; one existing Starlette/httpx deprecation warning. Focused Python telemetry: 12 passing tests (10 shared and 2 service tests).
- [x] Python telemetry and smoke lint/format checks passed; tracked diff whitespace check passed.
- [x] Real ephemeral cross-language smoke passed twice against the corrected local Collector. Latest trace `e4087f3c33caefe697be9e805ca62bf1`, three linked spans, all three signals, 401 auth rejection, canaries absent, synthetic request checks 44 ms.
- [x] Earlier successful trace `bc6963ced4e7b904ec335109ee30d5ad` retrieved from Tempo; both services' counters and exact histogram metric name retrieved from Prometheus; correlated fixed completion logs retrieved from Loki through Grafana APIs.
- [x] Dedicated pinned LGTM container healthy on loopback 3300/4318; no existing project service restarted. Real environment files/tokens unchanged. No model calls, refunds or Git mutations.
- [x] Runbook, examples, README, handoff and verification status updated. Removed unused Node SDK dependencies.
- [ ] Rendered dashboard visual check: browser login reached the first-password-change screen. Owner must choose a password; backend data/API verification is complete.
- [ ] Real service opt-in/restart and live request observation: deliberately deferred; existing services remain unchanged, dashboard traffic is synthetic.

Integration defects caught and corrected: Collector retry settings initially
failed validation; assigning `[]` to span events passed parsing but failed at
runtime, so events are now dropped with a dedicated filter processor. The smoke
receiver now handles Node's chunked OTLP transfer. Review found unbounded SSE
shutdown, startup telemetry failure isolation, Python SDK exception logging, and
span attribute naming; each received focused regression coverage/recheck.

No full platform observability completion claim: other services, model/RAG phase
metrics, business dashboards, alerting and AWS export remain later batches. No
LangSmith/Tau work or RAGAS reruns were performed.
