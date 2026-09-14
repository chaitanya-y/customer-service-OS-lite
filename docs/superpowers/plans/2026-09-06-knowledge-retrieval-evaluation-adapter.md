# Knowledge Retrieval Evaluation Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the existing governed Knowledge/RAG retrieval evaluator to the generic Evaluation Runner so real retrieval cases can run repeatedly with independent quality and governance grades.

**Architecture:** Add a RAG-specific adapter inside Evaluation Runner while keeping its core models, protocols, runner, and existing graders independent of Knowledge/RAG. The adapter consumes validated Knowledge/RAG datasets and the existing `RetrievalExecutor` interface, reuses the public retrieval evaluator, and emits generic samples containing identities and metrics rather than knowledge text.

**Tech Stack:** Python 3.12, Pydantic 2, `knowledge-rag`, pytest 9, Ruff, `uv`

**Spec:** `docs/superpowers/specs/2026-09-06-knowledge-retrieval-evaluation-adapter-design.md`

## Global Constraints

- Work on `dev` first.
- Do not call OpenAI, another paid model, or a live provider.
- Do not create a public or private evaluation HTTP endpoint.
- Do not modify Knowledge/RAG production source unless the approved design is revised.
- Do not copy retrieval, fusion, reranking, or retrieval-metric algorithms.
- Preserve document-scoped evidence identity as `(knowledge_document_id, chunk_id)`.
- Do not include chunk content in the generic evaluation sample or trace.
- Cross-context evidence is a system failure; malformed grader evidence is an evaluator failure.
- Forbidden evidence is always a blocking grade.
- Recall and reciprocal-rank grades default to non-blocking until reviewed thresholds exist.
- Do not commit, push, or merge without the repository owner's explicit approval.

---

## File map

| File | Responsibility |
|---|---|
| `apps/services/evaluation-runner/pyproject.toml` | Declare the sibling Knowledge/RAG adapter dependency |
| `apps/services/evaluation-runner/uv.lock` | Record reproducible resolved dependencies |
| `apps/services/evaluation-runner/evaluation_runner/adapters/__init__.py` | Adapter package marker only |
| `apps/services/evaluation-runner/evaluation_runner/adapters/knowledge_retrieval.py` | Map typed datasets and execute one governed retrieval case |
| `apps/services/evaluation-runner/evaluation_runner/retrieval_graders.py` | Independent Recall at K, MRR, and forbidden-evidence grades |
| `apps/services/evaluation-runner/tests/test_knowledge_retrieval_adapter.py` | Dataset preservation, evidence trace, versions, repetition, and isolation tests |
| `apps/services/evaluation-runner/tests/test_retrieval_graders.py` | Threshold, blocking, and malformed-metric tests |
| `apps/services/evaluation-runner/README.md` | Explain the connected retrieval evaluation with one example |

### Task 1: Dependency and validated dataset adaptation

**Files:**
- Modify: `apps/services/evaluation-runner/pyproject.toml`
- Modify: `apps/services/evaluation-runner/uv.lock`
- Create: `apps/services/evaluation-runner/evaluation_runner/adapters/__init__.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/adapters/knowledge_retrieval.py`
- Create: `apps/services/evaluation-runner/tests/test_knowledge_retrieval_adapter.py`

**Interfaces:**
- Consumes: `RetrievalEvaluationDataset` from `knowledge_rag.evaluation`.
- Produces: `AdaptedRetrievalDataset` and `adapt_retrieval_dataset(source_dataset) -> AdaptedRetrievalDataset`.

- [ ] **Step 1: Add the sibling package dependency**

Add `knowledge-rag` to Evaluation Runner dependencies and configure its local source:

```toml
dependencies = [
  "knowledge-rag",
  "pydantic>=2.13,<3",
]

[tool.uv.sources]
knowledge-rag = { path = "../knowledge-rag", editable = true }
```

Run `uv lock` from `apps/services/evaluation-runner`. Inspect the lock diff and
confirm it contains package metadata only, never environment values.

- [ ] **Step 2: Write failing dataset-adaptation tests**

