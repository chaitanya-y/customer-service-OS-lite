# Verification Status

Last updated: 2026-09-15

This file separates implementation, automated evidence, manual evidence, and work
that still needs proof. A feature existing in code is not the same as an end-to-end
production claim.

Dated entries preserve evidence and limitations at the time of each run. Earlier
statements about uncommitted code, prompt versions or a "next" trial are history;
use the latest checkpoint and [evaluation strategy](evaluation/EVALUATION_STRATEGY.md)
for current Git state and the next authorized-work boundary.

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
> historical verification (101 Agent Runtime tests passed). The September 10
> refinement and its offline evidence are recorded below; no fresh paid live
> browser recheck has been run.

## Single live v4 trial and review preparation on 2026-09-15

One explicitly authorized synthetic large-refund trial completed in 122 seconds.
The quality gate failed: the answer omitted the reviewed USD 750/500 comparison
and carried one citation, while verified policy version/hash and facts matched.
RAGAS scores: context precision approximately 1, recall 1, faithfulness 1,
relevance 0.5703918284251951, factual precision 0.33. All 15 recorded SDK invocations
succeeded; total 27,907 tokens, dollar cost unknown. No retry was performed.

Coordinator validated result/usage schemas, exact one-case/one-repetition coverage,
matching run IDs, CUSTOMER_SAFE evidence and mode 0600 private artifacts. Historical
v3 hashes remain unchanged. No application edits or new full-suite run occurred.
Machine-assisted review is prepared; owner review and human calibration are not
complete. No LangSmith export, Tau run, refund, token renewal, server restart,
dependency change or Git mutation occurred. See [the full measured checkpoint](evaluation/RAGAS_CLOSURE_REVIEW.md).

## Offline verification follow-up on 2026-09-15

Fresh checks for the pending trusted-policy and evaluation changes completed
without starting services or making paid calls:

| Command | Result |
| --- | --- |
| `uv run pytest` in `apps/services/agent-runtime` | 195 passed; two existing warnings |
| `.venv/bin/pytest -q` in `apps/services/evaluation-runner` | 268 passed; one cache warning |
| `pnpm test` in `apps/services/edge-api` | 86 passed |
| `pnpm test` in `apps/services/workflow-workers` | 74 passed; ephemeral Temporal test server downloaded after network approval |
| `node --test tests/*.test.mjs` in `packages/refund-policy` | 5 passed |
| `node --test tests/contract/*.test.mjs` | 92 passed |
| Python Ruff (`--no-cache`) in Agent Runtime and Evaluation Runner | Passed |
| Edge/Workflow `pnpm typecheck` and `pnpm build` | Passed |
| `pnpm lint:proto` | Passed |

The first restricted Workflow Workers attempt had 43 passes and 31 setup
failures because the Temporal test-server download was blocked by DNS; the
rerun passed all 74 tests. Earlier restricted builds could not write existing
repo-local `dist/` files; approved reruns passed. Logs for the rerun commands
are outside Git under `/private/tmp/cso-workflow-workers-test-20260915.log`,
`/private/tmp/cso-edge-api-build-20260915.log`, and
`/private/tmp/cso-workflow-workers-build-20260915.log`.

## Source-aware v4 policy-answer evaluation on 2026-09-14

The approved bounded follow-up adds a v4 fixture and a blocking deterministic
policy-answer grader. Only the large-refund case changes; all five inputs and
four other cases are preserved. Existing citation and prohibited-claim graders
are unchanged. Client preflight independently resolves the configured policy
before any paid work. Grading checks version/hash, amount/limits, reviewed band
and exact application wording; conflicting facts and invented citations fail.

Fresh coordinator evidence:

| Check | Result |
| --- | --- |
| Complete Evaluation Runner offline suite | 268 passed in 2.57 seconds |
| Changed Python lint and formatting | Passed for five files; formatting-only cleanup followed the full suite |
| Core grader import with `agent_runtime` unavailable | Passed |
| V3 preservation and v4-only case delta | Covered by passing tests; v3 SHA remains `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |
| Real composer/renderer and executor through new grader | Passed with external retrieval/model calls replaced by offline fakes |
| Invalid policy/amount/band rejected before clients | Passed; missing/unknown/mismatched policy, stale limits and zero amount covered |
| Diagnostic admission, changed/copy rejection | Passed for v4 while retaining prior pins |

This adds 25 tests to the prior 243-test suite. No new Agent Runtime/product code,
dependency, secret/token, server, provider/refund or Git operation occurred.
Historical measured results remain unchanged. No paid v4 trial, model reliability
claim, human calibration, LangSmith export or Tau execution is implied.
See [the v4 guide](evaluation/RAGAS_V4_POLICY_ANSWER.md).

## Trusted policy answers on 2026-09-14

The approved local implementation moves the unchanged v1/v2 policy values into
one shared JSON catalog. Edge signs its configured policy version and catalog
fingerprint in the agent-specific assertion. Python verifies that binding and
uses only the public currency/limits for deterministic monetary explanations.
Prompt v9 selects an internal presentation purpose; model-output guards still
run before rendering, and the public answer contract is unchanged. Zero,
missing, unsupported-currency or unbound amounts cannot produce a policy band.

Final fresh coordinator checks after all four implementation tasks:

| Check | Fresh result |
| --- | --- |
| Agent Runtime full offline suite | 195 passed; one existing Starlette/httpx deprecation warning |
| Edge API full suite | 86 passed |
| Workflow policy, policy input, risk and evidence-policy tests | 29 passed |
| Root contract suites plus shared policy catalog | 97 passed |
| Edge and Workflow TypeScript checks/builds | Passed; emitted modules resolve the shared policy package |
| Real Node signer to Python verifier, synthetic data only | Eight vectors passed: v1, v2, legacy absence, wrong hash, unknown version, wrong audience, expired token and bad signature |
| Evaluation Runner full suite | 243 passed |
| Changed Python lint/format | Passed for 17 files |
| v3 dataset SHA-256 | Unchanged: `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |

