# Verification Status

Last updated: 2026-09-06

This file separates implementation, automated evidence, manual evidence, and work
that still needs proof. A feature existing in code is not the same as an end-to-end
production claim.

## Current verdict

The governed refund journey is implemented end to end in the local architecture.
The safe human-takeover path has been demonstrated manually, and focused automated
tests cover proposal, policy, workflow, Human Operations, Gateway execution,
provider outcomes, reconciliation, RAG, and browser projections.

The latest positive local browser-to-provider test passed through the damaged-item
photo gate on 2026-09-06. The earlier September 5 proof remains historical
evidence. The accurate current claim is:

> The positive local photo-gated exceptional-refund journey is verified from
> customer chat through a clearer-photo request, exact replacement-revision
> acceptance, same-case monetary takeover, supervisor approval, exact customer
> confirmation, one provider submission, and settlement of that existing local
> refund. Temporal and the customer projection reached completion.
> Production authentication, real webhook/bank settlement, delivery-age
> eligibility, observability, and other operational/failure scenarios still
> require separate work and evidence. The browser run also exposed an unsupported
> delivery-date question. The subsequent wording safeguard has automated
> verification (101 Agent Runtime tests passed), but no fresh paid live browser
> recheck has been run.

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

## Positive local browser-to-provider proof on 2026-09-05

The following are disposable local test identifiers, not reusable seed data:

| Evidence | Result |
|---|---|
| Order | `23NK4CXW6XYMA5NE`, Vendure order 6, one Laptop 15 inch 8GB, delivered |
| Requested and settled amount | USD 1,683.80, including USD 5.00 shipping |
| Workflow | `refund-8ab2c8c1-4ef0-4878-974a-4959c0342453` |
| Human case | `case-7f3833c0-16c9-4a3d-ac76-04f1d2592da6` |
| Confirmed preview | `b4114bda-5ca1-414e-8f5e-05910cfe072f`, accepted at 18:01:15.705 UTC |
| Conversation | Four committed messages, customer/assistant/customer/assistant; second customer turn omitted the reference, which the answer retained; one workflow-link idempotency record; encrypted messages matched their stored integrity hashes |
| Human review | `TAKEOVER_REQUIRED`, then assigned supervisor approved an exceptional refund plan; case audit `OPENED → CLAIMED → DECISION_RECORDED → CLOSED`; decision outbox `DELIVERED` |
| Execution | One `executeRefund` activity, attempt 1, zero activity failures; one Gateway execution row and one Vendure refund, ID 4 |
| Provider settlement | With separate owner authorization, existing simulated refund 4 was marked `Settled` at 18:06:25.273 UTC; no new refund was created |
| Gateway | `SUCCEEDED` at 18:11:20.967 UTC; audit `requested → submitted → succeeded` |
| Temporal | Completed with `REFUND_SUCCEEDED` at 18:11:21.018 UTC, matching refund 4 and the confirmed amount |
| Customer browser | Automatically changed from **Refund initiated** to **Refund completed**, with **No action is needed** and USD 1,683.80 |
| Completion mechanism | Normal reconciliation, not a forced success signal; zero provider webhook events |

Trusted facts were refreshed after exceptional approval and immediately before
execution. Human claim and decision records each contain an idempotency key and
request fingerprint. The staff role is checked by the decision route; this audit
does not claim the database separately stores the role claim.

The dummy payment handler does not automatically settle refunds. This test
simulated the provider's final confirmation in Vendure and waited for the next
five-minute reconciliation check. No real bank transfer occurred. The order is
now refunded and must not be reused for another positive execution test.

## Photo-gated local browser-to-provider proof on 2026-09-06

This later owner-authorized run closes the prior gap between the photo-gate
smoke and positive provider execution. These are disposable local test records,
not portable seed data or production transactions:

| Evidence | Result |
|---|---|
| Order | `AUUYAWRHBVGJPK5R`, Vendure order 2, two Laptop 13 inch 8GB units |
| Scope and amount | Full order, USD 3,122.60 |
| Workflow | `refund-19928c34-afd6-4e0a-b709-29d8ca36381a` |
| Human case | `case-8307800e-a61c-4295-bfad-d118931137b7` |
| Photo review | First photo passed technical validation; staff requested a clearer photo; the replacement was accepted at its exact evidence revision |
| Monetary review | The same case changed from evidence review to monetary takeover; a supervisor separately approved the exceptional refund plan |
| Customer confirmation | Exact preview `724a34e6-f044-448e-817d-a17d02fa7dac` confirmed |
| Provider submission | Gateway created exactly one Vendure refund, ID 5, initially `Pending` |
| Provider settlement | Separate owner authorization changed existing refund 5 to `Settled`; no second refund was created |
| Final workflow | Temporal reached `REFUND_SUCCEEDED` |
| Final customer projection | `REFUND_COMPLETED`, with no customer action |

Technical image validation, staff acceptance of the exact photo set, supervisor
monetary approval and customer confirmation remained distinct gates. This run
proves the local photo-gated path to the Vendure simulator's settled refund state;
it does not prove real bank settlement or live payment-provider webhook delivery.
Do not reuse this now-refunded order for another positive execution test.

The successful browser run still generated an unsupported request for the
delivery date. The subsequent wording safeguard is implemented and automatically
verified as recorded below; a fresh paid live browser recheck has not been run.
The successful refund outcome does not establish trusted delivery-age eligibility,
which remains unimplemented.

## Order-contract recovery verification on 2026-09-06

Vendure's manual fulfillment returned an empty method string. That provider
shape violated the nonempty method expected by the order contract. Gateway now
normalizes blank provider methods to `unspecified`; it does not invent a carrier
or delivery date. Edge now maps the typed `order_lookup_unavailable` result to a
customer-safe, retryable HTTP 503 response.

| Check | Recorded result |
|---|---|
| Integration Gateway | Typecheck passed; all 44 tests passed |
| Edge API | Typecheck passed; all 83 tests passed |
| Agent Runtime (earlier September 6 order-contract checkpoint) | Ruff passed; all 98 tests passed, with one upstream warning |
| Live order lookup | Signed REST and MCP lookup passed |

These focused/full checks belong to the earlier September 6 order-contract
checkpoint. The subsequent wording-safeguard result is recorded separately below.
No additional model/provider request was made to prepare this documentation
update.

## Delivery wording safeguard verification on 2026-09-06

After the browser proof, `SYSTEM_PROMPT` was updated to forbid asking for a
delivery date or stating a delivery-age window. Runtime defense-in-depth rejects
either wording, allowing the existing graph to use its safe fallback. The full
Agent Runtime suite passed **101 tests**, with the same one upstream warning.

This is automated verification of the implemented safeguard, not a repeat of the
live journey: a fresh paid live browser recheck has **not** been run. Trusted
delivery-age eligibility remains unimplemented; neither a model question nor a
customer answer supplies trusted delivery facts.

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
| Private photo gate | Implemented for policy v2 | Contract, service, revision, ownership and workflow tests | Clearer-photo request and exact replacement acceptance before monetary takeover | Verified locally on 2026-09-06 |
| Positive local browser-to-provider path | Implemented | Focused paths covered | Photo-gated exceptional-refund proof recorded above: one refund, settlement of that same refund, completed workflow/customer projection | Passed locally on 2026-09-06 |
| Production auth, observability, event backbone, AWS | Planned | None | None | Not implemented |

## Display cleanup validation on 2026-09-05

The customer page now displays **Original payment method** instead of the raw
destination enum. **Review by** appears only while confirmation is the next
action. The original preview, amount, confirmation payload, and timeline are
unchanged.

