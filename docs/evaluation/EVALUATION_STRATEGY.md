# Customer Service Agent Evaluation Strategy

Status: Approved design direction
Date: 2026-09-06

## Purpose

This document defines how Customer Service OS Lite will evaluate retrieval,
generated answers, agent behavior, governance, and end-to-end customer-service
outcomes. Evaluation is a release boundary, not a collection of prompt tests.

The first evaluated journey is the governed refund flow. A later read-only order
status journey will test supervisor routing without delaying evaluation of the
already-complete refund vertical slice.

## Approved five-case baseline scope, September 13

The owner approved dataset v3 with the existing damaged-item reference and four
source-aligned reference corrections. See `RAGAS_DATASET_REVIEW.md` for the exact
texts. The older v1/v2 files and the development/held-out sets stay unchanged.
This does not change production prompts, guards, policy or retrieval.

The existing runner can evaluate all five cases with three repetitions. The
remaining empirical work is a separately authorized paid campaign, human review
of representative answers and judge disagreements, and a baseline report that
shows completion/rejection rates alongside semantic scores and scored coverage.
Human reference approval is not calibration. Report failures; do not repeatedly
tune and rerun one case until it passes. A v3 result is a new baseline, not a
direct improvement comparison with v2. Five cases cannot establish production
reliability, and provisional semantic minima are not calibrated release gates.

The hybrid answer-composer design is a separate product change, not a prerequisite
for recording honest failures. After this bounded baseline report, continue to
LangSmith experiments and then the external Tau retail benchmark. Their scores,
full-workflow evaluations and expanded/held-out evaluation remain separate work.
No paid v3 run, human ratings, LangSmith export or Tau execution is implied by
the fixture and diagnostic changes.

## Approved reference revision, September 12

`refund-rag-answer-v2.json` contains the owner's approved damaged-item reference:
the published request window, order/item identification and photo evidence before
approval. Its other four cases and all safety expectations are unchanged from v1.
The old dataset and live result are retained; the expected answer change requires
a separate v2 baseline. Four new offline checks bring the Evaluation Runner suite
to 212 passing tests. No new semantic scores or independent human calibration
were produced by that offline revision. The later authorized one-case v2 trial
failed at `DELIVERY_AGE_TEXT_REJECTED` before grading, despite successful query
embedding and answer API calls. Its usage report measured 3,966 tokens, not a
semantic score. The rejected text was not captured; its exact cause remains
unproven. See `../VERIFICATION_STATUS.md` for the historical artifact details.

The approved bounded offline batch extended private diagnostics to exact pinned
v1/v2 fixtures and prepared `RAGAS_DATASET_REVIEW.md`. Its full suite passed 218
tests, with lint and formatting clean; no new paid trial or live score followed.
Reference changes and human marks are not automated. Any additional paid trial
and rejected-answer retention require explicit approval. Diagnose the captured answer offline before changing
behavior or expanding trial coverage; do not silently reuse old paid permission.

## Offline tooling follow-up, September 11

The approved three-worker batch added candidate development/held-out datasets,
opt-in measured provider usage, explicit versioned cost estimates, and baseline
comparison checks for evaluator/judge/repetition compatibility and system-error
transitions. The combined Evaluation Runner suite passed 208 tests. The usage
sidecar is separate from quality samples and preserves unknowns as null; it is
not production observability or a provider bill. See the service README for flags
and `../VERIFICATION_STATUS.md` for verification boundaries. This batch made no
paid calls and did not complete human calibration or the remaining live trials.

## Current baseline

The Knowledge/RAG service already has a small retrieval evaluation foundation:

- versioned retrieval datasets;
- document-scoped expected and forbidden evidence;
- Recall at K and mean reciprocal rank;
- forbidden-evidence detection;
- tenant, environment, release, classification, locale, and effective-time
  validation;
- one real local five-case run against the 18-chunk OpenSearch corpus.

That local run produced Recall at 3 of `1.0`, MRR of `1.0`, and a
forbidden-evidence rate of `0.0`. These results prove that the small fixture and
runner are connected correctly. They are not a production-quality claim.

The repository now also contains the first answer-evaluation foundation:

- a five-case reviewed refund RAG answer dataset;
- an adapter that withholds reference answers from the system under test;
- exact customer-safe evidence, citation, tenant, environment, release, locale,
  and effective-time validation;
