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

const refundIntakeRequestSchema = z
  .object({
    customer_message: z.string().trim().min(1).max(2_000),
    order_reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

type BuildAppOptions = {
  verifyCustomerIdentity: VerifyCustomerIdentity;
  signContextAssertion: SignContextAssertion;
  intakeRefund: IntakeRefund;
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

  app.get('/health', async () => ({
    service: 'edge-api',
    status: 'ok',
  }));

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

      return sendAgentResponse(reply, agentResponse);
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
