# Contributor and Coding Agent Instructions

This file is the repository-level operating agreement. It applies unless a more
specific `AGENTS.md` inside a child directory overrides it.

## Read before changing code

Read these files in order:

1. `README.md`
2. `docs/CODEX_HANDOFF.md`
3. `docs/PROJECT_CONTEXT.md`
4. `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md`
5. `docs/LOCAL_AUTH_AND_SECRETS.md`
6. the relevant canonical schemas and tests for the boundary being changed

The PDF architecture package is useful background, but the version 1.1 Markdown
architecture and accepted ADRs take precedence if an older PDF page conflicts.

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
- One final positive browser-to-provider refund test is pending. See
  `docs/VERIFICATION_STATUS.md`.

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
