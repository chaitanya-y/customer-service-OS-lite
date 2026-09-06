import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { RefundPreviewUnavailableError, RefundWorkflowNotFoundError } from '../src/temporal-refund-client.js';

const TEST_IDENTITY = {
  principalId: 'customer-42',
  tenantId: 'tenant-local',
  environmentId: 'local',
  customerId: 'customer-42',
};
const TEST_CONVERSATION_ID = '019c321e-8650-7000-8000-000000000001';

function conversationResponse(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 201,
    body: {
      data: {
        conversationId: TEST_CONVERSATION_ID,
        status: 'OPEN',
        controlMode: 'AI',
        ...overrides,
      },
    },
  };
}

function acceptedMessageResponse(
  messageId: string,
  sequenceNumber: number,
) {
  return {
    statusCode: 202,
    body: {
      data: {
        conversationId: TEST_CONVERSATION_ID,
        messageId,
        sequenceNumber,
        status: 'ACCEPTED',
      },
    },
  };
}

function conversationTranscriptResponse(messages: unknown[]) {
  return {
    statusCode: 200,
    body: {
      data: {
        conversationId: TEST_CONVERSATION_ID,
        status: 'OPEN',
        controlMode: 'AI',
        messages,
      },
    },
  };
}

function acceptedCustomerConversation(
  messageId: string,
  sequenceNumber: number,
  text: string,
) {
  return conversationTranscriptResponse([
    {
      messageId,
      sequenceNumber,
      senderKind: 'END_CUSTOMER',
      text,
      createdAt: '2026-09-03T12:00:00.000Z',
    },
  ]);
}

const readyAgentResponse = {
  statusCode: 200,
  body: {
    status: 'refund_proposal_ready',
    customer_answer: {
      message: 'I have captured your refund request.',
      citations: [
        {
          knowledge_document_id: 'refund-policy-customer',
          chunk_id: 'section-001-chunk-001',
        },
      ],
    },
    refund_proposal: {
      proposalId: 'proposal-001',
      journeyType: 'REFUND',
      missingFields: [],
      intent: {
        orderId: 'ORDER-123',
        reasonCode: 'DAMAGED',
        scope: 'FULL_ORDER',
        itemIds: [],
        requestedAmount: { amountMinor: 5_000, currency: 'USD' },
      },
    },
  },
};

test('health reports the Edge API is ready', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
  });
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { service: 'edge-api', status: 'ok' });
});

test('returns a refund workflow stage for an authenticated customer', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    getRefundWorkflow: async (input) => {
      assert.equal(input.workflowId, 'refund-001');
      assert.equal(input.access.subjectCustomerId, 'customer-42');
      return { stage: 'AWAITING_CUSTOMER_CONFIRMATION' };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/refunds/refund-001',
    headers: { authorization: 'Bearer customer-access-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    workflow_id: 'refund-001',
    stage: 'AWAITING_CUSTOMER_CONFIRMATION',
  });
});

test('returns a versioned customer-safe refund journey for its owner', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async (token) => {
      assert.equal(token, 'customer-access-token');
      return TEST_IDENTITY;
    },
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    getRefundWorkflow: async (input) => {
      assert.deepEqual(input.access, {
        tenantId: 'tenant-local',
        environmentId: 'local',
        subjectCustomerId: 'customer-42',
        requestId: input.access.requestId,
        traceId: input.access.traceId,
      });
      return {
        stage: 'AWAITING_CUSTOMER_CONFIRMATION',
        preview: {
          previewId: 'preview-001',
          requestedAmount: { amountMinor: 5_000, currency: 'USD' },
          refundDestination: 'Original payment method',
          validUntil: '2026-08-25T10:00:00.000Z',
        },
        decision: { inputFactsHash: 'must-not-leak' },
      } as never;
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/refunds/refund-001/journey',
    headers: { authorization: 'Bearer customer-access-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    version: 'v1',
    workflow_id: 'refund-001',
    stage: 'REFUND_PREVIEW_READY',
    preview: {
      preview_id: 'preview-001',
      amount: { amount_minor: 5_000, currency: 'USD' },
      refund_destination: 'Original payment method',
      valid_until: '2026-08-25T10:00:00.000Z',
    },
    next_action: {
      type: 'CONFIRM_REFUND',
      label: 'Review and confirm your refund',
    },
    timeline: [
      { id: 'REQUEST_RECEIVED', label: 'Refund request received', status: 'COMPLETED' },
      { id: 'PREVIEW_READY', label: 'Refund preview prepared', status: 'CURRENT' },
      { id: 'SPECIALIST_REVIEW', label: 'Specialist review', status: 'PENDING' },
      { id: 'REFUND_PROCESSING', label: 'Refund processing', status: 'PENDING' },
      { id: 'COMPLETED', label: 'Refund completed', status: 'PENDING' },
    ],
  });
  assert.equal(response.body.includes('must-not-leak'), false);
});