| Check | Result |
|---|---|
| Customer display helpers | 7 regression tests passed: known and unknown destinations, deadline visibility, and unchanged normalized preview/amount |
| Customer Portal | Typecheck and production webpack build passed |
| Agent Runtime | Ruff lint and 97 tests passed; the four locally changed Python files pass the formatter check |
| Shared contracts | Protobuf lint and 21 JSON contract tests passed |
| Existing completed customer page | Shows USD 1,683.80, **Original payment method**, **Refund completed**, and **No action is needed**; no **Review by** |
| Documentation | 26 local links checked across 10 changed Markdown files; diff whitespace check passed |

This targeted rerun totals 125 passing tests; it is not a fresh full-stack
regression run. No additional model call, confirmation, refund, or provider
mutation was performed during the display check.

The full Agent Runtime formatter check found existing formatting differences in
`agent_runtime/integrations/customer_evidence.py`,
`agent_runtime/integrations/trusted_context.py`, `agent_runtime/refund/router.py`,
and `tests/test_customer_evidence.py`. These unrelated files were left unchanged.
The test suite also emits an upstream Starlette/httpx deprecation warning. The
native Node test runner emits a module-type warning; neither warning failed tests.

## Answer-composer regressions fixed before the positive test

The local answer path now receives trusted public order references and product
names instead of internal IDs. Conflicting order labels trigger safe fallback.
The model no longer receives the proposed amount as raw minor units; common
monetary expressions in its prose are rejected and application code appends the
formatted proposed USD amount. The underlying structured proposal is unchanged.

Agent Runtime Ruff and all 97 tests passed on 2026-09-05, including order-reference,
money formatting, safe-fallback, and graph regressions. The real two-turn browser
test retained the reference and displayed the correct USD 1,683.80. These fixes
were in the local working tree during the proof; inspect Git before assuming
they are committed or available in a fresh clone.

At this checkpoint the remaining gaps included generated technical field labels,
missing photo intake/gating, delivery-age checks and a premature preview timeline
step. The later photo slice and timeline fixes below address intake/gating and
that timeline defect. Broader generated-wording evaluations and delivery-age
eligibility remain gaps; the September 6 delivery wording safeguard has the
separate automated verification recorded above.
The confirmation-expiry gap identified during this review was implemented in the
follow-up below. Hiding the displayed deadline remains presentation only; the
authoritative guard is in Temporal.
Bounded wording guards do not replace answer, citation, specialist, trajectory,
and safety evaluations.

## Confirmation expiry implementation and verification on 2026-09-05

`waitForRefundConfirmation()` is shared by allowed, approval-required, and
supervisor-exceptional paths. It accepts only the first matching confirmation
processed before `validUntil` on the workflow clock, ignores the supplied
`confirmedAt` for authorization, and times out when no decision arrives. Invalid
or already expired deadlines fail closed as `PREVIEW_INVALIDATED`. Timely
acceptance is not invalidated by later human review or provider-processing delay;
the existing authoritative fact refresh and balance checks still apply.

Edge checks ownership first, rejects stale/terminal preview confirmations with
HTTP 409 `refund_preview_unavailable`, and handles a workflow-completion race
without disguising infrastructure errors. HTTP 202 is signal acknowledgement,
not proof that a confirmation or refund was accepted. The customer projection
offers no confirmation on an unavailable preview and does not expose raw facts.

| Check | Result |
|---|---|
| Workflow Workers | Typecheck and all 58 tests passed |
| Edge API | Typecheck and all 64 tests passed |
| Customer Portal | Typecheck, 8 tests, and production webpack build passed |
| Shared contracts | Protobuf lint and 21 JSON contract tests passed |

Total for this feature: 151 passing tests. The initial backdated-confirmation
regression failed on the old code (`REFUND_SUCCEEDED` instead of
`PREVIEW_INVALIDATED`) and passed after the fix. Exact before/at/after boundaries
are covered by the same pure deadline predicate used in the workflow handler.
Workflow tests cover all three timeout paths, malformed/old deadlines, wrong
preview IDs, duplicate decisions, timely decline, delayed approval/settlement,
timer survival across worker replacement, and replay of patched and synthetic
pre-patch histories. Legacy histories are generated with both expiry patches
disabled in the isolated test worker, not by modifying real workflow history.

