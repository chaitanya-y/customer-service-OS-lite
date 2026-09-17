# Codex Handoff

Last updated: 2026-09-16

Latest local work: the owner approved the first observability foundation batch.
Edge API and Agent Runtime now have opt-in safe OpenTelemetry instrumentation;
a separate loopback-only Grafana LGTM backend runs on 3300 with OTLP HTTP on
4318. The synthetic integration check stored linked spans, metrics and correlated
logs without paid calls or refunds. See [the observability runbook](observability/README.md)
and [implementation ledger](superpowers/plans/2026-09-16-observability-foundation.md).
These changes are uncommitted on dev based on `69dc0354`; existing project
services and real environment files were not changed or restarted. RAGAS results
are unchanged; LangSmith, Tau and later observability batches remain deferred.
Historical Git checkpoints below are not the current worktree status.

Git checkpoint: code commit `87ab48f` is pushed to `dev` and is included in
pushed `main` merge `97028db`. Both branches had identical code trees at this
checkpoint. Verification on merged `main` recorded 586 passing tests and four
optional Human Operations database skips across five changed services. See
[Verification Status](VERIFICATION_STATUS.md) for exact scope and warnings.
This documentation follow-up does not authorize another commit, push or paid run.
Older dated paragraphs below describe their checkpoint, not current Git state.

Latest evaluation checkpoint: two approved Sol workers completed one live v4
large-refund trial and independent preparation for the remaining v3 owner review.
The trial executed successfully but failed the blocking reviewed-policy answer
check: correct policy/facts were present, but the answer stayed generic and
retained one RAG citation instead of the required USD 750/500 explanation.
Faithfulness/recall were 1.0, relevance 0.5704 and factual precision 0.33. The 122-second
run used 27,907 tokens across 15 successful recorded SDK invocations. No retries,
refunds, code changes, secret/token renewals, service restarts or Git mutations
occurred. Purpose selection was not retained, so the exact cause is not proven.
Read [the measured checkpoint](evaluation/RAGAS_CLOSURE_REVIEW.md).
Owner review/calibration remain incomplete; no LangSmith export or Tau run started.

Preceding local evaluation follow-up: the approved source-aware v4 change is
implemented and the full Evaluation Runner suite passed **268 tests**. Only the
large-refund case changes from v3; its application-owned USD 750/500 comparison
has a blocking reviewed-policy grader instead of requiring a RAG citation.
Preflight checks configured policy version, limits and amount/band before clients;
the grader verifies catalog hash, independent facts, exact wording and no invented
citations. A model-selected purpose is not an exemption. Historical fixtures,
graders and scores are unchanged. No paid trial, service/token operation, refund
or Git mutation occurred. Read [the v4 guide](evaluation/RAGAS_V4_POLICY_ANSWER.md)
for the files, functions, example and remaining boundary. Live v4 reliability
and human calibration are not yet established.

Preceding local implementation: the owner approved the trusted policy explanation
and concise-answer design. All four tasks are implemented locally: shared v1/v2
catalog, agent-specific signed policy binding, prompt v9 purpose-aware
presentation and optional Evaluation Runner policy wiring.
Edge, Agent Runtime and Workflow Workers use the same policy bytes; monetary
comparisons are application-owned and cannot approve a refund. The public answer
contract and policy thresholds are unchanged. No new manual token is needed.
Final fresh checks passed 195 Agent Runtime, 243 Evaluation Runner, 86 Edge,
29 workflow-policy and 97 shared/contract tests: 650 total, plus eight
Node-to-Python compatibility vectors. Changed-file lint/format and both Node
typechecks/builds passed. The two stale v8 test expectations found during
integration were updated; the subsequent full suite is green. No paid rerun,
token/service operation, refund or Git mutation occurred. See
[the plan](superpowers/plans/2026-09-14-trusted-refund-answers.md).

