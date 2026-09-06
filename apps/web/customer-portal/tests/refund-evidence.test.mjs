import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { normalizeRefundEvidence, evidenceStatusMessage, hasReviewableEvidence, validateEvidenceFile, evidenceRequestError, MAX_EVIDENCE_UPLOAD_BYTES } from "@cso/ui/refund-evidence-model";
import { normalizeRefundJourney, getRefundReviewDeadline } from "../components/customer-api.ts";
import { EvidenceUploadError, evidenceUploadHeaders, readEvidenceUpload } from "../lib/evidence-upload.ts";

const accepted = JSON.parse(await readFile(new URL("../../../../tests/contract/fixtures/refund-evidence-summary/valid.json", import.meta.url), "utf8"));
const ready = { ...accepted, assessment: "UNREVIEWED", can_upload: true };
const empty = { ...ready, evidence_version: 0, attachments: [] };

test("canonical accepted photos stay distinct from refund approval and freeze uploads", () => {
  const evidence = normalizeRefundEvidence(accepted);
  assert.equal(evidence.assessment, "ACCEPTED");
  assert.equal(evidence.canUpload, false);
  assert.equal(hasReviewableEvidence(evidence), false);
  assert.match(evidenceStatusMessage(evidence), /does not approve a refund/);
});

test("projects only public metadata and never internal locators, notes, or filenames", () => {
  const input = structuredClone(ready);
  input.note = "INTERNAL NOTE";
  input.attachments[0].storage_key = "private/raw";
  input.attachments[0].url = "https://private.example/photo";
  input.attachments[0].original_filename = "private-name.png";
  const output = JSON.stringify(normalizeRefundEvidence(input));
  for (const value of ["INTERNAL NOTE", "private/raw", "private.example", "private-name"]) assert.ok(!output.includes(value));
});

test("malformed summaries fail closed instead of showing upload or review controls", () => {
  for (const input of [undefined, {}, { ...ready, version: "v2" }, { ...ready, evidence_version: -1 },
    { ...ready, evidence_version: Number.MAX_SAFE_INTEGER + 1 }, { ...ready, assessment: "AUTO_APPROVED" },
    { ...accepted, can_upload: true }, { ...ready, attachments: [...ready.attachments, ...ready.attachments] },
    { ...ready, attachments: [{ ...ready.attachments[0], display_label: "secret filename" }] },
    { ...ready, attachments: [{ ...ready.attachments[0], width: 0 }] },
    { ...ready, attachments: [{ ...ready.attachments[0], content_type: "image/svg+xml" }] },
    { ...ready, requirement: "NONE" }, { ...empty, assessment: "MORE_REQUIRED", customer_message_code: "PHOTO_UNCLEAR" },
  ]) assert.equal(normalizeRefundEvidence(input), undefined);
});

test("processing blocks specialist review while ready photos do not imply acceptance", () => {
  const evidence = normalizeRefundEvidence(ready);
  assert.equal(hasReviewableEvidence(evidence), true);
  assert.equal(evidence.assessment, "UNREVIEWED");
  const processing = { ...ready.attachments[0], evidence_id: "61ba70a1-668f-40da-b4d4-572db8372cbd", display_label: "Photo 2", technical_status: "PROCESSING" };
  delete processing.width; delete processing.height;
  const pending = normalizeRefundEvidence({ ...ready, attachments: [...ready.attachments, processing] });
  assert.equal(hasReviewableEvidence(pending), false);
  assert.match(evidenceStatusMessage(pending), /checking your photo files/);
});

test("request-more guidance is bounded public copy; rejected files are not ready", () => {
  const more = normalizeRefundEvidence({ ...ready, assessment: "MORE_REQUIRED", customer_message_code: "PHOTO_UNCLEAR" });
  assert.match(evidenceStatusMessage(more), /clearer, well-lit photo/);
  assert.equal(normalizeRefundEvidence({ ...ready, assessment: "MORE_REQUIRED", customer_message_code: "INTERNAL_FACT" }), undefined);
  const rejected = { ...ready.attachments[0], technical_status: "REJECTED", rejection_code: "INVALID_IMAGE" };
  delete rejected.width; delete rejected.height;
  assert.equal(hasReviewableEvidence(normalizeRefundEvidence({ ...ready, attachments: [rejected] })), false);
});

