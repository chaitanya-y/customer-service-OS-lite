import type { Money, RefundPolicyInput } from "./refund-policy.js";

export type RefundProposal = Readonly<{
  proposalId: string;
  journeyType: "REFUND";
  intent: Readonly<{
    orderId: string;
    reasonCode: string;
    scope: "FULL_ORDER" | "SELECTED_ITEMS" | "UNSPECIFIED";
    itemIds: readonly string[];
    requestedAmount?: Money;
  }>;
}>;

export type RefundContext = Readonly<{
  observationId: string;
  observedAt: string;
  source: Readonly<{
    provider: string;
    orderId: string;
    factsVersion: string;
  }>;
  selection: Readonly<{
    scope: "FULL_ORDER" | "SELECTED_ITEMS";
    itemIds: readonly string[];
  }>;
  facts: Readonly<{
    customerVerified: true;
    transactionRefundable: boolean;
    itemSelectionValid: boolean;
    priorRefundCount: number;
    refundableAmount: Money;
    refundDestination: "ORIGINAL_PAYMENT_METHOD";
  }>;
}>;

type CreateRefundPolicyInputOptions = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  policyVersion: string;
}>;

export function createRefundPolicyInput({
  proposal,
  refundContext,
  policyVersion,
}: CreateRefundPolicyInputOptions): RefundPolicyInput {
  assertMatchingOrder(proposal, refundContext);
  assertMatchingSelection(proposal, refundContext);

  return {
    schemaVersion: "1",
    journeyType: "REFUND",
    policyVersion,
    request: {
      proposalId: proposal.proposalId,
      orderId: proposal.intent.orderId,
      reasonCode: proposal.intent.reasonCode,
      scope: proposal.intent.scope,
      itemIds: [...proposal.intent.itemIds],
      ...(proposal.intent.requestedAmount === undefined
        ? {}
        : {
            requestedAmount: {
              amountMinor: proposal.intent.requestedAmount.amountMinor,
              currency: proposal.intent.requestedAmount.currency,
            },
          }),
    },
    facts: {
      customerVerified: refundContext.facts.customerVerified,
      transactionRefundable: refundContext.facts.transactionRefundable,
      itemSelectionValid: refundContext.facts.itemSelectionValid,
      priorRefundCount: refundContext.facts.priorRefundCount,
      refundableAmount: {
        amountMinor: refundContext.facts.refundableAmount.amountMinor,
        currency: refundContext.facts.refundableAmount.currency,
      },
      refundDestination: refundContext.facts.refundDestination,
    },
    factRefs: [
      {
        factId: refundContext.observationId,
        factType: "REFUND_CONTEXT",
        sourceVersion: refundContext.source.factsVersion,
        observedAt: refundContext.observedAt,
      },
    ],
  };
}

function assertMatchingOrder(
  proposal: RefundProposal,
  refundContext: RefundContext,
): void {
  if (proposal.intent.orderId !== refundContext.source.orderId) {
    throw new Error("REFUND_CONTEXT_ORDER_MISMATCH");
  }
}

function assertMatchingSelection(
  proposal: RefundProposal,
  refundContext: RefundContext,
): void {
  if (
    proposal.intent.scope !== refundContext.selection.scope ||
    !sameItemIds(proposal.intent.itemIds, refundContext.selection.itemIds)
  ) {
    throw new Error("REFUND_CONTEXT_SELECTION_MISMATCH");
  }
}

function sameItemIds(
  leftItemIds: readonly string[],
  rightItemIds: readonly string[],
): boolean {
  if (leftItemIds.length !== rightItemIds.length) {
    return false;
  }

  const sortedLeftItemIds = [...leftItemIds].sort();
  const sortedRightItemIds = [...rightItemIds].sort();
  return sortedLeftItemIds.every(
    (itemId, index) => itemId === sortedRightItemIds[index],
  );
}