Earlier local code checkpoint: after reviewing the v3 findings, the owner approved
a bounded answer-validator fix and independent evaluation regression batch.
The uncommitted patch accepts punctuation-equivalent trusted references, rejects
the missed personalized-denial wording, and adds source-validated policy framing
with narrowly supported incorrect OR missing alternatives. Essential conditions,
money authorization, prompt v8 and the pinned dataset remain unchanged.
Fresh offline results: 161 Agent Runtime and 240 Evaluation Runner tests passed
(23 new cases), with changed-file lint/format checks. No paid rerun, token/server
change, refund, commit or push occurred. See the final section of
[the v3 report](evaluation/RAGAS_V3_BASELINE.md) for functions, examples and limits.
The trusted USD 500 comparison and shorter context-specific footer were deferred
at that checkpoint; the subsequent approved batch above implements them. Neither
offline change establishes improved live scores.

Campaign checkpoint: the authorized v3 campaign completed on September 14 as
`refund-ragas-v3-campaign-20260914-001`: 15 attempted trials, five scored answers,
ten validator rejections and zero cases passing all three repetitions. All 95
recorded provider invocations succeeded, with 204,047 measured tokens; dollar
cost is unknown. This is not token expiry or a passing release baseline.
See [the v3 report](evaluation/RAGAS_V3_BASELINE.md) for exact outcomes, private
artifact hashes, offline rejection replay and human-review questions. Application
code and guards were unchanged. Do not launch another paid run automatically.

Next: review the actual answers and validator false positives with the owner,
record human/judge disagreements, and freeze the measured baseline. Human ratings
and independent calibration are not complete. Tell the owner before starting
LangSmith; no export or Tau run has happened. Fixes to the answer boundary are
separate scoped work requiring approval. The entries below preserve earlier
checkpoints, not a request to repeat the completed campaign.

Earlier checkpoint: the approved offline dataset v3 preparation is complete.
`refund-rag-answer-v3.json` retains the damaged-item reference and applies the
four owner-approved, source-aligned reference corrections. Historical v1/v2,
development/held-out fixtures, the answer prompt and all guards are unchanged.
Diagnostic capture accepts v3 only at its exact built-in path and SHA-256.
Evaluation Runner passes **232 tests**, lint and formatting (42 Python files).
These are offline tests, not live model trials or human calibration.

The latest authorized live trial, `refund-ragas-v8-20260913-001`, failed before
grading because its 30-day instruction lacked general-policy framing and
refund-reason scope. Usage was 4,129 tokens, two calls and zero judges/refunds.
The earlier v7 failed on a personalized eligibility conclusion; v6/v2 has one
completed, uncalibrated trial. No v3 scores exist. Stop prompt-only retry loops.

At that earlier checkpoint, the proposed next step was approval for a v3 campaign (five cases times
three repetitions, including private synthetic rejection capture), then review
the actual answers with the owner and report failures, scored coverage and
semantic results separately. Fifteen trials is not a provider-call or cost cap;
judge SDK retries are not explicitly disabled. Do not treat missing scores as
zero, compare v3 with v2 as an improvement, or claim reference approval is judge
calibration. A hybrid composer redesign is separate work. After the bounded
baseline report, proceed to LangSmith and then Tau without requiring a perfect
score first. No paid calls, service/token changes or Git writes were authorized
by the offline v3 implementation approval.
See `VERIFICATION_STATUS.md`, the Evaluation Runner README and
`docs/evaluation/RAGAS_DATASET_REVIEW.md` for exact evidence and the next boundary.

Earlier checkpoint: an authorized September 13 v2 trial completed on prompt v6:
context precision/recall and faithfulness scored 1.00, response relevancy 0.4407,
and factual correctness 0.56. It recorded 36,946 tokens with no rejection or
refund action. After review the owner approved a focused `refund-answer-v7`
prompt update. The guard and RAG references are unchanged. Agent Runtime passes
143 tests and Evaluation Runner 221 at that checkpoint. The later v7 rejection
and v8 failure are recorded above; neither produced semantic scores.
See the current `VERIFICATION_STATUS.md` entry for artifacts, the pre-existing
Agent Runtime formatting warnings and the explicit next-trial approval boundary.

