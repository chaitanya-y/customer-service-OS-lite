import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ProviderRefundOutcome, RefundExecutionRepository } from './refund-execution-repository.js';

export const PROVIDER_REFUND_EVENT_SIGNATURE_HEADER = 'x-cso-provider-signature';

const providerEventSchema = z.object({
  event_id: z.string().trim().min(1).max(200),
  provider_refund_id: z.string().trim().min(1).max(200),
  outcome: z.enum(['COMPLETED', 'FAILED']),
  occurred_at: z.string().datetime({ offset: true }),
}).strict();

type ProviderRefundEvent = Readonly<{
  eventId: string;
  providerRefundId: string;
  outcome: ProviderRefundOutcome;
  occurredAt: string;
}>;

export type VerifyProviderRefundEventSignature = (
  signature: string | undefined,
  event: ProviderRefundEvent,
) => boolean;

function signaturePayload(event: ProviderRefundEvent): string {
  return [event.eventId, event.providerRefundId, event.outcome, event.occurredAt].join('\n');
}

export function createHmacProviderRefundEventVerifier(secret: string): VerifyProviderRefundEventSignature {
  return (signature, event) => {
    if (!signature) return false;
    const expected = createHmac('sha256', secret).update(signaturePayload(event)).digest();
    const received = Buffer.from(signature, 'base64url');
    return received.length === expected.length && timingSafeEqual(received, expected);
  };
}

export function createProviderRefundEventSignature(secret: string, event: ProviderRefundEvent): string {
  return createHmac('sha256', secret).update(signaturePayload(event)).digest('base64url');
}

/**
 * This is the payment-provider adapter boundary. In production, a provider-
 * specific verifier should normalize its signed webhook into this narrow event.
 */
export function registerProviderRefundEventRoutes(
  app: FastifyInstance,
  repository: RefundExecutionRepository,
  verify?: VerifyProviderRefundEventSignature,
): void {
  app.post('/internal/v1/provider-refund-events', async (request, reply) => {
    if (!verify) {
      return reply.code(503).send({ error: { code: 'provider_webhook_not_configured' } });
    }
    const parsed = providerEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_provider_refund_event' } });
    }
    const event: ProviderRefundEvent = {
      eventId: parsed.data.event_id,
      providerRefundId: parsed.data.provider_refund_id,
      outcome: parsed.data.outcome,
      occurredAt: parsed.data.occurred_at,
    };
    const signature = typeof request.headers[PROVIDER_REFUND_EVENT_SIGNATURE_HEADER] === 'string'
      ? request.headers[PROVIDER_REFUND_EVENT_SIGNATURE_HEADER]
      : undefined;
    if (!verify(signature, event)) {
      return reply.code(401).send({ error: { code: 'provider_webhook_unauthorized' } });
    }
    const result = await repository.recordProviderRefundEvent(event);
    if (result === 'UNKNOWN_REFUND') {
      return reply.code(404).send({ error: { code: 'provider_refund_not_found' } });
    }
    return reply.code(202).send({ status: result === 'DUPLICATE' ? 'duplicate' : 'accepted' });
  });
}
