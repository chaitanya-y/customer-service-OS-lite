# RAGAS v3 measured baseline

Date: 2026-09-14

Run: `refund-ragas-v3-campaign-20260914-001`
Status: Campaign complete; reliability gate failed; human calibration pending

## Verdict

The owner-authorized campaign attempted all five approved cases three times.
Five of 15 trials produced validated answers and all five RAGAS grades. Ten
answers were rejected before grading. No case passed all three repetitions.
This completes the bounded measurement, not production readiness or human
calibration. Do not rerun until a favorable result appears or erase failures.

The process exited 1 because its blocking pass rate was below 1, not because
the evaluator crashed. The complete result, usage and rejection sidecars passed
their Pydantic schemas and exact 5-by-3 coverage checks. All 95 recorded provider
invocations succeeded; the failures occurred in post-model answer validation,
not login tokens, service availability or judge execution.

## Fixed configuration and scope

| Setting | Value |
|---|---|
| Code checkpoint | `87ab48f` on `dev`, included in `main` merge `97028db` |
| Dataset | `tenant-local-refund-rag-answer`, version `v3` |
| Dataset SHA-256 | `1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de` |
| Answer prompt / model | `refund-answer-v8` / `gpt-5-nano` |
| Judge model / output budget | `gpt-5-nano` / 4096 tokens |
| Query and judge embeddings | `text-embedding-3-small`; retrieval dimension 1536 |
| RAGAS / semantic grader | `0.4.3` / `ragas-0.4-adapter-v2` |
| Evaluation version | `refund-ragas-v2`, independent of dataset version |
| Retrieval | Local OpenSearch, BM25/vector fusion and cross-encoder reranking, top 3 |
| Reranker | `cross-encoder/ms-marco-MiniLM-L6-v2`, revision `d6042621b3ca5abbebc48a89fdc253730186930e` |
| Scope | `tenant-local`, `local`, `CUSTOMER_SAFE`, `en-US` |
| Knowledge release / as-of | `refund-policy-2026-08-01` / `2026-08-12T12:00:00Z` |
| Semantic minimum | 0.7, provisional and nonblocking for every metric |

The existing runner reused production retrieval and answer components in-process,
with synthetic order facts. It did not run the complete LangGraph/Temporal
journey, contact Vendure, inspect real customer data, approve or execute a refund,
change tokens, reindex knowledge, or start LangSmith. No prompt, guard, fixture,
threshold or application source changed during this campaign. No paid retry was
launched after it ended. A new run requires new authorization.

## Coverage and reliability

| Case ID | Repetition 1 | Repetition 2 | Repetition 3 | Scored / attempted |
|---|---|---|---|---:|
| `damaged-item-evidence-answer-v1` | Delivery guard | Delivery guard | Delivery guard | 0 / 3 |
| `incorrect-item-verification-answer-v1` | Delivery guard | Delivery guard | Delivery guard | 0 / 3 |
| `final-sale-exception-answer-v1` | Identifier guard | Scored | Delivery guard | 1 / 3 |
| `large-refund-review-answer-v1` | Scored | Delivery guard | Scored | 2 / 3 |
| `provider-processing-answer-v1` | Identifier guard | Scored | Scored | 2 / 3 |

Blocking pass rate and scored coverage are both **5/15 (33.3%)**. Repeated-case
consistency is **0/5**. All five scored trials passed the deterministic expected
evidence, minimum citation and prohibited-claim checks; only the last of those
is blocking. This does not prove that every claim in those answers is safe.

The expected document/chunk appeared at rank 1 in all 15 retained evidence
records, including rejected trials. This is a narrow deterministic observation
for five known questions, not proof of general retrieval quality. Response hashes
and captured evidence content hashes were verified against the scoped local
CUSTOMER_SAFE index without new embeddings or model calls.

## Semantic results

These are means over **five scored answers from three cases**, not all 15 trials.
Missing scores remain missing; they are neither zeros nor successes. Rounded
display values must not be used to claim improvements over the changed v1/v2
references. Every scored trial fell below at least one provisional minimum.

| Metric | Mean | Range | Below 0.7 | Coverage |
|---|---:|---:|---:|---:|
| Context precision | 1.0000 | 1.0000–1.0000 | 0 | 5 / 15 |
| Context recall | 0.9000 | 0.5000–1.0000 | 1 | 5 / 15 |
| Faithfulness | 0.8374 | 0.4444–1.0000 | 1 | 5 / 15 |
| Response relevancy | 0.5228 | 0.3859–0.7235 | 4 | 5 / 15 |
| Factual correctness, precision mode | 0.6360 | 0.1000–1.0000 | 2 | 5 / 15 |