- deterministic expected-evidence, citation-count, and prohibited-claim graders;
- RAGAS 0.4 context precision, context recall, faithfulness, response relevancy,
  and factual correctness adapters;
- an isolated executor that reuses production retrieval, proposal, and answer
  components with synthetic order facts and no commerce boundary;
- a guarded one-case live command that refuses to construct external clients
  unless `ALLOW_PAID_API_CALLS=true`.

Automated tests remain offline. Paid one-case attempts on September 7 and 10,
and the earlier September 11 v5 attempt, failed in the production answer composer
before semantic grading with `DELIVERY_AGE_TEXT_REJECTED`; they are failed system
trials, not zero-valued RAGAS scores. The September 11 v6 run completed one
synthetic case and produced the first measured semantic baseline. It is still only
one case/repetition: semantic grades remain informational, provisional minima are
not calibrated release thresholds, and no production-quality claim follows.

### Initial measured RAGAS cycle, September 11

The September 10 diagnostic captured a real synthetic answer instructing the
customer to ensure their request was within 30 days of delivery. The retrieved
policy supported that window for damaged items, but the personalized, unqualified
wording was rejected. Prompt `refund-answer-v5` now supplies conditional allowed
and disallowed examples. The exact rejected response is preserved in an offline
regression; the guard itself is unchanged. This tests the enforcement boundary,
not whether the model reliably follows the improved prompt.

The v5 trial also failed before judging; its exact rejected answer was not retained.
An offline contrast showed that the guard also rejected a safe statement that
eligibility had not been assessed. The approved Batch 1 corrects that bounded
false positive and introduces opt-in synthetic diagnostics. Prompt v6 makes
qualification application-owned; complete allowlisted uncertainty sentences are
replaced, not exempted together with surrounding unsafe clauses. General policy
windows still require supporting cited evidence, and safety decisions are unchanged.

Rejected-answer capture is off by default. The live diagnostic command permits
only the pinned built-in synthetic dataset and writes a private separate sidecar.
It never turns a rejected answer into a sample or calls semantic judges on it.
Evidence scope is checked before answer composition as well as at the final adapter.

The next measured cycle is staged:

1. Finish offline checks for the answer boundary, opt-in diagnostic capture,
   existing five-case dataset, metric input separation, and honest failure reporting.
2. Obtain separate authorization for one live synthetic damaged-item trial.
   Inspect the final answer, actual retrieved evidence, independent application
   facts, and each applicable semantic score together. Do not retry automatically
   until a favorable answer appears.
3. If the path works, request a separately bounded run of the remaining seed
   cases and repeated trials. Preserve failures and versioned results, not only
   successful samples. Prompt/grader changes require compatible baselines.
4. Record the first measured baseline and human review of what the scores mean.
   Five seed cases and a few repetitions do not establish production reliability
   or calibrated release thresholds. Candidate dataset expansion is implemented
   offline, while owner review, independent human calibration, and full
   agent/workflow evaluation remain separate work.

The v6 trial produced scores and no refund actions; the diagnostic and earlier
failed trials produced no semantic scores. The v6 result and a human-review
checklist are recorded in `RAGAS_BASELINE_REVIEW.md`. Missing semantic scores are
not zero scores; unmeasured token/cost fields are not evidence of free execution.
Framework implementation, one-case empirical measurement, and calibrated model
quality remain different completion claims.

### Delivery policy explanation boundary, September 10

The approved answer behavior distinguishes explaining a published delivery window
from determining this customer's eligibility. A general explanation must be
supported by the actual cited customer-safe evidence. Application code adds:
"This is policy information, not confirmation that your request qualifies. Your
delivery timing has not been verified."

Delivery-date questions, unsupported windows and personalized delivery-eligibility
claims remain prohibited. This does not implement delivery-age enforcement or
change Temporal, deterministic policy, supervisor approval or customer confirmation.
The English wording checks are defense in depth, not a universal semantic judge.
RAGAS evaluates the final qualified answer. Retrieved evidence and the reviewed
dataset references are not rewritten to make a trial pass. The grounding
refinement below adds independently derived application facts only at the answer
grading boundary.

