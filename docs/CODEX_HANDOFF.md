# Codex Handoff

Last updated: 2026-09-06

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

Before delegating, follow [the multi-agent working agreement](MULTI_AGENT_WORKING_AGREEMENT.md).
Default to one coordinator and one worker, use scoped briefs, and agree on
time/usage checkpoints. Bounded workers follow its scoped reading rules rather
than repeating this entire onboarding list. This does not authorize spawning
agents without approval for the current batch.

## Repository state at this handoff

- Repository: <https://github.com/chaitanya-y/customer-service-OS-lite>
- Development branch: `dev`
- Stable integration branch: `main`
- Commit `e5fbe50` (`Preserve customer context across refund chat turns`) contains
  the verified conversation-context regression fix and its tests. The September 5–6
  answer, photo-gate, order-contract and UI updates were verified in the local
  working tree; do not assume they are on GitHub. Inspect `git status --short` and recent commits before
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

The latest positive local browser-to-provider test passed through the photo gate
on 2026-09-06. Disposable order `AUUYAWRHBVGJPK5R` (Vendure order 2) contained two
Laptop 13 inch 8GB units; the full-order refund was USD 3,122.60. The first photo
passed technical validation, staff requested a clearer photo, and the replacement
was accepted at its exact revision. The same case then moved to monetary
takeover, a supervisor approved the exceptional plan, and the customer confirmed
preview `724a34e6-f044-448e-817d-a17d02fa7dac`.

Workflow `refund-19928c34-afd6-4e0a-b709-29d8ca36381a` and case
`case-8307800e-a61c-4295-bfad-d118931137b7` led to exactly one Gateway-created
Vendure refund, ID 5, initially `Pending`. Separately owner-authorized settlement
changed that existing refund to `Settled`; no second refund was created. Temporal
reached `REFUND_SUCCEEDED`, and the customer projection reached
`REFUND_COMPLETED` with no action. This is simulator evidence, not real bank
settlement or a live webhook proof. The earlier September 5 non-photo-gated
proof, refund 4 for USD 1,683.80, remains recorded as historical evidence.

Read `docs/VERIFICATION_STATUS.md` for the exact synthetic identifiers, audit
evidence, historical test runs, and remaining production limitations. Do not reuse
either now-refunded order for another positive execution test.

The September 6 browser run still generated an unsupported request for a delivery
date. The subsequent fix is implemented: `SYSTEM_PROMPT` forbids asking for the
delivery date or stating a delivery-age window, and runtime defense-in-depth
rejects either wording so the existing graph safely falls back. The full Agent
Runtime suite passed 101 tests with the same one upstream warning. A fresh paid
live browser recheck has not been run. Trusted delivery-age eligibility remains
unimplemented; the wording safeguard does not supply trusted delivery facts.

### September 6 order-contract regression

Vendure manual fulfillment returned an empty method string. The Gateway now
normalizes blank provider methods to `unspecified`, preserving a valid order
contract. Edge maps typed `order_lookup_unavailable` to a safe, retryable HTTP
503 instead of a generic downstream failure.

At the earlier September 6 order-contract checkpoint, Gateway typecheck and 44
tests, Edge typecheck and 83 tests, and Agent Runtime Ruff and 98 tests passed;
the Python run emitted one upstream warning. Live
signed REST and MCP order lookup also passed. These recorded checks cover the
order-contract recovery; the later 101-test wording-safeguard result is recorded
above.

### Committed multi-turn customer context

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

### September 5 answer and display fixes

The earlier sample exposed "item 3 in order 3" in the customer answer despite a
correct backend lookup. The answer composer now receives the trusted public order
reference and product names, not internal order/item identifiers. Explicit
conflicting order labels trigger a safe fallback.

A later answer incorrectly described 167880 minor units as 167,880 USD. Prompt
`refund-answer-v3` no longer receives the proposed money field. Common monetary
expressions in generated prose trigger fallback, and application code appends the
proposed USD amount using integer arithmetic. The backend Money contract is
unchanged. The September 5 run displayed USD 1,683.80 correctly. These bounded
checks are not universal factuality or grounding evaluation.

The customer page translates destination codes to readable labels and shows
**Review by** only while confirmation is the next action. The raw preview and
expiry metadata remain unchanged; this display change adds no expiry enforcement.

Remaining wording issues include technical labels such as
`refundRequest.orderReference` in model prose. A later local policy v2 slice adds
private photo upload, exact-revision staff review, and a durable evidence gate;
see [the photo guide](REFUND_PHOTO_EVIDENCE.md). Delivery-age eligibility is still
not enforced. The September 6 proof above now joins the photo gate to provider
execution; keep that local success separate from the remaining wording and
production gaps.

### Refund confirmation expiry, September 5 follow-up

The local implementation now binds confirmation to the preview ID and enforces
`validUntil` using Temporal's workflow clock. Exactly at the deadline is too late;
invalid dates fail closed. A durable timer invalidates unanswered previews.
Timely acceptance remains valid during later human review and provider processing;
existing fresh-facts checks still run. For v1 workflows a late supervisor decision
does not extend the inherited policy deadline. The photo-gated v2 exceptional
path rereads accepted evidence and fresh commerce facts and evaluates the pinned
policy again before constructing a new confirmation preview. It does not extend
an old preview or bypass customer confirmation.

Edge returns HTTP 409 `refund_preview_unavailable` for stale/terminal previews and
a confirmed completion race. HTTP 202 remains only signal-delivery acknowledgement.
The customer sees **Refund preview no longer available**, without confirmation or
a review deadline. The state also covers changed order facts, so the copy does not
claim expiry was necessarily the cause.

Rollout caveat: two Temporal patches preserve old histories. New waits get timers;
pre-patch workflows already parked in an unlimited wait reject their next late
live confirmation under the new worker, but do not acquire an automatic timer
retroactively. Inventory and explicitly migrate/close those legacy waits before
claiming universal timer coverage. No existing project workflow was migrated by
this implementation. See `VERIFICATION_STATUS.md` for isolated restart/replay proof.

The follow-up synthetic browser test also passed: a visible confirmation expired
automatically, controls disappeared, and a late Edge confirmation returned 409
with zero execution attempts. Private photo intake/review is now a separate local
slice; read `REFUND_PHOTO_EVIDENCE.md` and its verification section before testing.

The local v2 photo smoke passed through real service APIs: two synthetic uploads,
request-more, exact-revision acceptance, same-case takeover and safe rejection,
with zero money executions in that smoke. The later September 6 browser proof
also completed the photo-gated provider path. New local Edge requests now use v2; old workflows do
not change. Both 48-hour local login tokens were renewed on September 5 without
rotating signing secrets. See `VERIFICATION_STATUS.md` for expiry times, test
counts, browser/API distinction and fixture IDs. Changes remain uncommitted;
inspect Git before assuming these updates exist remotely.

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

1. Review and commit the approved local answer/display changes and verification
   documentation before assuming a fresh clone contains them.
2. Plan the legacy parked-workflow rollout, then address remaining customer
   wording, delivery-age eligibility and production evidence storage; extend evaluations
   without weakening authorization.
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
   current state, token model, latest verification evidence, and remaining
   hardening work back to me."
5. Upload or attach the PDFs from `docs/reference/` if the new task needs their
   visual content. The Markdown architecture remains the authoritative searchable
   source.
6. Transfer secrets through a password manager or secret store, never chat, Git,
   screenshots, or a handoff document.

The new account does not need the entire old chat to work safely. It needs the
repository, these handoff documents, the reference PDFs, and local secrets supplied
out of band.