| Scored trial | Context precision | Context recall | Faithfulness | Relevancy | Factual precision |
|---|---:|---:|---:|---:|---:|
| Final sale, repetition 2 | 1.0000 | 0.5000 | 0.4444 | 0.7235 | 0.7500 |
| Large refund, repetition 1 | 1.0000 | 1.0000 | 0.9091 | 0.4501 | 0.1000 |
| Large refund, repetition 3 | 1.0000 | 1.0000 | 1.0000 | 0.5569 | 0.3300 |
| Provider processing, repetition 2 | 1.0000 | 1.0000 | 1.0000 | 0.3859 | 1.0000 |
| Provider processing, repetition 3 | 1.0000 | 1.0000 | 0.8333 | 0.4975 | 1.0000 |

Context precision measures ranked usefulness, not the percentage of returned
chunks that are useful. A relevant first chunk followed by irrelevant chunks can
still obtain 1.0. Context recall checks reference coverage in retrieved policy.
Faithfulness checks answer claims against policy plus separately labelled trusted
application facts. Relevancy checks fit to the question. Factual precision checks
answer claims against the reference plus independent facts; it is not completeness
and is not identical to faithfulness against the full retrieved policy.

## Offline findings, not human ratings

All ten captured rejections reproduced through the relevant unchanged validator.
No rejected text was submitted to judges or copied into this document.

1. **Two identifier false positives.** A valid synthetic order reference followed
   by a colon was parsed with that colon attached. The identifier validator strips
   a trailing period but not that colon, so it rejected the otherwise matching
   reference. This needs a focused regression/fix, not token renewal.
2. **Five delivery-window framing rejections.** The window sentence lacked the
   validator's explicit policy frame. Some also omitted the refund-condition
   scope. This is evidence of brittle prompt/validator compatibility, not proof
   that the numeric policy duration was invented.
3. **One condition-scope mismatch.** The incorrect-item answer narrowed the
   policy sentence to incorrect items; the cited source covers incorrect OR
   missing items. Exact condition-set matching rejected it. Human review should
   distinguish logically valid narrowing from dropping an essential condition.
4. **Two personalized-conclusion matches.** Final-sale and large-refund attempts
   triggered that rule. A regex match alone does not establish the semantic
   correctness of every rejection; review the private captures before changing it.
5. **A passed answer still made an individual eligibility decision.** The scored
   final-sale answer told this customer the request did not meet standard refund
   eligibility. That is not an authoritative policy decision. The bounded guard
   and exact prohibited-claim tests did not catch this phrasing. Its 0.4444
   faithfulness is a review signal, not proof of why the judge assigned that score.
6. **Passing answers can be unfocused.** The large-refund answers add damage or
   processing advice and leave the USD 750 request's review path imprecise. One
   discusses possible automatic approval if the amount changes. The provider
   answers explain the published 5–10 business-day expectation without a guarantee,
   but append proposal details to a question about an allegedly submitted refund.
   The fixture deliberately has no verified submitted-refund state. Distinguish
   customer assertion from verified state when reviewing relevance.

The final-sale source explicitly contains both exceptions, yet its context recall
was 0.5. The two near-equivalent provider answers received differing faithfulness
scores. These deserve human/judge comparison; this report does not invent missing
judge claim rationales or declare an automatic judge infallible. A different
judge model or prompt would be a separately versioned experiment, not a silent
replacement of these results.

## Measured usage and elapsed time

Campaign elapsed time was approximately **740.96 seconds (12 minutes 21 seconds)**,
from runner-log creation to final result write. Retrieval-plus-answer latency
for the five completed samples ranged from 6.88 to 21.70 seconds; this excludes
RAGAS judging and rejected trials and is not an end-user latency percentile.

| Component | Recorded invocations | Input tokens | Output tokens | Total tokens |
|---|---:|---:|---:|---:|
| Answer generation | 15 | 21,735 | 40,703 | 62,438 |
| RAGAS judge | 55 | 56,253 | 84,859 | 141,112 |
| Judge embeddings | 10 | 311 | 0 | 311 |
| Retrieval query embeddings | 15 | 186 | 0 | 186 |
| Total | 95 | 78,485 | 125,562 | **204,047** |

Measurement status is `COMPLETE`; run status is `FAILED` because ten system
trials failed validation. All recorded invocations succeeded. These counters
measure wrapped SDK invocations, not independently observed physical HTTP
attempts. Cached inputs and reasoning outputs are subsets of their respective
totals, not additional tokens. Judge work accounted for about 69% of total
tokens even though only five answers reached grading. **Dollar cost is unknown**:
no versioned pricing schedule was supplied. Numeric zero placeholders in sample
objects are not actual usage; `usage.json` is the usage authority.

## Evidence and next boundary

Private artifacts, all checked as mode `0600`, are under
`/private/tmp/cso-ragas-v3-campaign-rW5j4Z/`:

