import { randomUUID } from 'node:crypto';

import type { CommerceProvider } from './commerce.js';
import { toOrderContext } from './order-context.js';

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
  return async function getOrderContext(orderReference: string) {
    const order = await commerceProvider.getOrderByReference(orderReference);

    if (!order) {
      return null;
    }

    return toOrderContext(order, {
      observationId: createObservationId(),
      observedAt: now().toISOString(),
    });
  };
}

export type GetOrderContext = ReturnType<typeof createGetOrderContext>;