The tests must build a real typed `RetrievalEvaluationDataset` and assert that the
generic dataset preserves the case ID, query, governed context, and exact expected
and forbidden document-scoped references:

```python
def test_adapt_retrieval_dataset_preserves_governed_case() -> None:
    source = make_source_dataset()

    adapted = adapt_retrieval_dataset(source)

    case = adapted.dataset.cases[0]
    assert case.case_id == "damaged-item-v1"
    assert case.capability is EvaluationCapability.RETRIEVAL
    assert case.input == {
        "query_text": "Can I refund a damaged item?",
        "tenant_id": "acme",
        "environment_id": "local",
        "knowledge_release_id": "refund-policy-2026-08-01",
        "allowed_classifications": ["CUSTOMER_SAFE"],
        "locale": "en-US",
        "as_of": "2026-08-12T12:00:00Z",
    }
    assert case.expectations["expected_evidence"] == [
        {
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-003-chunk-001",
        }
    ]
    assert adapted.get_source_case("damaged-item-v1") == source.cases[0]
```

Also assert that `get_source_case("unknown")` raises
`KnowledgeRetrievalAdapterError` rather than selecting another case.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
uv run pytest tests/test_knowledge_retrieval_adapter.py -v
```

Expected: collection fails because
`evaluation_runner.adapters.knowledge_retrieval` does not exist.

- [ ] **Step 4: Implement the minimal immutable adapter bundle**

Use a frozen dataclass that retains the validated source dataset and exposes an
explicit lookup:

```python
@dataclass(frozen=True)
class AdaptedRetrievalDataset:
    dataset: EvaluationDataset
    source_dataset: RetrievalEvaluationDataset

    def get_source_case(self, case_id: str) -> RetrievalEvaluationCase:
        for case in self.source_dataset.cases:
            if case.evaluation_case_id == case_id:
                return case
        raise KnowledgeRetrievalAdapterError(
            f"No source retrieval case exists for {case_id!r}."
        )
```

`adapt_retrieval_dataset()` must use `model_dump(mode="json")` for evidence
references and explicit scalar fields for trusted context. Do not store the full
typed Pydantic object inside generic JSON fields.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_knowledge_retrieval_adapter.py -v
uv run ruff check evaluation_runner/adapters tests/test_knowledge_retrieval_adapter.py
```

Expected: dataset tests pass and Ruff reports no errors.

- [ ] **Step 6: Review checkpoint**

Show the owner the dependency diff, `adapt_retrieval_dataset()`, the typed lookup,
and the passing test output. Do not commit automatically.

### Task 2: Execute one real governed retrieval case as a generic sample

**Files:**
- Modify: `apps/services/evaluation-runner/evaluation_runner/adapters/knowledge_retrieval.py`
- Modify: `apps/services/evaluation-runner/tests/test_knowledge_retrieval_adapter.py`

**Interfaces:**
- Consumes: `AdaptedRetrievalDataset`, `RetrievalExecutor`, `EmbeddingModel`, `RerankerModel`, positive `top_k`, and generic `EvaluationCase`.
- Produces: `KnowledgeRetrievalEvaluatedSystem.run(case, repetition) -> EvaluationSample`.

- [ ] **Step 1: Write failing sample and trace tests**

Use a deterministic fake `RetrievalExecutor`. Assert one call produces:

```python
sample = asyncio.run(system.run(adapted.dataset.cases[0], repetition=1))

assert sample.output["retrieval_metrics"] == {
    "recall_at_k": 1.0,
    "reciprocal_rank": 0.5,
    "forbidden_evidence_count": 0,
}
assert sample.output["retrieved_evidence"] == [
    {
        "rank": 1,
        "knowledge_document_id": "refund-policy-current-2026-08-01",
        "chunk_id": "section-001-chunk-001",
        "content_sha256": "a" * 64,
    },
    {
        "rank": 2,
        "knowledge_document_id": "refund-policy-current-2026-08-01",
        "chunk_id": "section-003-chunk-001",
        "content_sha256": "b" * 64,
    },
]
assert [event.kind for event in sample.trace] == [
    TraceEventKind.RETRIEVAL,
    TraceEventKind.RETRIEVAL,
]
assert "knowledge_text" not in sample.output
```

