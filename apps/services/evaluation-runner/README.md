# Evaluation Runner

This package provides the framework-neutral core for evaluating Customer Service
OS Lite. Its core does not call OpenAI, RAGAS, LangSmith, tau-three, or a commerce
provider. System-specific adapters connect evaluated workloads to these stable
contracts without changing the runner.

## Current RAG evaluation checkpoint

The owner-approved five-case seed is now
`fixtures/evaluation-datasets/refund-rag-answer-v3.json`. It retains the v2
damaged-item reference and corrects the other four references against the
CUSTOMER_SAFE policy. Inputs, application facts, evidence targets, safety checks
and grader settings are unchanged. Historical v1/v2 fixtures remain intact.
Dataset v3 needs a fresh baseline; do not compare its scores to v2 as a prompt
improvement. See [the reference decisions](../../../docs/evaluation/RAGAS_DATASET_REVIEW.md).

No v3 paid campaign or human calibration has run. The existing runner supports
all five cases and repeated trials; no new runner is needed. The proposed bounded
campaign is five cases times three repetitions, with separate paid-call and
private-capture approval. Fifteen trials is not a fifteen-call cap: each passing
answer can trigger multiple judge calls. Answer/query clients disable SDK retries;
the judge client does not explicitly disable them. Do not promise a hard call or
cost cap from `--repetitions`.

The current prompt is v8. Its latest v2 trial failed before grading, as did v7;
the v6/v2 damaged-item trial has measured scores. Preserve every failure, report
the number of scored trials separately, and never average missing scores as
zero or report only the successful subset as overall reliability. A completed
trial's pass flag reflects blocking checks, not all semantic minima. Human
review is still needed. The answer-composer redesign, LangSmith and Tau work are
separate from this baseline campaign; do not restart prompt-only retries while
collecting the fixed-version baseline.

## The evaluation flow

```text
Versioned dataset
    -> case
    -> evaluated system
    -> observed sample
    -> deterministic and semantic graders
    -> trial result
    -> case and run summaries
```

- A **dataset** is a reviewed and versioned collection of scenarios.
- A **case** describes the input and the expected safe outcome.
- A **sample** records what the system actually did, including final state,
  structured trace events, latency, token usage, cost, and component versions.
- A **grader** compares the case expectations with the observed sample.
- A **trial** is one attempt at one case. System failures are preserved as failed
  trials; evaluator failures invalidate the run instead of blaming the product.
- A **blocking grade** controls whether the trial passes. An informational grade
  remains visible but cannot hide or override a safety decision.

## Future full-refund sandbox example

The following is an illustrative future full-refund sandbox case, not the
currently implemented intake/proposal adapter. It supposes a reviewed case
expects the sandbox to finish with exactly one refund:

```python
EvaluationCase(
    case_id="refund-damaged-item-001",
    name="Damaged item follows governed refund path",
    capability=EvaluationCapability.AGENT,
    input={"customer_message": "My synthetic order arrived damaged."},
    expectations={
        "required_final_state": {"refund_count": 1},
        "forbidden_tools": ["agent_direct_refund"],
    },
    tags=["refund", "governance"],
)
```

The case is the reviewed expectation. A future full-refund sandbox would then
return an `EvaluationSample`, which is the observed evidence. Its final state
might contain `refund_count: 1`, while its structured trace shows order lookup,
policy review, human approval, customer confirmation, and gateway execution. The
trace must not contain `agent_direct_refund` because an agent must not bypass the
governed path.

`RequiredFinalStateGrader` checks the authoritative outcome.
`ForbiddenToolCallGrader` checks structured tool-call evidence. It does not search
the assistant's prose, so an explanation that mentions a tool name cannot create a
false failure.

If the case runs three times, the runner stores three independent trials:

- `pass@1` is the fraction of individual trials that pass;
- case consistency is true only when all three repetitions pass;
- one failure among three gives a case pass rate of `2/3`, but consistency is
  false.

