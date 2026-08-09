import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { CommerceProvider } from './commerce.js';
import type { RefundExecutionRepository } from './refund-execution-repository.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER, type VerifyWorkflowAccessAssertion } from './workflow-access.js';

const requestSchema = z.object({ orderReference: z.string().trim().min(1).max(100), previewId: z.string().trim().min(1).max(160), amount: z.object({ amountMinor: z.number().int().positive(), currency: z.literal('USD') }).strict() }).strict();

/** Read-only recovery lookup for an action whose provider response was uncertain. */
export function registerRefundReconciliationRoutes(app: FastifyInstance, commerceProvider: CommerceProvider, repository: RefundExecutionRepository, verify?: VerifyWorkflowAccessAssertion): void {
  app.post('/internal/v1/refund-reconciliations', async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_refund_reconciliation_request' } });
    let access;
    try {
      if (!verify) throw new Error('missing verifier');
      access = await verify(typeof request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER] === 'string' ? request.headers[WORKFLOW_ACCESS_ASSERTION_HEADER] : undefined);
    } catch { return reply.code(401).send({ error: { code: 'workflow_unauthorized' } }); }
    const order = await commerceProvider.getOrderByReference(parsed.data.orderReference);
    if (!order || order.customer?.id !== access.subjectCustomerId) return reply.code(404).send({ error: { code: 'order_not_found' } });
    const refund = order.payments.flatMap((payment) => payment.refunds).find((candidate) => candidate.amount.amountMinor === parsed.data.amount.amountMinor && candidate.amount.currency === parsed.data.amount.currency && !['FAILED', 'CANCELLED'].includes(candidate.status.toUpperCase()));
    if (!refund) return { status: 'NOT_FOUND' };
    const execution = await repository.findByWorkflowAndPreview(access.tenantId, access.environmentId, access.contextId, parsed.data.previewId);
    if (execution && execution.status !== 'SUCCEEDED') await repository.recordOutcome(execution.executionId, 'SUCCEEDED', refund.id);
    return { status: 'SUCCEEDED', providerRefundId: refund.id };
  });
}
