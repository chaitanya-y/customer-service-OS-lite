import type { RefundPolicyRelease } from "./refund-policy-release.js";

export type RefundRiskClass = "LOW" | "ELEVATED" | "HIGH";

export function assessRefundRisk(
  priorRefundCount: number,
  release: RefundPolicyRelease,
): RefundRiskClass {
  if (!Number.isSafeInteger(priorRefundCount) || priorRefundCount < 0) {
    throw new Error("INVALID_PRIOR_REFUND_COUNT");
  }

  if (priorRefundCount >= release.highRiskPriorRefundCount) {
    return "HIGH";
  }
  if (priorRefundCount >= release.elevatedRiskPriorRefundCount) {
    return "ELEVATED";
  }
  return "LOW";
}
