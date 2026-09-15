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

export type RefundPolicyBinding = Readonly<{
  policyVersion: string;
  catalogSha256: string;
}>;

export type RefundPolicyCatalog = Readonly<{
  catalogSha256: string;
  releases: Readonly<Record<string, RefundPolicyRelease>>;
}>;

export function loadRefundPolicyCatalog(catalogPath?: string): RefundPolicyCatalog;
export function getRefundPolicyRelease(version: string): RefundPolicyRelease;
export function getRefundPolicyBinding(version: string): RefundPolicyBinding;
