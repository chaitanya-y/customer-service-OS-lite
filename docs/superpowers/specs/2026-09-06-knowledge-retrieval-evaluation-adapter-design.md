# Knowledge Retrieval Evaluation Adapter Design

Status: Approved
Date: 2026-09-06

## Purpose

Connect the existing governed Knowledge/RAG retrieval evaluator to the generic
Evaluation Runner without rewriting either implementation. The result will let
the common runner execute the real retrieval contract repeatedly, preserve ranked
evidence and version information, apply retrieval-specific graders, and report
reliability consistently with later answer and agent evaluations.

This change does not add RAGAS, an LLM judge, LangSmith, a public evaluation API,
or a paid live evaluation command.

## Current separation

The repository currently has two correct but disconnected components:

1. `knowledge-rag` owns governed retrieval, document-scoped evidence identity,
   Recall at K, reciprocal rank, and forbidden-evidence detection.
2. `evaluation-runner` owns versioned generic cases, observed samples, graders,
   repeated trials, system/evaluator failure separation, pass rate, and
   consistency.

The adapter joins them while preserving their ownership boundaries.

## Considered approaches

### 1. Add RAGAS directly to Knowledge/RAG

This is the shortest route to semantic metrics, but it creates another isolated
runner. Repetitions, error handling, cost controls, and later agent evaluations
would remain inconsistent. This approach is rejected.

### 2. Add a broad evaluation HTTP endpoint to Knowledge/RAG

An HTTP boundary resembles production service communication, but the current
customer endpoint intentionally permits only current, customer-safe retrieval.
The evaluation dataset also tests historical and authorized internal evidence.
A broader endpoint would create a sensitive bypass surface solely for testing.
This approach is rejected for the current local evaluation phase.

### 3. Add an offline in-process adapter to Evaluation Runner

The adapter depends on the public Python contracts of `knowledge-rag`, accepts its
existing `RetrievalExecutor` interface, and converts results into generic
`EvaluationSample` records. Tests use a deterministic fake executor; a future
explicitly authorized live harness can inject the configured OpenSearch service.
This is the selected approach.

## Dependency boundary

The framework-neutral Evaluation Runner core must not import Knowledge/RAG.
Only `evaluation_runner.adapters.knowledge_retrieval` may import `knowledge_rag`.
The package configuration will express Knowledge/RAG as an adapter dependency so
the core models, protocols, runner, and existing graders remain reusable for agent
and policy evaluation.

The adapter will use public functions and models. It will not import private
helpers, copy retrieval algorithms, or reach directly into OpenSearch.

## Components

### Dataset adaptation

`adapt_retrieval_dataset()` converts a validated
`RetrievalEvaluationDataset` into a generic `EvaluationDataset`.

Each generic case preserves:

- the original stable case ID and query;
- tenant, environment, release, classification, locale, and effective time;
- expected and forbidden document-scoped evidence references;
- the `RETRIEVAL` capability tag.

The adapter also retains the original typed cases by ID for execution. It does not
parse an unvalidated dictionary back into trusted retrieval context.

### Evaluated system adapter

`KnowledgeRetrievalEvaluatedSystem.run()` receives one generic case and looks up
the corresponding validated typed retrieval case. It creates a one-case source
dataset and calls the existing public `run_retrieval_evaluation()` function. Its
constructor receives the expected embedding and reranker models so a provider or
model-version change between cases or repetitions is rejected rather than mixed
inside one generic run.

The returned `EvaluationSample` contains:

- ranked document and chunk identities;
- matched and forbidden evidence;
- Recall at K and reciprocal rank;
- a structured `RETRIEVAL` trace event for every returned chunk;
- elapsed latency;
- embedding, reranker, knowledge-release, and adapter versions.

If retrieval fails or returns evidence for another context, the existing
evaluator raises. If its observed reranker differs from the adapter's expected
model, the adapter raises. The generic runner records either condition as a
failed system trial and continues with later cases.

### Retrieval graders

Three independent graders avoid mixing unlike metrics into one opaque score:

1. `RecallAtKGrader` reports the observed Recall at K against a configurable
   minimum.
2. `ReciprocalRankGrader` reports how early the first expected chunk appeared
   against a configurable minimum.
3. `ForbiddenEvidenceGrader` requires zero forbidden evidence and is always a
   blocking governance gate.

Recall and reciprocal-rank blocking behavior is configurable and defaults to
non-blocking until a reviewed baseline establishes release thresholds. Forbidden
evidence remains blocking immediately.

Malformed or missing metric evidence is an evaluator error, not a zero score. The
run must be invalidated rather than making the evaluated system look worse or
better because the evaluator is broken.

## Example

Input case:

- query: `Can I get a refund for an item that arrived damaged?`
- expected: current refund-policy damaged-item chunk;
- forbidden: superseded-policy and internal-playbook chunks;
- top K: 3.

Observed ranks:

1. general refund requirements;
2. damaged-item refund policy;
3. original-payment-method policy.

The sample records Recall at 3 of `1.0`, reciprocal rank of `0.5`, and zero
forbidden evidence. The governance grader passes. If the configured informational
MRR minimum is `0.75`, the MRR grade is visible as failed but does not block the
trial until the team explicitly promotes that quality threshold to a release gate.

## Error handling

- Unknown generic case ID: system trial failure with no fabricated metrics.
- Retrieval exception: system trial failure; later cases continue.
- Cross-context evidence: rejected by the existing governed evaluator and recorded
  as a system failure.
- Missing or malformed metrics in an otherwise completed sample: evaluator failure
  that invalidates the run.
- Forbidden evidence: completed trial with a failed blocking grade.
- Paid provider access: absent from the adapter and its default tests.

## Test strategy

Tests will prove:

- every source case maps without losing its governed context or evidence identity;
- the adapter reuses the existing retrieval executor and metrics;
- ranked evidence becomes ordered structured trace events;
- embedding, reranker, release, and adapter versions are recorded;
- reranker version drift is rejected across cases and repetitions;
- cross-tenant evidence becomes a system-error trial;
- Recall at K and reciprocal-rank graders report scores independently;
- a forbidden chunk fails the blocking governance grade;
- malformed metric evidence invalidates the evaluation run;
- repeated trials flow through the generic runner without a paid API call.

Both packages' focused test suites, lint checks, and formatting checks will run.

## Files

### Evaluation Runner

- Modify `apps/services/evaluation-runner/pyproject.toml`
- Modify `apps/services/evaluation-runner/uv.lock`
- Create `apps/services/evaluation-runner/evaluation_runner/adapters/__init__.py`
- Create `apps/services/evaluation-runner/evaluation_runner/adapters/knowledge_retrieval.py`
- Create `apps/services/evaluation-runner/evaluation_runner/retrieval_graders.py`
- Create `apps/services/evaluation-runner/tests/test_knowledge_retrieval_adapter.py`
- Create `apps/services/evaluation-runner/tests/test_retrieval_graders.py`
- Modify `apps/services/evaluation-runner/README.md`

### Knowledge/RAG

No production source change is expected. Its public contracts and existing
evaluation functions will be reused as written.

## Follow-up sequence

After this adapter is verified:

1. add RAGAS context and answer graders behind the existing `Grader` protocol;
2. create a reviewed refund question, context, reference-answer, and citation
   dataset;
3. connect the complete refund-agent sandbox for multi-turn and trajectory
   evaluation;
4. add LangSmith export and later tau-three as separately reported adapters.
