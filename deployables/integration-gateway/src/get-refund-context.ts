import { randomUUID } from 'node:crypto';

import type { CommerceProvider } from './commerce.js';
import { toRefundContext, type RefundSelection } from './refund-context.js';
import type { OrderAccessContext } from './trusted-context.js';

type GetRefundContextDependencies = {
  commerceProvider: CommerceProvider;
  createObservationId?: () => string;
  now?: () => Date;
};

export function createGetRefundContext({
  commerceProvider,
  createObservationId = randomUUID,
  now = () => new Date(),
}: GetRefundContextDependencies) {
  return async function getRefundContext(
    orderReference: string,
    selection: RefundSelection,
    accessContext: OrderAccessContext,
  ) {
    const order = await commerceProvider.getOrderByReference(orderReference);

    if (
      !order?.customer ||
      order.customer.id !== accessContext.subjectCustomerId
    ) {
      return null;
    }

    return toRefundContext(order, selection, {
      observationId: createObservationId(),
      observedAt: now().toISOString(),
    });
  };
}

export type GetRefundContext = ReturnType<typeof createGetRefundContext>;
