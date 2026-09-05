# Codex Handoff

Last updated: 2026-09-04

## Start here

This is the shortest reliable handoff for a new Codex account or engineer. The
repository itself is the durable source of context; chat history is supplementary.

Read in this order:

1. `AGENTS.md` for working rules and safety invariants.
2. `README.md` for the product and current status.
3. `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md` for the current HLD and LLD.
4. `docs/PROJECT_CONTEXT.md` for detailed implementation history and commands.
5. `docs/LOCAL_AUTH_AND_SECRETS.md` before touching any token or `.env` file.
6. `docs/VERIFICATION_STATUS.md` before claiming the refund journey is complete.
7. `docs/LOCAL_REFUND_RUNBOOK.md` when starting or testing the stack.

## Repository state at this handoff

- Repository: <https://github.com/chaitanya-y/customer-service-OS-lite>
- Development branch: `dev`
- Stable integration branch: `main`
- Commit `e5fbe50` (`Preserve customer context across refund chat turns`) contains
  the verified conversation-context regression fix and its tests. The handoff
  documentation may still be uncommitted. Inspect `git status --short` before
  changing, committing, resetting, or switching branches.
- Local process, database, OpenSearch index, browser-session, and `.env` state
  are machine-local. A new account must follow the runbook rather than assuming
  that a currently running local server or token exists.
- Never assume local `.env`, Vendure data, OpenSearch indexes, or generated login
  tokens exist in a fresh clone.

## What the project is

Customer Service OS Lite is a production-shaped learning platform for creating,
governing, operating, and eventually deploying customer support agents. The first
walking skeleton is a complex refund journey rather than a collection of demos.

It combines:

- Next.js customer and Human Operations interfaces;
- Node.js/TypeScript Edge, Conversation, Workflow, Integration, and Human
  Operations services;
- Python/FastAPI LangGraph Agent Runtime and Knowledge/RAG service;
- OpenSearch hybrid retrieval with BM25, vectors, metadata filtering, RRF, and a
  cross-encoder reranker;
- read-only MCP commerce tools;
- deterministic versioned refund policy;
- Temporal durable workflow, confirmation, approval, takeover, execution, and
  reconciliation;
- PostgreSQL persistence for conversations, integration evidence, and Human
  Operations;
- a local Vendure commerce system.

## Current important truths

Human Operations is durable locally. The running service constructs
`PostgresHumanCaseRepository`. It stores refund cases, append-only audit events,
idempotency records, and pending decision outbox records transactionally. A retry
loop delivers pending decisions to Temporal. The in-memory repository is retained
for tests and dependency injection only.

The centralized Model Gateway is not implemented. Agent Runtime currently calls
its configured OpenAI models directly. `MODEL_ROUTE_ID` is evidence metadata, not
proof that a routing gateway exists. The planned gateway will centralize routing,
budgets, allowlists, fallback, provider credentials, latency/cost telemetry, and
model-policy audit.

The architecture PDFs remain useful, but they are not all current. The original
combined HLD/LLD is preserved as a baseline appendix. The authoritative changes are
in `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md` and at the front of the final
combined architecture PDF.

## Verification status

The safe manual takeover path and focused automated refund paths have passed. RAG
retrieval and grounded answer integration have also been exercised. One final
positive browser-to-provider test using a new disposable fulfilled Vendure order
is pending. Do not call the journey fully verified until the checklist in
`docs/VERIFICATION_STATUS.md` passes.

### Latest code commit: multi-turn customer context

The customer could give an order reference in one chat message and describe the
damaged item in the next. Previously the Edge API forwarded only the latest
message to Agent Runtime, so the agent could incorrectly ask for the order
reference again.

Commit `e5fbe50` fixes that boundary:

- Edge API persists the customer message, reads the trusted Conversation Runtime
  transcript, keeps only customer messages, bounds it to eight messages / 8,000
  characters, and forwards that chronological context to Agent Runtime.
- Edge resolves an order reference from the latest unambiguous customer message
  in that bounded history. An explicitly supplied order reference still wins.
- Agent Runtime validates the bounded history and supplies it to the structured
  refund-intent extraction call. RAG intentionally receives only the latest
  message, so a long transcript is not blindly passed to retrieval.
- Regression coverage passed: Edge API typecheck and 50 tests, Agent Runtime Ruff
  and 49 tests.

On 2026-09-04, a real two-message local BFF sample retained
`AVV8JSZH8G6ZZDMX` from the first message when the second message said the item
was damaged. The assistant did not ask for the order reference again, and the
second turn created a local human-review workflow. No refund was confirmed or
executed.

The sample exposed one customer-copy defect to fix before the final positive test:
the generated answer said "item 3 in order 3" instead of using the real order
reference. The governed backend used the correct order, but the answer-composer
input/contract must be tightened so it cannot confuse an item number with an order
reference. Add a regression test with the corrected behavior.

### Observed local timing baseline

These are one local-machine sample, not performance SLOs:

| Operation | Observed time |
|---|---:|
| Create conversation through Edge API | 14.2 ms |
| First customer message, Edge API total | 20.68 s |
| Second customer message, Edge API total | 18.82 s |
| Conversation Runtime customer-message persistence | 11.7–23.8 ms |
| Conversation Runtime transcript read | 6.5–24.6 ms |
| Conversation Runtime assistant-message persistence | 33.4–49.9 ms |
| Combined local MCP Gateway calls per turn | 268–291 ms |
| Temporal workflow execution after the second reply | 356 ms |

The Agent Runtime consumed about 19–21 seconds of each turn. It contains two
configured model calls, customer-safe RAG retrieval, and proposal construction.
Exact LLM versus RAG timings are not available yet because the project has
correlation IDs but not OpenTelemetry spans. Do not infer a per-model latency
breakdown from this table.

## Recommended next work

1. Tighten the answer-composer contract so it renders the actual order reference,
   not an item number as an order identifier, and add the regression test.
2. Run the one remaining positive end-to-end refund verification and record its
   evidence without committing credentials or customer data.
3. Add reproducible Vendure seed/bootstrap and one-command local orchestration.
4. Add browser end-to-end tests for confirmation, approval, takeover, processing,
   provider completion, and failure.
5. Add OpenTelemetry tracing and metrics, then CloudWatch dashboards/alarms for
   the AWS deployment.
6. Connect existing transactional outboxes to Kafka/MSK for projections and audit
   events.
7. Implement the centralized Model Gateway behind the existing model-client
   boundary.
8. Replace local login with Cognito/OIDC and deploy the first single-region slice.

## Moving to another ChatGPT or Codex account

1. Push the approved documentation and code to the private or public GitHub
   repository.
2. Keep `.env` files, tokens, API keys, local databases, and OpenSearch data out of
   Git.
3. Sign in to Codex with the new account and clone the repository.
4. Start the new task with: "Read `AGENTS.md` and `docs/CODEX_HANDOFF.md` completely,
   then inspect the repository. Do not write code. Explain the architecture,
   current state, token model, and remaining final test back to me."
5. Upload or attach the PDFs from `docs/reference/` if the new task needs their
   visual content. The Markdown architecture remains the authoritative searchable
   source.
6. Transfer secrets through a password manager or secret store, never chat, Git,
   screenshots, or a handoff document.

The new account does not need the entire old chat to work safely. It needs the
repository, these handoff documents, the reference PDFs, and local secrets supplied
out of band.