Earlier checkpoint: the September 13 offline batch added a separate one-case
agent retrieval-outage dataset and three tests. Evaluation Runner now passes
221 tests with lint/format clean. This covers real-graph intake fallback with
synthetic dependencies, not full Temporal/provider evaluation. The read-only
diagnostic review confirmed that the live CLI can call judges if its answer
passes; it has no answer-only mode. No paid retry, guard fix, RAG reference edit
or human calibration occurred. Read the current entry in
`VERIFICATION_STATUS.md` before resuming; the later v7 failure was captured and
diagnosed, but the earlier uncaptured response cannot be reconstructed.

## Start here

This is the shortest reliable handoff for a new Codex account or engineer. The
repository itself is the durable source of context; chat history is supplementary.

For evaluation work, use the [evaluation entrypoint](evaluation/README.md) for
the current frozen baseline, exact measured limits, and the safe reading order.

Read in this order:

1. `AGENTS.md` for working rules and safety invariants.
2. `README.md` for the product and current status.
3. `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md` for the current HLD and LLD.
4. `docs/PROJECT_CONTEXT.md` for detailed implementation history and commands.
5. `docs/LOCAL_AUTH_AND_SECRETS.md` before touching any token or `.env` file.
6. `docs/VERIFICATION_STATUS.md` before claiming the refund journey is complete.
7. `docs/LOCAL_REFUND_RUNBOOK.md` when starting or testing the stack.

Before delegating, follow [the multi-agent working agreement](MULTI_AGENT_WORKING_AGREEMENT.md).
Default to one coordinator and one worker, use scoped briefs, and agree on
time/usage checkpoints. Bounded workers follow its scoped reading rules rather
than repeating this entire onboarding list. This does not authorize spawning
agents without approval for the current batch.

## Repository state at this handoff

- Repository: <https://github.com/chaitanya-y/customer-service-OS-lite>
- Development branch: `dev`
- Stable integration branch: `main`
- Commit `e5fbe50` (`Preserve customer context across refund chat turns`) contains
  the verified conversation-context regression fix and its tests. It and the
  September 5–6 answer, photo-gate, order-contract and UI updates are ancestors
  of the September 14 pushed checkpoint above. The later evaluation work is
  included in `87ab48f`. Inspect current Git status before changing files;
  recorded branch pointers are a dated snapshot, not permission for Git writes.
- At the checkpoint, `.superpowers/` remained untracked and was deliberately
  excluded. Preserve it; local runtime artifacts are not release documentation.
- Local process, database, OpenSearch index, browser-session, and `.env` state
  are machine-local. A new account must follow the runbook rather than assuming
  that a currently running local server or token exists.
- Never assume local `.env`, Vendure data, OpenSearch indexes, or generated login
  tokens exist in a fresh clone.

## What the project is

Customer Service OS Lite is a production-shaped learning platform for creating,
governing, operating, and eventually deploying customer support agents. The first
walking skeleton is a complex refund journey rather than a collection of demos.

It combines:

- Next.js customer and Human Operations interfaces;
- Node.js/TypeScript Edge, Conversation, Workflow, Integration, and Human
  Operations services;
- Python/FastAPI LangGraph Agent Runtime and Knowledge/RAG service;
- OpenSearch hybrid retrieval with BM25, vectors, metadata filtering, RRF, and a
  cross-encoder reranker;
- read-only MCP commerce tools;
- deterministic versioned refund policy;
- Temporal durable workflow, confirmation, approval, takeover, execution, and
  reconciliation;
- PostgreSQL persistence for conversations, integration evidence, and Human
  Operations;
- a local Vendure commerce system.

## Current important truths

Human Operations is durable locally. The running service constructs
`PostgresHumanCaseRepository`. It stores refund cases, append-only audit events,
idempotency records, and pending decision outbox records transactionally. A retry
loop delivers pending decisions to Temporal. The in-memory repository is retained
for tests and dependency injection only.

The centralized Model Gateway is not implemented. Agent Runtime currently calls
its configured OpenAI models directly. `MODEL_ROUTE_ID` is evidence metadata, not
proof that a routing gateway exists. The planned gateway will centralize routing,
budgets, allowlists, fallback, provider credentials, latency/cost telemetry, and
model-policy audit.

