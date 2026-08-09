import type { RefundProposal, RefundContext } from './refund-policy-input.js';
import type { Money, RefundPolicyDecision } from './refund-policy.js';

export type RefundPreview = Readonly<{
  previewId: string;
  createdAt: string;
  proposalId: string;
  orderId: string;
  selection: Readonly<{
    scope: 'FULL_ORDER' | 'SELECTED_ITEMS';
    itemIds: readonly string[];
  }>;
  requestedAmount: Money;
  refundDestination: 'ORIGINAL_PAYMENT_METHOD';
  policyVersion: string;
  decisionId: string;
  inputFactsHash: string;
  validUntil: string;
}>;

export type CreateRefundPreviewInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  decision: RefundPolicyDecision;
  previewId: string;
  createdAt: string;
}>;

/** Builds the exact customer-visible offer from trusted facts and a policy decision. */
export function createRefundPreview({
  proposal,
  refundContext,
  decision,
  previewId,
  createdAt,
}: CreateRefundPreviewInput): RefundPreview {
  const requestedAmount = proposal.intent.requestedAmount;
  if (decision.effect !== 'ALLOW' || requestedAmount === undefined) {
    throw new Error('REFUND_PREVIEW_REQUIRES_ALLOWED_DECISION');
  }
  if (proposal.intent.orderId !== refundContext.source.orderId) {
    throw new Error('REFUND_PREVIEW_ORDER_MISMATCH');
  }

  return {
    previewId,
    createdAt,
    proposalId: proposal.proposalId,
    orderId: proposal.intent.orderId,
    selection: {
      scope: refundContext.selection.scope,
      itemIds: [...refundContext.selection.itemIds],
    },
    requestedAmount: {
      amountMinor: requestedAmount.amountMinor,
      currency: requestedAmount.currency,
    },
    refundDestination: refundContext.facts.refundDestination,
    policyVersion: decision.policyVersion,
    decisionId: decision.decisionId,
    inputFactsHash: decision.inputFactsHash,
    validUntil: decision.validUntil,
  };
}
