# RAG and commerce dependency tracing

Second local observability batch, approved 2026-09-16 (tests ran September 17 UTC).
This extends the existing SDKs rather than installing a second tracing system.
The changes are committed and pushed on `dev` as `8f976be`; the foundation is
on `main` through merge `cc36be6`, while this dependency batch is not yet merged.

## What a trace explains

```text
Agent Runtime
  knowledge.retrieve
    Knowledge/RAG POST /v1/customer-evidence
      rag.query_embedding
      rag.vector_search
      rag.keyword_search
      rag.fusion
      rag.rerank
  mcp.lookup_order
    Gateway POST /mcp (multiple MCP protocol requests)
      vendure.order_lookup
```

Each child has its own duration and parent span ID but shares the trace ID.
The existing Edge-to-Agent boundary links this to the customer request when all
participating processes opt in. Trace IDs are not signed tenant identities and
never authorize an operation. Existing assertion verification still applies.

The two Python dependency wrappers include response validation, so a malformed
or unauthorized response is not recorded as a successful operation. RAG phases
record static operation names, outcome and seconds without fake HTTP status codes.
Gateway retains actual provider HTTP status while marking a GraphQL application
error as failure, even when HTTP status is 200. No query, result, API key, order
reference or raw exception text is added to telemetry. Provider trace propagation
is disabled for Vendure; its existing provider API key remains unchanged.

## Main files and functions

| File | What changed |
| --- | --- |
| `packages/python-observability/cso_observability/bootstrap.py` | `operation()` wraps a static named phase; `trace_headers()` emits only W3C traceparent. Exceptions and cancellation remain exceptions. |
| Agent Runtime `integrations/customer_evidence.py` | `retrieve_customer_evidence()` wraps and propagates the RAG call, including response checks. |
| Agent Runtime `integrations/order_lookup.py` | `lookup_order()` wraps the actual MCP session and injects its trace parent without changing signed context. |
| Knowledge/RAG `main.py`, `observability.py`, `api.py`, `customer_evidence.py` | App-owned opt-in runtime, lifecycle and dependency wiring. Pure retrieval does not initialize global providers. |
| Knowledge/RAG `retrieval_service.py` | `retrieve()` times embedding, the two searches, fusion and reranking separately. |
| `packages/observability-node/index.mjs` | Internal server parent opt-in; Edge remains a fresh public root. Provider propagation opt-out and safe application-error classification. |
| Gateway `bootstrap.ts`, `server.ts`, `observability.ts`, `app.ts`, `mcp-routes.ts` | Initialize before serving, safe request completion including MCP's hijacked response, lifecycle cleanup. |
| Gateway `vendure-client.ts` | Times read-only order lookup, including safe semantic failure classification. Refund-write behavior is not changed. |
| `infrastructure/observability/grafana/foundation.json` | Adds new service logs and a RAG phase p95 panel. |

For example, if `rag.vector_search` is slow but `rag.query_embedding` is fast,
investigate OpenSearch before changing the embedding model. If the Gateway HTTP
request is fast but the provider span fails, inspect the safe error category and
provider availability rather than assuming the model failed.

## Repeat the synthetic proof

With Node 24 on PATH, dependencies installed and (optionally) the local LGTM
container running, from the repo root:

```sh
apps/services/agent-runtime/.venv/bin/python tools/observability/smoke.py --dependencies
apps/services/agent-runtime/.venv/bin/python tools/observability/smoke.py --dependencies --grafana
```

The harness starts ephemeral RAG and Gateway processes and uses the real Python
HTTP/MCP clients and real signed synthetic assertion checks. Embedding, search,
reranking and Vendure transport are deterministic test substitutes. No provider
credentials are inherited, no real model is called, and no refund is created.
The root synthetic span uses the SDK tracer directly in test code; it does not add
a test-only operation name to the production allowlist.

The first successful check produced trace `57861f3c7d064c9e03a3a933e2245e7d`:
14 linked spans, all three services' metrics/logs, canaries absent before export,
65 ms for the synthetic client checks. Tempo stored the full dependency tree.
This is trace-correlation evidence, not an actual OpenSearch/Vendure/model
performance benchmark or a completed live browser test.

The Grafana RAG p95 panel requires multiple periodic samples. A one-shot smoke
can leave rate-based panels empty; inspect the trace for individual timings.
Synthetic traces show fake dependency latency and should not set production SLOs.

Post-review repeat passed with 14 linked spans in 70 ms, trace
`4119c3de1c5ee4526936821287c4a438`. The later approved rollout recreated only
the observability container and retained its named volume. Browser verification
then showed the new RAG p95 panel and all four service series. Never use
`down -v` for a dashboard-only refresh.

## Enable in running services later

Gateway and RAG `.env.example` include the same
`CSO_TELEMETRY_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` and
`OTEL_SERVICE_VERSION` settings as the first two services. RAG must load these
before app import; Gateway dev/start uses its bootstrap. Use the service's own
name, not one shared name for all processes.

The approved local rollout enabled those settings in ignored `.env` files and
restarted only Edge API, Agent Runtime, Knowledge/RAG and Gateway. Each health
endpoint returned OK. A final safe dependency smoke produced 14 linked spans in
73 ms, all three signals, canaries absent and trace
`4f58122299800dbcdb7d256786b1b3d6` forwarded to Grafana. Signing secrets and
login tokens were unchanged. Paid model calls and refund execution still need
their own explicit approval.

## Limits and next batch

Model token/cost metrics, detailed model timing, Temporal activity and Human
Operations spans, business dashboards, alerting and AWS export remain pending.
LangSmith/Tau remain deferred and RAGAS results are unchanged. This batch does
not instrument every provider operation or replace durable refund audit records.
Gateway shutdown has bounded cleanup waits, not guaranteed bounded process
termination if another resource keeps the event loop alive.

Final checks and review results are recorded in `docs/VERIFICATION_STATUS.md`.
