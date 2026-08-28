import {
  CONTEXT_ASSERTION_HEADER,
  SERVICE_ASSERTION_HEADER,
} from './context-assertion.js';

export type ConversationRuntimeResponse = {
  statusCode: number;
  body: unknown;
};

export type CreateConversation = (input: {
  contextAssertion: string;
  idempotencyKey: string;
}) => Promise<ConversationRuntimeResponse>;

export type GetConversation = (input: {
  conversationId: string;
  contextAssertion: string;
}) => Promise<ConversationRuntimeResponse>;

export type AcceptCustomerMessage = (input: {
  conversationId: string;
  contextAssertion: string;
  idempotencyKey: string;
  clientMessageId: string;
  text: string;
}) => Promise<ConversationRuntimeResponse>;

export type AppendAssistantMessage = (input: {
  conversationId: string;
  serviceAssertion: string;
  idempotencyKey: string;
  clientMessageId: string;
  text: string;
}) => Promise<ConversationRuntimeResponse>;

export type LinkRefundWorkflow = (input: {
  conversationId: string;
  messageId: string;
  workflowId: string;
  serviceAssertion: string;
  idempotencyKey: string;
}) => Promise<ConversationRuntimeResponse>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type ConversationRuntimeClientOptions = {
  baseUrl: string;
  timeoutMilliseconds?: number;
  fetchImpl?: FetchLike;
};

export class ConversationRuntimeUnavailableError extends Error {
  constructor() {
    super('Conversation Runtime is unavailable');
    this.name = 'ConversationRuntimeUnavailableError';
  }
}

export function createConversationRuntimeClient({
  baseUrl,
  timeoutMilliseconds = 10_000,
  fetchImpl = fetch,
}: ConversationRuntimeClientOptions): {
  createConversation: CreateConversation;
  getConversation: GetConversation;
  acceptCustomerMessage: AcceptCustomerMessage;
  appendAssistantMessage: AppendAssistantMessage;
  linkRefundWorkflow: LinkRefundWorkflow;
} {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error('Conversation Runtime timeout must be a positive integer');
  }

  const createConversationEndpoint = new URL('/v1/conversations', baseUrl);

  async function request(
    endpoint: URL,
    init: RequestInit,
  ): Promise<ConversationRuntimeResponse> {
    try {
      const response = await fetchImpl(endpoint, {
        ...init,
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });

      return {
        statusCode: response.status,
        body: await response.json(),
      };
    } catch {
      throw new ConversationRuntimeUnavailableError();
    }
  }

  return {
    createConversation: ({ contextAssertion, idempotencyKey }) =>
      request(createConversationEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [CONTEXT_ASSERTION_HEADER]: contextAssertion,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ channel: 'web' }),
      }),

    getConversation: ({ conversationId, contextAssertion }) =>
      request(
        new URL(
          `/v1/conversations/${encodeURIComponent(conversationId)}`,
          baseUrl,
        ),
        {
          method: 'GET',
          headers: {
            [CONTEXT_ASSERTION_HEADER]: contextAssertion,
          },
        },
      ),

    acceptCustomerMessage: ({
      conversationId,
      contextAssertion,
      idempotencyKey,
      clientMessageId,
      text,
    }) =>
      request(
        new URL(
          `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
          baseUrl,
        ),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [CONTEXT_ASSERTION_HEADER]: contextAssertion,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            clientMessageId,
            content: { type: 'text', text },
          }),
        },
      ),

    appendAssistantMessage: ({
      conversationId,
      serviceAssertion,
      idempotencyKey,
      clientMessageId,
      text,
    }) =>
      request(
        new URL(
          `/v1/internal/conversations/${encodeURIComponent(conversationId)}/assistant-messages`,
          baseUrl,
        ),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SERVICE_ASSERTION_HEADER]: serviceAssertion,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            client_message_id: clientMessageId,
            content: { type: 'text', text },
          }),
        },
      ),

    linkRefundWorkflow: ({
      conversationId,
      messageId,
      workflowId,
      serviceAssertion,
      idempotencyKey,
    }) =>
      request(
        new URL(
          `/v1/internal/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/refund-workflow`,
          baseUrl,
        ),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [SERVICE_ASSERTION_HEADER]: serviceAssertion,
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({ workflow_id: workflowId }),
        },
      ),
  };
}