The architecture PDFs remain useful, but they are not all current. The original
combined HLD/LLD is preserved as a baseline appendix. The authoritative changes are
in `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md` and at the front of the final
combined architecture PDF.

## Verification status

The latest positive local browser-to-provider test passed through the photo gate
on 2026-09-06. Disposable order `AUUYAWRHBVGJPK5R` (Vendure order 2) contained two
Laptop 13 inch 8GB units; the full-order refund was USD 3,122.60. The first photo
passed technical validation, staff requested a clearer photo, and the replacement
was accepted at its exact revision. The same case then moved to monetary
takeover, a supervisor approved the exceptional plan, and the customer confirmed
preview `724a34e6-f044-448e-817d-a17d02fa7dac`.

Workflow `refund-19928c34-afd6-4e0a-b709-29d8ca36381a` and case
`case-8307800e-a61c-4295-bfad-d118931137b7` led to exactly one Gateway-created
Vendure refund, ID 5, initially `Pending`. Separately owner-authorized settlement
changed that existing refund to `Settled`; no second refund was created. Temporal
reached `REFUND_SUCCEEDED`, and the customer projection reached
`REFUND_COMPLETED` with no action. This is simulator evidence, not real bank
settlement or a live webhook proof. The earlier September 5 non-photo-gated
proof, refund 4 for USD 1,683.80, remains recorded as historical evidence.

Read `docs/VERIFICATION_STATUS.md` for the exact synthetic identifiers, audit
evidence, historical test runs, and remaining production limitations. Do not reuse
either now-refunded order for another positive execution test.

The September 6 browser run generated an unsupported delivery-date question. Its
initial blanket window safeguard later blocked September 7 RAGAS trials before
semantic grading (`DELIVERY_AGE_TEXT_REJECTED`). The September 10 correction
distinguishes supported, cited general policy explanations from personalized
eligibility decisions, and appends an application-owned qualification. Date
requests and unsupported/personalized claims remain prohibited. Trusted
delivery-age eligibility is still unimplemented. A fresh paid browser recheck
remains pending. A one-case v6 synthetic RAGAS run now exists, but it is not a
calibrated or production baseline; see `docs/evaluation/RAGAS_BASELINE_REVIEW.md`
and the latest verification entry.

Evaluation code is now committed and pushed in `87ab48f`: five owner-approved v3
RAG answer references, seven deterministic intake/proposal cases plus a separate
retrieval-outage case, RAGAS adapters, repeated trials, usage reporting and baseline
comparison. This is not full workflow evaluation or a completed public benchmark.
The immediate priority is evaluation before observability;
LangSmith, full workflow simulations and the public benchmark adapter remain
future steps.

An earlier offline follow-up added 10 development and 5 held-out RAG cases (all
new references pending owner review), a source/split manifest, optional measured
usage/cost sidecars, and evaluator/judge-compatible regression comparisons with
system-error transitions. The original five seed cases are unchanged. Evaluation
Runner's combined suite passed 208 tests; this is tooling coverage, not 208 live
AI trials. The one completed real RAGAS case and its unresolved human-review
questions remain in `docs/evaluation/RAGAS_BASELINE_REVIEW.md`. Follow the latest
`VERIFICATION_STATUS.md` entry and service README before proposing paid work.

September 12: the owner approved a source-aligned damaged-item reference in
`apps/services/evaluation-runner/fixtures/evaluation-datasets/refund-rag-answer-v2.json`.
Only that reference and the dataset version changed; historical v1 and its live
result remain intact. At that checkpoint a completed v2 baseline was still pending: the authorized
run `refund-ragas-dataset-v2-20260912-001` failed with
`DELIVERY_AGE_TEXT_REJECTED` before any judges ran. Query embedding and answer
generation succeeded; the usage sidecar measured 3,966 tokens, with cost unknown.
The exact rejected answer was not saved. Do not infer its wording or treat this
as a token-expiry issue. See `VERIFICATION_STATUS.md` for durable evidence.

