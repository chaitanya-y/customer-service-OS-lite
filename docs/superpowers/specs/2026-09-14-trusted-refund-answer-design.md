# Trusted policy explanations and concise refund answers

Approved in conversation on 2026-09-14. This records that approval; it does not authorize Git operations or paid trials.

## Outcome

Use the same immutable refund policy release for workflow decisions and customer-facing monetary explanations. The answer may explain an approval path before Temporal starts, but must never report an eligibility decision, actual approval, submission or settlement without authoritative workflow evidence.

## Data and trust boundary

Store the existing v1 and v2 releases, with unchanged values, in `packages/refund-policy/releases.json`. A small dependency-free Node ESM reader and Python reader consume those exact bytes. The artifact is required at deployment; retain the monorepo layout or explicitly configure the Python catalog path. Do not silently fall back to copied thresholds if it is absent.

Edge resolves its configured policy version and signs an optional `refundPolicy` claim containing `policyVersion` and the SHA-256 of the catalog bytes. The same configured version starts Temporal. Only the Agent Runtime assertion gets this claim; other audiences and signing lifetimes remain unchanged. Add the optional field to the existing canonical context schema. Existing assertions without the field remain accepted for compatibility but provide no authority to quote policy amounts.

Agent Runtime verifies the normal signature, audience, tenant and expiry, then resolves the signed version against its local catalog and compares the catalog hash. Unknown versions and hash mismatches fail closed. The resulting immutable public projection contains only version, catalog hash, USD currency and the two monetary limits; never expose risk configuration to the model or customer. No threshold/version is accepted from the public intake body or customer text.

## Answer responsibilities

The model's structured output gets an internal presentation purpose: `refund_request`, `missing_details`, `amount_review`, `provider_timing`, or `policy_question`. Defaulting absent purpose to `refund_request` preserves older test adapters. This field is not authorization and is not added to the public CustomerAnswer contract.

The existing model call selects purpose; there is no extra model call. The prompt advances to v9 and asks for concise, relevant guidance without boilerplate. Monetary expressions in model prose remain prohibited. Model-generated citations, identifiers, money and eligibility/window wording still pass the existing guards before rendering.

For `amount_review`, application code owns the entire amount/threshold comparison, using the verified projection and trusted proposal amount. It requires a resolved request amount and scope, supports USD only, and never guesses when context is missing. Return a short neutral policy-check message if the projection or reliable amount is unavailable. Do not attribute application-owned policy amounts to an unrelated RAG citation; these are independent application facts in evaluation.

Examples with the existing release:

* $750: Your requested refund of $750 exceeds our $500 threshold, so it requires specialist review before it can be approved.
* $125: Your $125 request is below $500 but above the $100 automatic-approval limit, so it requires human approval.
* Exactly $500: requires human approval, not the above-$500 takeover band.
* Up to $100: explain that automatic approval is possible only after eligibility and evidence checks; do not say it is approved.

For provider timing and general policy questions, keep cited relevant guidance without the proposed-amount footer. Missing-details answers ask for missing details without an amount footer. A refund-request answer retains application-owned proposed money but uses a concise label rather than a repeated not-approved disclaimer. Existing delivery-age qualifications remain; shortening them is not part of this change. Provider timing remains conditional when submission is not verified.

## Evaluation and preservation

Use the production renderer in the evaluation adapter. An optional operator-selected policy version resolves the same artifact; report the selected version/hash and independent policy limits as application facts, not reference-answer input. Preserve every existing dataset, reference, diagnostic pin and historical result. Changing prompt/runtime behavior does not rewrite the v3 baseline or prove better live scores.

Tests cover exact monetary boundaries, tampered/missing/unknown bindings, other-audience assertions unchanged, source/amount isolation from the model, concise purposes, retained guards and both language readers. No live model calls, service restarts, token renewal, refunds, dependency upgrades or Git actions.
