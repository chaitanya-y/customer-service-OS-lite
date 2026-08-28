import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConversationRuntimeUnavailableError,
  createConversationRuntimeClient,
} from '../src/conversation-runtime-client.js';
import {
  CONTEXT_ASSERTION_HEADER,
  SERVICE_ASSERTION_HEADER,
} from '../src/context-assertion.js';

const CONVERSATION_ID = '019c321e-8650-7000-8000-000000000001';

test('sends the expected Conversation Runtime request shapes', async () => {
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const client = createConversationRuntimeClient({
    baseUrl: 'http://conversation-runtime:3004',
    fetchImpl: async (input, init) => {
      requests.push({ input: input.toString(), init });
      return Response.json({
        data: {
          conversationId: CONVERSATION_ID,
          messageId: 'message-1',
          sequenceNumber: 1,
          status: 'ACCEPTED',
        },
      }, { status: 202 });
    },
  });

  await client.createConversation({
    contextAssertion: 'customer-context',
    idempotencyKey: 'create-key',
  });
  await client.getConversation({
    conversationId: CONVERSATION_ID,
    contextAssertion: 'customer-context',
  });
  await client.acceptCustomerMessage({
    conversationId: CONVERSATION_ID,
    contextAssertion: 'customer-context',
    idempotencyKey: 'customer-message-key',
    clientMessageId: 'client-message-1',
    text: 'I need help with my order.',
  });
  await client.appendAssistantMessage({
    conversationId: CONVERSATION_ID,
    serviceAssertion: 'edge-service-assertion',
    idempotencyKey: 'assistant-message-key',
    clientMessageId: 'assistant-message-1',
    text: 'I can help with that.',
  });

  assert.equal(requests.length, 4);
  assert.equal(
    requests[0]?.input,
    'http://conversation-runtime:3004/v1/conversations',
  );
  assert.equal(requests[0]?.init?.method, 'POST');
  assert.equal(
    new Headers(requests[0]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    'customer-context',
  );
  assert.equal(
    new Headers(requests[0]?.init?.headers).get('idempotency-key'),
    'create-key',
  );
  assert.equal(requests[0]?.init?.body, JSON.stringify({ channel: 'web' }));
  assert.ok(requests[0]?.init?.signal);
  assert.equal(
    requests[1]?.input,
    `http://conversation-runtime:3004/v1/conversations/${CONVERSATION_ID}`,
  );
  assert.equal(requests[1]?.init?.method, 'GET');
  assert.equal(
    new Headers(requests[1]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    'customer-context',
  );
  assert.equal(
    new Headers(requests[2]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    'customer-context',
  );
  assert.equal(
    requests[2]?.init?.body,
    JSON.stringify({
      clientMessageId: 'client-message-1',
      content: { type: 'text', text: 'I need help with my order.' },
    }),
  );
  assert.equal(
    new Headers(requests[3]?.init?.headers).get(SERVICE_ASSERTION_HEADER),
    'edge-service-assertion',
  );
  assert.equal(
    new Headers(requests[3]?.init?.headers).get(CONTEXT_ASSERTION_HEADER),
    null,
  );
  assert.equal(
    requests[3]?.init?.body,
    JSON.stringify({
      client_message_id: 'assistant-message-1',
      content: { type: 'text', text: 'I can help with that.' },
    }),
  );
});

test('maps Conversation Runtime transport failures to a stable client error', async () => {
  const client = createConversationRuntimeClient({
    baseUrl: 'http://conversation-runtime:3004',
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  await assert.rejects(
    () =>
      client.createConversation({
        contextAssertion: 'customer-context',
        idempotencyKey: 'create-key',
      }),
    ConversationRuntimeUnavailableError,
  );
});
