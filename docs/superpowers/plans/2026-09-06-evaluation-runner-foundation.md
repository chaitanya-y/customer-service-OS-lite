# Evaluation Runner Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-neutral Python evaluation runner that executes versioned cases repeatedly, applies deterministic graders, distinguishes system failures from evaluator failures, and produces reproducible per-case and run summaries.

**Architecture:** The new `evaluation-runner` is a separate Control and Knowledge workload. Evaluated systems and graders implement small async protocols; the core has no dependency on RAGAS, LangSmith, OpenAI, or tau-three. External frameworks and service adapters are added in later plans without changing the business-owned result contracts.

**Tech Stack:** Python 3.12, Pydantic 2, pytest 9, Ruff, `uv`

**Spec:** `docs/evaluation/EVALUATION_STRATEGY.md`

## Global Constraints

- Work on `dev` first.
- Do not call a paid model, start a provider mutation, or read raw production transcripts.
- Evaluation fixtures contain synthetic or explicitly approved data only.
- Critical authorization, policy, tenant, classification, and side-effect checks remain deterministic.
- No dependency on RAGAS, LangSmith, OpenAI, tau-three, or STATE-Bench in this foundation.
- Do not commit, push, or merge without the repository owner's explicit approval.

---

## File map

| File | Responsibility |
|---|---|
| `apps/services/evaluation-runner/pyproject.toml` | Isolated Python package and test/lint configuration |
| `apps/services/evaluation-runner/evaluation_runner/__init__.py` | Package marker only |
| `apps/services/evaluation-runner/evaluation_runner/models.py` | Versioned cases, samples, grades, trials, and summaries |
| `apps/services/evaluation-runner/evaluation_runner/protocols.py` | Async boundaries for evaluated systems and graders |
| `apps/services/evaluation-runner/evaluation_runner/graders.py` | Small deterministic outcome and forbidden-tool graders |
| `apps/services/evaluation-runner/evaluation_runner/runner.py` | Sequential repeated-trial execution and aggregation |
| `apps/services/evaluation-runner/tests/test_models.py` | Dataset and result invariants |
| `apps/services/evaluation-runner/tests/test_graders.py` | Real deterministic grader behavior |
| `apps/services/evaluation-runner/tests/test_runner.py` | Repetition, failure separation, blocking gates, and summaries |
| `apps/services/evaluation-runner/README.md` | Local learning guide and commands |

### Task 1: Package and versioned evaluation contracts

**Files:**
- Create: `apps/services/evaluation-runner/pyproject.toml`
- Create: `apps/services/evaluation-runner/evaluation_runner/__init__.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/models.py`
- Create: `apps/services/evaluation-runner/tests/test_models.py`

**Interfaces:**
- Consumes: JSON-safe synthetic case input and expectations.
- Produces: `EvaluationCase`, `EvaluationDataset`, `EvaluationSample`, `TraceEvent`, `GraderResult`, `TrialResult`, `CaseSummary`, `RunSummary`, and `EvaluationRun`.

- [ ] **Step 1: Create the package configuration**

Use Python `>=3.12,<3.13`, Pydantic `>=2.13,<3`, pytest `>=9.1,<10`, and Ruff `>=0.16,<1`. Configure pytest to read `tests` and Ruff to recognize `evaluation_runner` as first party.

- [ ] **Step 2: Write failing contract tests**

The tests must independently assert these behaviors:

```python
def test_dataset_rejects_duplicate_case_ids() -> None:
    with pytest.raises(ValueError, match="duplicate case IDs"):
        EvaluationDataset(
            dataset_id="refund-agent",
            dataset_version="v1",
            cases=[make_case("case-1"), make_case("case-1")],
        )


def test_trial_requires_sample_only_for_completed_status() -> None:
    with pytest.raises(ValueError, match="completed trial requires a sample"):
        TrialResult(
            trial_id="run-1:case-1:1",
            case_id="case-1",
            repetition=1,
            status=TrialStatus.COMPLETED,
            sample=None,
            grader_results=[],
        )
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `uv run pytest tests/test_models.py -v`

Expected: collection fails because `evaluation_runner.models` does not exist.

- [ ] **Step 4: Implement the minimal contracts**

Use frozen Pydantic models. `EvaluationCase` has a stable ID, name, capability, JSON-safe input, JSON-safe expectations, and unique tags. `EvaluationDataset` rejects duplicate case IDs. `EvaluationSample` contains output, final state, ordered trace events, latency, token/cost usage, and version evidence. `TrialStatus` distinguishes `COMPLETED` from `SYSTEM_ERROR`; evaluator exceptions are not converted into system failures.

`TrialResult` must enforce:

```python
@model_validator(mode="after")
def validate_status_payload(self) -> TrialResult:
    if self.status is TrialStatus.COMPLETED:
        if self.sample is None:
            raise ValueError("A completed trial requires a sample.")
        if self.error_message is not None:
            raise ValueError("A completed trial cannot contain an error.")
    elif self.sample is not None or not self.error_message:
        raise ValueError("A system-error trial requires only an error message.")
    return self
```

- [ ] **Step 5: Run the tests and verify GREEN**

Run: `uv run pytest tests/test_models.py -v`

Expected: all model tests pass.

### Task 2: Async system and grader protocols

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/protocols.py`
- Modify: `apps/services/evaluation-runner/tests/test_models.py`

**Interfaces:**
- Consumes: `EvaluationCase` and `EvaluationSample`.
- Produces: `EvaluatedSystem.run(case, repetition)` and `Grader.grade(case, sample)` async protocols.

- [ ] **Step 1: Write a failing structural-typing test**

```python
async def use_system(system: EvaluatedSystem, case: EvaluationCase) -> EvaluationSample:
    return await system.run(case, repetition=1)


async def use_grader(
    grader: Grader,
    case: EvaluationCase,
    sample: EvaluationSample,
) -> GraderResult:
    return await grader.grade(case, sample)
```

The concrete fake system and grader in the test should satisfy these protocols without inheriting from framework base classes.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `uv run pytest tests/test_models.py -v`

Expected: import failure for `evaluation_runner.protocols`.

- [ ] **Step 3: Implement the minimal protocols**

```python
class EvaluatedSystem(Protocol):
    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample: ...


class Grader(Protocol):
    name: str
    version: str

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult: ...
```

- [ ] **Step 4: Verify GREEN**

Run: `uv run pytest tests/test_models.py -v`

Expected: all model and protocol tests pass.

### Task 3: Deterministic foundation graders

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/graders.py`
- Create: `apps/services/evaluation-runner/tests/test_graders.py`

**Interfaces:**
- Consumes: `case.expectations["required_final_state"]`, `case.expectations["forbidden_tools"]`, and an `EvaluationSample`.
- Produces: blocking `GraderResult` records with stable grader name/version, binary score, and concrete failure reasons.

- [ ] **Step 1: Write failing final-state grader tests**

```python
async def test_required_final_state_grader_fails_changed_refund_count() -> None:
    case = make_case(
        expectations={"required_final_state": {"refund_count": 1}}
    )
    sample = make_sample(final_state={"refund_count": 2})

    result = await RequiredFinalStateGrader().grade(case, sample)

    assert result.passed is False
    assert result.blocking is True
    assert result.score == 0.0
    assert result.reasons == [
        "Final state field 'refund_count' expected 1 but received 2."
    ]
```

- [ ] **Step 2: Write failing forbidden-tool tests**

```python
async def test_forbidden_tool_grader_rejects_refund_write() -> None:
    case = make_case(expectations={"forbidden_tools": ["refund_order"]})
    sample = make_sample(
        trace=[TraceEvent(sequence=1, kind="TOOL_CALL", name="refund_order")]
    )

    result = await ForbiddenToolCallGrader().grade(case, sample)

    assert result.passed is False
    assert result.reasons == ["Forbidden tool called: refund_order."]
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `uv run pytest tests/test_graders.py -v`

