import { createHash } from 'node:crypto';

import type { CommerceOrder, Money } from './commerce.js';

export type RefundSelection =
  | {
      scope: 'FULL_ORDER';
      itemIds: string[];
    }
  | {
      scope: 'SELECTED_ITEMS';
      itemIds: string[];
    };

type ObservationMetadata = {
  observationId: string;
  observedAt: string;
};

function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

function refundConsumesBalance(status: string): boolean {
  const normalizedStatus = status.toUpperCase();
  return normalizedStatus !== 'FAILED' && normalizedStatus !== 'CANCELLED';
}

export function toRefundContext(
  order: CommerceOrder,
  selection: RefundSelection,
  metadata: ObservationMetadata,
) {
  const settledPayments = order.payments.filter(
    (payment) => payment.status.toUpperCase() === 'SETTLED',
  );
  const payment = settledPayments.length === 1 ? settledPayments[0] : null;
  const consumedAmountMinor = payment
    ? payment.refunds
        .filter((refund) => refundConsumesBalance(refund.status))
        .reduce((total, refund) => total + refund.amount.amountMinor, 0)
    : 0;
  const remainingPaymentAmountMinor = payment
    ? Math.max(payment.amount.amountMinor - consumedAmountMinor, 0)
    : 0;
  const selectedItems = selection.itemIds.map((itemId) =>
    order.items.find((item) => item.id === itemId),
  );
  const selectedItemTotalMinor = selectedItems.reduce(
    (total, item) => total + (item?.lineTotal.amountMinor ?? 0),
    0,
  );
  const selectedItemWasRefunded = payment?.refunds.some(
    (refund) =>
      refundConsumesBalance(refund.status) &&
      refund.lineIds.some((lineId) => selection.itemIds.includes(lineId)),
  );
  const itemSelectionValid =
    selection.scope === 'FULL_ORDER' ||
    (selectedItems.every((item) => item !== undefined) &&
      selectedItemWasRefunded !== true);
  const selectedMaximumMinor =
    selection.scope === 'FULL_ORDER'
      ? remainingPaymentAmountMinor
      : Math.min(selectedItemTotalMinor, remainingPaymentAmountMinor);
  const facts = {
    source: {
      provider: order.source.provider,
      orderId: order.source.orderId,
    },
    selection,
    payment: payment
      ? {
          paymentId: payment.id,
          status: payment.status,
          amount: payment.amount,
          refunds: payment.refunds.map((refund) => ({
            refundId: refund.id,
            status: refund.status,
            amount: refund.amount,
            lineIds: refund.lineIds,
          })),
        }
      : null,
    facts: {
      customerVerified: true,
      transactionRefundable:
        !order.active && payment !== null && remainingPaymentAmountMinor > 0,
      itemSelectionValid,
      refundableAmount: money(
        itemSelectionValid ? selectedMaximumMinor : 0,
        order.total.currency,
      ),
      refundDestination: 'ORIGINAL_PAYMENT_METHOD' as const,
    },
  };
  const factsDigest = createHash('sha256')
    .update(JSON.stringify(facts))
    .digest('hex');

  return {
    schemaVersion: '1' as const,
    observationId: metadata.observationId,
    observedAt: metadata.observedAt,
    source: {
      ...facts.source,
      factsVersion: `sha256:${factsDigest}`,
    },
    selection: facts.selection,
    facts: facts.facts,
  };
}