The next paid step is one separately authorized synthetic case, not an automatic
rerun of the dataset. Offline adapter tests cannot establish live model quality.

### Independent application grounding, September 10

Implemented in the Evaluation Runner after the wording correction. The refund
executor snapshots an allowlisted set of facts from validated synthetic fixture
input before invoking proposal/answer components: order reference, item name,
customer-reported reason, full-order request scope, proposed USD amount, no
approval/execution, and unverified delivery timing. These describe this isolated
evaluation, not a live workflow. They never come from generated answer text or
the reviewed reference. Versions record `synthetic-refund-facts-v1` and
`knowledge-answer-adapter-v2`.

The sample records `application_facts` separately from `retrieved_contexts`:

| Metric | Evidence/reference supplied |
|---|---|
| Context precision and recall | Original policy chunks and reviewed policy reference only |
| Faithfulness | Full answer, original chunks, plus a labelled trusted application facts block |
| Factual correctness | Full answer versus reviewed reference plus the same independent facts |
| Response relevancy | Original question and full answer only |

Factual correctness uses **precision**, not its former default F1: check claims
actually made without requiring the answer to recite every available fact. This
does not measure answer completeness. Retrieval recall and deterministic safety
checks remain separate; comprehensive answer-completeness evaluation is future
work. Scores remain informational and require human calibration.

Grader version `ragas-0.4-adapter-v2` marks the changed semantics. Baseline
comparison rejects mismatched grader versions, including nonblocking metrics.
The tests prove input separation and that a generated "$999 approved" answer
cannot replace independent "$120 proposed, no approval" facts. Offline judge
doubles do not establish semantic accuracy. The next paid step remains one
separately authorized expanded run; one live synthetic score exists, but it is not
yet a calibrated release baseline.

The repository now contains a seven-case synthetic refund-agent dataset and a
deterministic in-process adapter for the existing LangGraph intake/proposal
path. It covers route status, tool selection and arguments, proposal fields,
final state, safety invariants, and caller-supplied retained context across
turns. The adapter does not persist or reload conversation storage.
An independent one-case `refund-agent-failure-modes-v1.json` dataset now checks
retrieval-unavailable fallback through that same real graph. Its tests inspect
the retained trace for no answer-model call and no citations, and verify that
the existing graders reject deliberately corrupted state/tool observations.
The original seven-case dataset and all RAG reference answers remain unchanged.
`OrderLookup` observations grade only the protocol's order-reference argument;
fixture tenant/environment values remain separately labeled trusted context.
Production assertion-boundary tests, not this adapter, cover tenant binding.
Temporal, human approval, customer confirmation, provider execution, and
reconciliation are not evaluated yet. Public benchmark adapters, calibrated
model-judge rubrics, and complete evaluation release gates remain future work.

## Evaluation architecture

```text
Versioned evaluation dataset
        |
        v
Python Evaluation Runner
  |-- system adapter: RAG, Agent Runtime, or full refund sandbox
  |-- deterministic graders
  |-- RAGAS graders
  |-- model-based graders
  |-- optional benchmark adapters
        |
        v
Versioned trial records and aggregate report
        |
        +--> developer comparison
        +--> regression gate
        +--> later LangSmith experiment export
```

The Evaluation Runner belongs to the Control and Knowledge release boundary. It
must call evaluated systems through public or explicitly test-only interfaces. It
must not be imported by Agent Runtime to influence runtime decisions.

## Why the runner is separate

Putting all evaluation code inside Knowledge/RAG would make agent, workflow, and
policy evaluation awkward. Putting it inside Agent Runtime would let the system
under test own its grading boundary. A separate Python workload provides one
place for datasets, repetitions, graders, reports, and benchmark adapters while
leaving each runtime independently deployable.

## Four evaluation layers

### 1. Retrieval evaluation

Checks whether the correct evidence was found and prohibited evidence was kept
out.

Primary metrics:

- Recall at K;
- mean reciprocal rank;
- context precision;
- context recall;
- forbidden-evidence rate;
- tenant, environment, release, classification, locale, and effective-time
  violations;
- reranker lift compared with the fused candidate order.

RAGAS may calculate semantic retrieval metrics. Deterministic governance checks
remain authoritative.

### 2. Answer evaluation

Checks whether the final customer answer is useful and supported by retrieved
evidence.

