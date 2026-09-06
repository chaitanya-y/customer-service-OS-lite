# Refund photo evidence

This is the local photo evidence slice, added on 2026-09-05. It does not implement
automatic damage detection, delivery age eligibility, antivirus scanning, S3
storage, or production identity. Uploaded photos are not sent to the LLM or RAG.

## The rule

New requests pinned to `refund-policy-v2` with reason `DAMAGED` require accepted
photo evidence. Existing `refund-policy-v1` workflows keep their original rules.
An image being technically valid does not mean that damage has been accepted.
Accepting damage evidence does not approve a refund.

```text
Customer uploads photos on the refund page
  -> Edge verifies the customer and workflow owner
  -> Human Operations validates and privately stores normalized images
  -> Assigned staff review the exact evidence revision
  -> Temporal reads the authoritative accepted revision
  -> Fresh commerce facts and the pinned policy are evaluated again
  -> Monetary approval or takeover if required
  -> Exact customer preview and confirmation
  -> Fresh photo and commerce checks before any refund execution
```

## Example

A customer requests USD 750.00 for a damaged item. The model produces a proposal,
but policy returns `NEEDS_FACTS` with `missingFacts: ["DAMAGE_PHOTO"]`.
The refund waits in `AWAITING_CUSTOMER_EVIDENCE`; no refund preview is offered.

The customer selects a PNG and explicitly uploads it. The response includes a
public summary similar to this, not a public storage URL:

```json
{
  "version": "v1",
  "requirement": "DAMAGE_PHOTO",
  "evidence_version": 2,
  "assessment": "UNREVIEWED",
  "can_upload": true,
  "attachments": [{
    "evidence_id": "2a85b731-803b-4321-9917-d184113b4c25",
    "display_label": "Photo 1",
    "content_type": "image/png",
    "byte_size": 2048,
    "uploaded_at": "2026-09-05T15:00:00Z",
    "technical_status": "READY",
    "width": 640,
    "height": 480
  }]
}
```

`READY` means the image passed decoding and normalization. Staff must claim the
case, view the images, then submit `ACCEPT_EVIDENCE` or
`REQUEST_MORE_EVIDENCE` with the exact case and evidence versions. A stale page
cannot accept a newly changed set. A retry uses the same idempotency key so it
does not create another upload or decision.

If staff request clearer photos, the reviewed set is superseded, not deleted.
Its IDs and reviewed revision remain in the audit. The customer gets a fresh
current set, even if all five slots were previously used. Only the fresh set can
be accepted; the original 20-attempt collection limit still applies.

After acceptance, Temporal includes the assessment ID and accepted manifest hash
in policy fact references. USD 750.00 still exceeds the USD 500.00 threshold, so
the same case becomes a monetary takeover case. Its previous assignment is
cleared. A supervisor must claim it and explicitly approve an exceptional plan.
Only then can the customer review and confirm the exact amount. Photo acceptance
does not perform any of these money decisions.

## Read the code in this order

| File | Main responsibility |
|---|---|
| `contracts/customer-api/refund-evidence/v1/refund-evidence-summary.schema.json` | Public photo status, never storage paths or staff notes |
| `contracts/human-api/refund-evidence/v1/refund-evidence-review-command.schema.json` | Review action bound to exact case and evidence versions |
| `apps/services/edge-api/src/refund-evidence-routes.ts` | Authenticate owner before reading upload bytes; proxy private content |
| `apps/services/human-operations/src/private-evidence-store.ts` | `validatePhoto()` decodes/re-encodes images and strips metadata; private files have restrictive permissions |
| `apps/services/human-operations/src/postgres-refund-evidence-repository.ts` | Transactional upload reservation, validation result, review, revision locks, audit and case transition |
| `apps/services/human-operations/src/refund-evidence-routes.ts` | Customer, staff and Worker endpoints with separate authorization |
| `apps/services/workflow-workers/src/refund-evidence-client.ts` | `parseEvidenceSnapshot()` verifies order, proposal, selection, policy and accepted revision |
| `apps/services/workflow-workers/src/refund-policy.ts` | v2 evidence gate, without changing monetary thresholds |
| `apps/services/workflow-workers/src/refund-workflow.ts` | Durable wait, re-evaluation, case reuse and execution guard |
| `apps/web/customer-portal/components/refund-evidence.tsx` | Explicit upload and private image display |
| `apps/web/operations-console/components/refund-evidence-review.tsx` | Evidence review separate from monetary decisions |
| `packages/ui/src/refund-evidence-model.ts` | Shared safe display model for both interfaces |

## Local setup

Apply Human Operations migrations with its existing local migration credentials:

```bash
cd apps/services/human-operations
pnpm migrate
```

Configure these ignored Human Operations `.env` settings together:

```dotenv
REFUND_EVIDENCE_STORAGE_DIR="/absolute/private/path/outside/the/repository"
CONTEXT_ASSERTION_HMAC_SECRET=<same existing context secret as Edge>
CONTEXT_ASSERTION_ISSUER=customer-service-os-edge
```

