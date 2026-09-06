import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuthenticatedCustomer } from './customer-identity.js';
import { RefundWorkflowNotFoundError, type GetRefundWorkflow } from './temporal-refund-client.js';
import {
  EVIDENCE_VERSION_HEADER, MAX_EVIDENCE_BYTES, RefundEvidenceError,
  type EvidenceRequestContext, type RefundEvidenceClient,
} from './refund-evidence-client.js';

export function isEvidenceWaitStage(stage: string): boolean {
  return stage === 'AWAITING_CUSTOMER_EVIDENCE' || stage === 'AWAITING_EVIDENCE_REVIEW';
}

const messages: Readonly<Record<string, string>> = {
  evidence_not_found: 'This photo evidence was not found.',
  stale_evidence_version: 'The photos changed. Refresh the request before uploading again.',
  evidence_frozen: 'Photos cannot be added at this stage. Refresh the refund status.',
  evidence_limit_exceeded: 'The photo limit has been reached. Please contact support if more photos are needed.',
  idempotency_conflict: 'This upload attempt conflicts with an earlier upload. Refresh before trying again.',
  invalid_evidence: 'Send one JPEG or PNG photo with valid upload details.',
  evidence_too_large: 'Each photo must be no larger than 10 MiB.',
  unsupported_evidence_type: 'Only JPEG and PNG photos are supported.',
  evidence_unavailable: 'Photo evidence is temporarily unavailable. Please try again.',
};

export function sendEvidenceFailure(reply: FastifyReply, error: unknown) {
  const known = error instanceof RefundEvidenceError && Object.hasOwn(messages, error.code);
  const code = known ? error.code : 'evidence_unavailable';
  return reply.header('cache-control', 'private, no-store').code(known ? error.statusCode : 503)
    .send({ error: { code, message: messages[code] } });
}

const workflowId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const workflowParams = z.object({ workflowId }).strict();
const contentParams = workflowParams.extend({ evidenceId: z.uuid() }).strict();
const uploadHeaders = z.object({
  'content-type': z.enum(['image/jpeg', 'image/png']),
  'idempotency-key': z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  [EVIDENCE_VERSION_HEADER]: z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number).refine(Number.isSafeInteger),
}).passthrough();

export function registerRefundEvidenceRoutes(app: FastifyInstance, options: {
  verifyRequestIdentity: (authorization: string | undefined) => Promise<AuthenticatedCustomer>;
  getRefundWorkflow?: GetRefundWorkflow;
  evidenceClient?: RefundEvidenceClient;
  createCorrelationId: () => string;
}) {
  app.register(async routes => {
    const contexts = new WeakMap<FastifyRequest, EvidenceRequestContext>();
    // Fastify consumes the stream with this hard byte limit. onRequest below
    // verifies customer/workflow ownership before any image bytes are buffered.
    routes.addContentTypeParser(['image/jpeg', 'image/png'], { parseAs: 'buffer', bodyLimit: MAX_EVIDENCE_BYTES }, (_request, body, done) => done(null, body));
    routes.setErrorHandler((error, _request, reply) => {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendEvidenceFailure(reply, new RefundEvidenceError(413, 'evidence_too_large'));
      if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return sendEvidenceFailure(reply, new RefundEvidenceError(415, 'unsupported_evidence_type'));
      return sendEvidenceFailure(reply, error);
    });
    routes.addHook('onSend', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
    });

    async function authorize(request: FastifyRequest, reply: FastifyReply, uploading: boolean) {
      let identity;
      try { identity = await options.verifyRequestIdentity(request.headers.authorization); }
      catch { return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } }); }
      const params = (uploading ? workflowParams : contentParams).safeParse(request.params);
      if (!params.success) return sendEvidenceFailure(reply, new RefundEvidenceError(400, 'invalid_evidence'));
      if (!options.getRefundWorkflow || !options.evidenceClient) return sendEvidenceFailure(reply, new RefundEvidenceError(503, 'evidence_unavailable'));
      const context: EvidenceRequestContext = { workflowId: params.data.workflowId, identity, requestId: options.createCorrelationId(), traceId: options.createCorrelationId() };
      try {
        const workflow = await options.getRefundWorkflow({ workflowId: context.workflowId, access: {
          tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId,
          requestId: context.requestId, traceId: context.traceId,
        } });
        if (uploading) {
          if (!isEvidenceWaitStage(workflow.stage)) throw new RefundEvidenceError(409, 'evidence_frozen');
          const headers = uploadHeaders.safeParse(request.headers);
          if (!headers.success) {
            if (!['image/jpeg', 'image/png'].includes(request.headers['content-type'] ?? '')) throw new RefundEvidenceError(415, 'unsupported_evidence_type');
            throw new RefundEvidenceError(400, 'invalid_evidence');
          }
          if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new RefundEvidenceError(415, 'unsupported_evidence_type');
          const declaredLength = request.headers['content-length'];
          if (declaredLength !== undefined && (!/^[0-9]+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)))) throw new RefundEvidenceError(400, 'invalid_evidence');
          if (Number(declaredLength) > MAX_EVIDENCE_BYTES) throw new RefundEvidenceError(413, 'evidence_too_large');
          const evidence = await options.evidenceClient.getSummary(context);
          if (!evidence) throw new RefundEvidenceError(404, 'evidence_not_found');
          if (!evidence.can_upload) throw new RefundEvidenceError(409, 'evidence_frozen');
        }
        contexts.set(request, context);
      } catch (error) {
        if (error instanceof RefundWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'refund_workflow_not_found', message: 'Refund workflow was not found' } });
        return sendEvidenceFailure(reply, error);
      }
    }

    routes.post('/v1/refunds/:workflowId/evidence', {
      bodyLimit: MAX_EVIDENCE_BYTES,
      onRequest: async (request, reply) => authorize(request, reply, true),
    }, async (request, reply) => {
      const context = contexts.get(request);
      const headers = uploadHeaders.safeParse(request.headers);
      if (!context || !headers.success || !Buffer.isBuffer(request.body) || !request.body.length) return sendEvidenceFailure(reply, new RefundEvidenceError(400, 'invalid_evidence'));
      try {
        const evidence = await options.evidenceClient!.upload({ ...context, body: request.body,
          contentType: headers.data['content-type'], idempotencyKey: headers.data['idempotency-key'], expectedVersion: headers.data[EVIDENCE_VERSION_HEADER],
        });
        return reply.code(202).send({ evidence });
      } catch (error) { return sendEvidenceFailure(reply, error); }
    });

    routes.get('/v1/refunds/:workflowId/evidence/:evidenceId/content', {
      onRequest: async (request, reply) => authorize(request, reply, false),
    }, async (request, reply) => {
      const context = contexts.get(request);
      const params = contentParams.safeParse(request.params);
      if (!context || !params.success) return sendEvidenceFailure(reply, new RefundEvidenceError(400, 'invalid_evidence'));
      try {
        const content = await options.evidenceClient!.getContent({ ...context, evidenceId: params.data.evidenceId });
        return reply.type(content.contentType).header('content-disposition', 'inline').header('content-security-policy', "default-src 'none'; sandbox").send(content.body);
      } catch (error) { return sendEvidenceFailure(reply, error); }
    });
  });
}
