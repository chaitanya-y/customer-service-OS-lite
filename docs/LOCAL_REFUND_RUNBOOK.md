# Local Refund Journey Runbook

This guide starts and tests the implemented local refund journey. It is for a
development machine, not deployment.

## What this test proves

The browser path proves that a customer request is authenticated at the Edge,
processed by the LangGraph refund agent, grounded with customer-safe knowledge,
checked against trusted Vendure facts, evaluated by deterministic policy, and
handed to a human case when policy requires it.

The safest end-to-end demonstration is the **takeover path**. It creates and
resolves a Human Operations case but does not submit a refund to Vendure.

## Prerequisites

- Node.js `24.x` and pnpm `11.9.0`
- Python `3.12.x` and `uv`
- Docker Desktop, for PostgreSQL and a local OpenSearch instance
- Temporal CLI or a locally running Temporal development server
- A local Vendure database with a customer, API key, and fulfilled test order
- An already-published local RAG index named by `KNOWLEDGE_INDEX_NAME`

Install dependencies once:

```bash
corepack enable
pnpm install

cd tools/simulators/commerce-sandbox
pnpm install

cd ../../../apps/services/agent-runtime
uv sync --dev

cd ../knowledge-rag
uv sync --dev
```

OpenSearch is an external local dependency. This repository does not yet provide
a one-command OpenSearch or knowledge-publication setup. The Knowledge/RAG service
needs OpenSearch on `127.0.0.1:9200` and a published release before it can return
evidence.

## Configure local environment files

Copy each service's `.env.example` to `.env`. Do not add any `.env` file to Git.

The local secrets have the following required relationships. Read
[Local Authentication and Secrets](LOCAL_AUTH_AND_SECRETS.md) before changing
them; it explains which values must match and which values must be different.

| Secret | Services that must share it | Purpose |
|---|---|---|
| `CONTEXT_ASSERTION_HMAC_SECRET` | Edge API, Conversation Runtime, Integration Gateway, Agent Runtime, Knowledge/RAG | Edge-issued audience-specific customer context |
| `EDGE_SERVICE_ASSERTION_HMAC_SECRET` | Edge API, Conversation Runtime | Edge-only assistant-message commits; this must differ from every other secret |
| `WORKFLOW_ACCESS_HMAC_SECRET` | Workflow Workers, Integration Gateway | Worker-only fact refresh, refund execution, and reconciliation |
| `HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET` | Workflow Workers, Human Operations | Worker-only case open and close |
| `PROVIDER_WEBHOOK_HMAC_SECRET` | Integration Gateway only | Local signed provider outcome event verification |

`LOCAL_AUTH_HMAC_SECRET` belongs only to Edge API.
`HUMAN_ACCESS_HMAC_SECRET` belongs only to Human Operations. Keep every secret at
least 32 bytes and use different values for different purposes.

Conversation Runtime also requires `MESSAGE_ENCRYPTION_KEY_BASE64`: exactly 32
random bytes encoded as base64. It encrypts persisted chat text. Never reuse it
as an HMAC secret.

The two browser applications also need local development tokens:

```dotenv
# apps/web/customer-portal/.env
CSO_LOCAL_CUSTOMER_TOKEN=<output from the Edge API local:token command>

# apps/web/operations-console/.env
CSO_LOCAL_HUMAN_TOKEN=<output from the Human Operations local:token command>
HUMAN_OPERATIONS_BASE_URL=http://127.0.0.1:3003
```

The Edge local customer token has a maximum lifetime of 48 hours. Generate a new
one after it expires. The browser applications convert these development tokens
into HTTP-only local session cookies. The tokens themselves never go to browser
JavaScript.

## Start the stack

Start each process in its own terminal. Start dependencies before callers.

### 1. PostgreSQL

```bash
docker compose -f infrastructure/local/compose.yaml up -d postgres

cd apps/services/integration-gateway
pnpm migrate

cd ../conversation-runtime
DATABASE_URL=postgresql://cso_local:cso_local@127.0.0.1:5432/customer_service_os pnpm migrate

cd ../human-operations
MIGRATION_DATABASE_URL=postgresql://cso_local:cso_local@127.0.0.1:5432/customer_service_os pnpm migrate
```

### 2. Temporal

Start a local Temporal development server. The usual CLI command is:

```bash
temporal server start-dev
```

It should expose the Temporal gRPC endpoint on `127.0.0.1:7233` and the UI on
`http://127.0.0.1:8233`.

### 3. Vendure commerce simulator

```bash
cd tools/simulators/commerce-sandbox
pnpm dev
```

### 4. Integration Gateway

```bash
cd apps/services/integration-gateway
pnpm dev
```

### 5. Knowledge/RAG

