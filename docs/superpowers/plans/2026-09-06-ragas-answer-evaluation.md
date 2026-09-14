# RAGAS Answer Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate the real governed RAG answer boundary with repository-owned cases, deterministic safety checks, and RAGAS semantic metrics.

**Architecture:** Keep Evaluation Runner as the experiment owner and place RAGAS behind its `Grader` protocol. A separate answer adapter carries only reviewed input, customer-safe retrieved context, generated response, and evidence identities; live provider access remains in a guarded offline command.

**Tech Stack:** Python 3.12, Pydantic 2, RAGAS 0.4.x, OpenAI, OpenSearch, pytest 9, Ruff, `uv`

**Spec:** `docs/superpowers/specs/2026-09-06-ragas-answer-evaluation-design.md`

## Global Constraints

- Work on `dev` and preserve all existing uncommitted retrieval-adapter work.
- Write and observe a failing test before each production behavior.
- Do not call OpenAI, download a model, or query live OpenSearch during unit tests.
- Do not run a paid evaluation without a separate explicit authorization.
- Only `CUSTOMER_SAFE` context may enter answer evaluation.
- Do not start Temporal or call any commerce write boundary.
- Keep deterministic governance grades separate from semantic scores.
- Do not commit, push, merge, or discard work without explicit approval.

---

### Task 1: Answer evaluation contract and adapter

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/adapters/knowledge_answer.py`
- Create: `apps/services/evaluation-runner/tests/test_knowledge_answer_adapter.py`

**Interfaces:**
- Consumes: an `EvaluationCase` with `ANSWER` capability and an injected `KnowledgeAnswerExecutor`.
- Produces: an `EvaluationSample` containing `response`, ordered `retrieved_contexts`, evidence identities, latency, and component versions.

- [x] Write tests for valid mapping, customer-safe classification, reviewed-reference ownership, cross-context rejection, and repeated execution.
- [x] Run the focused test and confirm it fails because the adapter is absent.
- [x] Implement immutable result models, executor protocol, validation, and sample conversion.
- [x] Run the focused test and existing runner tests.

### Task 2: RAGAS semantic graders

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/ragas_graders.py`
- Create: `apps/services/evaluation-runner/tests/test_ragas_graders.py`

**Interfaces:**
- Consumes: reviewed `user_input` and `reference` plus system-produced `response` and `retrieved_contexts`.
- Produces: one `GraderResult` for each configured semantic metric.

- [x] Write failing table-driven tests for metric field selection, threshold behavior, malformed samples, scorer errors, and invalid scores.
- [x] Run the focused tests and confirm the missing module failure.
- [x] Implement `RagasMetricName`, `RagasMetricScorer`, and `RagasGrader` with strict input extraction.
- [x] Run focused and full Evaluation Runner tests.

### Task 3: Concrete optional RAGAS integration

**Files:**
- Modify: `apps/services/evaluation-runner/pyproject.toml`
- Modify: `apps/services/evaluation-runner/uv.lock`
- Modify: `apps/services/evaluation-runner/evaluation_runner/ragas_graders.py`
- Create: `apps/services/evaluation-runner/tests/test_ragas_integration.py`

**Interfaces:**
- Consumes: RAGAS 0.4 collections metrics configured with explicit LLM and embedding clients.
- Produces: validated scores through `RagasMetricScorer`.

- [x] Add an optional `ragas` dependency constrained to the current 0.4 API.
- [x] Write a failing compatibility test using a deterministic in-process metric double.
- [x] Implement lazy RAGAS imports and collections-API scorer calls.
- [x] Lock dependencies and run the focused tests without provider credentials.

### Task 4: Reviewed refund answer dataset

**Files:**
- Create: `apps/services/evaluation-runner/fixtures/evaluation-datasets/refund-rag-answer-v1.json`
- Create: `apps/services/evaluation-runner/tests/test_refund_rag_answer_dataset.py`

**Interfaces:**
- Consumes: repository `EvaluationDataset` JSON.
- Produces: five customer-safe answer cases with reviewed references and governance expectations.

- [x] Write a failing dataset-validation test covering stable IDs, ANSWER capability, references, classifications, and prohibited internal context.
- [x] Add the five reviewed cases.
- [x] Run the dataset and model-contract tests.

### Task 5: Guarded live evaluation command

**Files:**
- Create: `apps/services/evaluation-runner/evaluation_runner/live_rag_evaluation.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/adapters/refund_rag_answer.py`
- Create: `apps/services/evaluation-runner/evaluation_runner/answer_graders.py`
- Create: `apps/services/evaluation-runner/tests/test_live_rag_evaluation.py`
- Create: `apps/services/evaluation-runner/tests/test_refund_rag_answer_executor.py`
- Create: `apps/services/evaluation-runner/tests/test_answer_graders.py`

**Interfaces:**
- Consumes: explicit local dataset/index/model configuration and `ALLOW_PAID_API_CALLS`.
- Produces: an Evaluation Runner JSON result or a fail-closed configuration error.

- [x] Write failing tests for the paid-call guard, explicit paths/models, one-case selection, and no-commerce construction.
- [x] Implement the smallest command boundary with all external clients injected behind factories.
- [x] Run tests without the paid flag and prove that no provider client is constructed.

### Task 6: Documentation and offline verification

**Files:**
- Modify: `apps/services/evaluation-runner/README.md`
- Modify: `docs/evaluation/EVALUATION_STRATEGY.md`

- [x] Explain the metric meanings, their limitations, the customer-safe boundary, and the exact offline/live commands.
- [x] Run Ruff formatting and lint for Evaluation Runner.
- [x] Run the complete Evaluation Runner test suite.
- [x] Run focused Knowledge/RAG evaluation tests and lint.
- [x] Inspect the diff and scan it for secrets.
- [ ] Report exact passes, files changed, and what has not been run.
- [ ] Request separate authorization before the one-case paid run.