test('does not expose a refund journey when the workflow is not owned by the customer', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    getRefundWorkflow: async () => {
      throw new RefundWorkflowNotFoundError();
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/refunds/refund-001/journey',
    headers: { authorization: 'Bearer customer-access-token' },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: 'refund_workflow_not_found',
      message: 'Refund workflow was not found',
    },
  });
});

test('does not report workflow query failures as customer authentication failures', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    getRefundWorkflow: async () => {
      throw new Error('Temporal query timed out');
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/refunds/refund-001',
    headers: { authorization: 'Bearer customer-access-token' },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: {
      code: 'workflow_unavailable',
      message: 'Refund workflow is temporarily unavailable',
    },
  });
});

test('returns a clear conflict when a refund preview is no longer available for confirmation', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    confirmRefundWorkflow: async () => { throw new RefundPreviewUnavailableError(); },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/refund-001/confirmation',
    headers: { authorization: 'Bearer customer-access-token' },
    payload: { preview_id: 'preview-001', accepted: true },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: {
      code: 'refund_preview_unavailable',
      message: 'This refund preview is no longer available for confirmation. Refresh the refund status or start a new request.',
    },
  });
});

test('successful confirmation response acknowledges delivery without claiming acceptance or execution', async (context) => {
  let confirmations = 0;
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    confirmRefundWorkflow: async (input) => {
      confirmations += 1;
      assert.equal(input.previewId, 'preview-001');
      assert.equal(input.accepted, true);
      assert.equal(input.access.subjectCustomerId, 'customer-42');
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/refund-001/confirmation',
    headers: { authorization: 'Bearer customer-access-token' },
    payload: { preview_id: 'preview-001', accepted: true },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { workflow_id: 'refund-001', status: 'confirmation_received' });
  assert.equal(confirmations, 1);
});

test('confirmation transport failures remain service failures, not preview conflicts', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    confirmRefundWorkflow: async () => { throw new Error('Temporal transport unavailable'); },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/refund-001/confirmation',
    headers: { authorization: 'Bearer customer-access-token' },
    payload: { preview_id: 'preview-001', accepted: true },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: { code: 'workflow_unavailable', message: 'Refund workflow is temporarily unavailable' },
  });
});