The earlier offline diagnostic extension accepted only the exact path/content pins
for v1 and v2, keeping rejected responses private and unscored. Its focused suite
passed 39 tests and the full Evaluation Runner suite passed 218 tests, with lint
and formatting clean. This does not fix the live rejection or produce new scores.
Read the current Evaluation Runner README and verification entry before using it.
The new
`docs/evaluation/RAGAS_DATASET_REVIEW.md` prepares review of the five seed and
15 candidate cases without editing their references or filling human approvals.
That checkpoint's next action was to capture one v2 response with separate
permission and reproduce the rejection offline. That work is now recorded above;
follow the latest v3 checkpoint instead. Neither reference approval nor
diagnostic implementation authorizes a paid retry or guard change.

The September 10 evaluation-only follow-up now separates `application_facts`
from retrieved policy. The facts are snapshotted from validated synthetic input,
never generated answer text. Faithfulness sees both sources; factual correctness
uses precision against the reviewed reference plus independent facts. Retrieval
precision/recall are unchanged. Grader v2 prevents direct comparison with v1.
All 158 Evaluation Runner tests, lint and formatting passed at that offline
checkpoint. A separately authorized September 10 trial then failed before
grading: `refund-ragas-baseline-20260910-001` recorded `SYSTEM_ERROR` and no scores.
The separately authorized answer-only diagnostic captured "Ensure your request
is within 30 calendar days of delivery." The cited policy supported the duration,
but the answer guard rejected this personalized, unqualified wording. No refund
was executed. See the verification status for the attempt IDs and timings.

The earlier September 11 follow-up added allowed/disallowed examples in prompt
`refund-answer-v5` without changing the guard. Its authorized live trial still
failed with `DELIVERY_AGE_TEXT_REJECTED`, no sample and no semantic grades. The
exact answer was not retained. A separate offline probe demonstrated that a safe
uncertainty sentence was also rejected; do not assume this was the live answer.

The historical September 11 Batch 1 used `refund-answer-v6` and a narrowly bounded
uncertainty replacement with application-owned qualification. Unsupported
personalized decisions, delivery-date requests and the historical rejected answer
remain regression cases. The evaluation diagnostic mode retains rejected
schema-valid synthetic answers separately, never as scored successful samples.
Read the Evaluation Runner README for its explicit opt-in and dataset restrictions,
and `VERIFICATION_STATUS.md` for the completed checks and remaining limits.
That checkpoint proposed human review followed by a separately authorized expanded
run. The current fixed-version v3 campaign is described at the top of this file. Do not
authorize other cases/repetitions solely because the blocking gate passed.
Do not treat earlier paid-test permission as reusable. See the evaluation strategy
for limitations and exact metric inputs, and the verification status for checks.

### September 6 order-contract regression

Vendure manual fulfillment returned an empty method string. The Gateway now
normalizes blank provider methods to `unspecified`, preserving a valid order
contract. Edge maps typed `order_lookup_unavailable` to a safe, retryable HTTP
503 instead of a generic downstream failure.

At the earlier September 6 order-contract checkpoint, Gateway typecheck and 44
tests, Edge typecheck and 83 tests, and Agent Runtime Ruff and 98 tests passed;
the Python run emitted one upstream warning. Live
signed REST and MCP order lookup also passed. These recorded checks cover the
order-contract recovery; the later 101-test wording-safeguard result is recorded
above.

### Committed multi-turn customer context

The customer could give an order reference in one chat message and describe the
damaged item in the next. Previously the Edge API forwarded only the latest
message to Agent Runtime, so the agent could incorrectly ask for the order
reference again.

Commit `e5fbe50` fixes that boundary:

- Edge API persists the customer message, reads the trusted Conversation Runtime
  transcript, keeps only customer messages, bounds it to eight messages / 8,000
  characters, and forwards that chronological context to Agent Runtime.
- Edge resolves an order reference from the latest unambiguous customer message
  in that bounded history. An explicitly supplied order reference still wins.
- Agent Runtime validates the bounded history and supplies it to the structured
  refund-intent extraction call. RAG intentionally receives only the latest
  message, so a long transcript is not blindly passed to retrieval.