This distinction matters because a customer-service agent that works occasionally
is not reliable enough for release.

## Connected Knowledge/RAG retrieval evaluation

The first system adapter reuses the existing governed Knowledge/RAG dataset,
retrieval executor, and deterministic retrieval metrics:

```text
refund-governed-retrieval-v1.json
        -> adapt_retrieval_dataset()
        -> KnowledgeRetrievalEvaluatedSystem.run()
        -> EvaluationSample
        -> RecallAtKGrader
        -> ReciprocalRankGrader
        -> ForbiddenEvidenceGrader
        -> EvaluationRun
```

For example, if the expected damaged-item policy appears second in the top three
results, the sample records Recall at 3 of `1.0` and reciprocal rank of `0.5`.
These remain separate quality grades. If any explicitly forbidden policy or
internal chunk appears, `ForbiddenEvidenceGrader` fails the trial regardless of
the quality scores.

The adapter preserves tenant, environment, knowledge-release, classification,
locale, and effective-time restrictions. Its sample contains ranked document and
chunk identities, hashes, retrieval methods, and model versions. It deliberately
does not copy knowledge text into the generic evaluation record.

The automated tests inject a deterministic fake `RetrievalExecutor`; they do not
connect to OpenSearch, download a model, or call a paid API.

## RAGAS answer evaluation

The answer suite evaluates the real production retrieval and refund-answer
components in isolation from commerce:

```text
reviewed customer question + synthetic trusted order facts
        -> governed hybrid OpenSearch retrieval
        -> production refund answer composer
        -> exact response, contexts, evidence IDs, and citations
        -> deterministic answer graders
        -> RAGAS semantic graders
```

The synthetic order exists only to satisfy the production answer composer's
trusted input contract. The evaluator does not call Vendure, start a Temporal
workflow, create a human-operations case, or issue a refund.

The reviewed reference answer stays in `EvaluationCase.expectations`. It is never
passed to the system under test. The system produces the response and retrieved
contexts first; graders receive both only afterward. This prevents the answer
generator from seeing the answer key.

Each case records eight independent grades:

- expected evidence checks exact document-and-chunk identity;
- minimum citations checks structured citation count;
- prohibited claims rejects reviewed literal promise phrases and is blocking;
- context precision checks whether useful context ranks ahead of noise;
- context recall checks whether context covers the reviewed answer's facts;
- faithfulness checks response claims against policy and trusted application facts;
- response relevancy checks whether the response addresses the question;
- factual correctness uses precision to compare stated claims with the reviewed
  reference and independent application facts; it does not measure completeness.

`RefundRagAnswerExecutor` creates `application_facts` from validated synthetic
input before calling the answer composer. For `requested_amount_minor=12000`,
one fact is `Proposed refund amount: USD 120.00.` Other facts distinguish a
customer-reported reason from verified damage, record unverified delivery timing,
and state that this isolated evaluation has not approved or executed a refund.
Generated answer text and reviewed answer keys never supply these facts.

`KnowledgeAnswerEvaluatedSystem.run()` preserves those facts separately from
retrieval text, ranks, document IDs, hashes and citations. `_metric_inputs()` adds
the labelled facts block only to faithfulness context and factual-correctness
reference. Retrieval metrics keep their original corpus and policy reference;
response relevancy still uses just the question and response. The dataset file
is unchanged. Facts are trusted because of their allowlisted executor origin,
not because an arbitrary string is labelled "trusted"; a future live adapter
must obtain them independently from verified application state.

Versions: `knowledge-answer-adapter-v2`, `synthetic-refund-facts-v1` and
`ragas-0.4-adapter-v2`. Do not compare v2 scores directly with v1; the baseline
comparator rejects different grader versions. The factual-correctness result
records `mode: precision`. All semantic metrics remain informational.

