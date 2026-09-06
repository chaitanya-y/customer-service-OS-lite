# Contributor and Coding Agent Instructions

This file is the repository-level operating agreement. It applies unless a more
specific `AGENTS.md` inside a child directory overrides it.

## Read before changing code

The main agent reads these files when starting a new implementation task. Keep a
concise working summary; do not reload the whole set on every turn. Re-read when
the relevant document changes or the scope requires it.

Read these files in order:

1. `README.md`
2. `docs/CODEX_HANDOFF.md`
3. `docs/PROJECT_CONTEXT.md`
4. `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md`
5. `docs/LOCAL_AUTH_AND_SECRETS.md`
6. the relevant canonical schemas and tests for the boundary being changed

The PDF architecture package is useful background, but the version 1.1 Markdown
architecture and accepted ADRs take precedence if an older PDF page conflicts.

For a bounded subagent, the scoped reading rules in
[Multi-agent working agreement](docs/MULTI_AGENT_WORKING_AGREEMENT.md) replace the
full project onboarding list above. Applicable `AGENTS.md` files, safety rules,
required skill instructions and relevant canonical contracts are never optional.

## Efficient multi-agent work

- Delegation requires user approval for the current batch; this document is not
  blanket permission to spawn agents. Default to one coordinator and one worker.
- Before spawning, read [the working agreement](docs/MULTI_AGENT_WORKING_AGREEMENT.md).
  State the outcome, non-goals, ownership, dependencies, model choice, checks and
  time/usage checkpoints. Add a second worker only for independent useful work;
  more than two workers requires explicit approval.
- The owner approves task-based model selection within an approved parallel
  batch. Use the working agreement's routing guide: Luna for narrow work, Terra
  for clearly designed implementation, Sol or Astra for demanding work. Choose
  stronger models immediately when complexity or risk warrants it, not only
  after cheaper attempts fail. State the choice/reason and keep the main model,
  explicit user overrides, safety checks and budget boundaries unchanged.
- Use a compact task brief rather than a full-history fork by default. Do not
  duplicate implementation, full-suite runs or documentation work across agents.
- A file has one active editor. Shared contracts and service operations have
  named owners. Only the coordinator changes local secrets, servers or databases,
  and only with the required authorization.
- Review progress after 10 minutes or an observed 5 percentage-point allowance
  increase. At 20 minutes or an observed 10-point increase, pause new work at a
  safe checkpoint and ask whether to continue. These are soft checkpoints, not
  guaranteed cost caps; user-agreed budgets take precedence.
- Repeated failure requires a new hypothesis, not identical retries. Finish with
  relevant verified checks, remaining limitations and a file-by-file explanation.
  Never trade safety or necessary regression coverage for a lower usage number.

## Product and safety invariants

- The first vertical slice is the governed refund journey.
- The model may understand, retrieve, and propose. It may not authorize or
  execute a refund.
- Agent-accessible MCP commerce tools are read only.
- Temporal owns the durable refund state machine.
- Deterministic, versioned policy owns eligibility and approval decisions.
- Workflow Workers refresh trusted commerce facts before a consequential action.
- Customer confirmation is bound to the exact current preview.
- Integration Gateway is the only application boundary authorized to call the
  commerce refund mutation.
- Refund writes are idempotent. An uncertain provider response is not success.
- Tenant, environment, customer, staff, workflow, and audience restrictions must
  be derived from verified identity or signed service context, never model text.
- Only `CUSTOMER_SAFE` knowledge may reach the customer-answer path.
- Never log or commit secrets, access tokens, API keys, raw payment credentials,
  or customer personal data.

## Current implementation truth

- Human Operations uses PostgreSQL in the running local server. Its case mutation,
  audit event, idempotency record, and decision outbox record are transactional.
- `InMemoryHumanCaseRepository` is a test/dependency-injection adapter, not the
  running server's persistence choice.
- The centralized Model Gateway is planned, not implemented. Agent Runtime calls
  configured provider models directly through its model-client boundary today.
- Kafka, OpenTelemetry/CloudWatch, Cognito, AWS infrastructure, and voice are
  planned work.
- The positive local browser-to-provider exceptional-refund test passed on
  2026-09-05. See `docs/VERIFICATION_STATUS.md` for evidence and remaining gaps;
  this is not proof of real bank settlement or all production scenarios.
- The local damaged-item photo gate is policy v2 only. Private image validation,
  staff evidence acceptance, supervisor monetary approval and customer
  confirmation are distinct checks. Never send uploaded photos to RAG/the LLM.
- Photo retention deletion is not scheduled. Obtain explicit retention approval
  before enabling a purge; see `docs/REFUND_PHOTO_EVIDENCE.md`.

## Change workflow

1. Work on `dev` first.
2. Inspect the canonical contract and existing tests before writing application
   code.
3. Explain the intended behavior in simple language, list exact files to change,
   and obtain the owner's explicit permission before application-code edits.
4. Documentation-only changes may proceed when the owner explicitly asked for
   documentation updates.
5. Prefer the smallest complete vertical change. Avoid speculative services,
   duplicated DTOs, and unnecessary abstractions.
6. Add focused tests for changed behavior and run the relevant linter, type
   checker, unit tests, contract tests, and build.
7. Report what passed, what was not run, and any external side effects.
8. Do not merge or push `main` without explicit owner approval. Show the proposed
   main commit message before creating it.

Commit messages in this repository should be plain descriptions. Do not prefix
them with `feat:` and do not use a hyphen as a separator.

## Local security model

The local system uses multiple independent signing secrets because each protects a
different trust relationship. Only two login tokens are manually generated:
customer and Human Operations staff. Internal assertions are short lived and
generated automatically. Read `docs/LOCAL_AUTH_AND_SECRETS.md` before diagnosing
authentication or changing an environment variable.

## Validation rules

- Do not call a paid model or create a real/local commerce refund unless the owner
  explicitly authorizes that exact test.
- Use a fresh disposable Vendure order for a positive refund execution test.
- Verify final provider state before reporting a refund as completed.
- Keep `.env` files ignored and scan staged changes for secrets before committing.
- Keep generated dependencies, databases, caches, screenshots, and logs out of
  Git.