- Regression coverage passed: Edge API typecheck and 50 tests, Agent Runtime Ruff
  and 49 tests.

On 2026-09-04, a real two-message local BFF sample retained
`AVV8JSZH8G6ZZDMX` from the first message when the second message said the item
was damaged. The assistant did not ask for the order reference again, and the
second turn created a local human-review workflow. No refund was confirmed or
executed.

### September 5 answer and display fixes

The earlier sample exposed "item 3 in order 3" in the customer answer despite a
correct backend lookup. The answer composer now receives the trusted public order
reference and product names, not internal order/item identifiers. Explicit
conflicting order labels trigger a safe fallback.

A later answer incorrectly described 167880 minor units as 167,880 USD. Prompt
`refund-answer-v3` no longer receives the proposed money field. Common monetary
expressions in generated prose trigger fallback, and application code appends the
proposed USD amount using integer arithmetic. The backend Money contract is
unchanged. The September 5 run displayed USD 1,683.80 correctly. These bounded
checks are not universal factuality or grounding evaluation.

The customer page translates destination codes to readable labels and shows
**Review by** only while confirmation is the next action. The raw preview and
expiry metadata remain unchanged; this display change adds no expiry enforcement.

Remaining wording issues include technical labels such as
`refundRequest.orderReference` in model prose. A later local policy v2 slice adds
private photo upload, exact-revision staff review, and a durable evidence gate;
see [the photo guide](REFUND_PHOTO_EVIDENCE.md). Delivery-age eligibility is still
not enforced. The September 6 proof above now joins the photo gate to provider
execution; keep that local success separate from the remaining wording and
production gaps.

### Refund confirmation expiry, September 5 follow-up

The local implementation now binds confirmation to the preview ID and enforces
`validUntil` using Temporal's workflow clock. Exactly at the deadline is too late;
invalid dates fail closed. A durable timer invalidates unanswered previews.
Timely acceptance remains valid during later human review and provider processing;
existing fresh-facts checks still run. For v1 workflows a late supervisor decision
does not extend the inherited policy deadline. The photo-gated v2 exceptional
path rereads accepted evidence and fresh commerce facts and evaluates the pinned
policy again before constructing a new confirmation preview. It does not extend
an old preview or bypass customer confirmation.

Edge returns HTTP 409 `refund_preview_unavailable` for stale/terminal previews and
a confirmed completion race. HTTP 202 remains only signal-delivery acknowledgement.
The customer sees **Refund preview no longer available**, without confirmation or
a review deadline. The state also covers changed order facts, so the copy does not
claim expiry was necessarily the cause.

Rollout caveat: two Temporal patches preserve old histories. New waits get timers;
pre-patch workflows already parked in an unlimited wait reject their next late
live confirmation under the new worker, but do not acquire an automatic timer
retroactively. Inventory and explicitly migrate/close those legacy waits before
claiming universal timer coverage. No existing project workflow was migrated by
this implementation. See `VERIFICATION_STATUS.md` for isolated restart/replay proof.

The follow-up synthetic browser test also passed: a visible confirmation expired
automatically, controls disappeared, and a late Edge confirmation returned 409
with zero execution attempts. Private photo intake/review is now a separate local
slice; read `REFUND_PHOTO_EVIDENCE.md` and its verification section before testing.

The local v2 photo smoke passed through real service APIs: two synthetic uploads,
request-more, exact-revision acceptance, same-case takeover and safe rejection,
with zero money executions in that smoke. The later September 6 browser proof
also completed the photo-gated provider path. New local Edge requests now use v2; old workflows do
not change. Both 48-hour local login tokens were renewed on September 5 without
rotating signing secrets. See `VERIFICATION_STATUS.md` for expiry times, test
counts, browser/API distinction and fixture IDs. Those changes were uncommitted
at the September 5 checkpoint; they are included in the pushed history above.

### Observed local timing baseline

These are one local-machine sample, not performance SLOs:

| Operation | Observed time |
|---|---:|
| Create conversation through Edge API | 14.2 ms |
| First customer message, Edge API total | 20.68 s |
| Second customer message, Edge API total | 18.82 s |
| Conversation Runtime customer-message persistence | 11.7–23.8 ms |
| Conversation Runtime transcript read | 6.5–24.6 ms |
| Conversation Runtime assistant-message persistence | 33.4–49.9 ms |
| Combined local MCP Gateway calls per turn | 268–291 ms |
| Temporal workflow execution after the second reply | 356 ms |

The Agent Runtime consumed about 19–21 seconds of each turn. It contains two
configured model calls, customer-safe RAG retrieval, and proposal construction.
Exact LLM versus RAG timings are not available yet because the project has
correlation IDs but not OpenTelemetry spans. Do not infer a per-model latency
breakdown from this table.

## Recommended next work

Local login update on September 11: the customer token default/maximum and staff
CLI default/maximum are now seven days (604800 seconds). The owner authorized
renewal of both configured tokens with the same identities, staff role, and
signing secrets. They expire September 18, 2026, at approximately 3:30 PM
America/Chicago. The staff `.env` override is now
`LOCAL_HUMAN_ACCESS_TTL_SECONDS=604800`; the effective customer token remains in
the Customer Portal `.env.local`, and the staff token in Operations Console
`.env`. Both web apps were restarted. Internal assertions and browser cookie
behavior are unchanged. Treat the earlier September 5 48-hour renewal as history,
not the current lifetime. Always recheck expiry instead of relying on this date.
See `LOCAL_AUTH_AND_SECRETS.md` for the development-only security tradeoff.

1. Review the completed v3 campaign and its offline follow-up fixes; do not repeat
   the already completed 15-trial run. Finish the remaining owner/judge review
   while preserving its failed reliability gate and recorded scores.
2. Review the completed trusted-answer implementation and
   [new v4 policy-answer criterion](evaluation/RAGAS_V4_POLICY_ANSWER.md) before any
   further paid trial. The authorized single v4 trial is complete and failed;
   do not repeat it automatically. See the measured checkpoint above. The immutable v3 fixture requires at least one RAG citation
   even for amount-only answers; that historical check remains informational.
   V4's large-refund case instead verifies application-owned policy provenance
   with a blocking grade. A new paid trial needs explicit
   scope/approval. Notify the owner before LangSmith experiments,
   then proceed to the external Tau retail benchmark. Reference approval is not
   completed human calibration. Full Temporal/human/provider evaluation remains
   a separate extension; perfect RAGAS scores are not a prerequisite for moving on.
3. Add reproducible Vendure seed/bootstrap and one-command local orchestration.
4. Add browser end-to-end tests for confirmation, approval, takeover, processing,
   provider completion, and failure. The fresh paid browser wording check remains
   pending; the September 6 positive refund proof is already complete. Plan the
   legacy parked-workflow rollout, trusted delivery-age eligibility and production
   evidence storage separately, without weakening authorization.
5. Add OpenTelemetry tracing and metrics, then CloudWatch dashboards/alarms for
   the AWS deployment.
6. Connect existing transactional outboxes to Kafka/MSK for projections and audit
   events.
7. Implement the centralized Model Gateway behind the existing model-client
   boundary.
8. Replace local login with Cognito/OIDC and deploy the first single-region slice.

## Moving to another ChatGPT or Codex account

1. Push the approved documentation and code to the private or public GitHub
   repository.
2. Keep `.env` files, tokens, API keys, local databases, and OpenSearch data out of
   Git.
3. Sign in to Codex with the new account and clone the repository.
4. Start the new task with: "Read `AGENTS.md` and `docs/CODEX_HANDOFF.md` completely,
   then inspect the repository. Do not write code. Explain the architecture,
   current state, token model, latest verification evidence, and remaining
   hardening work back to me."
5. Upload or attach the PDFs from `docs/reference/` if the new task needs their
   visual content. The Markdown architecture remains the authoritative searchable
   source.
6. Transfer secrets through a password manager or secret store, never chat, Git,
   screenshots, or a handoff document.

The new account does not need the entire old chat to work safely. It needs the
repository, these handoff documents, the reference PDFs, and local secrets supplied
out of band.
