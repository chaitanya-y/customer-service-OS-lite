export type RefundPolicyRelease = Readonly<{
  policyVersion: string;
  supportedCurrency: "USD";
  automaticMaximumMinor: number;
  approvalMaximumMinor: number;
  elevatedRiskPriorRefundCount: number;
  highRiskPriorRefundCount: number;
  decisionValiditySeconds: number;
  permittedReasonCodes: readonly string[];
  requireDamagePhoto?: boolean;
}>;

export const REFUND_POLICY_V1: RefundPolicyRelease = Object.freeze({
  policyVersion: "refund-policy-v1",
  supportedCurrency: "USD",
  automaticMaximumMinor: 10_000,
  approvalMaximumMinor: 50_000,
  elevatedRiskPriorRefundCount: 1,
  highRiskPriorRefundCount: 2,
  decisionValiditySeconds: 15 * 60,
  permittedReasonCodes: Object.freeze([
    "DAMAGED",
    "DEFECTIVE",
    "WRONG_ITEM",
    "NOT_AS_DESCRIBED",
    "MISSING_ITEM",
    "LATE_DELIVERY",
    "NO_LONGER_NEEDED",
    "OTHER",
  ]),
});

// Policy v1 remains immutable for workflows already pinned to that release.
// This release adds photo evidence, not a delivery-date eligibility rule.
export const REFUND_POLICY_V2: RefundPolicyRelease = Object.freeze({
  ...REFUND_POLICY_V1,
  policyVersion: 'refund-policy-v2',
  requireDamagePhoto: true,
});

export function getRefundPolicyRelease(version: string): RefundPolicyRelease {
  if (version === REFUND_POLICY_V1.policyVersion) return REFUND_POLICY_V1;
  if (version === REFUND_POLICY_V2.policyVersion) return REFUND_POLICY_V2;
  throw new Error('UNKNOWN_REFUND_POLICY_VERSION');
}