The time-skipping server stalled on sticky-worker replacement in the first test
attempt. The test harness now disables the worker cache, checks that the timer is
persisted before replacement, and surfaces worker failures. The restart and full
suite reruns passed; production worker settings were not changed.

### Rollout limits

- Newly created waits schedule a durable expiry timer.
- Pre-patch waits that were already parked remain replay-compatible. Their next
  live confirmation is deadline-checked by the new worker, but an idle legacy
  wait does not acquire a timer retroactively. An authorized inventory/migration
  is still needed for universal autonomous expiry coverage.
- For v1, preview expiry inherits the original policy decision deadline; late
  exceptional approval cannot extend it. The later photo-gated v2 exceptional
  path obtains fresh accepted evidence and commerce facts and reevaluates its
  pinned policy before creating a confirmation preview.
- The initial feature check made no model/provider calls or production changes.
  The later synthetic browser expiry proof and authorized token renewals are
  recorded below. No legacy project workflow was migrated.

### Follow-up browser expiry proof

On 2026-09-05, isolated fixture
`refund-expiry-smoke-c1f4c829-1d97-4559-b6cd-61665c704b61` showed a USD 50.00
preview with confirmation controls, then automatically changed to **Refund
preview no longer available** at its deadline, without clicking or reloading.
The deadline was `2026-09-05T22:26:40.836Z`.

- Edge workflow and journey reads returned 200, with `PREVIEW_EXPIRED` in the
  customer projection and no confirmation action.
- A late confirmation returned 409 `refund_preview_unavailable`.
- History recorded the durable timer and expiry patch marker, zero confirmation
  signals and zero scheduled/attempted refund executions.
- The dedicated test worker stayed alive for a three-minute inspection window,
  then stopped. Querying this completed fixture later requires a worker on its
  unique queue; a 502 after the hold is not evidence that the main stack is down.

Both local login tokens were renewed with existing identity/role/signing secrets.
Customer expiry: `2026-09-07T22:05:40Z`; staff expiry:
`2026-09-07T22:30:56Z`. Both browser sign-ins were verified. Only the effective
ignored web environment files changed; no token or secret is recorded here.

## Private photo evidence verification on 2026-09-05

See [Refund Photo Evidence](REFUND_PHOTO_EVIDENCE.md) for setup and code reading
order. New damaged-item requests pinned to v2 wait for assigned staff acceptance
of a private photo revision. That acceptance does not authorize money.

| Changed boundary | Passing tests | Other checks |
|---|---:|---|
| JSON contracts | 91 | Strict public/internal schemas, rejected private fields |
| Edge API | 81 | Typecheck; owner-first upload/content checks and timeline regressions |
| Workflow Workers | 74 | Typecheck; replay, confirmation, frozen revision, collection expiry, continue-as-new deadline |
| Human Operations | 23 | Typecheck; isolated PostgreSQL, zero skipped tests |
| Customer Portal | 21 | Typecheck and production build |
| Operations Console | 7 | Typecheck and production build |

The Human Operations database tests used a dedicated temporary cluster and the
restricted `cso_human_operations_app` role with both `rolsuper=false` and
`rolbypassrls=false`. Unscoped/cross-tenant reads were invisible and cross-scope
writes were denied. Five photos followed by `REQUEST_MORE_EVIDENCE` preserves the
old files/audit, opens a fresh current set, and rejects acceptance of an old
revision. Corrupt/missing accepted file bytes fail closed. The test cluster was
stopped without deleting its directory; the project database was not replaced.

Human Operations migration 003 was applied locally. Private normalized file
storage and non-destructive stale-upload recovery are configured. Automatic
retention deletion remains disabled pending owner-approved retention rules.

