# Trusted Refund Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The owner-approved single Sol worker owns implementation; the coordinator owns review, integration checks and documentation. No commits or additional agents.

**Goal:** Explain policy amount bands from trusted versioned data and remove irrelevant answer boilerplate.

**Architecture:** One immutable JSON catalog supplies Node workflow rules and a Python public-policy projection. Edge signs version/hash in the agent-specific context; the answer application code renders monetary comparisons, while Temporal retains all decision authority.

**Tech Stack:** Existing Node 24 ESM, TypeScript, Python 3.12, Pydantic, jose/PyJWT, LangChain and offline test tools; no new dependency installation.

**Spec:** `docs/superpowers/specs/2026-09-14-trusted-refund-answer-design.md`

## Global Constraints

* Preserve current dev working tree, including prior answer fixes and all documentation edits.
* One Sol high worker exclusively edits implementation/tests listed below. Root edits documentation and performs final integration review. No nested agents.
* No Git mutations, paid/network model calls, service/token changes, real commerce operations or dependency upgrades.
* The model may understand, retrieve, and propose. It may not authorize or execute a refund.
* The existing monetary limits remain 10000 and 50000 USD minor units. Existing risk limits, reason codes, validity and v1/v2 photo semantics stay unchanged.
* No duplicate monetary constants in Python; no threshold sourced from RAG or request body.
* Legacy absent policy binding gives no monetary-policy authority. Explicit unknown/hash-mismatched binding is rejected.
* Historical dataset and scores are immutable. Model prose money guard and delivery/eligibility protections remain enforced.
* Review at 10 minutes / 5 allowance points; safe checkpoint at 20 minutes / 10 points. Worker reports red/green and stops after focused checks; coordinator runs combined suites once.

## Task 1: Single policy artifact and readers

Files: create `packages/refund-policy/releases.json`, `index.mjs`, `index.d.mts`, `tests/releases.test.mjs`; modify `apps/services/workflow-workers/src/refund-policy-release.ts`; create `apps/services/agent-runtime/agent_runtime/refund/policy.py` and `tests/test_refund_policy.py`.

Node imports from service src/dist use `../../../../packages/refund-policy/index.mjs` (both remain at the same depth). Node reads artifact adjacent to its ESM reader. Python accepts an explicit catalog path for deployment/testing; default resolves the repository artifact from its module location, never the process working directory. No source dependency on another deployable. No generated artifact copies in Git.

Interfaces:

```ts
type RefundPolicyBinding = Readonly<{policyVersion: string; catalogSha256: string}>;
// Preserve the existing RefundPolicyRelease fields and exports.
getRefundPolicyRelease(version: string): RefundPolicyRelease;
getRefundPolicyBinding(version: string): RefundPolicyBinding;
```

```python
class RefundPolicyBinding(BaseModel):
    policy_version: str = Field(alias="policyVersion")
    catalog_sha256: str = Field(alias="catalogSha256", pattern=r"^[a-f0-9]{64}$")

# Frozen public projection: policy_version, catalog_sha256, currency,
# automatic_maximum_minor, approval_maximum_minor.
# Verify raw catalog SHA-256 and version before returning the projection.
verify_refund_policy(binding: RefundPolicyBinding) -> VerifiedRefundPolicy
```

- [x] Write tests proving unchanged v1/v2 values, immutable Node releases, invalid/unknown releases and exact bounds. Python tests load the real artifact and reject wrong hash/version; no amount constants in production Python.
- [x] Observe failures before adding readers/artifact; distinguish import/setup failure from an expected missing-behavior assertion.
- [x] Move the exact existing values into the JSON catalog, validate integers/order/currency/required fields and freeze returned objects. Retain worker exports to avoid workflow changes.
- [x] Run Node catalog tests plus workflow policy/risk/photo-policy tests, Python policy tests and TypeScript typecheck.

## Task 2: Signed policy binding to the real answer path

Files: modify `contracts/internal-api/trusted-context-assertion/v1/context-assertion-claims.schema.json`; Edge `src/context-assertion.ts`, `src/server.ts`, corresponding context-assertion tests; Agent Runtime `integrations/trusted_context.py`, `refund/router.py`, `refund/state.py`, `refund/graph.py`, relevant trusted-context/route/graph tests; root contract tests if schema fixture coverage needs updating.

```ts
// Optional signer option, supplied only when creating the agent-audience signer.
refundPolicy?: RefundPolicyBinding;
// server.ts resolves this from config.REFUND_POLICY_VERSION;
// buildApp receives that same version for startRefundWorkflow.
```

```python
# ContextAssertionClaims accepts optional alias refundPolicy.
# VerifiedAgentRuntimeContext includes a verified projection or None.
# Router supplies projection in RefundState; graph passes it to compose.
async def compose(..., refund_policy: VerifiedRefundPolicy | None = None): ...
```