test('authenticates, signs context, and forwards a valid refund request', async (
  context,
) => {
  const correlationIds = ['request-1', 'trace-1'];
  const app = buildApp({
    verifyCustomerIdentity: async (token) => {
      assert.equal(token, 'customer-access-token');
      return TEST_IDENTITY;
    },
    signContextAssertion: async (input) => {
      assert.deepEqual(input, {
        identity: TEST_IDENTITY,
        requestId: 'request-1',
        traceId: 'trace-1',
        channelId: 'web',
      });
      return 'signed-context';
    },
    signAgentRuntimeContextAssertion: async (input) => {
      assert.deepEqual(input, {
        identity: TEST_IDENTITY,
        requestId: 'request-1',
        traceId: 'trace-1',
        channelId: 'web',
      });
      return 'agent-runtime-context';
    },
    signKnowledgeRagContextAssertion: async (input) => {
      assert.deepEqual(input, {
        identity: TEST_IDENTITY,
        requestId: 'request-1',
        traceId: 'trace-1',
        channelId: 'web',
      });
      return 'knowledge-rag-context';
    },
    intakeRefund: async (request, assertions) => {
      assert.deepEqual(request, {
        customer_message: 'Please refund my order.',
        order_reference: 'ORDER-123',
      });
      assert.deepEqual(assertions, {
        agentRuntime: 'agent-runtime-context',
        integrationGateway: 'signed-context',
        knowledgeRag: 'knowledge-rag-context',
      });
      return {
        statusCode: 200,
        body: { status: 'order_context_loaded' },
      };
    },
    createCorrelationId: () => {
      const id = correlationIds.shift();
      assert.ok(id);
      return id;
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/intake',
    headers: { authorization: 'Bearer customer-access-token' },
    payload: {
      customer_message: '  Please refund my order.  ',
      order_reference: '  ORDER-123  ',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'order_context_loaded' });
});

test('rejects an invalid request before authentication', async (context) => {
  let authenticationCalled = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => {
      authenticationCalled = true;
      return TEST_IDENTITY;
    },
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/intake',
    payload: { customer_message: '   ', customerId: 'customer-other' },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(authenticationCalled, false);
  assert.equal(response.json().error.code, 'invalid_refund_request');
});

test('rejects a request without valid customer authentication', async (
  context,
) => {
  let contextSigningCalled = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => {
      throw new Error('invalid token');
    },
    signContextAssertion: async () => {
      contextSigningCalled = true;
      return 'signed-context';
    },
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/intake',
    payload: { customer_message: 'Please refund my order.' },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(contextSigningCalled, false);
  assert.equal(response.json().error.code, 'customer_unauthorized');
});

test('does not expose an Agent Runtime server failure', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({
      statusCode: 500,
      body: { secret_internal_detail: 'stack trace' },
    }),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/intake',
    headers: { authorization: 'Bearer customer-access-token' },
    payload: { customer_message: 'Please refund my order.' },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: {
      code: 'agent_runtime_unavailable',
      message: 'Agent Runtime request failed',
    },
  });
});

test('requires customer authentication for conversation routes', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => {
      throw new Error('invalid token');
    },
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    createConversation: async () => conversationResponse(),
    getConversation: async () => ({ statusCode: 200, body: { data: {} } }),
    acceptCustomerMessage: async () => acceptedMessageResponse('message-1', 1),
    appendAssistantMessage: async () => acceptedMessageResponse('message-2', 2),
    intakeRefund: async () => readyAgentResponse,
  });
  context.after(() => app.close());

  const [created, queried, messaged] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/v1/conversations',
      headers: { 'idempotency-key': 'create-1' },
      payload: {},
    }),
    app.inject({
      method: 'GET',
      url: `/v1/conversations/${TEST_CONVERSATION_ID}`,
    }),
    app.inject({
      method: 'POST',
      url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
      headers: { 'idempotency-key': 'message-1' },
      payload: {
        client_message_id: 'client-message-1',
        content: { type: 'text', text: 'Please refund my order.' },
      },
    }),
  ]);

  for (const response of [created, queried, messaged]) {
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      error: {
        code: 'customer_unauthorized',
        message: 'Customer authentication is required',
      },
    });
  }
});

test('creates a conversation with a scoped idempotency key', async (context) => {
  const correlationIds = ['request-1', 'trace-1'];
  const app = buildApp({
    verifyCustomerIdentity: async (token) => {
      assert.equal(token, 'customer-access-token');
      return TEST_IDENTITY;
    },
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async (input) => {
      assert.deepEqual(input, {
        identity: TEST_IDENTITY,
        requestId: 'request-1',
        traceId: 'trace-1',
        channelId: 'web',
      });
      return 'conversation-context';
    },
    signEdgeServiceAssertion: async () => 'service-context',
    createConversation: async (input) => {
      assert.equal(input.contextAssertion, 'conversation-context');
      assert.match(input.idempotencyKey, /^cso-[a-f0-9]{64}$/);
      assert.notEqual(input.idempotencyKey, 'browser-create-1');
      return conversationResponse();
    },
    intakeRefund: async () => readyAgentResponse,
    createCorrelationId: () => {
      const id = correlationIds.shift();
      assert.ok(id);
      return id;
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-create-1',
    },
    payload: {},
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    conversation_id: TEST_CONVERSATION_ID,
    status: 'OPEN',
    control_mode: 'AI',
  });
});

