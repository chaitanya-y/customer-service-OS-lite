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

The repository does not yet contain RAGAS evaluation, answer-level evaluation,
multi-turn agent simulation, trajectory grading, repeated trials, public
benchmark adapters, or evaluation release gates.

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

Checks the complete multi-turn behavior rather than only the last answer.

Primary checks:

- correct specialist or route;
- correct tool selection and arguments;
- appropriate clarification when required facts are missing;
- conversation context retained across turns;
- required handoff or approval performed;
- no prohibited tool or unauthorized action;
- final environment state matches the requested outcome;
- no duplicate provider action;
- latency, token use, and cost per trial.

Trajectory grading should allow more than one safe path. Exact tool order is
asserted only when order is itself a safety invariant.

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
4. Create the reviewed refund RAG and answer dataset.
5. Add the refund-agent sandbox adapter and deterministic final-state graders.
6. Add multi-turn simulations, trajectory grading, and repeated trials.
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
