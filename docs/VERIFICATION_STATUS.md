# Verification Status

Last updated: 2026-09-04

This file separates implementation, automated evidence, manual evidence, and work
that still needs proof. A feature existing in code is not the same as an end-to-end
production claim.

## Current verdict

The governed refund journey is implemented end to end in the local architecture.
The safe human-takeover path has been demonstrated manually, and focused automated
tests cover proposal, policy, workflow, Human Operations, Gateway execution,
provider outcomes, reconciliation, RAG, and browser projections.

One final positive browser-to-provider test remains pending. Until it passes, say:

> The refund journey is implemented and substantially tested locally; the final
> positive browser-to-provider verification is pending.

## Automated validation run on 2026-09-03

The documentation release was checked without starting application servers,
calling a paid model, or executing a refund.

| Check | Result |
|---|---|
| Protobuf lint and JSON contract tests | Passed, 21 tests |
| Edge API | Typecheck passed, 45 tests passed |
| Conversation Runtime | Typecheck passed, 25 tests passed, 1 optional PostgreSQL integration test skipped because `CONVERSATION_TEST_DATABASE_URL` was not set |
| Integration Gateway | Typecheck passed, 44 tests passed |
| Workflow Workers | Typecheck passed, 45 tests passed including Temporal workflow tests |
| Human Operations | Typecheck passed, 9 tests passed, 1 optional PostgreSQL integration test skipped because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was not set |
| Control/Knowledge | Typecheck passed, 12 tests passed |
| Agent Runtime | Ruff passed, 46 tests passed |
| Knowledge/RAG | Ruff passed, 101 tests passed |
| Customer, Operations, and Admin frontends | All typechecks and production builds passed |
| Markdown links and diff whitespace | Passed |
| Final architecture PDF | 192 pages, metadata checked, amendment and appendix transition visually rendered and inspected |

Total automated tests: 348 passed and 2 optional database integration tests
skipped. The Python suites emitted an upstream Starlette/httpx deprecation warning;
it is not a test failure but should be handled during a future dependency upgrade.

## Latest conversation-context verification on 2026-09-04

Commit `e5fbe50` (`Preserve customer context across refund chat turns`) fixes a
multi-turn customer-chat defect: the agent previously received only the latest
message, rather than the earlier customer-provided order reference.

| Check | Result |
|---|---|
| Edge API | Typecheck passed, 50 tests passed, including prior-reference propagation and ambiguous-reference rejection |
| Agent Runtime | Ruff passed, 49 tests passed, including ordered bounded conversation-context validation and graph propagation |
| Live local BFF sample | Passed. First turn supplied `AVV8JSZH8G6ZZDMX`; second turn supplied the damaged-item reason without repeating the reference; assistant retained the reference and did not ask for it again |
| Refund safety | The sample created a local review workflow only. No preview was confirmed and no refund execution was requested |

The live sample measured 20.68 seconds for the first Edge API message and 18.82
seconds for the second. Conversation persistence/read operations were 6.5–49.9
ms, local MCP Gateway calls were 268–291 ms, and the asynchronous Temporal
workflow completed in 356 ms. The Agent Runtime accounts for roughly 19–21
seconds because it includes configured model calls and RAG. Per-hop model and
retrieval timings are not yet instrumented with OpenTelemetry.

## Evidence matrix

| Area | Implementation | Automated evidence | Manual evidence | Current status |
|---|---|---|---|---|
| Customer login and BFF | Implemented | Route and UI checks | Local sign-in used | Verified locally |
| Conversation Runtime | PostgreSQL encrypted transcript, workflow links, and bounded customer-history handoff | Unit/integration tests | Two-turn customer context retained through Edge and Agent Runtime | Verified locally |
| Agent proposal | LangGraph typed refund proposal | Python tests | Real configured model exercised | Verified locally |
| Customer-safe RAG | OpenSearch hybrid retrieval and grounded answer | Retrieval/evaluation tests | Online retrieval returned customer-safe cited chunks | Verified locally |
| Deterministic policy | Versioned refund decisions | Worker tests | Seen in local workflows | Verified locally |
| Temporal workflow | Preview, confirmation, human review, execution, reconciliation | Unit/integration tests | Safe takeover path used | Verified locally |
| Human Operations | PostgreSQL cases, audit, idempotency, durable decision outbox | Service tests | Queue, claim, exceptional plan used | Verified locally |
| Integration Gateway | Vendure projection, MCP, refund authorization, idempotency, provider events | Service tests | Vendure refund previously observed | Verified locally |
| Final positive browser-to-provider path | Implemented | Focused paths covered | Fresh complete proof not yet recorded | Pending |
| Production auth, observability, event backbone, AWS | Planned | None | None | Not implemented |

## Known issue before the final positive test

The new multi-turn sample proved that the correct order reference reaches the
governed path. Its generated customer answer nevertheless rendered "item 3 in
order 3." This is a customer-copy defect, not proof of a wrong commerce lookup.
Before running the final positive test, pass the real order reference explicitly
to the answer-composer contract, constrain the generated wording, and add a
regression test that rejects an item number presented as an order identifier.

## Remaining positive end-to-end checklist

Use a new disposable fulfilled Vendure order. First fix the known answer-copy
issue above. Paid model use and a refund mutation must be explicitly authorized
for the test.

1. Confirm PostgreSQL, Temporal, OpenSearch, Vendure, all backend services, and both
   browser applications are healthy.
2. Generate fresh customer and staff local login tokens if needed.
3. Submit a damaged-item refund in the customer conversation.
4. Verify the conversation message is persisted and linked to the workflow.
5. Verify order facts come through the read-only MCP path and RAG returns only
   `CUSTOMER_SAFE` evidence.
6. If policy requires takeover, claim the case and approve an exceptional refund
   plan as a supervisor.
7. Verify the customer receives the exact current preview and explicitly confirms
   it.
8. Verify the browser does not call Vendure directly.
9. Verify Workflow Workers refresh facts and Integration Gateway performs one
   idempotent refund mutation.
10. Verify the customer first sees processing, not premature success.
11. Verify Vendure records the refund.
12. Verify signed provider outcome delivery or reconciliation moves the workflow
    to `REFUND_SUCCEEDED`.
13. Verify the Customer Portal shows completion and Human Operations closes the
    related case.
14. Inspect Temporal history, Human Operations audit, Conversation Runtime data,
    and Gateway evidence for matching tenant, environment, workflow, and request
    identifiers.

Record only non-sensitive identifiers and results. Never record tokens, secrets,
API keys, payment references, or customer personal data.

## What this verification does not claim

Local success does not prove production bank settlement, Cognito integration,
managed database recovery, Kafka delivery, distributed observability, multi-region
behavior, workload scaling, or AWS deployment. Those require separate deployment
and operational evidence.