test("evidence wait states normalize without confirmation or review deadline", () => {
  for (const [stage, action, next] of [
    ["AWAITING_CUSTOMER_EVIDENCE", "PROVIDE_EVIDENCE", "PROVIDE_EVIDENCE"],
    ["AWAITING_EVIDENCE_REVIEW", "WAIT_FOR_SPECIALIST", "WAIT"],
    ["EVIDENCE_COLLECTION_EXPIRED", "NONE", "NONE"],
  ]) {
    const journey = normalizeRefundJourney("workflow-test", { version: "v1", stage, next_action: { type: action }, evidence: stage === "EVIDENCE_COLLECTION_EXPIRED" ? { ...ready, can_upload: false } : ready, timeline: [] });
    assert.equal(journey.nextAction, next);
    assert.equal(journey.preview, undefined);
    assert.equal(getRefundReviewDeadline(journey), undefined);
    assert.ok(journey.evidence);
    if (stage === "EVIDENCE_COLLECTION_EXPIRED") { assert.equal(journey.evidence.canUpload, false); assert.match(journey.statusDetail, /contact support/); }
  }
});

test("client file validation bounds type and size before sending", () => {
  assert.equal(validateEvidenceFile({ type: "image/jpeg", size: MAX_EVIDENCE_UPLOAD_BYTES }), undefined);
  assert.match(validateEvidenceFile({ type: "image/svg+xml", size: 12 }), /JPEG or PNG/);
  assert.match(validateEvidenceFile({ type: "image/png", size: 0 }), /empty/);
  assert.match(validateEvidenceFile({ type: "image/png", size: MAX_EVIDENCE_UPLOAD_BYTES + 1 }), /10 MB/);
});

test("expired collection fails closed if a stale response still advertises upload or confirmation", () => {
  const journey = normalizeRefundJourney("workflow-test", { version: "v1", stage: "EVIDENCE_COLLECTION_EXPIRED", next_action: { type: "CONFIRM_REFUND" }, evidence: ready,
    preview: { preview_id: "preview-test", amount: { amount_minor: 5309, currency: "USD" }, refund_destination: "ORIGINAL_PAYMENT_METHOD", valid_until: "2026-09-06T00:00:00Z" } });
  assert.equal(journey.nextAction, "NONE");
  assert.equal(journey.evidence.canUpload, false);
  assert.equal(getRefundReviewDeadline(journey), undefined);
  assert.equal(journey.preview.amount.amountMinor, 5309);
});

function uploadHeaders(overrides = {}) {
  return new Headers({ "content-type": "image/png", "idempotency-key": "opaque-upload-test", "x-cso-expected-evidence-version": "0", ...overrides });
}

test("BFF forwards exact upload retry key and evidence revision", () => {
  assert.deepEqual(evidenceUploadHeaders(uploadHeaders()), { contentType: "image/png", idempotencyKey: "opaque-upload-test", version: "0" });
  assert.throws(() => evidenceUploadHeaders(uploadHeaders({ "content-type": "image/svg+xml" })), { status: 415 });
  for (const version of ["-1", "01", "1.5", "9007199254740992", ""]) assert.throws(() => evidenceUploadHeaders(uploadHeaders({ "x-cso-expected-evidence-version": version })), { status: 400 });
  assert.throws(() => evidenceUploadHeaders(uploadHeaders({ "idempotency-key": " " })), { status: 400 });
  assert.throws(() => evidenceUploadHeaders(uploadHeaders({ "content-length": String(MAX_EVIDENCE_UPLOAD_BYTES + 1) })), { status: 413 });
});

test("BFF preserves raw bytes and rejects empty bodies", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  assert.deepEqual(new Uint8Array(await readEvidenceUpload(new Blob([bytes]).stream())), bytes);
  await assert.rejects(readEvidenceUpload(null), error => error instanceof EvidenceUploadError && error.status === 400);
  await assert.rejects(readEvidenceUpload(new Blob([]).stream()), { status: 400 });
});

test("BFF cancels oversized streams without trusting Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_EVIDENCE_UPLOAD_BYTES)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readEvidenceUpload(stream), { status: 413 });
  assert.equal(cancelled, true);
});

test("safe errors distinguish session, stale state, frozen evidence, and upload limits", () => {
  assert.match(evidenceRequestError(401), /sign in/);
  assert.match(evidenceRequestError(409, "stale_evidence_version"), /changed/);
  assert.match(evidenceRequestError(409, "evidence_frozen"), /already been reviewed/);
  assert.match(evidenceRequestError(409, "evidence_limit_exceeded"), /photo limit/);
});

test("closed upload capability never asks the customer to add unavailable photos", () => {
  assert.equal(evidenceStatusMessage(normalizeRefundEvidence({ ...empty, can_upload: false })), "No reviewable photos are available for this request.");
  const closedMore = normalizeRefundEvidence({ ...ready, can_upload: false, assessment: "MORE_REQUIRED", customer_message_code: "PHOTO_UNCLEAR" });
  assert.match(evidenceStatusMessage(closedMore), /uploads are no longer available/);
});