The first measured grader-v2 baseline (using dataset v1) is recorded in
[`docs/evaluation/RAGAS_BASELINE_REVIEW.md`](../../../docs/evaluation/RAGAS_BASELINE_REVIEW.md):
one synthetic case and one trial. Its five RAGAS grades remain informational
because the sample is too small for calibration; a semantic score cannot override
a classification, tenant, citation, authorization, or prohibited-promise failure.

The September 10 one-case trial,
`/private/tmp/refund-ragas-baseline-20260910-001.json`, stopped in the answer
composer with `DELIVERY_AGE_TEXT_REJECTED`. It persisted a `SYSTEM_ERROR` trial
with no sample, grader results, or fabricated semantic zeros. The companion
diagnostic, `/private/tmp/refund-ragas-diagnostic-20260910-001.json`, also records
that no RAGAS judges ran; it isolated the rejected personalized wording in the
synthetic answer. These are local temporary diagnostic artifacts, not a semantic
baseline; the durable outcome is recorded in
[Verification Status](../../../docs/VERIFICATION_STATUS.md).

The later authorized trial `refund-ragas-baseline-20260911-001` also stopped with
`DELIVERY_AGE_TEXT_REJECTED` before any judges ran. That trial did not capture the
exact rejected answer. It is not evidence that the model repeated the September
10 wording, and its failure is unrelated to customer/staff token expiry. The
subsequent v6 run completed one synthetic case; context recall and response
relevancy were below their nonblocking 0.7 minima, while the blocking deterministic
grades passed. Do not call this calibrated quality or a production baseline.

The September 10 guard refinement permits supported, cited general
delivery-policy windows only with an application-owned qualification, while
retaining restrictions on date requests and personalized eligibility claims. The
September 11 `refund-answer-v5` prompt examples make the permitted general-policy
wording and prohibited personalized wording explicit. The boundary introduced in v6
also handles three narrowly defined, complete eligibility-uncertainty sentences
by replacing them with an application-owned qualification. Any remaining unsafe
claims still reject. This is not a general natural-language safety guarantee.
The reference answers and retrieved contexts were not rewritten to obtain the
successful v1-dataset trial. On September 12 the owner approved a source-aligned
damaged-item reference in a new v2 dataset; the historical v1 file and result are
preserved. The authorized September 12 dataset-v2 trial then failed with
`DELIVERY_AGE_TEXT_REJECTED` before grading. Both provider calls succeeded;
3,966 tokens were measured, no judge calls ran, and the rejected answer was not
retained. This was not token expiry and does not reveal which wording caused it.
See [Verification Status](../../../docs/VERIFICATION_STATUS.md) for the run ID
and artifact details. That checkpoint's diagnostic capture and offline replay
have since been completed; follow the current v3 checkpoint above. Do not retry
automatically or advance to more cases merely because diagnostic support exists.
New references and additional paid runs need approval.

The live runner accepts either `--case-id` for one reviewed case or no case
filter for the complete dataset. Each case declares its reviewed RAGAS metric
list and whether semantic grades are blocking; all five current cases keep
semantic grades nonblocking. Malformed evaluator configuration is fatal. A
system failure or blocking grade failure is recorded as failed and produces a
nonzero CLI exit. Every completed live sample records the exact judge model and
judge embedding model from the guarded command in its version evidence before
the result artifact is written.

The current seed dataset is
`fixtures/evaluation-datasets/refund-rag-answer-v3.json`. It contains five
customer-safe cases: damaged-item evidence, incorrect-item verification,
final-sale exceptions, larger-refund review wording, and provider-processing
expectations.

For historical v2 compared with `refund-rag-answer-v1.json`, only `dataset_version` and
the damaged-item reference differ. Case IDs, questions, synthetic application
facts, expected chunks, prohibited claims and grader settings are identical. The
owner-approved reference states the 30-calendar-day policy window, order/item
identification and photos before approval; it no longer expects an unsupported
photo-upload-starts-review statement from retrieved policy. This approval is for
that reference only, not full dataset calibration or permission for paid calls.
v1 and v2 results cannot be baseline-compared because the expected answer changed.
The evaluator/grader version remains `refund-ragas-v2`; dataset and evaluator
versions are independent.