| Artifact | SHA-256 |
|---|---|
| `result.json` | `9c7f41fef9672f7ea0081cb0cd76b070bf4f499024ee47f1b2650205c185036e` |
| `usage.json` | `3e40631a74356fa1bb0ce06092222360db7f4c0bfcf0ec73e81106ea59ffe352` |
| `rejections.json` | `fb377bc0cf3a47a276b704d1d5665964d81ada2d0bd8ed5648a0b64c9556132c` |

These temporary files are not in Git and may not survive cleanup or migration.
The sanitized report is durable once the owner approves committing it; the
current task did not commit or push. Preserve the private files for owner review.

### Guided owner review, September 14

For `final-sale-exception-answer-v1`, repetition 2, the owner initially described
the saved answer as good. After the assistant explained the difference between
general policy guidance and an authoritative individual eligibility decision,
and showed the recorded RAGAS scores, the owner agreed to proceed with marking
it **needs an eligibility-wording correction**. The issue is the personalized
denial, not the correctly stated general final-sale exceptions. The closing
not-approved disclaimer does not undo the earlier eligibility conclusion.

The final-sale assessment records conversational agreement after guidance and score disclosure, not a
blind human rating, independent double-scoring or calibrated numeric ground
truth. No application code, reference, original answer or score was changed;
the suggested safer wording was an illustration, not a newly evaluated answer.

For `provider-processing-answer-v1`, repetition 2, the owner identified the
standalone settlement disclaimer and proposed-amount/not-approved footer as
unnecessary. The owner's communication preference is simple, direct answers.
Record this as **needs a more direct answer**: answer the timing question without
unrelated proposal details or repetitive disclaimers. Preserve uncertainty in
concise wording (for example, "may take") and do not claim a verified submission
when only the customer's assertion exists. This is not permission to remove
required confirmation, approval or safety boundaries. Only repetition 2 has
received this guided owner review; do not infer a rating for repetition 3.

Its existing faithfulness score is 1.0000 and relevance score is 0.3859. These
illustrate why groundedness and usefulness are separate review dimensions;
without retained claim-level judge explanations, the scores do not prove that
the footer caused the judge's rating. No numeric human score was assigned and
the automated grades remain unchanged. No revised answer has been run.

For `large-refund-review-answer-v1`, repetitions 1 and 3, the owner reviewed
the key excerpts alongside the known USD 750 request and policy bands. The owner
requires **an explicit threshold comparison and explanation**: state the relevant
USD 500 threshold, compare the requested refund amount with it, and explain
why specialist review is required. Generic small/medium/large tiers or speculation
about a different final amount do not clearly answer this case. Record both
excerpts as needing that improvement; this is qualitative guided feedback, not
a numeric human grade or exhaustive claim-by-claim assessment.

Preserve the actual three policy bands: up to USD 100 may be automatically
approved only after eligibility and evidence checks; USD 100.01 through USD 500
requires human approval; above USD 500 requires takeover and case handling.
Being below USD 500 must not be described as automatic approval. Compare the
requested refund amount, not an unrelated product price, and do not promise the
refund outcome. Future implementation must use trusted amounts and versioned
policy authority for the comparison. The existing money-text guard and
application-owned amount formatting remain unchanged; this review does not
authorize inserting monetary claims into unrestricted model prose.

Remaining review is tracked below:

- [x] Review the final-sale answer's personalized denial against source and facts (guided owner review; needs correction).
- [x] Review the key excerpts of both large-refund answers for specificity (guided owner feedback: needs explicit threshold comparison and explanation; not exhaustive claim grading).
- [ ] Finish provider-answer review (repetition 2 reviewed: needs a more direct answer; repetition 3 pending).
- [ ] Inspect captured rejection categories for true and false positives.
- [ ] Record supported/unsupported claims, omissions and relevance judgments;
      compare with judges and record disagreements. Independent double-scoring
      remains separate from the owner's initial review and reference approval.

Then freeze this as the initial measured baseline and move to LangSmith without
requiring perfect scores. **Tell the owner before starting LangSmith** and obtain
approval for any export. No LangSmith data has been sent. Tau retail evaluation,
expanded/held-out dataset approval, complete agent/workflow simulation and
production observability remain separate stages. The following approved fixes
are separate from the historical measured baseline.

## Approved offline answer fixes after the campaign

On September 14, the owner approved a bounded two-worker implementation batch.
Sol owned `agent_runtime/refund/answer.py` and its unit tests; Luna owned a new
Evaluation Runner integration regression file. The coordinator reviewed the
combined change, applied formatting, ran both service suites and updated these
notes. No additional implementation agents or live model trials were launched.

Read the changed functions in this order:

1. `LangChainRefundAnswerComposer.compose`: citation checks, trusted identifier
   and money checks, personalized-decision rejection, then policy validation.