Assert `sample.versions` contains exact adapter, knowledge release, embedding, and
reranker identifiers. Use an injected clock in the test so latency is deterministic.

- [ ] **Step 2: Write failing integration-behavior tests**

Add tests proving reranker drift becomes a system error and:

```python
class AlwaysPassGrader:
    name = "test-always-pass"
    version = "v1"

    async def grade(self, case, sample) -> GraderResult:
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0,
            passed=True,
            blocking=True,
        )


result = asyncio.run(
    run_evaluation(
        dataset=adapted.dataset,
        system=system,
        graders=[AlwaysPassGrader()],
        repetitions=3,
        run_id="retrieval-run-001",
        evaluation_version="retrieval-evaluation-v1",
    )
)
assert executor.call_count == 3
assert result.summary.consistent_case_rate == 1.0
```

For a fake executor that returns evidence with `tenant_id="other-tenant"`, assert
the generic trial has status `SYSTEM_ERROR`, passed is false, and contains no
fabricated sample or grades.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
uv run pytest tests/test_knowledge_retrieval_adapter.py -v
```

Expected: failures identify the absent `KnowledgeRetrievalEvaluatedSystem`.

- [ ] **Step 4: Implement the evaluated-system adapter**

Implement:

```python
class KnowledgeRetrievalEvaluatedSystem:
    adapter_version = "knowledge-retrieval-adapter-v1"

    def __init__(
        self,
        *,
        adapted_dataset: AdaptedRetrievalDataset,
        executor: RetrievalExecutor,
        embedding_model: EmbeddingModel,
        reranker_model: RerankerModel,
        top_k: int,
        clock: Callable[[], float] = perf_counter,
    ) -> None: ...

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample: ...
```

The implementation must:

1. reject non-retrieval capability and unknown case IDs;
2. create a one-case `RetrievalEvaluationDataset` from the retained validated case;
3. wrap the injected executor only to record its public `RetrievalExecutionResult`;
4. call the existing public `run_retrieval_evaluation()` exactly once;
5. require the observed reranker model to equal the configured expected reranker;
6. build output and traces from the recorded result and public case metrics;
7. include identities, ranks, hashes, retrieval methods, and versions but no chunk
   content;
8. set final state to `{"retrieval_completed": True}` for the generic runner;
9. calculate non-negative elapsed milliseconds with the injected monotonic clock.

Do not import `_validate_execution_result` or any other private Knowledge/RAG
helper.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_knowledge_retrieval_adapter.py -v
uv run ruff check evaluation_runner/adapters tests/test_knowledge_retrieval_adapter.py
```

Expected: execution, repetition, trace, version, and cross-context tests pass.

- [ ] **Step 6: Review checkpoint**

Show the owner `KnowledgeRetrievalEvaluatedSystem.run()`, one concrete
`EvaluationSample`, and the tests proving no content leakage or paid call. Do not
commit automatically.

