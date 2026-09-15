# Bounded RAGAS measurement and review checkpoint

Date: 2026-09-15
Status: Bounded measurement baseline frozen on 2026-09-15;
quality gate failed; owner review and human calibration are not complete.

Frozen means preserve the measured results and stop automatic retry campaigns.
It does not mean production qualification or that every RAG evaluation task is
complete. Remaining owner decisions can be appended without changing historical
scores. LangSmith design is the next stage; implementation and external export
are not yet approved by this checkpoint.

## Single v4 trial

Run `refund-ragas-v4-large-review-20260915-001` used the reviewed
`large-refund-review-answer-v1` case from dataset v4, one repetition,
`refund-policy-v2`, prompt v9, `gpt-5-nano` answer and judges, and
`text-embedding-3-small` query/judge embeddings. Evaluation version remains
`refund-ragas-v2`; this is independent of dataset version.

The run began at 20:48:08 UTC and ended at 20:50:10 UTC (122 seconds).
Retrieval plus answer latency was 21.953 seconds; that is not the total judge
runtime or a user-facing p95 measurement.

Preflight verified OpenSearch, the configured tenant-local index/release,
1536-dimensional vectors and the cached pinned cross-encoder. All three
retrieved chunks were CUSTOMER_SAFE. No server restart, token renewal, commerce
call, refund, new dependency, rejection capture, or LangSmith export occurred.

Observed answer:

> Automatic approval is not guaranteed for larger refund requests. The policy splits refunds into ranges: small refunds may be automatically approved after eligibility and required evidence; mid-sized refunds require human approval; very large refunds require human takeover and case handling. For order EVAL-REFUND-004, whether your request is auto-approved depends on the refund amount relative to those ranges.

Expected application-rendered answer:

> Your requested refund of $750 is above the $500 specialist-review threshold, so it requires specialist review before it can be approved.

The trial **completed but failed**. This is a quality failure, not an execution
failure. The version, catalog hash and required application facts matched.
The answer missed the exact reviewed monetary explanation and retained one real
RAG citation. That citation was from retrieved evidence, not fabricated, but
this reviewed application-only response requires zero RAG citations.

| Check | Result | Blocking? |
| --- | --- | --- |
| Expected retrieval evidence | Pass | No |
| Minimum citation count (minimum zero) | Pass; one citation observed | No |
| Prohibited claim | Pass | Yes |
| Reviewed policy answer | Fail: wording mismatch and expected zero citations | Yes |
| Context precision | 1.0000 rounded | No |
| Context recall | 1.0000 | No |
| Faithfulness | 1.0000 | No |
| Response relevancy | 0.5704; below provisional 0.7 | No |
| Factual correctness, precision mode | 0.3300; below provisional 0.7 | No |

The expected monetary presentation was not observed. The public result does not
retain the model's chosen purpose, so it does not prove which purpose was selected
or precisely why the renderer path was missed. Preserve this as a regression
candidate; do not claim a proven root cause or modify prompts/guards without a
separate scoped change. No retry was performed.

This illustrates why faithfulness is insufficient alone: a grounded answer can
still be generic and fail the reviewed task. One repetition cannot establish
reliability. V4 is not a direct improvement comparison with v3 because its
criterion changed.

## Measured usage and artifact verification

| Component | Recorded SDK invocations | Tokens |
| --- | ---: | ---: |
| Answer | 1 | 3,786 |
| RAGAS judges | 11 | 24,056 |
| Judge embeddings | 2 | 56 |
| Query embedding | 1 | 9 |
| Total | 15 | 27,907 |

All 15 recorded invocations succeeded. These counters are not independent
transport-level retry counts. Usage status COMPLETED means execution completed,
not that quality passed. Measurement is COMPLETE. Dollar cost is unknown because
no verified pricing schedule was configured. Reasoning tokens are already included
in output totals and must not be added again.

Coordinator verification parsed the result/usage through their production
Pydantic models, checked one case/one repetition, matching run IDs, CUSTOMER_SAFE
evidence, and owner-only file permissions. Historical v3 artifact hashes still
match their original recorded digests. No application code changed in this batch;
the preceding 268-test result remains historical offline evidence, not a new run.

Private files under `/private/tmp/cso-ragas-close.7Uj06X/live/`:

| File | SHA-256 |
| --- | --- |
| result.json | `40322f639071918423d621eee3cd7c303cfd89c80fe18d7d3227bdb326ba2422` |
| usage.json | `47f1a0d7127207beb8b756136f02d8e876484f0dea909c62f4bab5506dbee74a` |

These files are mode 0600 and outside Git. Temporary artifacts may not survive
cleanup; this sanitized report records the outcome. No commit or push occurred.

## Machine-assisted v3 review, not human calibration

The independent review reconfirmed 15 attempts, five scored answers, ten
SYSTEM_ERROR trials, zero cases passing all three repetitions, 95 successful
recorded invocations and 204,047 tokens. Historical grades remain unchanged.

| Scored answer | Existing guided owner decision | Remaining observation |
| --- | --- | --- |
| Final sale, repetition 2 | Needs eligibility-wording correction | Source-supported exceptions do not authorize an individual denial |
| Large refund, repetitions 1 and 3 | Needs explicit threshold comparison | Generic tiers and unrelated advice do not address the known USD 750 amount |
| Provider timing, repetition 2 | Needs a more direct answer | Grounded timing content includes an irrelevant proposal footer |
| Provider timing, repetition 3 | Pending owner decision | Same relevance concern; faithfulness 0.8333 and relevance 0.4975 are existing scores, not new ratings |

Provider repetition 3 states:

> Thanks for checking on your refund. After your refund is approved, we submit it to the original payment method. Banks and payment providers may take 5 to 10 business days to show the refund in your bank account. We cannot guarantee a provider's settlement time.
>
> Proposed refund amount: USD 125.00. This is a request, not a refund approval.

The timing propositions cover the reference and retain conditionality. The
proposed assessment is **needs a more direct answer** because the footer does not
answer the timing question. This is an assistant assessment pending owner review.
Claim-level judge explanations were not retained, so we cannot establish why
faithfulness differs from repetition 2's 1.0.

Rejection review distinguishes causes from whole-answer safety:

- Two identifier captures have demonstrable terminal-colon false-positive causes.
- One incorrect-item capture has an OR-alternative scope-matching false-positive
  cause. That does not endorse its separate claim that review was already underway.
- Two captures contain clear personalized-conclusion concerns (final-sale denial
  and a large-refund path inferred from full-order scope rather than amount).
- Five window-framing captures remain ambiguous. Their time windows are supported
  by policy, and imperative or conditional request instructions do not necessarily
  claim verified delivery age. They may be overly strict guard rejections. Other
  omissions or unsupported claims must be reviewed separately; for example,
  one answer drops the digital-goods exclusion's access/download condition.

Do not label this as seven proven true positives. The supported summary is three
identifiable false-positive rejection causes, two clear conclusion concerns and
five unresolved framing cases. Historical broad rejection codes are unchanged.

## Next boundary

The authorized run and review-preparation work are finished. The quality gate is
not green, and no human numeric ratings, blind review or calibrated release
thresholds have been established.

Finish the owner's guided review and record unresolved disagreements honestly.
The baseline is frozen with a failed gate and a tracked monetary-presentation
issue; perfect scores are not required to begin LangSmith. Announce LangSmith
before starting, and obtain permission for any external export. A targeted
presentation fix or another paid trial requires separate scope/approval; do not
restart an open-ended retry campaign. External Tau benchmarking, expanded/held-out
cases and production observability remain separate stages.
