import {
  getRefundPolicyBinding,
  getRefundPolicyRelease,
} from "../../../../packages/refund-policy/index.mjs";
import type {
  RefundPolicyBinding,
  RefundPolicyRelease,
} from "../../../../packages/refund-policy/index.mjs";

export type { RefundPolicyBinding, RefundPolicyRelease };
export { getRefundPolicyBinding, getRefundPolicyRelease };

export const REFUND_POLICY_V1 = getRefundPolicyRelease("refund-policy-v1");

// Policy v1 remains immutable for workflows already pinned to that release.
// This release adds photo evidence, not a delivery-date eligibility rule.
export const REFUND_POLICY_V2 = getRefundPolicyRelease("refund-policy-v2");
