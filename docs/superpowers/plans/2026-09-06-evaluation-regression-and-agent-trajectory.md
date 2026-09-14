# Evaluation Regression and Agent Trajectory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:test-driven-development for implementation. Do not commit.

**Goal:** Complete the offline RAGAS regression runner and add deterministic
refund-agent trajectory evaluation.

**Architecture:** Three agents own disjoint files. The existing evaluation
contracts remain the shared boundary. The controller reviews and integrates all
changes, then runs the complete suite.

**Tech Stack:** Python 3.12, Pydantic, pytest, RAGAS 0.4 collections API,
LangGraph Agent Runtime adapters.

**Spec:** `docs/superpowers/specs/2026-09-06-evaluation-regression-and-agent-trajectory-design.md`

## Global Constraints

- No paid model or external-service calls.
- No Vendure, Temporal, human-operations, payment, or refund mutation.
- No commits, pushes, merges, or secret changes.
- Tests must fail for the missing behavior before production code is written.
- Preserve existing uncommitted work.
- Production Agent Runtime files are read-only for this slice.

---

### Task 1: Executable RAGAS suite configuration and failure status

**Files:**
- Modify: `apps/services/evaluation-runner/evaluation_runner/live_rag_evaluation.py`
- Modify only if required: `apps/services/evaluation-runner/evaluation_runner/ragas_graders.py`
- Modify: `apps/services/evaluation-runner/tests/test_live_rag_evaluation.py`
- Modify only if required: `apps/services/evaluation-runner/tests/test_ragas_graders.py`

**Produces:** Reviewed per-case metric selection; explicit one-case/full-suite
selection; result status usable by a CLI caller; evaluator failures remain
distinguishable from product failures.

- [ ] Add failing tests for reviewed metric selection, malformed/unknown metric
  configuration, full-suite selection, blocking failure status, and system-error
  status.
- [ ] Run focused tests and record the expected failures.
- [ ] Implement the smallest configuration and orchestration changes.
- [ ] Run focused tests and the Evaluation Runner suite.
- [ ] Refactor without broadening scope and record the file-by-file changes.

### Task 2: Run integrity and baseline comparison

**Files:**
- Modify: `apps/services/evaluation-runner/evaluation_runner/models.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/baseline.py`
- Create: `apps/services/evaluation-runner/tests/test_baseline.py`
- Modify: `apps/services/evaluation-runner/tests/test_models.py`

**Produces:** Strict run validation and a typed comparison that separates
blocking regressions from informational score deltas.

- [ ] Add failing tests for duplicate trial IDs, missing/unexpected repetitions,
  inconsistent summaries, duplicate grader identities, incompatible datasets,
  newly failing blocking grades, and semantic score deltas.
- [ ] Run focused tests and record the expected failures.
- [ ] Implement Pydantic integrity validation and the baseline comparator.
- [ ] Run focused tests and the Evaluation Runner suite.
- [ ] Refactor without changing existing runner semantics.

### Task 3: Deterministic refund-agent trajectory evaluation

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/adapters/agent_runtime_refund.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/trajectory_graders.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/policy_graders.py`
- Create: `apps/services/evaluation-runner/fixtures/evaluation-datasets/refund-agent-v1.json`
- Create focused tests under `apps/services/evaluation-runner/tests/`.

**Produces:** An in-process adapter for the existing refund intake graph, ordered
trace evidence, reviewed single/multi-turn cases, and deterministic route, tool,
argument, proposal, and safety grading.

- [ ] Add fixture-contract and grader tests before implementations.
- [ ] Add adapter tests using deterministic injected order, intent, evidence,
  and answer dependencies; verify tests fail for missing behavior.
- [ ] Implement trace and policy graders.
- [ ] Implement the smallest adapter and multi-turn driver that preserves
  caller-managed conversation context.
- [ ] Run focused tests, Evaluation Runner tests, and Agent Runtime focused
  regressions.

### Task 4: Integration review and documentation

**Files:**
- Modify: `apps/services/evaluation-runner/README.md`
- Modify: `docs/evaluation/EVALUATION_STRATEGY.md`

- [ ] Review all three diffs for shared-contract conflicts.
- [ ] Fix integration findings with covering tests.
- [ ] Document what is implemented, what remains nonblocking, and how to run only
  offline tests.
- [ ] Run format, lint, complete tests, Agent Runtime regressions,
  `git diff --check`, and credential-pattern scanning.
- [ ] Report exact evidence and request separate authorization before any paid
  baseline run.