test('returns a customer safe conversation transcript', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    getConversation: async (input) => {
      assert.equal(input.conversationId, TEST_CONVERSATION_ID);
      assert.equal(input.contextAssertion, 'conversation-context');
      return {
        statusCode: 200,
        body: {
          data: {
            conversationId: TEST_CONVERSATION_ID,
            status: 'OPEN',
            controlMode: 'AI',
            messages: [
              {
                messageId: 'message-1',
                sequenceNumber: 1,
                senderKind: 'CUSTOMER',
                text: 'Please refund my damaged order.',
                createdAt: '2026-08-20T12:00:00.000Z',
                refundWorkflowId: 'refund-proposal-001',
              },
            ],
          },
          meta: { internal_value: 'must not be exposed' },
        },
      };
    },
    intakeRefund: async () => readyAgentResponse,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}`,
    headers: { authorization: 'Bearer customer-access-token' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    conversation_id: TEST_CONVERSATION_ID,
    status: 'OPEN',
    control_mode: 'AI',
    messages: [
      {
        message_id: 'message-1',
        sequence_number: 1,
        sender_kind: 'CUSTOMER',
        content: {
          type: 'text',
          text: 'Please refund my damaged order.',
        },
        created_at: '2026-08-20T12:00:00.000Z',
        refund_workflow: {
          workflow_id: 'refund-proposal-001',
          status: 'started',
        },
      },
    ],
  });
});

test('extracts an order reference from chat, appends the safe answer, then starts a ready refund workflow', async (context) => {
  const correlationIds = ['request-1', 'trace-1'];
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async (input) => {
      assert.deepEqual(input, {
        identity: TEST_IDENTITY,
        requestId: 'request-1',
        traceId: 'trace-1',
      });
      return 'service-context';
    },
    acceptCustomerMessage: async (input) => {
      assert.equal(input.conversationId, TEST_CONVERSATION_ID);
      assert.equal(input.contextAssertion, 'conversation-context');
      assert.equal(input.clientMessageId, 'client-message-1');
      assert.equal(input.text, 'Please refund order AVV8JSZH8G6ZZDMX because it arrived damaged.');
      assert.match(input.idempotencyKey, /^cso-[a-f0-9]{64}$/);
      return acceptedMessageResponse('customer-message-1', 1);
    },
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'Please refund order AVV8JSZH8G6ZZDMX because it arrived damaged.',
    ),
    intakeRefund: async (input, assertions) => {
      assert.deepEqual(input, {
        customer_message: 'Please refund order AVV8JSZH8G6ZZDMX because it arrived damaged.',
        order_reference: 'AVV8JSZH8G6ZZDMX',
        conversation_messages: [
          {
            sequence_number: 1,
            text: 'Please refund order AVV8JSZH8G6ZZDMX because it arrived damaged.',
          },
        ],
      });
      assert.deepEqual(assertions, {
        agentRuntime: 'agent-context',
        integrationGateway: 'gateway-context',
        knowledgeRag: 'rag-context',
      });
      return readyAgentResponse;
    },
    appendAssistantMessage: async (input) => {
      assert.equal(input.conversationId, TEST_CONVERSATION_ID);
      assert.equal(input.serviceAssertion, 'service-context');
      assert.match(input.idempotencyKey, /^cso-[a-f0-9]{64}$/);
      assert.match(input.clientMessageId, /^cso-[a-f0-9]{64}$/);
      assert.equal(input.text, 'I have captured your refund request.');
      return acceptedMessageResponse('assistant-message-1', 2);
    },
    startRefundWorkflow: async (input) => {
      assert.deepEqual(input, {
        workflowId: 'refund-proposal-001',
        orderReference: 'AVV8JSZH8G6ZZDMX',
        policyVersion: 'refund-policy-v1',
        proposal: {
          proposalId: 'proposal-001',
          journeyType: 'REFUND',
          intent: {
            orderId: 'ORDER-123',
            reasonCode: 'DAMAGED',
            scope: 'FULL_ORDER',
            itemIds: [],
            requestedAmount: { amountMinor: 5_000, currency: 'USD' },
          },
        },
        access: {
          tenantId: 'tenant-local',
          environmentId: 'local',
          subjectCustomerId: 'customer-42',
          requestId: 'request-1',
          traceId: 'trace-1',
        },
      });
      return { workflowId: input.workflowId };
    },
    linkRefundWorkflow: async (input) => {
      assert.equal(input.conversationId, TEST_CONVERSATION_ID);
      assert.equal(input.messageId, 'assistant-message-1');
      assert.equal(input.workflowId, 'refund-proposal-001');
      assert.equal(input.serviceAssertion, 'service-context');
      assert.match(input.idempotencyKey, /^cso-[a-f0-9]{64}$/);
      return { statusCode: 202, body: { data: { status: 'LINKED' } } };
    },
    createCorrelationId: () => {
      const id = correlationIds.shift();
      assert.ok(id);
      return id;
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-1',
    },
    payload: {
      client_message_id: 'client-message-1',
      content: {
        type: 'text',
        text: 'Please refund order AVV8JSZH8G6ZZDMX because it arrived damaged.',
      },
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    conversation_id: TEST_CONVERSATION_ID,
    customer_message_id: 'customer-message-1',
    assistant_message: {
      message_id: 'assistant-message-1',
      content: {
        type: 'text',
        text: 'I have captured your refund request.',
      },
    },
    refund_workflow: {
      workflow_id: 'refund-proposal-001',
      status: 'started',
    },
  });
  assert.equal('citations' in response.json().assistant_message, false);
});

test('carries a prior customer order reference and bounded customer history into a later chat turn', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-3', 3),
    getConversation: async () => conversationTranscriptResponse([
      {
        messageId: 'customer-message-1',
        sequenceNumber: 1,
        senderKind: 'END_CUSTOMER',
        text: 'My order reference is AVV8JSZH8G6ZZDMX.',
        createdAt: '2026-09-03T12:00:00.000Z',
      },
      {
        messageId: 'assistant-message-2',
        sequenceNumber: 2,
        senderKind: 'ASSISTANT',
        text: 'Please tell me the reason for the refund.',
        createdAt: '2026-09-03T12:00:01.000Z',
      },
      {
        messageId: 'customer-message-3',
        sequenceNumber: 3,
        senderKind: 'END_CUSTOMER',
        text: 'The item arrived damaged. I want a full refund for item 3.',
        createdAt: '2026-09-03T12:00:02.000Z',
      },
    ]),
    intakeRefund: async (input) => {
      assert.deepEqual(input, {
        customer_message: 'The item arrived damaged. I want a full refund for item 3.',
        order_reference: 'AVV8JSZH8G6ZZDMX',
        conversation_messages: [
          {
            sequence_number: 1,
            text: 'My order reference is AVV8JSZH8G6ZZDMX.',
          },
          {
            sequence_number: 3,
            text: 'The item arrived damaged. I want a full refund for item 3.',
          },
        ],
      });
      return {
        statusCode: 200,
        body: {
          status: 'awaiting_refund_details',
          customer_answer: { message: 'Please share a photo of the damaged item.' },
        },
      };
    },
    appendAssistantMessage: async () => acceptedMessageResponse('assistant-message-4', 4),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-history-1',
    },
    payload: {
      client_message_id: 'client-message-history-1',
      content: {
        type: 'text',
        text: 'The item arrived damaged. I want a full refund for item 3.',
      },
    },
  });

  assert.equal(response.statusCode, 202);
});

test('does not start a workflow while refund details are still missing', async (context) => {
  let workflowStarted = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-1', 1),
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'The item was damaged.',
    ),
    intakeRefund: async () => ({
      statusCode: 200,
      body: {
        status: 'awaiting_refund_details',
        customer_answer: {
          message: 'Please provide a photo of the damaged item.',
        },
      },
    }),
    appendAssistantMessage: async (input) => {
      assert.equal(input.text, 'Please provide a photo of the damaged item.');
      return acceptedMessageResponse('assistant-message-1', 2);
    },
    startRefundWorkflow: async () => {
      workflowStarted = true;
      return { workflowId: 'should-not-start' };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-2',
    },
    payload: {
      client_message_id: 'client-message-2',
      content: { type: 'text', text: 'The item was damaged.' },
      order_reference: 'ORDER-123',
    },
  });

  assert.equal(response.statusCode, 202);
  assert.equal(workflowStarted, false);
  assert.deepEqual(response.json(), {
    conversation_id: TEST_CONVERSATION_ID,
    customer_message_id: 'customer-message-1',
    assistant_message: {
      message_id: 'assistant-message-1',
      content: {
        type: 'text',
        text: 'Please provide a photo of the damaged item.',
      },
    },
  });
});

test('persists the deterministic order-reference reply without starting a workflow', async (context) => {
  let workflowStarted = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-1', 1),
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'I need help with a refund.',
    ),
    intakeRefund: async () => ({
      statusCode: 200,
      body: {
        status: 'awaiting_order_reference',
        customer_answer: {
          message: 'Please share your order reference so I can look into this refund request.',
        },
      },
    }),
    appendAssistantMessage: async (input) => {
      assert.equal(
        input.text,
        'Please share your order reference so I can look into this refund request.',
      );
      return acceptedMessageResponse('assistant-message-1', 2);
    },
    startRefundWorkflow: async () => {
      workflowStarted = true;
      return { workflowId: 'should-not-start' };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-need-order-reference',
    },
    payload: {
      client_message_id: 'client-message-need-order-reference',
      content: { type: 'text', text: 'I need help with a refund.' },
    },
  });

  assert.equal(response.statusCode, 202);
  assert.equal(workflowStarted, false);
  assert.equal(
    response.json().assistant_message.content.text,
    'Please share your order reference so I can look into this refund request.',
  );
});

test('does not append a fake assistant message when the agent fails after customer acceptance', async (context) => {
  let assistantAppendCalled = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-1', 1),
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'I need a refund.',
    ),
    intakeRefund: async () => {
      throw new Error('agent unavailable');
    },
    appendAssistantMessage: async () => {
      assistantAppendCalled = true;
      return acceptedMessageResponse('assistant-message-1', 2);
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-3',
    },
    payload: {
      client_message_id: 'client-message-3',
      content: { type: 'text', text: 'I need a refund.' },
      order_reference: 'ORDER-123',
    },
  });

  assert.equal(response.statusCode, 502);
  assert.equal(assistantAppendCalled, false);
  assert.deepEqual(response.json(), {
    error: {
      code: 'agent_runtime_unavailable',
      message: 'Agent Runtime request failed',
    },
  });
});

test('returns a retryable customer error when refund intent extraction is unavailable', async (context) => {
  let assistantAppendCalled = false;
  let workflowStarted = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-1', 1),
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'I need a refund for order ORDER-123.',
    ),
    intakeRefund: async () => ({
      statusCode: 200,
      body: {
        customer_message: 'I need a refund for order ORDER-123.',
        order_reference: 'ORDER-123',
        journey: 'refund',
        status: 'intent_extraction_unavailable',
        error_code: 'intent_extraction_unavailable',
      },
    }),
    appendAssistantMessage: async () => {
      assistantAppendCalled = true;
      return acceptedMessageResponse('assistant-message-1', 2);
    },
    startRefundWorkflow: async () => {
      workflowStarted = true;
      return { workflowId: 'should-not-start' };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-intent-unavailable',
    },
    payload: {
      client_message_id: 'client-message-intent-unavailable',
      content: {
        type: 'text',
        text: 'I need a refund for order ORDER-123.',
      },
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(assistantAppendCalled, false);
  assert.equal(workflowStarted, false);
  assert.deepEqual(response.json(), {
    error: {
      code: 'refund_intent_unavailable',
      message: 'We could not understand your refund request right now. Please try again.',
    },
  });
});

test('returns a retryable customer error when authoritative order lookup is unavailable', async (context) => {
  let assistantAppendCalled = false;
  let workflowStarted = false;
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-1', 1),
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'I need a refund for order ORDER-123.',
    ),
    intakeRefund: async () => ({
      statusCode: 200,
      body: {
        customer_message: 'I need a refund for order ORDER-123.',
        order_reference: 'ORDER-123',
        journey: 'refund',
        status: 'order_lookup_unavailable',
        error_code: 'invalid_order_context',
      },
    }),
    appendAssistantMessage: async () => {
      assistantAppendCalled = true;
      return acceptedMessageResponse('assistant-message-1', 2);
    },
    startRefundWorkflow: async () => {
      workflowStarted = true;
      return { workflowId: 'should-not-start' };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-order-lookup-unavailable',
    },
    payload: {
      client_message_id: 'client-message-order-lookup-unavailable',
      content: {
        type: 'text',
        text: 'I need a refund for order ORDER-123.',
      },
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(assistantAppendCalled, false);
  assert.equal(workflowStarted, false);
  assert.deepEqual(response.json(), {
    error: {
      code: 'order_lookup_unavailable',
      message: 'We could not retrieve your order right now. Please try again.',
    },
  });
});

test('returns a stable error when assistant persistence fails', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'gateway-context',
    signAgentRuntimeContextAssertion: async () => 'agent-context',
    signKnowledgeRagContextAssertion: async () => 'rag-context',
    signConversationRuntimeContextAssertion: async () => 'conversation-context',
    signEdgeServiceAssertion: async () => 'service-context',
    acceptCustomerMessage: async () => acceptedMessageResponse('customer-message-1', 1),
    getConversation: async () => acceptedCustomerConversation(
      'customer-message-1',
      1,
      'I need a refund.',
    ),
    intakeRefund: async () => readyAgentResponse,
    appendAssistantMessage: async () => ({
      statusCode: 500,
      body: { error: { internal_detail: 'database stack trace' } },
    }),
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      authorization: 'Bearer customer-access-token',
      'idempotency-key': 'browser-message-4',
    },
    payload: {
      client_message_id: 'client-message-4',
      content: { type: 'text', text: 'I need a refund.' },
      order_reference: 'ORDER-123',
    },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: {
      code: 'conversation_runtime_unavailable',
      message: 'Conversation service is temporarily unavailable',
    },
  });
});

test('starts a durable refund workflow only for a complete proposal', async (context) => {
  const correlationIds = ['request-1', 'trace-1'];
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    signAgentRuntimeContextAssertion: async () => 'agent-runtime-context',
    signKnowledgeRagContextAssertion: async () => 'knowledge-rag-context',
    intakeRefund: async () => ({
      statusCode: 200,
      body: {
      status: 'refund_proposal_ready',
      refund_proposal: {
          schemaVersion: '1',
          resultType: 'JOURNEY_PROPOSAL',
          proposalId: 'proposal-001',
          journeyType: 'REFUND',
          turnId: 'turn-001',
          missingFields: [],
          evidenceIds: ['order-observation-001'],
          executionEvidence: {
            executionId: 'execution-001',
          },
          intent: {
            orderId: 'ORDER-123',
            reasonCode: 'DAMAGED',
            scope: 'FULL_ORDER',
            itemIds: [],
            requestedAmount: { amountMinor: 5_000, currency: 'USD' },
          },
        },
      },
    }),
    startRefundWorkflow: async (input) => {
      assert.deepEqual(input, {
        workflowId: 'refund-proposal-001',
        orderReference: 'ORDER-123',
        policyVersion: 'refund-policy-v1',
        proposal: {
          proposalId: 'proposal-001',
          journeyType: 'REFUND',
          intent: {
            orderId: 'ORDER-123',
            reasonCode: 'DAMAGED',
            scope: 'FULL_ORDER',
            itemIds: [],
            requestedAmount: { amountMinor: 5_000, currency: 'USD' },
          },
        },
        access: {
          tenantId: 'tenant-local',
          environmentId: 'local',
          subjectCustomerId: 'customer-42',
          requestId: 'request-1',
          traceId: 'trace-1',
        },
      });
      return { workflowId: input.workflowId };
    },
    createCorrelationId: () => {
      const id = correlationIds.shift();
      assert.ok(id);
      return id;
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/intake',
    headers: { authorization: 'Bearer customer-access-token' },
    payload: {
      customer_message: 'Refund my damaged order.',
      order_reference: 'ORDER-123',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().refund_workflow, {
    workflow_id: 'refund-proposal-001',
    status: 'started',
  });
});
