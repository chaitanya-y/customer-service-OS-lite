import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import { z } from 'zod';

import {
  ConversationUnavailableError,
  IdempotencyConflictError,
  MessageTooLargeError,
  type ConversationService,
} from './conversation-service.js';
import {
  CONTEXT_ASSERTION_HEADER,
  ContextAssertionError,
  type VerifyContextAssertion,
} from './trusted-context.js';

const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const createConversationSchema = z
  .object({
    channel: z.literal('web').default('web'),
  })
  .strict();
const acceptMessageSchema = z
  .object({
    clientMessageId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    content: z
      .object({
        type: z.literal('text'),
        text: z.string().trim().min(1).max(32_768),
      })
      .strict(),
  })
  .strict();
const conversationParametersSchema = z.object({
  conversationId: z.uuid(),
});

type BuildAppOptions = {
  verifyContextAssertion: VerifyContextAssertion;
  conversationService: ConversationService;
  checkHealth: () => Promise<void>;
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async (_request, reply) => {
    try {
      await options.checkHealth();
      return { service: 'conversation-runtime', status: 'ok' };
    } catch {
      return reply.code(503).send({
        service: 'conversation-runtime',
        status: 'unavailable',
      });
    }
  });

  app.post('/v1/conversations', async (request, reply) => {
    const body = createConversationSchema.safeParse(request.body ?? {});
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );

    if (!body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_CONVERSATION_REQUEST',
          message: 'Conversation request is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyContextAssertion(
        readContextAssertion(request.headers[CONTEXT_ASSERTION_HEADER]),
      );
      const conversation = await options.conversationService.createConversation({
        context,
        idempotencyKey: idempotencyKey.data,
        channel: body.data.channel,
      });

      return reply.code(201).send({
        data: conversation,
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      });
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  app.post('/v1/conversations/:conversationId/messages', async (
    request,
    reply,
  ) => {
    const parameters = conversationParametersSchema.safeParse(request.params);
    const body = acceptMessageSchema.safeParse(request.body);
    const idempotencyKey = idempotencyKeySchema.safeParse(
      request.headers['idempotency-key'],
    );

    if (!parameters.success || !body.success || !idempotencyKey.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_MESSAGE_REQUEST',
          message: 'Message request is invalid',
          retryable: false,
        },
      });
    }

    try {
      const context = await options.verifyContextAssertion(
        readContextAssertion(request.headers[CONTEXT_ASSERTION_HEADER]),
      );
      const accepted = await options.conversationService.acceptMessage({
        context,
        conversationId: parameters.data.conversationId,
        idempotencyKey: idempotencyKey.data,
        clientMessageId: body.data.clientMessageId,
        text: body.data.content.text,
      });

      return reply.code(202).send({
        data: accepted,
        meta: {
          requestId: context.requestId,
          apiVersion: '2026-08-05',
        },
      });
    } catch (error) {
      return sendStableError(reply, error, request.log);
    }
  });

  return app;
}

function readContextAssertion(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

function sendStableError(
  reply: FastifyReply,
  error: unknown,
  logger: Pick<FastifyBaseLogger, 'error'>,
) {
  if (error instanceof ContextAssertionError) {
    return reply.code(401).send({
      error: {
        code: 'CONTEXT_UNAUTHORIZED',
        message: 'Trusted context is required',
        retryable: false,
      },
    });
  }

  if (error instanceof IdempotencyConflictError) {
    return reply.code(409).send({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for another request',
        retryable: false,
      },
    });
  }

  if (error instanceof ConversationUnavailableError) {
    return reply.code(404).send({
      error: {
        code: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation was not found',
        retryable: false,
      },
    });
  }

  if (error instanceof MessageTooLargeError) {
    return reply.code(400).send({
      error: {
        code: 'MESSAGE_TOO_LARGE',
        message: 'Message exceeds the supported size',
        retryable: false,
      },
    });
  }

  logger.error({ err: error }, 'Conversation request failed');
  return reply.code(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Conversation request could not be completed',
      retryable: true,
    },
  });
}
