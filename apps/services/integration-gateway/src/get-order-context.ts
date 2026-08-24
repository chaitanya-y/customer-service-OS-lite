import { randomUUID } from 'node:crypto';

import type { CommerceProvider } from './commerce.js';
import { toOrderContext } from './order-context.js';
import type { OrderAccessContext } from './trusted-context.js';

type GetOrderContextDependencies = {
  commerceProvider: CommerceProvider;
  createObservationId?: () => string;
  now?: () => Date;
};

export function createGetOrderContext({
  commerceProvider,
  createObservationId = randomUUID,
  now = () => new Date(),
}: GetOrderContextDependencies) {
  return async function getOrderContext(
    orderReference: string,
    accessContext: OrderAccessContext,
  ) {
    const order = await commerceProvider.getOrderByReference(orderReference);

    if (
      !order?.customer ||
      order.customer.id !== accessContext.subjectCustomerId
    ) {
      return null;
    }

    return toOrderContext(order, {
      observationId: createObservationId(),
      observedAt: now().toISOString(),
    });
  };
}

export type GetOrderContext = ReturnType<typeof createGetOrderContext>;