Total: 650 passing tests plus eight compatibility vectors. Agent Runtime adds
34 cases and Evaluation Runner adds three relative to the preceding offline
checkpoint. The initial Evaluation Runner run had two stale v8 expectations;
those were updated to v9, followed by a fresh passing full suite. No real secrets/tokens were read or
printed by the cross-language test. No paid model calls, services, token renewal,
refund execution, Git history or remote branches were changed by this batch.
The optional `--refund-policy-version` resolves the local artifact before live
provider construction, passes the verified projection to the real composer, and
records version/hash plus independent policy limits. Legacy invocations have no
monetary-policy authority. No historical dataset or grader was changed.

See the [plan](superpowers/plans/2026-09-14-trusted-refund-answers.md) for the exact
scope. Full Temporal test-server scenarios, live models, browser flows and
provider operations were not exercised. This does not rewrite the prompt-v8
measured campaign below or establish a live v9 reliability result.

## Offline answer-boundary follow-up on 2026-09-14

The owner approved the bounded two-worker follow-up to the v3 campaign findings.
The local patch changes the production answer composer and its tests, plus a
new independent Evaluation Runner regression file. It fixes terminal-colon
reference false positives, the missed personalized eligibility denial, supported
policy framing, and explicit incorrect OR missing condition narrowing.
Unsupported claims and omitted conjunctive requirements remain rejected. A
review regression also protects general procedural eligibility wording from a
new false positive. No prompt, grader, dataset or policy threshold changed.