Primary metrics and checks:

- faithfulness to retrieved context;
- answer relevancy;
- factual correctness where a reference answer exists;
- citation correctness and citation completeness;
- policy coverage;
- unsupported promise detection;
- customer-safe wording;
- empathy and clarity using a calibrated model judge.

An LLM judge may score subjective quality. It may not decide whether tenant,
authorization, money, or provider-state rules passed.

### 3. Agent evaluation

Checks behavior across turns rather than only the last answer. In the current
deterministic slice, the caller supplies bounded retained context and a
previously resolved order reference for each turn; this is not a claim of
persisted conversation storage.

Primary checks:

- correct specialist or route;
- correct tool selection and arguments;
- appropriate clarification when required facts are missing;
- caller-supplied conversation context used across turns;
- required handoff or approval performed;
- no prohibited tool or unauthorized action;
- final environment state matches the requested outcome;
- no duplicate provider action;
- latency, token use, and cost per trial.

Trajectory grading should allow more than one safe path. Exact tool order is
asserted only when order is itself a safety invariant.

The current deterministic implementation evaluates seven core synthetic refund cases
plus one separately versioned retrieval-outage case
through the existing LangGraph intake/proposal path. It grades route status,
selected tools and arguments, proposal fields, final state, and safety
invariants, including retention of an order reference across multiple turns.
That case receives retained conversation messages and the prior order reference
from its caller; the adapter itself has no conversation store. Its lookup trace
separates observed protocol arguments from fixture-supplied trusted
tenant/environment context. Production assertion-boundary tests cover actual
tenant binding. It does not run Temporal or exercise human approval, customer
confirmation, provider execution, or reconciliation.

### 4. Governance and adversarial evaluation

Checks invariants that must pass even when answer quality is otherwise high.

Examples:

- cross-tenant order lookup attempts;
- internal-only knowledge leakage;
- prompt injection in customer text, knowledge, or tool results;
- attempts to bypass supervisor or customer confirmation;
- fabricated order, preview, case, and refund identifiers;
- replayed confirmation or provider events;
- stale facts and stale policy or knowledge releases;
- ambiguous provider outcomes;
- evidence accepted without an authorized staff decision.

Critical governance checks are binary release blockers.

## Dataset strategy

### Internal golden dataset

The authoritative product dataset starts with 30 to 50 reviewed refund cases.
Cases are synthetic or explicitly approved and contain no raw customer personal
data. Each case includes:

- stable case ID and dataset version;
- capability and scenario tags;
- initial environment state;
- one or more customer turns;
- expected final state;
- required and forbidden outcomes;
- applicable prompt, knowledge, policy, workflow, and tool-contract versions;
- grader configuration.

Cases should cover happy paths, missing facts, policy denial, photo evidence,
human approval, manual takeover, customer decline, preview expiry, duplicate
confirmation, provider failure, reconciliation, and adversarial isolation cases.

Every manually discovered regression becomes a permanent case after it is
minimized and reviewed.

### Public benchmarks

- Use the maintained tau-three Retail benchmark as the primary external
  multi-turn retail comparison. Do not use the outdated tasks in the original
  `tau-bench` repository.
- Use STATE-Bench customer-support scenarios as a secondary breadth check.
- Use ECom-Bench concepts for multimodal damaged-item evidence.
- Use AgentDojo concepts for prompt-injection and tool-security cases.

Official benchmark tasks and internal adapted tasks must be reported separately.
Changing a benchmark task makes it an internal case, not a comparable public
benchmark result.

## Framework decisions

### RAGAS

Use RAGAS for semantic RAG metrics such as context precision, context recall,
faithfulness, and response relevancy. Wrap it behind our grader protocol. RAGAS
does not replace deterministic metadata, authorization, classification, or
citation-identity checks.

The current implementation uses the RAGAS 0.4 collections API and records each
metric as a separate `GraderResult`. It includes precision-mode factual
correctness for reviewed-reference cases, with separately labelled application
grounding as described above. The optional dependency pins `langchain-community` to
`0.3.31` because RAGAS `0.4.3` imports a legacy VertexAI compatibility module
removed in `langchain-community` `0.4.x`. This pin is isolated to the Evaluation
Runner's optional RAGAS extras and covered by an import smoke test.

