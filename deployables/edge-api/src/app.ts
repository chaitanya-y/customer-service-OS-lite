import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';

import type {
  AgentRuntimeResponse,
  IntakeRefund,
  RefundIntakeRequest,
} from './agent-runtime-client.js';
import type { SignContextAssertion } from './context-assertion.js';
import type { VerifyCustomerIdentity } from './customer-identity.js';
import {
  RefundWorkflowNotFoundError,
  type ConfirmRefundWorkflow,
  type GetRefundWorkflow,
  type StartRefundWorkflow,
} from './temporal-refund-client.js';

const refundIntakeRequestSchema = z
  .object({
    customer_message: z.string().trim().min(1).max(2_000),
    order_reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const readyRefundProposalSchema = z.object({
  proposalId: z.string().min(1),
  journeyType: z.literal('REFUND'),
  missingFields: z.array(z.string()).length(0),
  intent: z.object({
    orderId: z.string().min(1),
    reasonCode: z.string().min(1),
    scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']),
    itemIds: z.array(z.string()),
    requestedAmount: z.object({
      amountMinor: z.number().int().positive(),
      currency: z.string().min(1),
    }).strict(),
  }).strict(),
}).strict();

const readyAgentResponseSchema = z.object({
  status: z.literal('refund_proposal_ready'),
  refund_proposal: readyRefundProposalSchema,
}).passthrough();
const workflowParamsSchema = z.object({ workflowId: z.string().min(1).max(200) }).strict();
const confirmationSchema = z.object({ preview_id: z.string().min(1).max(200), accepted: z.boolean() }).strict();

type BuildAppOptions = {
  verifyCustomerIdentity: VerifyCustomerIdentity;
  signContextAssertion: SignContextAssertion;
  intakeRefund: IntakeRefund;
  startRefundWorkflow?: StartRefundWorkflow;
  getRefundWorkflow?: GetRefundWorkflow;
  confirmRefundWorkflow?: ConfirmRefundWorkflow;
  refundPolicyVersion?: string;
  createCorrelationId?: () => string;
  logger?: boolean;
};

function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || authorization.length > 8_200) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1];
}