The storage directory must be private (mode `0700`) and outside the checkout.
Only normalized JPEG/PNG files are kept, with mode `0600`. Do not put this path
under a public web root or commit its contents. For new local refund requests,
set `REFUND_POLICY_VERSION=refund-policy-v2` in Edge and restart Edge, Human
Operations and Workflow Workers after the code and migration are installed.

There is no third manually copied login token. Customer and staff login tokens
remain the two local 48-hour tokens. Edge automatically signs a 60-second
`cso-evidence+jwt` assertion for audience `human-operations-evidence`, using its
existing context secret. Workflow Workers use the separate existing Human
Operations workflow secret and narrow evidence purposes. Never put either
assertion in a browser, model prompt, or log.

## Limits and recovery

1. JPEG/PNG only, maximum 10 MiB per upload, 20 million decoded pixels, and
   8192 pixels per dimension. At most five current photos, 25 MiB for the current
   set, and 20 upload attempts per collection.
2. The collection has a 24-hour deadline. Temporal polls every 30 seconds and
   continues into a new run after 120 polls while retaining the original
   deadline. This bounds workflow history without resetting the deadline.
3. Expiry closes only the evidence review. It does not approve or execute money.
4. Accepted revisions are frozen. Missing or corrupt stored image bytes fail
   closed at the Worker read boundary before an action can proceed.
5. Stale `PROCESSING` uploads are recoverable as technical rejections; they are
   not treated as valid evidence after a process crash.
6. Retention deletion is implemented for explicit operator use but is **not
   scheduled**. No real photos were deleted during this change. A retention
   policy and authorization are required before enabling automatic deletion.
7. Image normalization is not antivirus scanning. Production needs a storage,
   scanning, retention, identity and operational rollout review.

## Repeatable local integration check

From the repository root, with the local stack and both signing boundaries
configured:

```bash
node tools/testing/refund-evidence-smoke.mjs --check
node tools/testing/refund-evidence-smoke.mjs --run --hold-seconds=60
```

The first command makes no network calls. The second explicitly creates synthetic
Temporal workflows, a synthetic Human Operations case, and two tiny generated
PNGs. It uses real Edge/Human Operations HTTP clients and the real policy/activity
factory; only commerce facts are simulated. Model and provider calls are forbidden.
It checks customer ownership, retry-safe upload, private content, request-more,
replacement acceptance, same-case takeover, fresh facts and safe rejection.

`READY` prints customer/staff URLs for a read-only browser inspection window.
Do not claim, upload or decide manually while this automated check owns the case.
The script rejects the synthetic takeover and verifies zero refund execution or
confirmation signals. Synthetic case/audit/files remain; there is no destructive
cleanup. Completed workflow queries require its unique worker queue to be served.
Use Node 22.21.0 if the local Temporal Worker fails to initialize on Node 24, as
documented in the runbook. Normal application tooling remains Node 24.

## Photo-gated browser-to-provider proof on 2026-09-06

The earlier September 5 positive Vendure proof predates the evidence gate. A
separate September 6 local browser run completed the photo-gated path for order
`AUUYAWRHBVGJPK5R` (Vendure order `2`): two Laptop 13 inch 8GB units, full order
USD `3,122.60`. Workflow `refund-19928c34-afd6-4e0a-b709-29d8ca36381a` used Human
Operations case `case-8307800e-a61c-4295-bfad-d118931137b7` throughout.

The first photo passed technical validation, staff requested a clearer photo,
and the replacement was accepted at the exact evidence revision. The same case
then changed to monetary takeover; a supervisor approved the exceptional plan
and the customer confirmed preview `724a34e6-f044-448e-817d-a17d02fa7dac`. Gateway
created exactly one Vendure refund, `5`, initially `Pending`. Separate
owner-authorized settlement changed that existing refund to `Settled` without
creating a second refund. Temporal reached `REFUND_SUCCEEDED`; the customer
projection reached `REFUND_COMPLETED` with no action. Do not reuse this refunded
order for another positive execution test.

This proves the local photo-gated browser-to-Vendure path, not a real payment
provider webhook or bank settlement. The successful browser run still generated
an unsupported request for the delivery date. The subsequent fix makes
`SYSTEM_PROMPT` forbid delivery-date questions and delivery-age windows; runtime
defense-in-depth rejects either wording so the existing graph safely falls back.
The full Agent Runtime suite passed 101 tests with the same one upstream warning.
A fresh paid live browser recheck has not been run. Trusted delivery-age
eligibility remains unimplemented. The synthetic integration check above remains
a separate zero-refund-execution proof.

See [Verification Status](VERIFICATION_STATUS.md) for completed checks and
[the local runbook](LOCAL_REFUND_RUNBOOK.md) for the full stack. Production auth,
AWS storage and scanning, authorized retention deletion, and OpenTelemetry /
observability remain follow-up work.