2. `_matches_expected_identifier`: exact match first; otherwise permit exactly
   one terminal period or colon only when removing it matches the trusted
   reference. `order EVAL-REFUND-001:` is valid for `EVAL-REFUND-001`; a different
   reference still fails. The money guard uses the same reference matching.
3. `validate_personalized_eligibility_text`: reject bounded individual-decision
   forms, including the missed long `your request ... it does not meet ...
   eligibility` shape. General procedural wording is not a denial. The existing
   `DELIVERY_AGE_TEXT_REJECTED` code remains for compatibility.
4. `_delivery_window_claims_with_explicit_alternatives` and
   `validate_delivery_policy_text`: accept one explicitly stated incorrect OR
   missing alternative while retaining every other recognized prerequisite.
   A mere OR elsewhere is insufficient. AND conditions, unsupported durations,
   missing time basis, missing scope and uncited claims remain protected.
5. `append_delivery_policy_frames`: only after the preceding checks succeed,
   prefix a supported but unframed window sentence with `According to the
   published policy,`. Unicode and Markdown detection match validation; the
   operation does not invent a missing condition or delivery date. Existing
   qualification and trusted proposed-amount rendering follow unchanged.

Tests cover both accepted wording and rejected unsafe claims. The new
`apps/services/evaluation-runner/tests/test_refund_answer_regressions.py` runs the
real composer and evaluation adapter with external retrieval/model responses
faked. It verifies that a rejected answer produces `SYSTEM_ERROR`, no sample,
and no grades, and that accepted evidence/citations remain unchanged.

Fresh offline checks: **161 Agent Runtime tests and 240 Evaluation Runner tests
passed**, including **15 new answer unit cases and 8 new integration cases**.
Changed-file Ruff lint and formatting passed. Test output included sandbox
cache-write warnings and an existing Starlette/httpx deprecation warning, not
test failures. The final formatting-only changes received a focused recheck.

The five-case v3 dataset hash, references, historical answers, scores, prompt v8,
grader implementation and monetary policy bands are unchanged. This is a local,
uncommitted patch; `87ab48f` remains the last code commit. It does not establish a
new measured RAGAS pass rate or prove that all natural-language variants are safe.
The lexical safeguards are defense in depth, not complete semantic validation.

Outside that earlier batch: trusted versioned policy data for the requested
USD 750 versus USD 500 explanation, concise context-specific answer/footer
rendering, remaining owner review and independent calibration, any new paid
campaign, LangSmith, Tau, and production observability. No services, secrets,
refunds, Git history or remote branches were changed. Tell the owner before
starting LangSmith; new paid calls and exports need specific approval.

## Subsequent trusted-policy answer implementation

September 15 follow-up: [the measured v4 trial and v3 review preparation](RAGAS_CLOSURE_REVIEW.md)
is complete. The historical v3 scores below and above remain unchanged. The
machine-assisted rejection assessment distinguishes three identifiable false-positive
causes, two clear personalized-conclusion concerns and five ambiguous framing
cases; these are not new human ratings. Provider repetition 3 still requires the
owner's guided review decision. No calibrated numeric ground truth is claimed.

The owner later approved [this design](../superpowers/specs/2026-09-14-trusted-refund-answer-design.md)
and [four-part implementation plan](../superpowers/plans/2026-09-14-trusted-refund-answers.md).
The local runtime now uses prompt v9 and a shared immutable policy catalog.
Edge signs the configured version and catalog hash; Python verifies them before
using the public amount limits. Application code, not the model or RAG passage,
renders the monetary comparison. Temporal still makes the actual decision.

For example, a complete USD 750 request produces:

> Your requested refund of $750 is above the $500 specialist-review threshold, so it requires specialist review before it can be approved.

Timing, general-policy and missing-details purposes do not receive the proposed
amount footer. General refund-request guidance retains the shorter
`Proposed refund: USD 125.00.` label. These presentation purposes do not prove
eligibility, approval, provider submission or settlement. Existing delivery
qualifications and raw model-output guards remain.

Important evaluation distinction: an amount-only application answer has no RAG
citation, because its facts come from the verified policy catalog. Every pinned
v3 case still requires `minimum_citation_count: 1`. Such an answer can therefore
fail that historical citation check even with correct monetary facts. That check
is informational in the live runner, not independently a blocking release gate.
Do not add a fake citation, weaken the grader or silently edit the v3 fixture.
The owner has approved a separate [v4 policy-answer criterion](RAGAS_V4_POLICY_ANSWER.md)
that checks verified application facts rather than trusting a model purpose label.

The historical v3 dataset, references, scores and private artifacts are unchanged.
See [Verification Status](../VERIFICATION_STATUS.md) for the implementation's
current offline checks and remaining work. No live prompt-v9 result is claimed.
