export type RefundPolicyRelease = Readonly<{
  policyVersion: string;
  supportedCurrency: "USD";
  automaticMaximumMinor: number;
  approvalMaximumMinor: number;
  elevatedRiskPriorRefundCount: number;
  highRiskPriorRefundCount: number;
  decisionValiditySeconds: number;
  permittedReasonCodes: readonly string[];
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