| Check | Fresh result |
| --- | --- |
| Agent Runtime full offline suite | 161 passed, including 15 new unit cases |
| Evaluation Runner full offline suite | 240 passed, including 8 new integration cases |
| Ruff lint and formatting | Passed for the three changed Python files |
| v3 dataset SHA-256 | Unchanged: `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |

The full suites produced sandbox pytest-cache write warnings; Agent Runtime also
emitted its existing Starlette/httpx deprecation warning. Ruff checks were run
without caches after the sandbox rejected cache writes. Final formatting-only
changes received a focused test recheck. These are offline component/integration
checks with external models and retrieval faked, not new RAGAS scores, a live
browser refund test or production certification. No other service suites were
rerun. The patch is uncommitted; Git, services and tokens were left unchanged.

See [the v3 baseline follow-up](evaluation/RAGAS_V3_BASELINE.md) for file/function
walkthrough. Its then-deferred monetary explanation and concise presentation are
covered by the subsequent approved batch above. Owner review/calibration and
separately authorized live trials remain pending. LangSmith and Tau have not started.

## Completed v3 RAGAS campaign on 2026-09-14

The separately owner-authorized `refund-ragas-v3-campaign-20260914-001` attempted
all five approved seed cases three times with fixed prompt v8 and dataset v3.
Five answers reached all five semantic graders; ten were rejected before grading
(eight delivery-text, two identifier). Blocking pass rate was 5/15, repeated-case
consistency 0/5. All recorded API invocations succeeded. This is a completed
measurement with a failed reliability gate, not an evaluator crash or expired
token, and not a production-quality pass.

Usage was 204,047 tokens across 95 recorded invocations. Elapsed time was about
12 minutes 21 seconds. Semantic means over only five scored answers were context
precision 1.0000, recall 0.9000, faithfulness 0.8374, relevance 0.5228 and factual
precision 0.6360. Missing scores are not zero; every scored trial missed at least
one provisional nonblocking minimum. Cost is unknown without a pricing schedule.

Result/usage/diagnostic schemas, exact 15-trial coverage, dataset pin, private
permissions, response hashes and evidence hashes were verified. All ten captured
rejections reproduced offline. Two were trailing-colon identifier false
positives; the delivery failures and a personalized eligibility denial that
escaped the guard require review. No code, prompt, guard, dataset, tokens or
index changed. No refund, LangSmith export or follow-up paid run occurred.

The complete [v3 baseline report](evaluation/RAGAS_V3_BASELINE.md) records trial
scores, limitations and artifacts. Owner review and independent human calibration
remain unfilled. Review these findings next, then freeze this bounded baseline;
notify the owner before starting LangSmith. Do not repeat the paid campaign merely
to obtain better scores. The older preparation and merge records below are dated
history; their pending-run statements describe the time before this campaign.

## Verified code commit and merge on 2026-09-14

After owner approval, commit `87ab48f` (`Add evaluation regression coverage and
strengthen local answer safeguards`) was pushed to `dev`. It was merged into
`main` as `97028db` (`Merge dev to main and add RAG evaluation tooling and answer
safeguards`). The following checks ran on merged `main` before it was pushed:

| Boundary | Recorded result | Other verification |
|---|---:|---|
| Evaluation Runner | 232 passed | Ruff lint clean; all 42 Python files passed formatting |
| Agent Runtime | 146 passed | Ruff lint clean; the two changed answer/composer test files passed formatting |
| Knowledge/RAG | 102 passed | Ruff lint clean; the two changed embedding/provider test files passed formatting |
| Edge API | 85 passed | TypeScript typecheck passed |
| Human Operations | 21 passed, 4 skipped | TypeScript typecheck passed |

Total: **586 passed, 4 skipped** across these five services. The four optional
PostgreSQL tests were skipped because `HUMAN_OPERATIONS_TEST_DATABASE_URL` was
not configured; the older isolated-database proof below is not a fresh rerun.
Agent Runtime and Knowledge/RAG each emitted an existing Starlette/httpx
deprecation warning. Full-repository formatting was not claimed: four untouched
Agent Runtime files had the previously recorded formatting differences.

The earlier pre-commit checks encountered sandbox socket restrictions in Human
Operations and public tokenizer-cache network restrictions in Knowledge/RAG.
The reruns with the needed access passed without application changes. No paid
models or RAGAS judges were called. Gateway, Workflow Workers, Conversation
Runtime, root contracts and frontend builds/browser suites were not rerun in
this changed-service merge check; their dated evidence below remains historical.

Remote refs were verified after pushing. `dev` and `main` had the same tree,
`48269d1b118c0f51728a06b861526c00dfaa8575`, and the working branch returned to
`dev`. `.superpowers/` remained untracked and excluded. No environment files,
tokens, local databases or runtime artifacts were committed. No new model trial,
browser journey, migration, refund or provider settlement accompanied the merge.

This documentation-only follow-up records those prior results; it does not claim
another application test run. The v3 paid campaign, human calibration, LangSmith
export and external Tau benchmark are still pending. A fresh browser wording
check is also pending, separately from the completed September 6 refund proof.

## Approved dataset v3 preparation on 2026-09-13

The offline five-case v3 preparation is complete. The owner approved four
source-aligned reference corrections for incorrect items, final-sale exceptions,
large refunds and provider processing. The damaged-item reference is unchanged.
Only those four references and `dataset_version` differ semantically from v2.
Inputs, synthetic facts, evidence targets, safety checks and grader settings are
unchanged. This is a new answer key, not a change to customer answers or policy.

Diagnostic capture adds only the exact built-in v3 path and this SHA-256:
`1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de`.
Copied or modified fixtures remain rejected before clients are created; the
parser uses the verified bytes. Rejected answers remain private and unscored.
Tests prove all five references reach the grader without reaching the evaluated
answer system. Historical v1/v2, development, held-out and split fixture hashes,
and the full production answer module hash, match the pre-change snapshot.

Fresh verification: **232 Evaluation Runner tests passed**, Ruff lint passed,
and all **42 Python files** passed formatting. Eleven test instances were added;
the focused suite passed 50 tests. A scoped independent review found no defects.
Agent Runtime was unchanged in this task; its earlier 146-test result in the
v8-refinement record remains historical, not a new run. No paid calls, service/token/env
changes, dependency installs, refund actions or Git writes occurred.

No v3 live scores or human calibration exist. The next proposed campaign uses
five cases times three repetitions with fixed versions and separate paid/capture
approval. Keep failed trials in the reliability denominator and report semantic
scores only with their scored coverage; missing grades are not zero. Owner
approval of references is not human rating of generated answers. Do not compare
v3 against v2 as an improvement. The reference decisions and bounded sequence
are in `evaluation/RAGAS_DATASET_REVIEW.md` and `evaluation/EVALUATION_STRATEGY.md`.

## Captured v8 trial on 2026-09-13

The separately authorized `refund-ragas-v8-20260913-001` used the same pinned
v2 damaged-item case, models and three CUSTOMER_SAFE evidence chunks. It failed
before judging with `SYSTEM_ERROR` / `DELIVERY_AGE_TEXT_REJECTED`. It said:

> Submit the request within 30 calendar days of delivery.

The duration is supported for damaged items, but that sentence lacks the
general-policy framing and refund-reason scope required by the strict text
validator. It did not match the earlier personalized-exception conclusion.
Offline replay with matching saved evidence hashes reproduced the failure.
Replacing only that sentence in memory with the supported general damaged-item
policy form passed the delivery-text validator; this was not a production fix
or a quality grade. The answer also transferred an incorrect/missing-item
verification requirement into a damaged-item response, an unresolved review
finding rather than a reconstructed RAGAS judgment.

Usage was **4,129 tokens** across one answer call (4,115) and one query-embedding
call (14). Measurement is complete; reasoning is included in output totals.
No judges ran, no semantic scores exist, and no refund action or trial retry
occurred. Artifacts `result.json`, `usage.json`, `rejections.json` and `runner.log`
are private (`0600`) under `/private/tmp/cso-ragas-v8-approved-iIBHLfmI/`.
Result/usage/diagnostic schemas and response/evidence hashes were verified.
The result is an answer-generation/validation failure, not token expiry.

The owner agreed to stop prompt-only retry cycles and prepare a bounded
five-case evaluation campaign. A possible hybrid answer-composer redesign is
separate work, not implemented here. Failed system trials must remain visible;
they are not semantic zeroes and must not disappear from the denominator.

## Captured v7 rejection and offline v8 refinement on 2026-09-13

The authorized trial `refund-ragas-v7-20260913-001` used the same synthetic
damaged-item v2 case, models and three CUSTOMER_SAFE evidence chunks as the
completed v6 trial below. It failed before RAGAS scoring with `SYSTEM_ERROR` /
`DELIVERY_AGE_TEXT_REJECTED`. The captured answer said:

> Final-sale products are not eligible for a refund unless the item arrived
> damaged or the wrong item was sent; since your item arrived damaged, it falls
> under the damaged-item exception.

The personalized-conclusion guard matched `your item arrived damaged, it falls`.
The error code also covers personalized eligibility, not just delivery dates.
An offline replay using matching saved evidence content hashes reproduced the
rejection; removing only the offending line in memory passed the delivery-text
validator. No saved answer or production response was altered. This diagnoses
this captured failure, not the exact cause of the earlier uncaptured failure.

The trial made one answer call (4,525 tokens) and one query-embedding call
(14 tokens): **4,539 total tokens**, measurement complete. Reasoning tokens are
included in output totals. No RAGAS judges ran, no scores were produced, no refund
was executed, and no automatic retry occurred. Cost remains unknown without a
pricing schedule. The private `0600` artifacts are in
`/private/tmp/cso-ragas-v7-approved-ZVLfN0fC/`: `result.json`, `usage.json`,
`rejections.json` and `runner.log`. Temporary files may not survive migration.

The owner then approved a bounded offline refinement to `refund-answer-v8`:
reported damage is not verified eligibility; explain a relevant policy exception
only as a general condition; never decide that this customer's item qualifies.
The prompt includes allowed/disallowed examples and warns against assuming that
an item is final-sale from its refund reason. Deterministic policy and all guard
and composer code from `IDENTIFIER_MENTION` onward are unchanged (SHA-256
`699c847dfae48068ba7a307306463161d0beb5c0c8a1a1ae7dbdf49d5216187c`).
The five RAG seed/development/held-out/split fixture hashes are also unchanged.

Three new composer cases preserve the exact synthetic response, isolate its
offending sentence without any delivery-window text, and accept a general
exception explanation while retaining citations, the application qualification
and trusted amount. The full copied response matches the captured SHA-256
`803b1f76078fb53252cbe13adcc351bde90f25938eb7fb97dac71cdf91bcfaad`.
These boundary tests already passed with v7's unchanged guard. Two evaluator
version-provenance checks failed before the v8 update and passed afterwards;
neither check proves the model follows the prompt.

Fresh offline verification: **146 Agent Runtime tests passed** (one existing
Starlette/httpx deprecation warning), **221 Evaluation Runner tests passed**,
and both linters passed. Both edited runtime Python files and all 41 evaluator
Python files passed formatting. The full runtime format check still reports the
same four untouched files listed below. No paid call, server/token change or Git
mutation accompanied the v8 refinement. No live v8 trial had run at that
checkpoint; the subsequent authorized failed trial is recorded above.
Repeated trials, human calibration,
and reviewed expanded cases remain necessary; do not claim this prompt change
solves model reliability or completes RAGAS.

## Earlier approved v7 answer-prompt refinement on 2026-09-13

After the offline answer/source review, the owner approved the damaged-item
answer rubric and a bounded prompt update. `refund-answer-v7` now instructs the
model to preserve a rule's refund-reason scope and request/review/approval stage,
state applicable prerequisites explicitly, and omit unrelated exclusions while
retaining relevant exceptions. It does not change deterministic policy,
verification controls, retrieval, answer guards or the v1/v2 RAG references.

Two existing executor tests first failed because normal results and private
rejection diagnostics still recorded prompt v6; after the update all 12 executor
tests passed. Full verification: **143 Agent Runtime tests passed** (one
Starlette/httpx deprecation warning) and **221 Evaluation Runner tests passed**.
Both linters passed. The edited answer file and all 41 evaluator Python files
passed formatting. The full Agent Runtime format check still reports four
untouched files: `integrations/customer_evidence.py`,
`integrations/trusted_context.py`, `refund/router.py` and
`tests/test_customer_evidence.py`. They were not reformatted in this scope.

The guard-and-composer code from `IDENTIFIER_MENTION` onward has the same SHA-256
before and after the prompt change. The pinned v1/v2 fixture hashes also match.
Version-reporting tests and existing guard regressions do not prove model
compliance with the new instructions. No live v7 trial had run at that checkpoint;
the later authorized failed trial is recorded above. No
additional paid calls, server/token changes or Git mutations accompanied this
implementation. Fresh trials require separate approval; do not lower thresholds
or rewrite the reference to improve scores.

## Completed v2 RAGAS trial on 2026-09-13, using prompt v6

The owner authorized one synthetic damaged-item trial, all five configured
metrics if the answer passed, and private rejected-answer capture. Run
`refund-ragas-v2-capture-20260913-001` completed using `refund-answer-v6`, dataset
v2, evaluator v2, `gpt-5-nano` and `text-embedding-3-small`. The answer passed the
production guard; the diagnostic sidecar contains zero rejections. This does
not explain or fix the earlier uncaptured intermittent rejection.

| Metric | Score | Above provisional 0.70 minimum |
|---|---:|---|
| Context precision | 1.0000 | Yes |
| Context recall | 1.0000 | Yes |
| Faithfulness | 1.0000 | Yes |
| Response relevancy | 0.4407 | No |
| Factual correctness, precision mode | 0.5600 | No |

All semantic grades remain informational; the overall pass reflects blocking
safety checks, not universal quality success. Retrieval plus answer took 21.89
seconds. Usage measured 36,946 tokens over 15 successful calls: one answer,
11 judge, two judge-embedding and one query-embedding calls. No pricing schedule
was supplied; cost is unknown, not zero. Reasoning tokens are already included
in output totals. No repeat trial or refund action occurred.

Private artifacts (all mode `0600`) are under
`/private/tmp/cso-ragas-v2-approved-cwCuIwEv/`: `result.json`, `usage.json`,
`rejections.json` and `runner.log`. The saved run and diagnostic sidecar passed
schema/integrity validation. Temporary local files may not survive migration.
The subsequent agent-assisted review found an over-broad verification statement,
unnecessary exclusions, and an insufficiently explicit photo-before-approval
condition. These are review findings, not reconstructed judge reasoning: the
adapter retains numeric scores but not detailed claim-level explanations.
Owner approval of the answer rubric is not completed independent calibration.

## Offline evaluation follow-up on 2026-09-13

The bounded batch used one Sol worker for read-only rejection-replay readiness,
one for a single missing intake-evaluation case, and a separate read-only review
after implementation. No new diagnostic or production guard was implemented.

- Added `refund-agent-failure-modes-v1.json`: one synthetic retrieval-outage
  case, separate from the unchanged seven-case agent dataset. It exercises the
  real LangGraph intake with deterministic external dependencies and the real
  fallback answer. A proposal remains ready, but knowledge is unavailable,
  composition is fallback, citations are empty, and the answer model is not
  called. No refund is authorized or executed.
- Added three automated tests for fixture validity, one trial through all
  seven existing graders, and deliberately corrupted observations rejected by
  final-state, forbidden-tool and safety graders. Trace assertions are automated
  tests, not a new generic trajectory-grading framework. The worker observed
  three missing-fixture failures before adding the fixture, then three passes.
- Coordinator verification: **221 Evaluation Runner tests passed in 3.19
  seconds**, no skips; Ruff lint clean; all 41 Python files formatted;
  `git diff --check` passed. These are three new tests, not 221 paid evaluations.
- The separate read-only review finished with no blocking findings. Existing
  wrong-proposal-amount grader coverage was reused rather than duplicated in
  the new outage test.
- Read-only diagnostic finding: the live CLI is not answer-only. A passing
  answer proceeds to configured RAGAS judges. A future trial needs explicit
  approval covering that scope and optional private rejection retention.
  Offline delivery-validator replay needs the captured answer/citations plus
  exact CUSTOMER_SAFE evidence with matching content hashes. At that checkpoint
  the rejected answer had not been retained. The later v7 capture is diagnosed
  above; the earlier uncaptured response's exact cause remains unknown.

This batch made no paid calls, live-score measurements, service/token changes,
provider actions, dependency changes or Git mutations. RAG reference review and
human calibration remain pending; no reference answers or human marks changed.
Full Temporal/human/provider evaluation, LangSmith export and public tau
benchmark integration remain unimplemented. See the Evaluation Runner README
for the replay boundary and the source-review worksheet for owner decisions.

## Offline v2 diagnostics and dataset-review batch on 2026-09-12

The owner approved two independent workstreams. One Sol worker extended the
existing diagnostic boundary; another prepared source review and then performed
a bounded read-only review of the diagnostic change. The coordinator integrated
documentation and ran the full Evaluation Runner suite once on settled code.

- Diagnostic mode now allows only the exact resolved paths and reviewed SHA-256
  pins of `refund-rag-answer-v1.json` and `refund-rag-answer-v2.json`. Copied or
  modified fixtures are rejected before external clients are constructed. The
  bytes that pass the pin are reused for parsing. Capture is still opt-in,
  private (`0600`), non-overwriting and separate from quality samples.
- Tests exercise both versions and an offline v2 path through the real answer
  composer, executor, adapter and runner. Only the external model and retrieval
  are doubled. A deliberately uncited policy-window answer produces
  `DELIVERY_AGE_TEXT_REJECTED`; its private diagnostic is retained while the main
  trial remains `SYSTEM_ERROR`, with no sample or judge scoring. This synthetic
  test does not reproduce or reveal the uncaptured live answer below.
- [The worksheet](evaluation/RAGAS_DATASET_REVIEW.md) covers five seed, ten
  development and five held-out cases against the registered CUSTOMER_SAFE
  source. Its chunk map is fixture-level verification, not a fresh live-index
  check. All reference decisions and human calibration remain with the owner;
  the 15 candidate references still await review. Expected-evidence lists are
  minimum retrieval targets, not exclusive lists of permissible context.

| Verification | Result |
|---|---|
| New behavior before implementation | v2 diagnostic test failed against the old v1-only path check; v1 passed |
| Worker focused live-evaluator suite | 39 passed in 1.96 seconds |
| Coordinator full Evaluation Runner suite | 218 passed in 2.19 seconds, no skips |
| Additional test cases since the 212-test checkpoint | 6 |
| Ruff lint / formatting | Clean; 40 Python files already formatted |
| Whitespace and scoped code review | `git diff --check` passed; no review blockers |
| Guard and fixture preservation | SHA-256 checks confirmed answer implementation/tests and all five RAG fixture/manifest files unchanged |

No paid calls, new live scores, provider/refund actions, service or secret
changes, dependency changes, or Git operations were performed. Diagnostic
support is complete for this bounded batch; the underlying live rejection is
not fixed. Next: review the worksheet, obtain separate approval for a paid trial
and private rejected-answer capture, then reproduce any captured rejection
offline before choosing a behavior change. Do not expand cases or repetitions
automatically.

## Latest live v2 trial on 2026-09-12: rejected before grading

The separately authorized run `refund-ragas-dataset-v2-20260912-001` attempted
one damaged-item case and one repetition against dataset v2. Query embedding and
answer generation succeeded, but the production answer guard returned
`DELIVERY_AGE_TEXT_REJECTED`. The saved trial is `SYSTEM_ERROR`, with
`sample: null` and `grader_results: []`. No RAGAS judge or judge-embedding calls
ran. This is a failed system trial, not a zero-valued semantic score or a new
completed baseline.

The content-free usage report measured 14 query-embedding tokens and 3,952 answer
tokens (1,134 input plus 2,818 output), totaling 3,966 tokens. The answer's 2,624
reasoning tokens are included in its output count, not extra tokens. Cost remains
null because no price schedule was supplied. Both API calls succeeded; this
failure was not customer/staff token expiry. No retry or refund action occurred.

Machine-local artifacts are `/private/tmp/cso-ragas-dataset-v2-NtfSKU/result.json`
and `usage.json` in that directory. Temporary files are not portable handoff
dependencies; this entry preserves their outcome. The exact rejected response
was not captured because diagnostic mode was not enabled. Do not infer its
wording, assume a model violation versus a false positive, or change the guard
without further evidence. Any additional paid call needs fresh approval.

## Owner-approved RAG answer dataset v2 on 2026-09-12

The owner approved a revised damaged-item reference grounded in the published
CUSTOMER_SAFE policy: the 30-calendar-day request window, order/item identification
and photos before approval. The new `refund-rag-answer-v2.json` preserves all five
case IDs; only the dataset version and damaged-item reference differ from v1.
The historical v1 file retains SHA-256
`00aa539c014dfd3d45944c5f8bacc327e1c79dfdaf04b44027bd26a107f533d6`.
The original live result, production answer guard and diagnostic dataset pin were
not changed. This is reference approval, not completion of human calibration.

Four new offline tests first failed because the new dataset was absent, then
passed. They protect historical data and unchanged case fields, and exercise the
real RAGAS grader adapter to confirm the approved reference reaches context
precision, context recall and factual correctness. The external scorer is a
test double; its scores are not live RAGAS quality evidence. Independent
application facts are still appended only for factual-correctness comparison,
not for retrieval metrics.

Final verification: Evaluation Runner 212 tests passed in 2.87 seconds; Ruff lint
passed and all 40 Python files passed formatting checks. That offline reference
change made no paid calls or changes to services, tokens, embeddings, indexes,
refunds or Git history. The later live trial is recorded above. v2 results must
not be directly baseline-compared with v1. At this checkpoint, normal v2 usage
reporting was available, while rejected-answer capture supported only pinned v1.

## Offline RAGAS dataset, usage and comparison batch on 2026-09-11

The owner approved one coordinator and three bounded workers (two Sol, one Luna).
This batch expanded evaluation tooling and documentation, not the number of live
quality trials. It did not change the answer guard, original five-case seed,
secrets, services, indexes, refund state, dependencies or Git history.

1. Added 10 development and 5 held-out synthetic cases, with split membership and
   source SHA-256 provenance in `refund-rag-splits-v1.json`. References remain
   `AGENT_AUTHORED_PENDING_OWNER_REVIEW`. Four new fixture tests validate contract,
   split and trust-boundary properties, not live model quality. The held-out split
   is not an independent benchmark; true zero-evidence abstention is excluded.
2. Added opt-in, content-free provider-usage reports for query embeddings,
   structured answers, RAGAS judges and judge embeddings. Unknowns remain null;
   cache/reasoning counts are subsets, not extra tokens. Versioned caller-supplied
   prices may yield an estimate, never an invoice or a guessed historical cost.
   Usage reporting is attempted on fatal judge errors without hiding the error.
   Atomic publication refuses existing files and preserves another run's staging
   file. The production embedding provider only adds optional client injection.
3. Strengthened baseline comparison: reject incompatible evaluator/judge versions
   and repetition coverage; report completed-to-system-error regressions and the
   reverse recovery separately from semantic score changes.
4. Recorded the first completed live case and its human calibration checklist in
   `evaluation/RAGAS_BASELINE_REVIEW.md`. No human marks were fabricated.

| Verification | Result |
|---|---|
| Evaluation Runner full suite after the timeout correction | 208 passed in 2.32 seconds, no skipped tests |
| Added Evaluation Runner coverage | 28 cases beyond the pre-batch 180-test checkpoint |
| Worker focused usage/live/comparison/embedding checks | 66 passed in 1.82 seconds after the timeout correction; includes the new embedding-injection test |
| Dataset worker focused checks | 8 new-plus-seed tests passed |
| Ruff lint and formatting | Evaluation Runner clean, 39 files formatted; both changed Knowledge/RAG files clean |

External API responses were simulated with local test transports. No paid calls
were made. Review caught an injected-client timeout regression before completion;
the instrumented clients explicitly use 30 seconds and zero SDK retries. Focused
checks and the final full suite passed after that correction. These tests
establish tooling behavior, not new RAGAS scores. The one
real damaged-item trial remains the only completed live semantic measurement.
Next: owner reference review, separately approved remaining four seed cases,
then a separately approved five-case repeated run and judge/human calibration.
Production observability, LangSmith and public agent benchmark integration are
not completed by this batch. See the service README for usage flags, comparison
semantics and the file reading order.

## Answer boundary and synthetic diagnostics Batch 1 on 2026-09-11

The owner approved two scoped workers and later explicitly resumed their
interrupted work. This offline implementation batch made no paid model calls; a
separately authorized v6 trial later produced the first completed live semantic
measurement, recorded below.

Prompt `refund-answer-v6` makes eligibility qualification application-owned.
Three exact complete English uncertainty sentences are recognized (with NFKC
normalization), checked separately from the rest of the answer, and replaced
with the standard qualification. For example, "Your request has not been
assessed for eligibility." no longer fails solely for containing "eligibility".
Added clauses, unsupported positive/negative eligibility decisions and delivery
date requests still reject. The historical captured personalized-window response
continues to reject. Cited general windows still require matching duration,
calendar/business basis and recognized conditions. This is a small allowlist,
not a universal semantic validator, and it does not enforce delivery age.

The composer defaults to `capture_rejected_answer=False`. Explicit capture
retains a defensive copy of a schema-valid rejected answer before application
qualification or money is appended. It never retains malformed raw provider
output in that field, never returns a rejected answer, and leaves normal errors
with no rejected-answer payload.

The live evaluator accepts `--rejection-diagnostics-path` only for the built-in
reviewed synthetic dataset and its exact content hash. It parses those same
verified bytes, checks evidence scope before composing, and keeps rejected
responses in a separate owner-only (`0600`), non-overwriting file. Result and
temporary-path aliases, pre-existing outputs and missing output directories are
rejected before clients are constructed. The main result remains `SYSTEM_ERROR`
with no sample or semantic grades. A judge failure still invalidates the run and
writes neither new result nor diagnostic sidecar. No references or raw retrieved
passages are copied into the rejection sidecar. Read the Evaluation Runner README
for the opt-in contract and future dataset-pin review requirement.

| Fresh check | Result |
|---|---|
| Agent Runtime full suite | 143 passed, one existing Starlette deprecation warning |
| Evaluation Runner full suite with installed optional dependencies | 179 passed, no skipped tests |
| Focused worker checks | 95 answer tests; 38 evaluator/executor tests passed |
| Added coverage compared with the previous batch | 19 Agent Runtime cases and 20 Evaluation Runner cases |
| Ruff lint | Both packages passed |
| Ruff formatting | Two changed Agent Runtime files and all 36 Evaluation Runner files passed |
| Offline integrated failure path | Real composer, executor, adapter, runner and sidecar; only external retrieval/model replaced with test doubles; original rejected answer captured privately, SYSTEM_ERROR preserved, zero judge/external calls |

Both Sol workers completed. The coordinator reviewed their changes and ran the
full suites once on settled code. Customer-facing answer schemas, money formatting,
refund workflow authorization, dataset contents, model/judge metric inputs and
dependencies are unchanged. The four previously noted untouched Agent Runtime
formatting issues were not included in this bounded batch. No services were
restarted, no secrets or indexes changed, and nothing was committed or pushed.
The running Agent Runtime may still require a restart before browser testing;
an isolated evaluation command imports the current source in a fresh process.

Next: independently human-double-score the completed v6 case and adjudicate
disagreements before treating its scores as meaningful. Separately authorize any
expanded seed-case or repetition run; do not infer quality calibration or
production reliability from this one case.

## Seven-day local login tokens on 2026-09-11

The owner requested seven-day local customer and staff login tokens instead of
48-hour tokens. Edge now issues and validates a maximum lifetime of 604800
seconds. The Human Operations local token CLI defaults to 604800 and refuses
longer configured lifetimes; the running service continues to verify JWT expiry.
The configured staff TTL override was updated too, so the old 172800 value cannot
silently shorten newly generated tokens.

Both expired tokens were replaced in their effective ignored environment files,
preserving all identity claims, the staff role, and signing secrets. Signature
checks and the production identity verifiers accepted both renewed tokens. Both
have exactly 604800 seconds between issue and expiry, expiring September 18,
2026, at approximately 3:30 PM America/Chicago. No secret/token values were printed.
Customer Portal and Operations Console were restarted to load the replacements;
the running Edge watcher loaded the changed customer verifier.

| Check | Result |
|---|---|
| Edge API | Typecheck passed; 85 tests passed |
| Human Operations | Typecheck passed; 21 tests passed, 4 optional PostgreSQL tests skipped because the test database URL was not configured |
| New lifetime behavior | Test-first failures for seven-day customer validity and staff CLI acceptance/default, followed by passing tests after the bounded change |
| Customer web authentication | No session: 401; with local session and renewed upstream token: 404 `conversation_not_found` for a deliberately nonexistent valid ID, proving authentication passed without creating a conversation |
| Staff web authentication | No session: 401; with local session and renewed token: 200 on read-only case listing |
| Web pages | Both sign-in pages returned 200 |

The first Human Operations full-suite attempt hit sandbox `listen EPERM` errors
in four socket tests. The authorized local-socket rerun passed; no application
fix was required. All three edited environment files remain ignored by Git.
Browser cookie behavior, internal short-lived assertions, production auth plans,
refund state and RAGAS guards were unchanged. No paid calls, refunds, commits or
pushes were made. Seven-day local tokens do not solve the separate RAGAS
delivery-wording rejection.

## Latest live RAGAS attempt on 2026-09-11

After the offline prompt-v5 batch below, the earlier authorized synthetic trial
`refund-ragas-baseline-20260911-001` stopped after approximately 28.2 seconds
with `DELIVERY_AGE_TEXT_REJECTED`; it records `SYSTEM_ERROR`, no sample and no
semantic grades. A later v6 run, `refund-ragas-baseline-20260911-v6-4096-001`,
completed one `damaged-item-evidence-answer-v1` case in 142.13 seconds. Its
artifact is `/private/tmp/cso-ragas-v6-budget4096-0dnpe8/result.json`.

Observed RAGAS grades were context precision `0.8333`, context recall `0.6667`,
faithfulness `1.0`, response relevancy `0.6769`, and factual correctness
precision `0.73`. Deterministic grades passed and the runner marked the trial
passed, but context recall and response relevancy missed their nonblocking 0.7
minima. Thus the run passed its blocking gate; it did not establish calibrated
quality or a release threshold. The exact answer/source comparison and human
calibration checklist are in `docs/evaluation/RAGAS_BASELINE_REVIEW.md`.

This isolated evaluation does not use customer/staff login tokens. The answer
reached the production text guard; renewing login tokens cannot fix that rejection.
An independent offline contrast probe also exposed a false positive: the guard
rejected "Your request has not been assessed for eligibility." while accepting
"Your delivery timing has not been verified." Unsupported eligibility decisions
and mixed uncertainty-plus-eligibility claims remained rejected. The subsequent
v6 batch addressed this bounded false positive and added opt-in synthetic
diagnostics without weakening refund authorization. The completed one-case trial
above is the current live evidence; additional paid trials still require fresh
owner authorization, and a calibrated full-dataset baseline is pending.

## Offline prompt and RAGAS readiness batch on 2026-09-11

Prompt `refund-answer-v5` adds explicit conditional examples of permitted general
policy wording and prohibited personalized window/date requests. The 30-day
example is not a universal rule; the cited evidence must support its duration,
time basis, and conditions. A source comparison against the pre-batch local file
confirmed all guard regexes, validation/composer functions, monetary formatting,
and qualification logic are byte-for-byte unchanged.

The new Agent Runtime regression preserves the exact 753-character synthetic
answer from the September 10 diagnostic, its three citations and supporting
customer-safe evidence. It exercises the real composer with a substituted external
model response and confirms `DELIVERY_AGE_TEXT_REJECTED`. The existing positive
case confirms supported general-policy wording receives the qualification and
trusted USD amount. These tests preserve enforcement; they cannot measure whether
a live model follows the new prompt.

The evaluation readiness audit checked the five existing seed references and
evidence mappings against the pinned customer-safe policy. Existing tests already
cover metric-specific application-fact separation. A strengthened live-runner
test proves a failed system invokes no judges and persists no sample or semantic
grades. One new test proves a scorer exception invalidates the evaluation and
does not write a quality artifact. The executor's expected prompt version was
updated to v5 after integration exposed the stale v4 assertion. Datasets and
production Evaluation Runner code were not changed.

| Final check | Result |
|---|---|
| Agent Runtime full suite | 124 passed; one existing Starlette deprecation warning and a sandbox pytest-cache warning |
| Evaluation Runner full suite, including installed optional integration dependencies | 159 passed with pytest cache disabled |
| Ruff lint | Both packages passed with cache disabled |
| Ruff formatting | Two changed Agent Runtime files and all 36 Evaluation Runner files passed |
| Added coverage | Two new tests, one strengthened existing test, one updated version expectation |

The initial Ruff invocation could not write its cache in the sandbox; rerunning
with `--no-cache` passed without application changes. The four previously recorded
untouched Agent Runtime formatting failures were not part of this bounded change.

Reading order: [prompt and composer](../apps/services/agent-runtime/agent_runtime/refund/answer.py),
[captured-response regression](../apps/services/agent-runtime/tests/test_refund_answer.py),
[live evaluation failure tests](../apps/services/evaluation-runner/tests/test_live_rag_evaluation.py),
then [the evaluation run guide](../apps/services/evaluation-runner/README.md).

Both scoped Sol workers finished; the coordinator reviewed their diffs and ran
the final suites. No paid APIs, model calls, provider/refund actions, secrets,
datasets, indexed documents, service processes, or Git history were changed in
this batch. The code and documentation were uncommitted at that checkpoint and
are now included in the September 14 pushed history. The running Agent
Runtime was not restarted in that batch; a browser recheck then needed it to load
v5. An isolated evaluation command imports the current source in a new process.

At that checkpoint, the next step was a separately authorized one-case live trial.
The later v6 trial above completed that step. The bounded dataset/repetition run,
fresh browser wording check, and calibrated semantic release gates remain pending.
Do not equate offline completion with completed RAG evaluation.

## Live RAGAS attempt and diagnostic on 2026-09-10

After the offline grounding correction, the owner separately authorized one live
trial and one diagnostic retry of the same synthetic damaged-item case. These
were not part of the earlier offline checks below.

| Attempt | Evidence | Outcome |
|---|---|---|
| `refund-ragas-baseline-20260910-001` | One `damaged-item-evidence-answer-v1` trial, evaluation version `refund-ragas-v2`, answer/judge configuration `gpt-5-nano`, embeddings `text-embedding-3-small`; about 30.3 seconds elapsed | `SYSTEM_ERROR`, `sample: null`, `grader_results: []`; answer rejected with `DELIVERY_AGE_TEXT_REJECTED` before semantic grading |
| `refund-ragas-diagnostic-20260910-001` | One separately authorized answer-only diagnostic using the same synthetic case and customer-safe evidence; 28.26 seconds elapsed | The captured answer included "Ensure your request is within 30 calendar days of delivery." The unchanged guard rejected personalized, unqualified window wording. No RAGAS judges ran. |

The retrieved damaged-item policy did contain the 30-calendar-day rule. This was
not evidence that the policy duration was invented: the problem was how the answer
applied/explained it when customer delivery timing was unverified. Offline replay
accepted the supported general-policy alternative and required the usual
application-owned qualification. It did not prove future model compliance.

Neither attempt executed a refund or changed the knowledge corpus. They produced
no semantic quality scores; an absent score is not a score of zero. These timings
are single-run observations, not a latency benchmark. Actual paid token/cost
accounting was not captured, so default zero-valued accounting fields must not be
interpreted as zero spend. At that checkpoint, the successful live RAGAS baseline
was still pending; the later one-case v6 measurement is recorded above and is not
a calibrated full-dataset baseline.

## Independent RAGAS grounding correction on 2026-09-10

The Evaluation Runner now records independently derived synthetic application
facts separately from retrieved policy. Faithfulness receives both sources;
factual-correctness precision uses the reviewed reference supplemented with those
facts. Retrieval precision/recall and their corpus are unchanged. No facts or
answer keys are extracted from generated responses. The grader version is now
`ragas-0.4-adapter-v2`; old and new scores cannot be directly baseline-compared.

Fresh offline verification: **158 Evaluation Runner tests passed**, Ruff lint
passed, and all 36 Python files passed formatting checks. The added regressions
cover independent money/status facts, malformed facts, metric-specific input
separation, unchanged retrieval evidence, and nonblocking grader-version mismatch.
Eleven missing-behavior tests failed before implementation; all pass now.

This verifies wiring and guardrails, not LLM-judge quality. A successful paid
one-case baseline and fresh browser wording recheck remained pending at that
checkpoint. No paid API,
refund execution, runtime code, secrets or indexed documents were changed by
this evaluation-only correction. No commit or push was made.

## Cited delivery-policy wording correction on 2026-09-10

The September 7 one-case live RAGAS artifacts `refund-ragas-baseline-20260907-003`
and `refund-ragas-baseline-20260907-004` recorded `SYSTEM_ERROR` with
`DELIVERY_AGE_TEXT_REJECTED`, not RAGAS quality scores. The old wording guard
rejected a general delivery-window statement even when it matched retrieved policy.

Prompt `refund-answer-v4` and `validate_delivery_policy_text` now distinguish a
supported, cited general policy explanation from personalized eligibility. The
bounded matcher checks the exact cited document/chunk, duration, time basis and
recognized rule conditions. An accepted explanation receives the application-owned
qualification that the customer's delivery timing has not been verified. Common
unsupported/mixed/negated windows, date questions, and personalized conclusions
are rejected. Trusted monetary formatting and the final answer length contract
remain in place. This is English defense in depth, not general semantic validation
or delivery-age enforcement.

Offline verification:

| Check | Result |
|---|---|
| Agent Runtime | Full suite: 123 passed, one existing Starlette deprecation warning |
| Evaluation Runner with installed optional production/RAGAS dependencies | Full suite: 141 passed |
| Production composer through evaluation adapter | Regression reproduced the old rejection, then passed with the qualified answer and unchanged evidence |
| Ruff lint | Both packages passed |
| Formatting | Changed Python files and all Evaluation Runner files passed; four untouched Agent Runtime files still fail formatting |

The four existing formatting failures are `agent_runtime/integrations/customer_evidence.py`,
`agent_runtime/integrations/trusted_context.py`, `agent_runtime/refund/router.py`,
and `tests/test_customer_evidence.py`. They were not changed by this fix.
Offline tests replace external model/retrieval calls; they do not prove live
model compliance or RAGAS score quality. No servers, secrets, indexed documents,
paid APIs, or provider refunds were changed or exercised in this correction.

A successful live RAGAS baseline and a fresh browser wording recheck remain
pending. The subsequent evaluation-only grounding correction above addresses the
distinction between retrieved policy and application-owned facts. Existing
reviewed reference answers are unchanged on disk. No commit or push was made for
this correction.

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
were in the local working tree during the proof and are now included in the
September 14 pushed history. Local data and secrets still do not travel with a clone.

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
waits. The current cited-policy wording safeguard has the September 10 offline
evidence above; a fresh paid live browser recheck has not been run.
