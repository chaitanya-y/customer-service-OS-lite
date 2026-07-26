import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CommerceProvider } from './commerce.js';

const orderReferenceSchema = z.string().trim().min(1).max(100);

type OrderRouteParams = {
  orderReference: string;
};

export function registerOrderRoutes(
  app: FastifyInstance,
  commerceProvider: CommerceProvider,
): void {
  app.get<{ Params: OrderRouteParams }>(
    '/v1/orders/:orderReference',
    async (request, reply) => {
      const parsedReference = orderReferenceSchema.safeParse(
        request.params.orderReference,
      );

      if (!parsedReference.success) {
        return reply.code(400).send({
          error: {
            code: 'invalid_order_reference',
            message: 'Order reference is invalid',
          },
        });
      }

      try {
        const order = await commerceProvider.getOrderByReference(
          parsedReference.data,
        );

        if (!order) {
          return reply.code(404).send({
            error: {
              code: 'order_not_found',
              message: 'Order was not found',
            },
          });
        }

        return order;
      } catch (error) {
        request.log.error(
          {
            err: error,
            orderReference: parsedReference.data,
          },
          'Commerce provider order lookup failed',
        );

        return reply.code(502).send({
          error: {
            code: 'commerce_provider_unavailable',
            message: 'Commerce provider request failed',
          },
        });
      }
    },
  );
}