function sendAgentResponse(
  reply: FastifyReply,
  response: AgentRuntimeResponse,
) {
  if (response.statusCode >= 500) {
    return reply.code(502).send({
      error: {
        code: 'agent_runtime_unavailable',
        message: 'Agent Runtime request failed',
      },
    });
  }

  return reply.code(response.statusCode).send(response.body);
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  });
  const createCorrelationId = options.createCorrelationId ?? randomUUID;
  const refundPolicyVersion = options.refundPolicyVersion ?? 'refund-policy-v1';

  app.get('/health', async () => ({
    service: 'edge-api',
    status: 'ok',
  }));

  async function verifyRequestIdentity(authorization: string | undefined) {
    return options.verifyCustomerIdentity(extractBearerToken(authorization));
  }

  app.get('/v1/refunds/:workflowId', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: { code: 'invalid_workflow_id', message: 'Workflow ID is invalid' } });
    if (!options.getRefundWorkflow) return reply.code(503).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is unavailable' } });
    try {
      const identity = await verifyRequestIdentity(request.headers.authorization);
      const workflow = await options.getRefundWorkflow({ workflowId: params.data.workflowId, access: { tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId, requestId: createCorrelationId(), traceId: createCorrelationId() } });
      return reply.send({ workflow_id: params.data.workflowId, ...workflow });
    } catch (error) {
      if (error instanceof RefundWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'refund_workflow_not_found', message: 'Refund workflow was not found' } });
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }
  });

  app.post('/v1/refunds/:workflowId/confirmation', async (request, reply) => {
    const params = workflowParamsSchema.safeParse(request.params);
    const body = confirmationSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: { code: 'invalid_refund_confirmation', message: 'Refund confirmation is invalid' } });
    if (!options.confirmRefundWorkflow) return reply.code(503).send({ error: { code: 'workflow_unavailable', message: 'Refund workflow is unavailable' } });
    try {
      const identity = await verifyRequestIdentity(request.headers.authorization);
      await options.confirmRefundWorkflow({ workflowId: params.data.workflowId, previewId: body.data.preview_id, accepted: body.data.accepted, access: { tenantId: identity.tenantId, environmentId: identity.environmentId, subjectCustomerId: identity.customerId, requestId: createCorrelationId(), traceId: createCorrelationId() } });
      return reply.code(202).send({ workflow_id: params.data.workflowId, status: 'confirmation_received' });
    } catch (error) {
      if (error instanceof RefundWorkflowNotFoundError) return reply.code(404).send({ error: { code: 'refund_workflow_not_found', message: 'Refund workflow was not found' } });
      return reply.code(401).send({ error: { code: 'customer_unauthorized', message: 'Customer authentication is required' } });
    }
  });

  app.post('/v1/refunds/intake', async (request, reply) => {
    const parsedRequest = refundIntakeRequestSchema.safeParse(request.body);

    if (!parsedRequest.success) {
      return reply.code(400).send({
        error: {
          code: 'invalid_refund_request',
          message: 'Refund request is invalid',
        },
      });
    }

    const accessToken = extractBearerToken(request.headers.authorization);
    let identity;

    try {
      identity = await options.verifyCustomerIdentity(accessToken);
    } catch {
      return reply.code(401).send({
        error: {
          code: 'customer_unauthorized',
          message: 'Customer authentication is required',
        },
      });
    }

    const requestId = createCorrelationId();
    const traceId = createCorrelationId();
    let contextAssertion;

    try {
      contextAssertion = await options.signContextAssertion({
        identity,
        requestId,
        traceId,
        channelId: 'web',
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Context signing failed');

      return reply.code(500).send({
        error: {
          code: 'internal_error',
          message: 'Request could not be authorized',
        },
      });
    }

    try {
      const refundRequest: RefundIntakeRequest = {
        customer_message: parsedRequest.data.customer_message,
        ...(parsedRequest.data.order_reference === undefined
          ? {}
          : { order_reference: parsedRequest.data.order_reference }),
      };
      const agentResponse = await options.intakeRefund(
        refundRequest,
        contextAssertion,
      );

      if (agentResponse.statusCode < 200 || agentResponse.statusCode >= 300) {
        return sendAgentResponse(reply, agentResponse);
      }

      const readyResponse = readyAgentResponseSchema.safeParse(agentResponse.body);
      if (!readyResponse.success) {
        return reply.code(agentResponse.statusCode).send(agentResponse.body);
      }
      if (!options.startRefundWorkflow) {
        throw new Error('WORKFLOW_STARTER_NOT_CONFIGURED');
      }

      const workflow = await options.startRefundWorkflow({
        workflowId: `refund-${readyResponse.data.refund_proposal.proposalId}`,
        proposal: {
          proposalId: readyResponse.data.refund_proposal.proposalId,
          journeyType: 'REFUND',
          intent: {
            orderId: readyResponse.data.refund_proposal.intent.orderId,
            reasonCode: readyResponse.data.refund_proposal.intent.reasonCode,
            scope: readyResponse.data.refund_proposal.intent.scope,
            itemIds: readyResponse.data.refund_proposal.intent.itemIds,
            requestedAmount:
              readyResponse.data.refund_proposal.intent.requestedAmount,
          },
        },
        policyVersion: refundPolicyVersion,
        access: {
          tenantId: identity.tenantId,
          environmentId: identity.environmentId,
          subjectCustomerId: identity.customerId,
          requestId,
          traceId,
        },
      });

      return reply.code(agentResponse.statusCode).send({
        ...readyResponse.data,
        refund_workflow: {
          workflow_id: workflow.workflowId,
          status: 'started',
        },
      });
    } catch (error) {
      request.log.error({ err: error, requestId }, 'Agent Runtime request failed');

      return reply.code(502).send({
        error: {
          code: 'agent_runtime_unavailable',
          message: 'Agent Runtime request failed',
        },
      });
    }
  });

  return app;
}
