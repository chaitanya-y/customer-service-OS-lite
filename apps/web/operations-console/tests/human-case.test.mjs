import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildEvidenceReviewCommand, caseTypeLabel, normalizeAuditEvents, normalizeHumanCase } from "../components/human-case.ts";

const fixture = JSON.parse(await readFile(new URL("../../../../tests/contract/fixtures/refund-evidence-summary/valid.json", import.meta.url), "utf8"));
const evidence = { ...fixture, assessment: "UNREVIEWED", can_upload: true };
const wireCase = { case_id: "case-display-test", workflow_id: "workflow-display-test", case_type: "REFUND_EVIDENCE_REVIEW", case_version: 3, created_at: "2026-09-05T15:00:00Z", updated_at: "2026-09-05T15:00:00Z", assigned_staff_id: "staff-test", status: "CLAIMED", can_claim: false, allowed_actions: [], allowed_evidence_actions: ["ACCEPT_EVIDENCE", "REQUEST_MORE_EVIDENCE"], evidence, review_packet: { requested_amount: { amount_minor: 5309, currency: "USD" } } };

test("evidence cases retain amount but never expose refund actions", () => {
  const normalized = normalizeHumanCase({ ...wireCase, allowed_actions: ["APPROVE", "REJECT"] });
  assert.equal(caseTypeLabel(normalized.caseType), "Damage evidence review");
  assert.deepEqual(normalized.allowedActions, []);
  assert.deepEqual(normalized.allowedEvidenceActions, ["ACCEPT_EVIDENCE", "REQUEST_MORE_EVIDENCE"]);
  assert.deepEqual(normalized.reviewPacket.requestedAmount, { amountMinor: 5309, currency: "USD" });
});

test("evidence review controls require authoritative capability, a claim, and reviewable photos", () => {
  for (const changes of [{ allowed_evidence_actions: [] }, { status: "OPEN" }, { status: "CLOSED" }, { assigned_staff_id: undefined }, { evidence: undefined }, { evidence: fixture }, { evidence: { ...evidence, evidence_version: 0, attachments: [] } }, { case_type: "REFUND_APPROVAL" }]) {
    assert.deepEqual(normalizeHumanCase({ ...wireCase, ...changes }).allowedEvidenceActions, []);
  }
  assert.deepEqual(normalizeHumanCase({ ...wireCase, allowed_evidence_actions: ["AUTO_APPROVE", "ACCEPT_EVIDENCE"] }).allowedEvidenceActions, ["ACCEPT_EVIDENCE"]);
});

test("review commands bind exact revisions and cannot approve money", () => {
  const result = buildEvidenceReviewCommand(normalizeHumanCase(wireCase), "ACCEPT_EVIDENCE", "DAMAGE_VISIBLE", "  Damage is visible.  ");
  assert.deepEqual(result, { version: "v1", action: "ACCEPT_EVIDENCE", expected_case_version: 3, expected_evidence_version: 2, reason_code: "DAMAGE_VISIBLE", note: "Damage is visible." });
  assert.ok(!("decision" in result));
  assert.ok(!("amount" in result));
});

test("request-more reasons and internal note are validated", () => {
  const normalized = normalizeHumanCase(wireCase);
  assert.deepEqual(buildEvidenceReviewCommand(normalized, "REQUEST_MORE_EVIDENCE", "PHOTO_UNCLEAR", " "), { version: "v1", action: "REQUEST_MORE_EVIDENCE", expected_case_version: 3, expected_evidence_version: 2, reason_code: "PHOTO_UNCLEAR" });
  assert.throws(() => buildEvidenceReviewCommand(normalized, "ACCEPT_EVIDENCE", "PHOTO_UNCLEAR", ""));
  assert.throws(() => buildEvidenceReviewCommand(normalized, "REQUEST_MORE_EVIDENCE", "DAMAGE_VISIBLE", ""));
  assert.throws(() => buildEvidenceReviewCommand(normalized, "ACCEPT_EVIDENCE", "DAMAGE_VISIBLE", "a".repeat(2001)));
  assert.throws(() => buildEvidenceReviewCommand({ ...normalized, allowedEvidenceActions: [] }, "ACCEPT_EVIDENCE", "DAMAGE_VISIBLE", ""));
});

test("processing photos block review even if an upstream capability is stale", () => {
  const attachment = { ...evidence.attachments[0], technical_status: "PROCESSING" };
  delete attachment.width; delete attachment.height;
  assert.deepEqual(normalizeHumanCase({ ...wireCase, evidence: { ...evidence, attachments: [attachment] } }).allowedEvidenceActions, []);
});

test("existing approval and takeover actions remain available", () => {
  assert.deepEqual(normalizeHumanCase({ ...wireCase, case_type: "REFUND_APPROVAL", allowed_actions: ["APPROVE", "REJECT"] }).allowedActions, ["APPROVE", "REJECT"]);
  assert.deepEqual(normalizeHumanCase({ ...wireCase, case_type: "REFUND_TAKEOVER", allowed_actions: ["RESOLVE_TAKEOVER", "APPROVE_EXCEPTIONAL_REFUND"] }).allowedActions, ["RESOLVE_TAKEOVER", "APPROVE_EXCEPTIONAL_REFUND"]);
});

test("staff audit maps occurred_at and details.note without exposing arbitrary details", () => {
  assert.deepEqual(normalizeAuditEvents({ audit_events: [{ actor_id: "staff-test", occurred_at: "2026-09-05T16:00:00Z", event_type: "EVIDENCE_REVIEW_RECORDED", details: { note: "Reviewed damage.", storage_key: "never-render-this" } }] }), [{ actorId: "staff-test", createdAt: "2026-09-05T16:00:00Z", eventType: "EVIDENCE_REVIEW_RECORDED", note: "Reviewed damage." }]);
  assert.deepEqual(normalizeAuditEvents({ audit_events: [{ created_at: "legacy-time", note: "legacy note" }] }), [{ createdAt: "legacy-time", note: "legacy note" }]);
});
