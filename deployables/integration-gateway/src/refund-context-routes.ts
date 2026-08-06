import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { GetRefundContext } from './get-refund-context.js';
import {
  CONTEXT_ASSERTION_HEADER,
  type VerifyContextAssertion,
} from './trusted-context.js';

const refundContextRequestSchema = z.object({
  orderReference: z.string().trim().min(1).max(100),
  selection: z.discriminatedUnion('scope', [
    z.object({
      scope: z.literal('FULL_ORDER'),
      itemIds: z.array(z.string()).length(0).default([]),
    }),
    z.object({
      scope: z.literal('SELECTED_ITEMS'),
      itemIds: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
    }),
  ]),
});

export function registerRefundContextRoutes(
  app: FastifyInstance,
  getRefundContext: GetRefundContext,
  verifyContextAssertion: VerifyContextAssertion,
): void {
  app.post('/internal/v1/refund-contexts', async (request, reply) => {
    const parsedRequest = refundContextRequestSchema.safeParse(request.body);

    if (!parsedRequest.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_refund_context_request',
          message: 'Refund context request is invalid',
        },
      });
    }

    const assertion = request.headers[CONTEXT_ASSERTION_HEADER];
    let accessContext;

    try {
      accessContext = await verifyContextAssertion(
        typeof assertion === 'string' ? assertion : undefined,
      );
    } catch {
      return reply.code(401).send({
        error: {
          code: 'context_unauthorized',
          message: 'Trusted context is required',
        },
      });
    }

    try {
      const refundContext = await getRefundContext(
        parsedRequest.data.orderReference,
        parsedRequest.data.selection,
        accessContext,
      );

      if (!refundContext) {
        return reply.code(404).send({
          error: {
            code: 'order_not_found',
            message: 'Order was not found',
          },
        });
      }

      return refundContext;
    } catch (error) {
      request.log.error(
        {
          err: error,
          orderReference: parsedRequest.data.orderReference,
        },
        'Commerce provider refund context lookup failed',
      );

      return reply.code(502).send({
        error: {
          code: 'commerce_provider_unavailable',
          message: 'Commerce provider request failed',
        },
      });
    }
  });
}