Expected: import failure because `evaluation_runner.graders` does not exist.

- [ ] **Step 4: Implement minimal deterministic graders**

`RequiredFinalStateGrader` compares only explicitly required top-level fields. It does not require the complete state to be identical, allowing harmless diagnostic fields. `ForbiddenToolCallGrader` scans structured `TOOL_CALL` events; it never searches free-form assistant text.

- [ ] **Step 5: Run the tests and verify GREEN**

Run: `uv run pytest tests/test_graders.py -v`

Expected: all grader tests pass.

### Task 4: Repeated-trial runner and transparent aggregation

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/runner.py`
- Create: `apps/services/evaluation-runner/tests/test_runner.py`

**Interfaces:**
- Consumes: `EvaluationDataset`, `EvaluatedSystem`, graders, `run_id`, `evaluation_version`, and positive `repetitions`.
- Produces: `EvaluationRun` with every trial, per-case pass rates, overall trial pass rate, and all-trials-consistent case rate.

- [ ] **Step 1: Write the failing repetition test**

```python
async def test_runner_executes_every_case_for_every_repetition() -> None:
    system = RecordingSystem(sample=make_sample())

    result = await run_evaluation(
        dataset=make_dataset(case_count=2),
        system=system,
        graders=[AlwaysPassGrader()],
        repetitions=3,
        run_id="run-001",
        evaluation_version="evaluation-v1",
    )

    assert system.calls == [
        ("case-1", 1), ("case-1", 2), ("case-1", 3),
        ("case-2", 1), ("case-2", 2), ("case-2", 3),
    ]
    assert result.summary.trial_count == 6
```

- [ ] **Step 2: Write failure-separation and blocking-gate tests**

The tests must prove:

- a system exception becomes a `SYSTEM_ERROR` trial and later cases still run;
- a grader exception raises `EvaluationRunError` and does not create a misleading score;
- non-blocking quality failures remain visible but do not fail the trial;
- one failed blocking grade fails the trial;
- `consistent_case_rate` counts only cases that passed every repetition.

- [ ] **Step 3: Run the tests and verify RED**

Run: `uv run pytest tests/test_runner.py -v`

Expected: import failure because `evaluation_runner.runner` does not exist.

- [ ] **Step 4: Implement sequential evaluation execution**

The initial runner deliberately executes sequentially. This gives deterministic
ordering and prevents an accidental burst of paid calls when future model graders
are introduced. Explicit bounded concurrency belongs in a later cost-control task.

Trial IDs use the stable form `run_id:case_id:repetition`. A completed trial passes
when every blocking grader passes. A system-error trial always fails. Aggregate
metrics are counts and rates; the runner must not average unlike grader scores into
one misleading quality number.

- [ ] **Step 5: Run the tests and verify GREEN**

Run: `uv run pytest tests/test_runner.py -v`

Expected: all runner tests pass.

### Task 5: Learning guide and complete verification

**Files:**
- Create: `apps/services/evaluation-runner/README.md`

**Interfaces:**
- Consumes: the completed foundation.
- Produces: a short guide explaining dataset, case, trial, sample, grader, blocking gate, repetitions, `pass@1`, and consistency.

- [ ] **Step 1: Document one concrete refund example**

Use a synthetic case where the expected final state has one refund, the trace must
not contain an agent-accessible refund tool, and three repetitions must all pass.
Explain that the sample represents observed behavior while the case represents
reviewed expectations.

- [ ] **Step 2: Run formatting, lint, and all tests**

Run:

```bash
uv run ruff format --check .
uv run ruff check .
uv run pytest
```

Expected: all checks pass with no warnings owned by this package.

- [ ] **Step 3: Inspect the repository diff and secret safety**

Verify that only the listed evaluation files and approved design documents changed.
Confirm no `.env`, token, API key, customer data, generated environment, or cache is
tracked.

- [ ] **Step 4: Stop before Git history changes**

Show the owner the file-by-file diff, test results, and a proposed plain commit
message. Do not commit, push, merge, or change `main` without explicit approval.
