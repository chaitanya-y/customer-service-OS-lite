# Evaluation Runner

This package provides the framework-neutral core for evaluating Customer Service
OS Lite. It does not call OpenAI, RAGAS, LangSmith, tau-three, or a commerce
provider. Later adapters will connect those systems to these stable contracts.

## The evaluation flow

```text
Versioned dataset
    -> case
    -> evaluated system
    -> observed sample
    -> deterministic and semantic graders
    -> trial result
    -> case and run summaries
```

- A **dataset** is a reviewed and versioned collection of scenarios.
- A **case** describes the input and the expected safe outcome.
- A **sample** records what the system actually did, including final state,
  structured trace events, latency, token usage, cost, and component versions.
- A **grader** compares the case expectations with the observed sample.
- A **trial** is one attempt at one case. System failures are preserved as failed
  trials; evaluator failures invalidate the run instead of blaming the product.
- A **blocking grade** controls whether the trial passes. An informational grade
  remains visible but cannot hide or override a safety decision.

## Synthetic refund example

Suppose a reviewed case expects the sandbox to finish with exactly one refund:

```python
EvaluationCase(
    case_id="refund-damaged-item-001",
    name="Damaged item follows governed refund path",
    capability=EvaluationCapability.AGENT,
    input={"customer_message": "My synthetic order arrived damaged."},
    expectations={
        "required_final_state": {"refund_count": 1},
        "forbidden_tools": ["agent_direct_refund"],
    },
    tags=["refund", "governance"],
)
```

The case is the reviewed expectation. The evaluated system then returns an
`EvaluationSample`, which is the observed evidence. Its final state might contain
`refund_count: 1`, while its structured trace shows order lookup, policy review,
human approval, customer confirmation, and gateway execution. The trace must not
contain `agent_direct_refund` because an agent must not bypass the governed path.

`RequiredFinalStateGrader` checks the authoritative outcome.
`ForbiddenToolCallGrader` checks structured tool-call evidence. It does not search
the assistant's prose, so an explanation that mentions a tool name cannot create a
false failure.

If the case runs three times, the runner stores three independent trials:

- `pass@1` is the fraction of individual trials that pass;
- case consistency is true only when all three repetitions pass;
- one failure among three gives a case pass rate of `2/3`, but consistency is
  false.

This distinction matters because a customer-service agent that works occasionally
is not reliable enough for release.

## Why execution is sequential first

The foundation runs one trial at a time. This makes ordering reproducible and
prevents a future model-backed evaluator from accidentally producing a burst of
paid API calls. Bounded concurrency can be added later with explicit cost limits.

## Local verification

From this directory, run:

```bash
uv run ruff format --check .
uv run ruff check .
uv run pytest
```

These tests are offline and use synthetic data only.
