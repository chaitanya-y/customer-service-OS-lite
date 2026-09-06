import assert from "node:assert/strict";
import { test } from "node:test";

import * as customerApi from "../components/customer-api.ts";

const deadline = "2026-09-10T12:00:00.000Z";

function createJourney(stage = "REFUND_PREVIEW_READY", action = "CONFIRM_REFUND") {
  return customerApi.normalizeRefundJourney("refund-display-test", {
    version: "v1",
    stage,
    preview: {
      preview_id: "preview-display-test",
      amount: { amount_minor: 5_309, currency: "USD" },
      refund_destination: "ORIGINAL_PAYMENT_METHOD",
      valid_until: deadline,
    },
    next_action: { type: action, label: "" },
    timeline: [],
  });
}

test("formats canonical refund destinations as customer-readable labels", () => {
  for (const [destination, label] of [
    ["ORIGINAL_PAYMENT_METHOD", "Original payment method"],
    ["STORE_CREDIT", "Store credit"],
    ["OTHER", "Other refund destination"],
  ]) {
    assert.equal(customerApi.formatRefundDestination(destination), label);
  }
});

test("preserves known customer-readable destination labels", () => {
  for (const label of ["Original payment method", "Store credit", "Other refund destination"]) {
    assert.equal(customerApi.formatRefundDestination(label), label);
  }
});

test("uses neutral copy without echoing unknown destination values", () => {
  for (const destination of ["FUTURE_PROVIDER_ROUTE", "Unexpected provider text", "constructor", "__proto__", ""]) {
    assert.equal(customerApi.formatRefundDestination(destination), "the designated refund destination");
  }
});

test("keeps the exact review deadline while confirmation is pending", () => {
  const journey = createJourney();

  assert.equal(journey.nextAction, "CONFIRM_OR_DECLINE");
  assert.equal(customerApi.getRefundReviewDeadline(journey), deadline);
});

test("hides the review deadline for wait and no-action journeys, even when a preview remains", () => {
  for (const stage of [
    "REQUEST_RECEIVED",
    "REFUND_PREVIEW_READY",
    "SPECIALIST_REVIEWING",
    "REFUND_PROCESSING",
    "REFUND_COMPLETED",
    "MORE_INFORMATION_NEEDED",
    "REFUND_NOT_APPROVED",
    "REFUND_CANCELLED",
    "PREVIEW_EXPIRED",
    "PREVIEW_INVALIDATED",
    "REFUND_FAILED",
    "REQUEST_RESOLVED",
  ]) {
    for (const action of ["WAIT_FOR_REFUND", "WAIT_FOR_SPECIALIST", "NONE"]) {
      const journey = createJourney(stage, action);

      assert.equal(journey.preview.expiresAt, deadline);
      assert.equal(customerApi.getRefundReviewDeadline(journey), undefined, `${stage}: ${action}`);
    }
  }
});

test("has no review deadline without a preview or a deadline", () => {
  const journey = createJourney();

  assert.equal(customerApi.getRefundReviewDeadline({ ...journey, preview: undefined }), undefined);
  assert.equal(customerApi.getRefundReviewDeadline({
    ...journey,
    preview: { ...journey.preview, expiresAt: undefined },
  }), undefined);
});

test("explains an unavailable preview without assuming why and preserves its amount without confirmation", () => {
  const journey = createJourney("PREVIEW_EXPIRED", "NONE");

  assert.equal(journey.stage, "PREVIEW_EXPIRED");
  assert.equal(journey.statusLabel, "Refund preview no longer available");
  assert.equal(journey.statusDetail, "This refund preview expired or the order details changed. Please start a new request so we can review the latest details.");
  assert.equal(journey.nextAction, "NONE");
  assert.equal(customerApi.getRefundReviewDeadline(journey), undefined);
  assert.equal(journey.preview.previewId, "preview-display-test");
  assert.equal(journey.preview.expiresAt, deadline);
  assert.deepEqual(journey.preview.amount, { amountMinor: 5_309, currency: "USD" });
  assert.equal(customerApi.formatRefundAmount(journey.preview.amount), "$53.09");
});

test("display helpers preserve the normalized preview, identifiers, action, and USD amount", () => {
  const journey = createJourney();
  const originalJourney = structuredClone(journey);

  customerApi.formatRefundDestination(journey.preview.refundDestination);
  customerApi.getRefundReviewDeadline(journey);

  assert.deepEqual(journey, originalJourney);
  assert.equal(journey.workflowId, "refund-display-test");
  assert.equal(journey.preview.previewId, "preview-display-test");
  assert.equal(journey.preview.refundDestination, "ORIGINAL_PAYMENT_METHOD");
  assert.equal(journey.preview.expiresAt, deadline);
  assert.deepEqual(journey.preview.amount, { amountMinor: 5_309, currency: "USD" });
  assert.equal(journey.nextAction, "CONFIRM_OR_DECLINE");
  assert.equal(customerApi.formatRefundAmount(journey.preview.amount), "$53.09");
});
