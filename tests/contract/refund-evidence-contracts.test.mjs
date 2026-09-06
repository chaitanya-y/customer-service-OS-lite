import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../../", import.meta.url);
const readJson = async (file) => JSON.parse(await readFile(new URL(file, root), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const summarySchema = await readJson("contracts/customer-api/refund-evidence/v1/refund-evidence-summary.schema.json");
const reviewSchema = await readJson("contracts/human-api/refund-evidence/v1/refund-evidence-review-command.schema.json");
const validateSummary = ajv.compile(summarySchema);
const validateReview = ajv.compile(reviewSchema);
const summary = await readJson("tests/contract/fixtures/refund-evidence-summary/valid.json");
const review = await readJson("tests/contract/fixtures/refund-evidence-review-command/valid.json");

function expectValid(validate, value) {
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}
function expectInvalid(validate, value) {
  assert.equal(validate(value), false);
  assert.ok(validate.errors?.length);
}
function processingSummary() {
  const result = structuredClone(summary);
  result.assessment = "UNREVIEWED";
  result.can_upload = true;
  result.attachments[0].technical_status = "PROCESSING";
  delete result.attachments[0].width;
  delete result.attachments[0].height;
  return result;
}

test("photo summary accepts no requirement only as an empty upload-disabled snapshot", () => {
  const value = { version: "v1", requirement: "NONE", evidence_version: 0, assessment: "UNREVIEWED", can_upload: false, attachments: [] };
  expectValid(validateSummary, value);
  expectInvalid(validateSummary, { ...value, can_upload: true });
  expectInvalid(validateSummary, { ...value, attachments: summary.attachments });
  expectInvalid(validateSummary, { ...value, assessment: "ACCEPTED" });
});

test("photo summary represents empty intake, processing, technical rejection, and more required separately", () => {
  expectValid(validateSummary, { ...summary, evidence_version: 0, assessment: "UNREVIEWED", can_upload: true, attachments: [] });
  const processing = processingSummary();
  expectValid(validateSummary, processing);
  const rejected = structuredClone(processing);
  rejected.attachments[0].technical_status = "REJECTED";
  rejected.attachments[0].rejection_code = "INVALID_IMAGE";
  expectValid(validateSummary, rejected);
  expectValid(validateSummary, { ...summary, assessment: "MORE_REQUIRED", can_upload: true, customer_message_code: "PHOTO_UNCLEAR" });
});

for (const status of ["PROCESSING", "REJECTED"]) {
  test(`accepted photo set rejects technically ${status} files`, () => {
    const value = processingSummary();
    value.assessment = "ACCEPTED";
    value.can_upload = false;
    value.attachments[0].technical_status = status;
    if (status === "REJECTED") value.attachments[0].rejection_code = "INVALID_IMAGE";
    expectInvalid(validateSummary, value);
  });
}

for (const [name, mutate] of [
  ["empty accepted set", v => { v.attachments = []; }],
  ["accepted set still accepting uploads", v => { v.can_upload = true; }],
  ["zero accepted revision", v => { v.evidence_version = 0; }],
  ["negative revision", v => { v.evidence_version = -1; }],
  ["fractional revision", v => { v.evidence_version = 1.5; }],
  ["unsafe integer revision", v => { v.evidence_version = Number.MAX_SAFE_INTEGER + 1; }],
  ["unknown requirement", v => { v.requirement = "DELIVERY_PROOF"; }],
  ["unknown assessment", v => { v.assessment = "APPROVED"; }],
  ["missing customer follow-up code", v => { v.assessment = "MORE_REQUIRED"; }],
  ["follow-up code on accepted evidence", v => { v.customer_message_code = "PHOTO_UNCLEAR"; }],
  ["unbounded customer message", v => { v.assessment = "MORE_REQUIRED"; v.customer_message_code = "Please upload to https://example.invalid"; }],
  ["unsupported wire version", v => { v.version = "v2"; }],
  ["missing required field", v => { delete v.can_upload; }],
]) {
  test(`photo summary rejects ${name}`, () => {
    const value = structuredClone(summary);
    mutate(value);
    expectInvalid(validateSummary, value);
  });
}

for (const field of ["note", "staff_id", "allowed_evidence_actions", "storage_url", "storage_key", "customer_id", "reviewed_evidence_version"]) {
  test(`customer photo summary rejects private or ambiguous field ${field}`, () => {
    expectInvalid(validateSummary, { ...summary, [field]: "synthetic-private-value" });
  });
}
for (const field of ["original_filename", "storage_url", "content_url", "storage_key", "note", "exif", "customer_id"]) {
  test(`photo metadata rejects non-public field ${field}`, () => {
    const value = structuredClone(summary);
    value.attachments[0][field] = "synthetic-private-value";
    expectInvalid(validateSummary, value);
  });
}

for (const [name, mutate] of [
  ["unsupported media", p => { p.content_type = "image/svg+xml"; }],
  ["original filename as label", p => { p.display_label = "private-customer-photo.jpg"; }],
  ["URL as attachment identity", p => { p.evidence_id = "https://example.invalid/photo"; }],
  ["invalid timestamp", p => { p.uploaded_at = "yesterday"; }],
  ["missing validated dimensions", p => { delete p.width; }],
  ["zero width", p => { p.width = 0; }],
  ["negative bytes", p => { p.byte_size = -1; }],
  ["empty ready image", p => { p.byte_size = 0; }],
  ["fractional bytes", p => { p.byte_size = 1.5; }],
  ["rejection details on ready photo", p => { p.rejection_code = "INVALID_IMAGE"; }],
  ["unknown technical state", p => { p.technical_status = "ACCEPTED"; }],
]) {
  test(`photo metadata rejects ${name}`, () => {
    const value = structuredClone(summary);
    mutate(value.attachments[0]);
    expectInvalid(validateSummary, value);
  });
}

test("rejected photos require bounded error codes and processing photos cannot claim dimensions", () => {
  const value = processingSummary();
  value.attachments[0].width = 100;
  expectInvalid(validateSummary, value);
  delete value.attachments[0].width;
  value.attachments[0].technical_status = "REJECTED";
  expectInvalid(validateSummary, value);
  value.attachments[0].rejection_code = "Decoder path /private/example";
  expectInvalid(validateSummary, value);
});

test("v1 transport allows five distinct photos but not six or identical duplicates", () => {
  const value = structuredClone(summary);
  value.attachments = Array.from({ length: 5 }, (_, index) => ({
    ...summary.attachments[0],
    evidence_id: `00000000-0000-4000-8000-00000000000${index}`,
    display_label: `Photo ${index + 1}`,
  }));
  expectValid(validateSummary, value);
  value.attachments.push({ ...value.attachments[0], evidence_id: "00000000-0000-4000-8000-000000000006" });
  expectInvalid(validateSummary, value);
  value.attachments = [summary.attachments[0], structuredClone(summary.attachments[0])];
  expectInvalid(validateSummary, value);
});

test("staff review permits bounded request-more reasons separately from evidence acceptance", () => {
  for (const reason_code of ["PHOTO_UNCLEAR", "DAMAGED_ITEM_NOT_VISIBLE", "ORDER_ITEM_NOT_IDENTIFIABLE"]) {
    expectValid(validateReview, { ...review, action: "REQUEST_MORE_EVIDENCE", reason_code, note: "Synthetic internal rationale" });
    expectInvalid(validateReview, { ...review, reason_code });
  }
  expectInvalid(validateReview, { ...review, action: "REQUEST_MORE_EVIDENCE" });
});

for (const [name, changes] of [
  ["money approval", { action: "APPROVE" }],
  ["exceptional approval", { action: "APPROVE_EXCEPTIONAL_REFUND" }],
  ["forged staff identity", { decided_by: "someone" }],
  ["forged timestamp", { decided_at: "2026-09-05T15:00:00Z" }],
  ["customer-facing note", { customer_note: "Private content" }],
  ["storage URL", { storage_url: "https://example.invalid/photo" }],
  ["client case binding", { case_id: "other-case" }],
  ["client assessment override", { assessment: "ACCEPTED" }],
  ["unknown reason", { reason_code: "ALL_GOOD" }],
  ["empty note", { note: "" }],
  ["blank note", { note: " \n\t" }],
  ["oversized note", { note: "x".repeat(2001) }],
]) {
  test(`staff evidence command rejects ${name}`, () => expectInvalid(validateReview, { ...review, ...changes }));
}
for (const field of ["expected_case_version", "expected_evidence_version"]) {
  test(`staff evidence command requires a positive safe integer ${field}`, () => {
    for (const invalid of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      expectInvalid(validateReview, { ...review, [field]: invalid });
    }
    const missing = { ...review };
    delete missing[field];
    expectInvalid(validateReview, missing);
  });
}

test("contract documents runtime checks; a structurally valid revision is not proof it is current", () => {
  expectValid(validateReview, { ...review, expected_case_version: 99, expected_evidence_version: 88 });
  assert.match(reviewSchema.description, /compare BOTH expected versions atomically/);
  assert.match(reviewSchema.description, /not live authorization or revision invariants/);
  assert.match(summarySchema.description, /enforce unique attachment IDs/);
  assert.match(summarySchema.description, /validate actual bytes/);
  // JSON Schema uniqueItems compares complete objects, not one object's ID.
  // Services must reject repeated IDs even if other fields differ.
  const value = structuredClone(summary);
  value.attachments.push({ ...value.attachments[0], display_label: "Photo 2" });
  expectValid(validateSummary, value);
});
