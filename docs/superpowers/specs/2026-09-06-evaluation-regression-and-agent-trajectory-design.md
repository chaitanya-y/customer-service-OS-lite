# Evaluation Regression and Agent Trajectory Design

Status: Approved for implementation
Date: 2026-09-06

## Goal

Turn the existing RAGAS answer-evaluation foundation into an executable,
auditable regression suite while adding the first deterministic evaluation of
the existing LangGraph refund intake and proposal behavior.

## Scope

The implementation has three independent tracks:

1. Make each answer case's reviewed grader configuration executable and support
   explicit one-case or full-dataset runs with meaningful failure status.
2. Validate persisted evaluation-run integrity and compare candidate runs with a
   reviewed baseline without prematurely making semantic scores release gates.
3. Evaluate the Agent Runtime refund intake graph with deterministic injected
   dependencies, structured trajectories, and reviewed single-turn and
   multi-turn cases.

No task may call a paid model, mutate Vendure, start a Temporal workflow, create
a human-operations case, issue a refund, commit, push, or merge.

## RAGAS execution behavior

The runner must read the configured `ragas_metrics` and
`semantic_scores_blocking` fields from each reviewed case. Unknown metrics or
malformed configuration invalidate evaluation rather than silently falling back
to defaults. Deterministic safety grades remain blocking.

The command supports either one explicit case or the complete dataset. A
blocking grade failure or system error produces a failed run and a nonzero CLI
exit. Evaluator/configuration failures are distinct fatal evaluation errors.

Execution remains sequential. No concurrency is added until model usage and
cost enforcement are reliable.

## Artifact integrity and comparison

An `EvaluationRun` must be internally consistent:

- trial IDs are unique;
- each trial belongs to a dataset case;
- each case has exactly the configured repetition numbers;
- case summaries match their trials;
- aggregate summary counts match case and trial evidence;
- grader identities within a trial are unique.

A baseline comparator reports blocking regressions separately from semantic
metric deltas. Semantic RAGAS scores remain informational until human
calibration approves thresholds. Comparisons reject different dataset IDs or
versions so unlike experiments are not presented as regressions.

## Refund-agent evaluation

The first agent adapter invokes the existing `build_refund_graph()` directly
with injected deterministic dependencies. It evaluates intake and proposal
behavior only. It does not pretend to evaluate downstream workflow execution.

Reviewed cases cover:

- missing order reference clarification;
- order lookup normalization and success;
- order not found and dependency unavailable;
- missing refund details;
- multi-turn retention of a previously supplied order reference;
- ready damaged-item proposal;
- tenant-safe tool arguments;
- absence of mutation or direct-refund tools.

The adapter emits ordered structured trace events. Graders evaluate route/status,
required and forbidden tools, reviewed tool arguments, proposal fields, and
required final state. Exact tool order is asserted only where it is a safety or
dependency invariant.

## Boundaries

- Reference answers and expectations never enter the system under test.
- Synthetic facts contain no real customer data.
- Evaluation code stays in Evaluation Runner; production Agent Runtime remains
  unchanged for this slice.
- All external systems and model calls are replaced by deterministic injected
  implementations in automated tests.
- Public tau benchmark scores remain separate from internal product evaluation.

## Verification

Each track follows red-green-refactor with focused tests. Integration finishes
with Evaluation Runner formatting, lint, complete tests, Agent Runtime focused
regressions, `git diff --check`, and a scan for credential-shaped values.