```bash
cd apps/services/knowledge-rag
uv run uvicorn knowledge_rag.main:app --reload --host 127.0.0.1 --port 8001
```

Knowledge/RAG retrieves only `CUSTOMER_SAFE` evidence for the active tenant and
knowledge release. The current customer workflow-status page does not yet expose
the generated answer or citations, so verify grounding through the Agent Runtime
response or its integration checks rather than expecting citations in that page.

### 6. Agent Runtime

```bash
cd apps/services/agent-runtime
uv run uvicorn agent_runtime.main:app --reload --host 127.0.0.1 --port 8000
```

### 7. Conversation Runtime

```bash
cd apps/services/conversation-runtime
pnpm dev
```

It listens on `http://127.0.0.1:3004`. Edge API signs short-lived customer
context for customer reads/writes and a separate Edge-only assertion for
assistant-message commits.

### 8. Human Operations

```bash
cd apps/services/human-operations
pnpm dev
```

### 9. Temporal Workflow Workers

```bash
cd apps/services/workflow-workers
pnpm dev
```

On the current Apple Silicon development setup, the Temporal Worker can fail on
Node 24 with `RangeError: Invalid atomic access index`. If that happens, run only
this terminal with Node `22.21.0`. The rest of the repository continues to use
Node 24. This is a local Temporal compatibility workaround, not the deployment
target.

### 10. Edge API

```bash
cd apps/services/edge-api
pnpm dev
```

### 11. Create fresh local browser tokens and start the interfaces

```bash
cd apps/services/edge-api
pnpm --silent local:token

cd ../human-operations
pnpm --silent local:token
```

Paste the first output into `apps/web/customer-portal/.env` and the second into
`apps/web/operations-console/.env`, then run these commands from the repository
root:

```bash
pnpm dev:customer
pnpm dev:operations
pnpm dev:admin
```

The customer and operations development servers intentionally use Webpack, which
has been more reliable than the current Turbopack setup on this local stack.

## Local URLs

| Service | URL |
|---|---|
| Customer UI | `http://127.0.0.1:3100/sign-in` |
| Operations Console | `http://127.0.0.1:3101/sign-in` |
| Admin Console shell | `http://127.0.0.1:3102` |
| Edge API health | `http://127.0.0.1:3000/health` |
| Vendure Dashboard | `http://127.0.0.1:3001/dashboard` |
| Integration Gateway health | `http://127.0.0.1:3002/health` |
| Human Operations health | `http://127.0.0.1:3003/health` |
| Agent Runtime health | `http://127.0.0.1:8000/health` |
| Knowledge/RAG health | `http://127.0.0.1:8001/health` |
| OpenSearch | `http://127.0.0.1:9200` |
| Temporal UI | `http://127.0.0.1:8233` |

Use the exact `127.0.0.1` URLs above for browser testing. Local BFF routes accept
that development origin explicitly. Do not mix it with `localhost` in the same
test session.

## Test the safe takeover path

1. Open the Customer UI and choose **Continue locally**.
2. On `/support`, enter a full request with a valid local order reference. In the
   owner environment, this was tested with `AVV8JSZH8G6ZZDMX`:

   ```text
   I want a refund for order AVV8JSZH8G6ZZDMX. The item arrived damaged and I would like a full refund.
   ```

3. Submit the request. A high-value request should become **A specialist is
   helping**. This is expected, it is the deterministic takeover decision.
4. Open the Operations Console and choose **Continue locally**.
5. In the **Open** queue, open the newest case. Review the order reference,
   requested amount, policy reason codes, and evidence IDs.
6. Click **Claim this case**, choose **Resolve manual takeover**, add a note, and
   submit it.
7. Return to the customer journey and refresh the page. It should read **Support
   review completed**.

This path proves the human review and audit boundary without a commerce write.

## Test multi-turn order-reference retention

This is a regression test for conversational context. It may use the configured
model and create a local review case, but it does not execute a refund unless the
customer later confirms a preview.

Start with a fresh browser conversation. The simplest option is a private window.
Otherwise, open browser developer tools on the Customer Portal and run:

```javascript
sessionStorage.removeItem("cso.current-conversation-id");
location.reload();
```

Then send these messages as two separate turns, leaving the optional order
reference field empty:

```text
I need help with a refund. My order reference is AVV8JSZH8G6ZZDMX.
```

```text
The item arrived damaged. I want a full refund for item 3.
```

Pass condition: the second response must not ask the customer to share the order
reference again. It may request required evidence or create a high-value human
review case. This test passed through the local BFF, Edge API, Conversation
Runtime, Agent Runtime, MCP Gateway, Knowledge/RAG, and Temporal on 2026-09-04.