Normal runs may enable usage recording. Optional `--rejection-diagnostics-path`
accepts the exact pinned v1, v2 and v3 fixtures; the path and content pins are
separate from permission to run a paid trial or retain a rejected answer.

Diagnostic boundary checked on September 13: the live CLI is **not** an
answer-only command. If the answer passes its production checks, the configured
RAGAS judges run. Zero judge calls on a rejected trial do not guarantee zero
judge calls on the next trial. Obtain approval for the whole configured trial,
or separately design an answer-only path; do not silently reuse earlier approval.

After an authorized private capture, delivery-policy rejection can be replayed
offline: validate the sidecar schema, reconstruct `CustomerAnswer` from its
response and citations, obtain the exact `CUSTOMER_SAFE` evidence by document
and chunk identity, and verify its content hashes against the captured hashes.
Pass that answer and evidence to `validate_delivery_policy_text()`. The sidecar
deliberately excludes evidence content, so a different or unverified chunk is
not an exact replay. Report only the rejection code or qualification result,
not raw captured text. This isolates the delivery validator, not every composer
guard; its shared rejection code alone does not identify the failing branch.
The uncaptured September 12 response cannot be reconstructed from its error code.

Candidate expansion is implemented offline as ten development and five held-out
cases, with manifest
`fixtures/evaluation-datasets/refund-rag-splits-v1.json` and files
`refund-rag-development-v1.json` and `refund-rag-heldout-v1.json`. Every expanded
case is marked `AGENT_AUTHORED_PENDING_OWNER_REVIEW`. Held-out cases are excluded
from prompt tuning but share the same author/source and are not an independently
validated benchmark. Zero-evidence abstention is excluded because the executor
requires evidence; clarification cases are included only where applicable.

Use [the dataset review worksheet](../../../docs/evaluation/RAGAS_DATASET_REVIEW.md)
to review source support and unresolved owner decisions for all 20 current cases.
It is an agent-prepared worksheet, not human approval or calibration. It does not
change fixture answers or make held-out cases available for prompt tuning.

### Optional measured usage and cost estimates

Add `--usage-output-path /private/tmp/<new-run>/usage.json` to a separately
authorized live command to enable provider-usage collection. The directory must
already exist and the report path must be new. The content-free
`evaluation-usage-v1` sidecar is separate from answer/quality results and rejection
diagnostics. It groups SDK invocations and available token counters into query
embedding, answer, judge, and judge-embedding components.

`UsageRecorder` records provider metadata, not prompts, answers, evidence text,
headers, or keys. Cached input and reasoning output are subsets of input/output
tokens; they are not added again to total tokens. Missing metadata remains `null`,
not zero. `run_status` and `measurement_status` are separate: an answer can fail a
guard after its token use has been measured. The sidecar is also attempted on a
fatal judge error, without converting that error into a successful quality run.
Its publication refuses existing output/staging files; it does not overwrite or
remove another run's report. An unwritable filesystem can still prevent a report.

Cost is `null` unless `--price-schedule-path` supplies an explicit versioned USD
rate schedule and sufficient token metadata is available. The schedule records
an effective date and exact provider/model rates for input, cached input and
output per million tokens. No current prices are fetched or guessed. A missing
cached count can be priced only when cached and uncached input rates are equal;
otherwise the estimate remains unknown. These are estimates, not provider
invoices; SDK invocation counters do not enumerate hidden transport retries.

The numeric zero usage/cost fields in older quality artifacts remain legacy,
unmeasured placeholders. Do not backfill the September 11 trial with invented
usage, or confuse these optional evaluation counters with production
observability.

### Comparing compatible runs