The live integration smoke passed with workflow
`refund-evidence-smoke-54f4e4a3-8856-49be-b37b-467345b1681d` and case
`case-a37c5535-b3e8-4673-80e1-9afc5b6ac162`. It used real Temporal, Edge and Human
Operations APIs, the real activity factory and policy v2, and generated PNGs.
Commerce facts were synthetic; no model or provider calls were made.

- Owner-mismatched journey, upload and image requests returned 404.
- Upload replay was idempotent; customer and claimed-staff image reads were
  private and decoded as the expected normalized PNGs.
- Staff requested clearer photos, then accepted the exact replacement revision.
  The superseded image was excluded from the accepted set.
- The same case became `REFUND_TAKEOVER`, clearing its evidence-phase assignment.
  The supervisor reclaimed and rejected it as safe test cleanup.
- Three fact refreshes were observed across the fixtures. No confirmation signal,
  refund execution, or reconciliation was scheduled or attempted.
- Browser inspection showed the photo input, private photo rendering and evidence
  acceptance message; the unclaimed staff case showed only claim controls, not
  monetary actions. Upload/review mutations in this smoke were driven by HTTP,
  not manual browser clicks.

Final review also fixed and tested two lifecycle defects: accepted evidence cases
are closed if an approval preview expires or is declined; aborted uploads release
their capacity exactly once, but active processing retains capacity until it
settles. Four real-socket tests cover disconnect/timeout/authorization races.

All 297 tests in the changed-boundary table pass. Edge, Human Operations and
Workflow Workers were restarted with the final code. Edge's ignored local
configuration now pins **new** requests to `refund-policy-v2`; existing workflow
versions are untouched. All 12 service/interface HTTP probes returned 200 and the
Workflow Worker reported RUNNING. No Git commit, push, merge, model call, or
provider refund execution was performed in this follow-up. Synthetic cases,
photos and workflow histories are retained for audit; their IDs distinguish them
from real requests.

## Repeatable positive end-to-end checklist

The September 6 photo-gated proof is complete. Use this checklist for future regressions with
a new disposable delivered Vendure order. Paid model use and refund/provider
mutations must be explicitly authorized for that test.

1. Confirm PostgreSQL, Temporal, OpenSearch, Vendure, all backend services, and both
   browser applications are healthy.
2. Generate fresh customer and staff local login tokens if needed.
3. Submit a damaged-item refund in the customer conversation.
4. Verify the conversation message is persisted and linked to the workflow.
5. Verify order facts come through the read-only MCP path and RAG returns only
   `CUSTOMER_SAFE` evidence.
6. For a damaged-item v2 request, upload a photo and have assigned staff review
   the exact revision. Exercise a clearer-photo request and replacement upload;
   verify the superseded set cannot be accepted. Only after evidence acceptance,
   reclaim the same case in its monetary phase and approve the exceptional refund
   plan as a supervisor when policy requires takeover.
7. Verify the customer receives the exact current preview and explicitly confirms
   it.
8. Verify the browser does not call Vendure directly.
9. Verify Workflow Workers refresh facts and Integration Gateway performs one
   idempotent refund mutation.
10. Verify the customer first sees processing, not premature success.
11. Verify Vendure records exactly one refund. If the dummy provider leaves it
    `Pending`, separately authorize and settle that existing refund with a clearly
    local test transaction ID. Do not invoke another refund to finish settlement.
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
and operational evidence. The positive runs also do not establish live webhook
delivery, all duplicate/replay/concurrency behavior, all rejection and failure
branches, or delivery-window eligibility. The September 6 run proves local
Vendure execution through the photo gate, not real provider/bank settlement.
OpenTelemetry/observability, production auth and AWS remain unimplemented.
Confirmation expiry tests do not prove automatic migration of legacy parked
waits. The delivery-date/window wording safeguard is implemented and passed the
101-test Agent Runtime suite; a fresh paid live browser recheck has not been run.
