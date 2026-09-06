# Local Authentication and Secrets

Last updated: 2026-09-05

## The simple mental model

The project does not require you to manually manage many live tokens.

You configure several independent signing secrets once. You manually generate two
local login tokens. The services then generate short-lived internal assertions
automatically for each request.

```text
Signing secret configured in service .env
  -> service signs a JWT token or assertion
  -> receiving service verifies it with the matching secret
  -> verified claims become trusted identity and scope
```

A secret is a long-lived local key used to sign or verify. A token is a signed,
time-limited message that carries claims. The signature lets the receiver detect
whether anyone changed those claims.

## The two tokens you generate manually

### Customer login token

Generate it in `apps/services/edge-api`:

```bash
pnpm --silent local:token
```

Put the output in the effective customer web environment file. For example:

```dotenv
# apps/web/customer-portal/.env
CSO_LOCAL_CUSTOMER_TOKEN=<generated token>
```

It is an HS256 JWT signed with `LOCAL_AUTH_HMAC_SECRET`. It represents the one
configured local customer and is accepted only by Edge API. Its maximum supported
lifetime is 48 hours.

Next.js `.env.local` overrides `.env`. The September 5 owner setup keeps this
customer token in `apps/web/customer-portal/.env.local`. Check which file supplies
the effective value before replacing it; changing only `.env` will not replace a
token shadowed by `.env.local`. Restart the web app and sign in locally again.
This is file precedence, not an additional token or signing secret.

### Human Operations staff token

Generate it in `apps/services/human-operations`:

```bash
pnpm --silent local:token
```

Put the output in the effective Operations Console environment file. For example:

```dotenv
# apps/web/operations-console/.env
CSO_LOCAL_HUMAN_TOKEN=<generated token>
```

It is an HS256 JWT signed with `HUMAN_ACCESS_HMAC_SECRET`. It represents the local
staff ID and role and is accepted only by Human Operations. Its maximum supported
lifetime is 48 hours.

The two Next.js applications keep these server-side and expose only an HTTP-only
local session cookie to the browser. Browser JavaScript does not need the raw JWT.

## Internal assertions are automatic

After Edge API verifies the customer token, it creates audience-specific internal
JWT assertions. These normally live for 60 seconds and must never be pasted into a
browser or `.env` file.

Examples:

- an Agent Runtime assertion with audience `agent-runtime`;
- a Knowledge/RAG assertion with audience `knowledge-rag`;
- an Integration Gateway assertion with audience `integration-gateway`;
- a private-photo assertion with audience `human-operations-evidence`;
- a Conversation Runtime assertion with its conversation audience;
- an Edge service assertion for committing assistant messages.

Workflow Workers similarly create short-lived assertions for Integration Gateway
refund operations and Human Operations case/evidence operations. Private photos
do not introduce another manually generated login token.

An assertion can contain claims such as tenant ID, environment ID, principal or
customer ID, conversation ID, workflow ID, request ID, purpose, issuer, audience,
issued-at time, and expiration. The receiver verifies every claim relevant to its
boundary before using it.

## Signing secret relationships

Values marked "must match" must be identical in the listed services. Every row
must use a different random value from every other row.

| Secret | Where it is configured | What it protects |
|---|---|---|
| `LOCAL_AUTH_HMAC_SECRET` | Edge API only | Local customer login token |
| `HUMAN_ACCESS_HMAC_SECRET` | Human Operations only | Local staff login token |
| `CONTEXT_ASSERTION_HMAC_SECRET` | Edge API, Conversation Runtime, Integration Gateway, Agent Runtime, Knowledge/RAG, Human Operations when photo intake is enabled | Local audience-specific customer context assertions; values must match |
| `EDGE_SERVICE_ASSERTION_HMAC_SECRET` | Edge API and Conversation Runtime | Assistant-message commits; values must match |
| `WORKFLOW_ACCESS_HMAC_SECRET` | Workflow Workers and Integration Gateway | Fact refresh, refund execution, and reconciliation; values must match |
| `HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET` | Workflow Workers and Human Operations | Worker-only case open/close and bound evidence read/transition; values must match |
| `PROVIDER_WEBHOOK_HMAC_SECRET` | Integration Gateway and the local provider adapter/test sender | Signed provider outcome events |

For local development, use at least 32 random bytes per secret. One way to create
a value is:

```bash
openssl rand -hex 32
```

Run it separately for every row. Do not reuse one value everywhere.

The shared `CONTEXT_ASSERTION_HMAC_SECRET` is an intentional local simplification:
the Edge signs and several services verify, while the JWT audience prevents normal
cross-use. Production should use separate per-audience keys or asymmetric signing
where only Edge has the private key and each service has the appropriate public
verification key.

## Other sensitive values

| Value | Purpose |
|---|---|
| `OPENAI_API_KEY` | External credential used by Agent Runtime and embedding/answer paths that call OpenAI |
| `VENDURE_API_KEY` | External commerce credential used by Integration Gateway |
| `MESSAGE_ENCRYPTION_KEY_BASE64` | Exactly 32 random bytes encoded as base64; encrypts stored conversation text and is not a JWT signing secret |
| `DATABASE_URL` | Runtime database credential with restricted application permissions |
| `MIGRATION_DATABASE_URL` | More privileged local migration credential; do not use it as the normal runtime account |

Do not place any real value in documentation, source code, fixtures, test output,
screenshots, issues, or Git history.

## Why the same name appears in several `.env` files

Signing and verification are performed by different processes. The signer and
verifier need compatible key material, so the same relationship value appears in
multiple service configurations.

Example:

```text
Edge API signs audience=knowledge-rag
  using CONTEXT_ASSERTION_HMAC_SECRET=A

Knowledge/RAG verifies audience=knowledge-rag
  using CONTEXT_ASSERTION_HMAC_SECRET=A
```

If Knowledge/RAG uses secret `B`, verification fails even though both variables
have the same name. If an Integration Gateway assertion is replayed to RAG, the
audience check still rejects it.

## Expiration and common failures

`Customer authentication is required` usually means the customer login token is
missing, expired, signed with a different `LOCAL_AUTH_HMAC_SECRET`, or the Customer
Portal was not restarted after `.env` changed.

`Human authorization is required` usually means the staff token is missing,
expired, signed with a different `HUMAN_ACCESS_HMAC_SECRET`, or the Operations
Console was not restarted after `.env` changed.

An internal `401` or `403` usually means one of the paired service secrets differs,
an issuer/audience differs, the token expired, or tenant/environment claims do not
match service configuration.

Use this recovery order:

1. Confirm the correct services share the correct secret and unrelated purposes
   do not reuse it.
2. Restart every service whose `.env` changed.
3. Regenerate the affected customer or staff login token.
4. Replace only the matching web application token.
5. Restart that web application and choose Continue locally again.
6. Read the receiving service error without printing the token or secret.

## Production replacement

Local tokens are a development adapter, not the intended AWS identity system.

- Customers and staff will authenticate through Cognito or another OIDC provider.
- Browser sessions will use secure HTTP-only cookies at the Next.js BFF boundary.
- Service workloads will use IAM/workload identity where possible.
- Signing keys and provider credentials will live in AWS Secrets Manager with KMS
  protection and rotation.
- Internal assertions will use separate audiences and preferably asymmetric keys.
- The application route and verified identity interfaces can remain stable, so the
  project does not need to rewrite the business workflow for production auth.