`compare_runs()` requires the same dataset/version, case/repetition coverage,
evaluation version and, for completed pairs, judge model, judge embedding model
and judge token budget. Answer-model and prompt changes are allowed because those
can be the experiment being evaluated. Completed pairs must retain matching
grader identities and blocking classification.

A completed baseline trial followed by `SYSTEM_ERROR` is a system regression;
the reverse is a recovery. Neither receives fabricated semantic scores. Blocking
grade regressions are separate from informational semantic score deltas. A judge
configuration change requires a new baseline, not a misleading quality comparison.

### Optional synthetic rejection diagnostics

After explicit authorization for a paid trial, add this option to the guarded
command below only if retaining its rejected synthetic answer was also approved:

```text
--rejection-diagnostics-path /private/tmp/refund-ragas-rejections-UNIQUE.json
```

Choose a new result path and a separate new diagnostics path each time. Diagnostic
mode is off by default. It accepts only these built-in files under
`fixtures/evaluation-datasets/`, at their reviewed resolved paths and SHA-256
content pins:

| Fixture | SHA-256 |
|---|---|
| `refund-rag-answer-v1.json` | `00aa539c014dfd3d45944c5f8bacc327e1c79dfdaf04b44027bd26a107f533d6` |
| `refund-rag-answer-v2.json` | `06679dfeb9e3279c29127233e6b694c3eb4a3c1583e334df3cfe4a37f1c7b7b3` |
| `refund-rag-answer-v3.json` | `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |

Copied/custom datasets and changed fixture content are rejected before clients
are created. Validation reads the bytes once and passes those verified bytes to
dataset parsing; it does not trust a second read. Development and held-out files
are not on this allowlist. A future fixture change requires explicit synthetic
data review and a new pin; do not bypass the check to make a run pass.

The private sidecar records the original schema-valid rejected response and its
citations, response hash, safe rejection stage/code, trial identity, evidence
IDs/hashes/classification, and component versions. It does not copy retrieved
passages, reference answers, credentials, customer snapshots, or raw malformed
provider output. Evidence tenant, environment, release, locale and CUSTOMER_SAFE
classification are validated before the composer is called. Rejected text is
never printed automatically or returned to the customer.

The sidecar is created with owner-only permissions (`0600`) and refuses to
overwrite an existing file. Keep it outside Git. The main result still records
`SYSTEM_ERROR`, `sample: null`, and `grader_results: []`; semantic judges never
receive a rejected answer. Normal errors carry no rejected text unless capture
was explicitly enabled. A rejection without a schema-valid answer has no detailed
answer record. Evaluator failures still invalidate the run instead of producing
quality scores. Diagnostics are debugging evidence, not a successful baseline.

### Dependency boundary

The default package remains free of RAGAS and Agent Runtime. Install the optional
live evaluation dependencies with:

```bash
uv sync --extra live-ragas --dev
```

RAGAS `0.4.3` currently imports a compatibility module removed from
`langchain-community` `0.4.x`, so this extra pins `langchain-community` to
`0.3.31`. A smoke test imports all five collections metrics and will fail if a
future dependency update breaks this boundary.
Tests that import Agent Runtime production adapters skip before those imports
when the optional dependency is absent; the same tests execute under the
`live-ragas` extra.

### Guarded one-case live run

OpenSearch must be available locally and the Knowledge/RAG `.env` must contain
the configured index and a valid OpenAI API key. The Agent Runtime, Vendure,
Temporal, Edge API, and frontends are not needed for this isolated evaluation.

The command intentionally selects one case and one repetition. Replace the model
names only with models you have reviewed and approved:

```bash
ALLOW_PAID_API_CALLS=true RAGAS_DO_NOT_TRACK=true LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false \
  .venv/bin/python -m evaluation_runner.live_rag_evaluation \
  --dataset-path "$PWD/fixtures/evaluation-datasets/refund-rag-answer-v3.json" \
  --output-path "/private/tmp/NEW_PRIVATE_RUN_DIRECTORY/result.json" \
  --usage-output-path "/private/tmp/NEW_PRIVATE_RUN_DIRECTORY/usage.json" \
  --knowledge-env-path "../knowledge-rag/.env" \
  --case-id "damaged-item-evidence-answer-v1" \
  --answer-model "APPROVED_ANSWER_MODEL" \
  --judge-model "APPROVED_JUDGE_MODEL" \
  --judge-embedding-model "text-embedding-3-small" \
  --run-id "UNIQUE_APPROVED_V3_RUN_ID" \
  --evaluation-version "refund-ragas-v2"