### Task 3: Independent retrieval quality and governance graders

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/retrieval_graders.py`
- Create: `apps/services/evaluation-runner/tests/test_retrieval_graders.py`

**Interfaces:**
- Consumes: `EvaluationCase` and `EvaluationSample.output["retrieval_metrics"]`.
- Produces: `RecallAtKGrader`, `ReciprocalRankGrader`, `ForbiddenEvidenceGrader`, and `RetrievalGraderError`.

- [ ] **Step 1: Write failing quality-grader tests**

Test exact threshold behavior independently:

```python
result = asyncio.run(
    RecallAtKGrader(minimum=0.8).grade(case, sample(recall_at_k=0.75))
)
assert result.score == 0.75
assert result.passed is False
assert result.blocking is False
assert result.reasons == [
    "Recall at K 0.7500 is below the configured minimum 0.8000."
]
```

Repeat for reciprocal rank. Assert `minimum` rejects values outside `[0, 1]` and
that callers may explicitly set `blocking=True`.

- [ ] **Step 2: Write failing governance and evaluator-error tests**

Assert:

```python
result = asyncio.run(
    ForbiddenEvidenceGrader().grade(
        case,
        sample(forbidden_evidence_count=1),
    )
)
assert result.score == 0.0
assert result.passed is False
assert result.blocking is True
assert result.reasons == ["Retrieved 1 forbidden evidence item."]
```

Missing, boolean, negative, string, or greater-than-one bounded quality metrics
must raise `RetrievalGraderError`. Run one malformed sample through
`run_evaluation()` and assert it raises `EvaluationRunError` naming the grader and
case; it must not create a zero product score.

- [ ] **Step 3: Run the grader tests and verify RED**

Run:

```bash
uv run pytest tests/test_retrieval_graders.py -v
```

Expected: collection fails because `evaluation_runner.retrieval_graders` does not
exist.

- [ ] **Step 4: Implement metric readers and graders**

Use strict internal readers:

```python
def _read_unit_interval_metric(sample: EvaluationSample, name: str) -> float:
    metrics = sample.output.get("retrieval_metrics")
    if not isinstance(metrics, dict):
        raise RetrievalGraderError("retrieval_metrics must be an object")
    value = metrics.get(name)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise RetrievalGraderError(f"{name} must be numeric")
    numeric_value = float(value)
    if not 0 <= numeric_value <= 1:
        raise RetrievalGraderError(f"{name} must be between 0 and 1")
    return numeric_value
```

Each grader must expose stable `name` and `version` values and return one
`GraderResult`. Do not combine Recall at K and MRR into a mean. The forbidden
grader must always set `blocking=True`; its constructor must not allow callers to
downgrade it.

- [ ] **Step 5: Run grader and runner tests and verify GREEN**

Run:

```bash
uv run pytest tests/test_retrieval_graders.py tests/test_runner.py -v
uv run ruff check evaluation_runner/retrieval_graders.py tests/test_retrieval_graders.py
```

Expected: all focused tests pass.

- [ ] **Step 6: Review checkpoint**

Show the owner each grader's input, score, pass decision, blocking behavior, and
one malformed-evaluator example. Do not commit automatically.

### Task 4: Learning documentation and complete verification

**Files:**
- Modify: `apps/services/evaluation-runner/README.md`

**Interfaces:**
- Consumes: the completed adapter and retrieval graders.
- Produces: a copyable local example and verified package documentation.

- [ ] **Step 1: Document the connected retrieval example**

Add a short section showing:

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

Explain that the default tests use a fake executor and that injecting a configured
live executor may call paid embeddings, requiring explicit owner authorization.

- [ ] **Step 2: Verify Evaluation Runner**

Run from `apps/services/evaluation-runner`:

```bash
uv run ruff format --check .
uv run ruff check .
uv run pytest
```

Expected: zero formatter differences, zero lint errors, and all tests pass.

- [ ] **Step 3: Verify Knowledge/RAG regression safety**

Run from `apps/services/knowledge-rag`:

```bash
uv run ruff check .
uv run pytest tests/test_evaluation.py tests/test_evaluation_runner.py
```

Expected: lint passes and the existing retrieval evaluation tests pass unchanged.
The repository's known whole-package formatter-version drift is not modified by
this task.

- [ ] **Step 4: Inspect diff and secret safety**

Run:

```bash
git diff --check
git status --short --untracked-files=all
git diff --stat
```

Confirm only the approved spec, plan, adapter package, retrieval graders, tests,
package metadata, lock file, and README changed. Confirm no `.env`, API key,
token, customer transcript, knowledge content, model cache, virtual environment,
or test cache is tracked.

- [ ] **Step 5: Stop before Git history changes**

Present the owner with:

- the file-by-file diff;
- exact test counts and commands;
- limitations, including that no live OpenSearch or RAGAS call ran;
- proposed plain commit messages without prefixes or hyphen separators.

Do not commit, push, merge, or change `main` without explicit approval.
