import { createHash } from 'node:crypto';

import type { CommerceOrder } from './commerce.js';

type ObservationMetadata = {
  observationId: string;
  observedAt: string;
};

export function toOrderContext(
  order: CommerceOrder,
  metadata: ObservationMetadata,
) {
  const facts = {
    source: {
      provider: order.source.provider,
      orderId: order.source.orderId,
    },
    reference: order.reference,
    status: order.status,
    active: order.active,
    placedAt: order.placedAt,
    customerRef: order.customer
      ? {
          customerId: order.customer.id,
        }
      : null,
    total: {
      amountMinor: order.total.amountMinor,
      currency: order.total.currency,
    },
    items: order.items.map((item) => ({
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unitPrice: {
        amountMinor: item.unitPrice.amountMinor,
        currency: item.unitPrice.currency,
      },
      lineTotal: {
        amountMinor: item.lineTotal.amountMinor,
        currency: item.lineTotal.currency,
      },
    })),
    payments: order.payments.map((payment) => ({
      paymentId: payment.id,
      status: payment.status,
      amount: {
        amountMinor: payment.amount.amountMinor,
        currency: payment.amount.currency,
      },
      method: payment.method,
    })),
    fulfillments: order.fulfillments.map((fulfillment) => ({
      fulfillmentId: fulfillment.id,
      status: fulfillment.status,
      method: fulfillment.method,
      trackingCode: fulfillment.trackingCode,
    })),
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
    reference: facts.reference,
    status: facts.status,
    active: facts.active,
    placedAt: facts.placedAt,
    customerRef: facts.customerRef,
    total: facts.total,
    items: facts.items,
    payments: facts.payments,
    fulfillments: facts.fulfillments,
  };
}