For a damaged-item example:

- context precision falls when an unrelated shipping chunk ranks above the
  damaged-item policy;
- context recall falls when the retrieved chunks omit the photo-evidence rule
  contained in the reviewed reference;
- faithfulness falls when the answer claims approval even though no retrieved
  context supports approval;
- response relevancy falls when the answer discusses an unrelated topic;
- factual correctness falls when the answer contradicts the reviewed safe
  answer.

These are model-estimated semantic measurements. They can vary by judge model and
prompt and must be calibrated against human review. Exact identity, isolation,
authorization, and side-effect checks remain deterministic. Every completed
live sample records the exact judge and judge-embedding model identifiers in its
version evidence before the artifact is written.

### LangSmith

Use LangSmith later for datasets, experiment comparison, trace inspection, and
AgentEvals trajectory grading because Agent Runtime already uses LangGraph.
Evaluation contracts and pass/fail policy remain repository-owned so switching
experiment platforms does not rewrite business correctness.

### Model judges

Use model judges only for semantic or experiential criteria. Judge prompts,
models, rubrics, and versions are recorded. A reviewed sample is periodically
double-scored by humans to measure judge agreement.

## Trials and reliability

Agent results are nondeterministic. Each case may run more than once:

- development: one trial for fast feedback;
- nightly regression: three trials;
- release qualification: five trials for critical suites.

Reports include first-attempt pass rate and consistency (`pass^k`). Customer
support emphasizes consistency because every customer needs a correct outcome,
not merely one successful attempt among several.

## Grading authority

Use the strongest available evidence in this order:

1. authoritative final database or provider state;
2. deterministic policy, authorization, contract, and side-effect checks;
3. deterministic response and citation checks;
4. model-based semantic graders;
5. human review and calibration.

A fluent answer cannot compensate for an unauthorized or incorrect side effect.

## Initial release-gate policy

The first runs establish baselines before setting quality thresholds. The
following safety gates apply immediately:

- zero cross-tenant evidence or commerce access;
- zero internal-only evidence in a customer answer;
- zero unauthorized refund attempts;
- zero duplicate provider refunds;
- required customer and human approvals present for every applicable action;
- every claimed completed refund verified against authoritative provider state.

Quality thresholds for retrieval, answers, latency, and cost will be proposed
after the expanded dataset has a reviewed baseline. Selecting arbitrary targets
before measuring the dataset would create misleading gates.

## Privacy, safety, and cost

- Evaluation fixtures contain synthetic or approved data only.
- Raw production transcripts require a separate redaction and approval design.
- Tests do not make paid model calls by default.
- Paid evaluation requires an explicit flag and owner authorization.
- Trial concurrency is bounded and costs are estimated before a large run.
- Uploaded customer photos remain outside RAG and model evaluation unless a
  separately approved, privacy-safe multimodal dataset is introduced.
- Evaluation never creates a commerce refund unless the exact test and disposable
  order were explicitly authorized.

## Delivery sequence

1. Build framework-neutral evaluation case, trial, grader, and report contracts.
2. Connect the existing Knowledge/RAG retrieval evaluator through an adapter.
3. Add RAGAS answer and context graders with deterministic fakes for tests.
   Implemented offline; the one-case completed baseline is recorded, while a
   complete/full-dataset paid baseline remains pending.
4. Create the reviewed refund RAG and answer dataset. The five-case seed and
   candidate 10-development/5-held-out expansion are implemented offline; owner
   review, broader coverage, and the complete/full-dataset paid baseline remain
   pending.
5. Expand refund-agent sandbox coverage beyond the current deterministic
   intake/proposal adapter.
6. Add Temporal, approval, confirmation, provider, and reconciliation
   simulations, then expand trajectory coverage and repeated trials.
7. Export experiments and traces to LangSmith.
8. Add the official tau-three Retail adapter and keep its scores separate.
9. Add a read-only order-status journey to evaluate supervisor routing.
10. Add production sampling and online evaluation after observability exists.

## Non-goals for the first implementation

- no Admin Console UI;
- no production transcript ingestion;
- no automatic prompt optimization;
- no paid model evaluation by default;
- no provider mutation;
- no attempt to integrate every benchmark at once;
- no replacement of service-owned unit and contract tests.
