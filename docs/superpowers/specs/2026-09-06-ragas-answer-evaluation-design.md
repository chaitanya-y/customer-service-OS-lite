# RAGAS Answer Evaluation Design

Status: Approved
Date: 2026-09-06

## Purpose

Add semantic RAG answer evaluation to the existing Evaluation Runner without
placing evaluation code in the customer request path. The evaluator will keep
retrieval quality, answer quality, and deterministic governance results separate
so a high semantic score can never hide tenant, classification, citation, or
authorization failure.

## Scope

This slice will:

1. provide a guarded offline command for the existing governed OpenSearch
   retrieval dataset;
2. adapt the RAGAS 0.4 collections API to the repository-owned `Grader`
   protocol;
3. define a reviewed single-turn refund RAG answer dataset;
4. accept customer-safe retrieved context and a generated response through an
   injected answer-system boundary;
5. report context precision, context recall, faithfulness, response relevancy,
   and factual correctness independently;
6. keep paid calls disabled unless the owner supplies an explicit run flag.

This slice does not add agent trajectory evaluation, production transcript
sampling, LangSmith export, a public evaluation API, or a commerce mutation.

## Architecture

```text
Reviewed answer case
  -> evaluated RAG answer system
       -> governed retrieval
       -> production answer boundary
  -> EvaluationSample
       -> deterministic governance graders
       -> RAGAS semantic graders
  -> versioned EvaluationRun
```

Evaluation Runner remains the owner of cases, repetitions, grader results, and
run summaries. RAGAS is an adapter behind that contract rather than a second
runner with unrelated pass/fail behavior.

## RAGAS metrics

- Context precision checks whether useful retrieved chunks are ranked ahead of
  irrelevant chunks.
- Context recall checks whether retrieved chunks contain the information needed
  by the reviewed reference answer.
- Faithfulness checks whether claims in the generated response are supported by
  retrieved context.
- Response relevancy checks whether the response addresses the customer input.
- Factual correctness compares the response with the reviewed reference answer.

Each metric produces its own `GraderResult`. Semantic metrics are initially
informational and non-blocking until a reviewed baseline exists. They never
override blocking deterministic governance checks.

## Data contract and trust boundary

The reviewed case owns `user_input` and `reference`. The evaluated system owns
`response`, ordered `retrieved_contexts`, and document-scoped evidence
identities. A grader must never accept a reference answer supplied by the system
under test.

Only synthetic or explicitly approved cases may be used. Only `CUSTOMER_SAFE`
context may enter the answer-evaluation payload. Internal evidence remains
eligible only for the separate governed retrieval suite and must never be sent
to the customer answer composer or semantic answer judge.

The existing retrieval adapter continues to store identities and hashes without
chunk text. Answer evaluation uses a separate adapter because semantic graders
need customer-safe context text. This does not weaken the retrieval adapter's
content-minimization contract.

## RAGAS integration boundary

`RagasMetricScorer` is a small asynchronous protocol that accepts a validated
single-turn payload and returns one score. `RagasGrader` validates the generic
case and sample, selects only the fields required by its configured metric, and
converts the score into a repository `GraderResult`.

The concrete RAGAS scorer uses the collections API and is constructed only by
the offline live-run module. Tests inject deterministic scorers, so unit tests do
not initialize an external model, download a model, or make a paid call.

RAGAS is an optional dependency of Evaluation Runner. The core evaluation models,
runner, deterministic graders, and Knowledge/RAG retrieval adapter remain usable
without installing the optional semantic-evaluation extra.

## Production component isolation

The live answer system reuses the production `KnowledgeRetrievalService`,
`RefundProposalBuilder`, and `LangChainRefundAnswerComposer`. Each reviewed case
contains small synthetic trusted order facts under `system_context`; the reviewed
reference remains outside that object and is never passed to those components.

This boundary evaluates the exact retrieval and answer behavior without looking
up a Vendure order, starting a Temporal workflow, opening a human case, or calling
a refund provider. It records the exact retrieved context, document-scoped
identities, content hashes, citations, and component versions used in the trial.

Deterministic graders check expected evidence, citation count, and reviewed
prohibited promise phrases before the semantic results are interpreted. The
prohibited-claim grade blocks immediately; semantic grades remain informational
until a reviewed baseline establishes defensible thresholds.

## Live-run safety

The live command fails closed unless `ALLOW_PAID_API_CALLS=true`. It requires an
explicit dataset path, index name, evaluator model, and output path. Before the
full suite, the owner will see the case count, repetition count, selected models,
and estimated call shape. The first authorized live run uses one case and one
trial.

Retrieval evaluation may call OpenAI once per query for query embeddings and runs
the cross-encoder locally. Semantic answer evaluation may make multiple judge and
embedding calls per case. No live command may start a Temporal workflow or call a
refund provider.

## Initial dataset

The initial answer dataset contains reviewed customer-safe refund questions for:

1. damaged-item evidence requirements;
2. incorrect-item verification;
3. final-sale restrictions;
4. larger-refund human review without exposing an internal monetary threshold;
5. provider-processing expectations without claiming bank settlement.

Each case records a stable ID, version, tags, customer input, reference answer,
and deterministic expectations for citations and prohibited claims. The internal
support-escalation case remains in the retrieval/governance suite only.

## Errors

- Missing or malformed semantic inputs invalidate the evaluator; they do not
  become a zero score.
- A RAGAS exception becomes an evaluator error and invalidates the run.
- A non-finite or out-of-range score is rejected.
- Internal or cross-context evidence is a blocking deterministic failure and is
  never forwarded to RAGAS.
- A system failure remains separate from a grader failure.

## Verification

Tests will prove:

- the answer dataset cannot mark internal evidence as customer-safe context;
- the system output cannot replace the reviewed reference answer;
- each RAGAS metric receives exactly its required fields;
- thresholds and blocking flags are represented honestly;
- malformed scores and scorer failures invalidate evaluation;
- deterministic fakes allow the entire suite to run without paid calls;
- the live command refuses to run without the explicit paid-call flag;
- existing Evaluation Runner and Knowledge/RAG tests remain green.

## Files

- Modify `apps/services/evaluation-runner/pyproject.toml`
- Modify `apps/services/evaluation-runner/uv.lock`
- Create `apps/services/evaluation-runner/evaluation_runner/ragas_graders.py`
- Create `apps/services/evaluation-runner/evaluation_runner/answer_graders.py`
- Create `apps/services/evaluation-runner/evaluation_runner/adapters/knowledge_answer.py`
- Create `apps/services/evaluation-runner/evaluation_runner/adapters/refund_rag_answer.py`
- Create `apps/services/evaluation-runner/evaluation_runner/live_rag_evaluation.py`
- Create `apps/services/evaluation-runner/fixtures/evaluation-datasets/refund-rag-answer-v1.json`
- Create focused tests for the new contracts, graders, adapter, and live guard
- Modify `apps/services/evaluation-runner/README.md`
- Modify `docs/evaluation/EVALUATION_STRATEGY.md` after verification

## Delivery sequence

1. Finish and verify the already-started governed retrieval adapter.
2. Add answer sample validation and the injected evaluated-system adapter.
3. Add RAGAS grader contracts with deterministic test scorers.
4. Add the optional concrete RAGAS 0.4 integration.
5. Add the reviewed answer dataset and validation tests.
6. Add the guarded live command.
7. Run all offline checks.
8. Request separate authorization for a one-case paid evaluation.