For one local sample, the first and second Edge API turns took 20.68 and 18.82
seconds respectively. Conversation persistence and transcript reads were under 50
ms; model and RAG work inside Agent Runtime accounted for nearly all remaining
time. These are local development observations, not performance targets.

## Test a refund execution path carefully

For an order that policy allows or requires approval, the customer must review an
exact preview and choose **Confirm refund**. That confirmation signals Temporal;
it does not call Vendure from the browser. The Workflow Worker refreshes facts
again and calls the Integration Gateway's idempotent execution route.

Use a disposable local order for this test. Check the resulting refund in the
Vendure Dashboard, then inspect the workflow in Temporal UI. Do not use an
unknown real order or production credentials.

The customer journey first shows **Refund initiated**. This means the refund was
accepted by the commerce or payment boundary, but the system is waiting for an
authoritative final result. It moves to **Refund completed** only when Vendure
reconciliation finds a settled refund or a signed provider outcome event reports
completion. A failed provider event moves it to **Refund needs attention**.

The local Vendure simulator normally settles the refund quickly. A real payment
provider may take days, so its signed webhook is accepted at
`POST /internal/v1/provider-refund-events`. The Gateway records each event before
retrying delivery to Temporal. This endpoint is for a provider adapter, never a
browser client.

## Current browser behavior

- The Customer Portal owns only same-origin BFF routes. It does not call internal
  services directly.
- It maps internal workflow stages to customer-safe language and removes internal
  citations before rendering.
- The Operations Console supplies an idempotency key for claim and decision
  mutations and displays the review packet plus audit trail.
- The Customer Portal listens to a same origin SSE wake up stream and refetches
  the authoritative journey view. If that stream disconnects, it falls back to a
  ten second polling interval.
- Conversation context sent to Agent Runtime includes only bounded end-customer
  messages. Assistant messages are intentionally excluded, and RAG receives only
  the latest customer message.

## Troubleshooting

| Symptom | Check |
|---|---|
| `pnpm: command not found` | Run `corepack enable`, open a new shell, then check `pnpm --version`. |
| Customer authentication required | Regenerate the Edge token, update `apps/web/customer-portal/.env`, and restart the Customer UI. |
| Human authentication unavailable | Regenerate the Human Operations token, update `apps/web/operations-console/.env`, and restart the Operations Console. |
| Request origin is not allowed | Use `http://127.0.0.1:3100`, not a different host or port. |
| No human case appears | Verify Human Operations and Workflow Workers are running and connected to the same Temporal server. |
| RAG request fails | Verify OpenSearch, the configured published index, and `OPENAI_API_KEY` in Knowledge/RAG. |
| Grounded answer falls back to a generic message | Verify `REFUND_ANSWER_MODEL_TIMEOUT_SECONDS=30` in Agent Runtime or use its default, then restart Agent Runtime. The answer call gets one bounded 30-second attempt rather than repeated timeouts. |
| Assistant asks for an order reference that was provided in an earlier turn | Start a fresh conversation and run the multi-turn retention test above. If it repeats, inspect Edge API conversation-context tests before changing prompt wording. |
| Assistant calls an item number an order number | Known customer-copy defect. Do not treat it as a failed lookup; tighten the answer-composer contract and add the regression test before the final positive refund test. |
| Existing case disappeared after restart | This is not expected now. Verify PostgreSQL is running, `DATABASE_URL` points to the same database, Human Operations migrations ran, and the tenant/environment values did not change. |
| Provider event endpoint returns `503` | Set `PROVIDER_WEBHOOK_HMAC_SECRET` in the Integration Gateway `.env` and restart the Gateway. |

## What this does not prove yet

This local test does not prove production authentication, real bank settlement,
managed PostgreSQL backup/high availability, Kafka delivery, distributed tracing,
workload scaling, or AWS deployment.
Those are the next hardening and deployment milestones.

## Final positive refund test still pending

The safe takeover path and focused automated execution tests have passed. One
manual positive browser-to-provider proof remains before the refund journey can be
called fully verified end to end:

1. Create and fulfill a disposable order in Vendure.
2. Submit a damaged-item refund from the Customer Portal.
3. If policy creates a takeover case, claim it and approve an exceptional refund
   plan in the Operations Console.
4. Confirm the exact refund preview in the Customer Portal.
5. Observe `REFUND_PROCESSING` after provider acceptance.
6. Verify the refund record in Vendure.
7. Verify a signed provider event or reconciliation moves Temporal to
   `REFUND_SUCCEEDED`.
8. Confirm the Customer Portal shows the truthful completed state.
9. Inspect the Temporal history, Human Operations audit trail, Conversation
   Runtime transcript, and Integration Gateway evidence.

Use a fresh disposable order and do not repeat confirmation against an already
refunded order.