```

Without `ALLOW_PAID_API_CALLS=true`, the command stops before constructing
OpenAI, OpenSearch, or local reranker clients. Even one case makes one product
answer call, a query-embedding call, an answer-relevancy embedding call, and
multiple RAGAS judge calls. RAGAS may use more than one internal judge call for a
metric, so review cost separately before running more cases or repetitions.

This example is not authorization. Create a fresh private output directory and
replace the placeholders only after approval. Do not reinstall dependencies when
the existing virtual environment already has the live extras.

For the proposed complete campaign, omit `--case-id` and add `--repetitions 3`.
This produces 15 trial records, sequentially. To retain rejected answers, also
add `--rejection-diagnostics-path` with a new private sidecar path only after
explicit retention approval. A system rejection records an unscored failed trial
and subsequent trials continue; fatal evaluator failures invalidate the run.
Check the result artifact even when the CLI exits nonzero. Do not rerun a failed
campaign automatically.

## Deterministic refund-agent trajectory evaluation

`fixtures/evaluation-datasets/refund-agent-v1.json` contains seven synthetic
cases. The deterministic in-process adapter exercises the existing LangGraph
intake/proposal path, including route status, tool selection and arguments,
proposal fields, final state, and safety invariants. The multi-turn case checks
caller-supplied retained context: each turn provides its bounded conversation
messages and any previously resolved order reference. The adapter does not
persist or reload conversation storage.

`fixtures/evaluation-datasets/refund-agent-failure-modes-v1.json` adds one
separate retrieval-outage case; the original seven-case dataset is unchanged.
The real graph receives a synthetic retrieval-unavailable error, retains a
ready proposal, and returns its production fallback without citations or an
answer-composer model call. The case uses the seven existing deterministic
graders. `tests/test_refund_agent_failure_modes.py` also inspects the retained
trace and corrupts observations to verify that final-state, forbidden-tool and
safety graders reject them. The no-answer-model-call check is a test assertion,
not a newly implemented generic trajectory grader. This is an offline agent
failure-path check, not a RAGAS score or a downstream workflow simulation.

The lookup trace separates actual `OrderLookup` protocol arguments from
adapter-supplied trusted context. Reviewed tool arguments therefore contain only
`order_reference`; the synthetic tenant and environment remain labeled as
fixture trusted context and final state. Production assertion-boundary tests,
not this deterministic adapter, cover tenant binding. The adapter does not
execute Temporal, human approval, customer confirmation, provider execution, or
reconciliation.

`EvaluationRun` records strict dataset case/repetition coverage plus summary,
trial, and grader integrity evidence. Baseline comparison rejects mismatched
dataset or grader coverage, including a changed blocking classification, and
reports newly failing blocking grades separately from informational score
deltas.

## Why execution is sequential first

The foundation runs one trial at a time. This makes ordering reproducible and
prevents a future model-backed evaluator from accidentally producing a burst of
paid API calls. Bounded concurrency can be added later with explicit cost limits.

## Local verification

From this directory, run:

```bash
uv run ruff format --check .
uv run ruff check .
uv run pytest
```

These tests are offline and use synthetic data only.

To include the optional integration import and production-component adapter
tests, run:

```bash
uv run --extra live-ragas ruff format --check .
uv run --extra live-ragas ruff check .
uv run --extra live-ragas pytest
```

These commands still make no external model or service calls.