- [x] Write a Node sign/decode test for correct binding and unchanged assertions without binding. Add Python verifier tests for signed valid, bad signature/audience, missing legacy binding, unknown version and altered hash.
- [x] Add the optional canonical field, configure the agent signer from the release reader, verify it only after existing authentication checks, then pass the verified projection through the real graph.
- [x] Test that public intake cannot inject policy fields, and default/missing binding never enables amount comparisons. Preserve existing assertion TTL and other service audiences.
- [x] Run focused auth/route/graph and contract tests; do not start real services.

## Task 3: Concise, purpose-aware presentation

Files: modify Agent Runtime `refund/answer.py` and answer tests; create `refund/presentation.py` and `tests/test_refund_presentation.py` to keep the large composer focused.

```python
AnswerPurpose = Literal["refund_request", "missing_details", "amount_review", "provider_timing", "policy_question"]
class DraftCustomerAnswer(CustomerAnswer):
    purpose: AnswerPurpose = "refund_request"
# Public CustomerAnswer remains message + citations.
```

```python
# Exact branch boundaries; all money formatting uses integer minor units.
if amount_minor > policy.approval_maximum_minor:
    # explain amount above specialist-review threshold
elif amount_minor > policy.automatic_maximum_minor:
    # explain above automatic band and at/below specialist threshold
else:
    # conditional automatic approval only, after eligibility/evidence
```

- [x] Write table cases for 10000, 10001, 50000, 50001 and 75000. Assert exact/at/below/above wording, missing context/amount and non-USD safe behavior.
- [x] Add internal purpose schema, bump prompt to `refund-answer-v9`, ask for concise relevant guidance and no model-authored money. Do not send policy amounts or trusted proposed money to the model.
- [x] Validate raw model output with existing guards first. Deterministically render amount-review purpose from verified policy and complete trusted proposal scope; retain citations only for model guidance actually used. Remove proposed money footer from provider/policy/missing-details purposes; keep a short application-owned proposed amount for refund-request purpose. Preserve existing delivery qualification.
- [x] Test wrong identifiers, model-written money and personalized decisions still reject even when presentation would replace their text. Test public response shape and original rejection capture remain valid.

## Task 4: Evaluation wiring and settled verification

Files: modify Evaluation Runner `evaluation_runner/adapters/refund_rag_answer.py`, `evaluation_runner/live_rag_evaluation.py` and their tests; add focused renderer integration cases without editing pinned datasets.

```python
# Optional operator configuration; never read from dataset reference answers.
RefundRagAnswerExecutor(..., refund_policy: VerifiedRefundPolicy | None = None)
# CLI: --refund-policy-version; resolve artifact before creating provider clients.
# Result versions include policy version/catalog hash when supplied.
# Independent application facts include the public thresholds only when verified.
```

- [x] Test production composer integration with explicit verified policy and model purpose; inspect the original model input to ensure reference answers and money were not injected.
- [x] Add optional CLI configuration and reject unknown policy before provider-client creation. Preserve old invocations with no monetary-policy authority; preserve existing diagnostic dataset pins and results.
- [x] Worker runs only focused tests for its edits plus affected typechecks/lint and reports results. Root reviews the full diff and runs settled Agent Runtime, Evaluation Runner, Edge API, shared catalog, contract and focused Workflow policy suites.
- [x] Root records new/total tests and limitations in handoff, verification status and baseline follow-up. No new scores, live browser proof, deployment or commits are claimed.

## Progress

All four tasks are complete locally and remain uncommitted. Sol high owned implementation/tests; the coordinator owned independent review, integration checks and documentation. No additional worker or new scope was introduced.

Final fresh checks: Agent Runtime 195 passed; Evaluation Runner 243 passed; Edge 86 passed; workflow policy/input/risk/evidence 29 passed; root contract suites plus shared catalog 97 passed. Total: 650 tests, plus eight synthetic Node-to-Python signed-assertion compatibility vectors. Changed-file Ruff lint/format passed for 17 Python files. Edge and Workflow typechecks/builds passed, and their emitted modules resolved the shared package.

The first full Evaluation Runner check had two stale v8 expectations; Task 4 updated them to v9 and the final full suite passed. The existing Starlette/httpx deprecation warning remains. Full Temporal test-server scenarios and live model/browser/provider tests were not run.

Review also corrected inherited-property policy lookup, strict numeric catalog parsing, a zero-refund boundary, and purpose leakage in public serialization. Policy limits, historical datasets, graders and measured results remain unchanged. A future purpose-aware citation criterion needs separate owner review: v3 requires a RAG citation even for application-owned amount-only answers.

Observed shared account weekly usage moved from 43% to 45% during the batch; this is account-level usage, not exact task token accounting. No paid calls, token/service operations, refunds or Git mutations occurred. Deployment must include matching catalog bytes. Tell the owner before LangSmith; live calls/exports require separate approval.
