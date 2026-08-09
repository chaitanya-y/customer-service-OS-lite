import assert from "node:assert/strict";
import { test } from "node:test";

import { REFUND_POLICY_V1 } from "../src/refund-policy-release.js";
import { assessRefundRisk } from "../src/refund-risk.js";

test("classifies no completed prior refunds as low risk", () => {
  assert.equal(assessRefundRisk(0, REFUND_POLICY_V1), "LOW");
});

test("classifies one completed prior refund as elevated risk", () => {
  assert.equal(assessRefundRisk(1, REFUND_POLICY_V1), "ELEVATED");
});

test("classifies two or more completed prior refunds as high risk", () => {
  assert.equal(assessRefundRisk(2, REFUND_POLICY_V1), "HIGH");
  assert.equal(assessRefundRisk(3, REFUND_POLICY_V1), "HIGH");
});

test("rejects an invalid prior-refund count", () => {
  assert.throws(
    () => assessRefundRisk(-1, REFUND_POLICY_V1),
    /INVALID_PRIOR_REFUND_COUNT/,
  );
});
