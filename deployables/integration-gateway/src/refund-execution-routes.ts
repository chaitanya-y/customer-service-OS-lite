import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CommerceProvider } from './commerce.js';
import { toRefundContext } from './refund-context.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER, type VerifyWorkflowAccessAssertion } from './workflow-access.js';

const requestSchema = z.object({
  orderReference: z.string().trim().min(1).max(100),
  reasonCode: z.string().trim().min(1).max(100),
  amount: z.object({ amountMinor: z.number().int().positive(), currency: z.literal('USD') }).strict(),
  selection: z.object({ scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']), itemIds: z.array(z.string()).max(100) }).strict(),
  idempotencyKey: z.string().min(1).max(240),
}).strict();

type ExecutionResult = { status: 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION'; providerRefundId?: string };

/** Local-only idempotency store. Replace with durable storage before multi-instance deployment. */
export function registerRefundExecutionRoutes(app: FastifyInstance, commerceProvider: CommerceProvider, verify?: VerifyWorkflowAccessAssertion): void {
  const results = new Map<string, ExecutionResult>();
  app.post('/internal/v1/refunds', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_refund_execution_request' } });
    let access;
    try {
      access = await verify?.(typeof request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER] === 'string' ? request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER] : undefined);
      if (!verify) throw new Error('missing verifier');
    } catch { return reply.code(401).send({ error: { code: 'workflow_unauthorized' } }); }
    const cached = results.get(parsed.data.idempotencyKey);
    if (cached) return cached;
    if (!commerceProvider.executeRefund) return reply.code(501).send({ error: { code: 'refund_execution_not_configured' } });
    const order = await commerceProvider.getOrderByReference(parsed.data.orderReference);
    if (!order || order.customer?.id !== access?.subjectCustomerId) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const currentContext = toRefundContext(order, parsed.data.selection, { observationId: 'refund-execution-check', observedAt: new Date().toISOString() });
    const payment = order.payments.find((candidate) => candidate.status.toUpperCase() === 'SETTLED');
    if (!payment || !currentContext.facts.transactionRefundable || !currentContext.facts.itemSelectionValid || currentContext.facts.refundableAmount.currency !== parsed.data.amount.currency || parsed.data.amount.amountMinor > currentContext.facts.refundableAmount.amountMinor) {
      return reply.code(409).send({ error: { code: 'refund_no_longer_eligible' } });
    }
    try {
      const result = await commerceProvider.executeRefund({ paymentId: payment.id, amount: parsed.data.amount, reason: parsed.data.reasonCode });
      const response: ExecutionResult = result.status === 'SUCCEEDED'
        ? result.providerRefundId === undefined
          ? { status: 'SUCCEEDED' }
          : { status: 'SUCCEEDED', providerRefundId: result.providerRefundId }
        : { status: 'FAILED' };
      results.set(parsed.data.idempotencyKey, response);
      return response;
    } catch (error) {
      request.log.error({ err: error }, 'Refund provider outcome is unknown; reconciliation required');
      return { status: 'PENDING_RECONCILIATION' } satisfies ExecutionResult;
    }
  });
}
