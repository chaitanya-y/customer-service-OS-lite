import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import {
  ConversationUnavailableError,
  IdempotencyConflictError,
} from '../src/conversation-service.js';
import { ServiceAssertionError } from '../src/service-assertion.js';
import { ContextAssertionError } from '../src/trusted-context.js';
import {
  createTestConversationService,
  FakeConversationRepository,
  TEST_CONTEXT,
  TEST_CONVERSATION_ID,
  TEST_MESSAGE_ID,
  TEST_SERVICE_CONTEXT,
} from './test-fixtures.js';

test('health reports database readiness', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    service: 'conversation-runtime',
    status: 'ok',
  });
});

test('creates an idempotent customer conversation', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async (assertion) => {
      assert.equal(assertion, 'signed-context');
      return TEST_CONTEXT;
    },
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: {
      'x-cso-context-assertion': 'signed-context',
      'idempotency-key': 'create-1',
    },
    payload: { channel: 'web' },
  });

  assert.equal(response.statusCode, 201);
  assert.deepEqual(response.json(), {
    data: {
      conversationId: TEST_CONVERSATION_ID,
      status: 'OPEN',
      controlMode: 'AI',
    },
    meta: {
      requestId: 'request-1',
      apiVersion: '2026-08-05',
    },
  });
});

test('durably accepts a message without waiting for AI work', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      'x-cso-context-assertion': 'signed-context',
      'idempotency-key': 'message-1',
    },
    payload: {
      clientMessageId: 'browser-message-1',
      content: { type: 'text', text: '  Please refund me.  ' },
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    data: {
      conversationId: TEST_CONVERSATION_ID,
      messageId: TEST_MESSAGE_ID,
      sequenceNumber: 1,
      status: 'ACCEPTED',
    },
    meta: {
      requestId: 'request-1',
      apiVersion: '2026-08-05',
    },
  });
  assert.equal(repository.messageRecord?.protectedMessage.plaintextByteLength, 17);
});

test('rejects a mutation without an idempotency key', async (context) => {
  let verificationCalled = false;
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => {
      verificationCalled = true;
      return TEST_CONTEXT;
    },
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: { 'x-cso-context-assertion': 'signed-context' },
    payload: {
      clientMessageId: 'browser-message-1',
      content: { type: 'text', text: 'Please refund me.' },
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'INVALID_MESSAGE_REQUEST');
  assert.equal(verificationCalled, false);
});

test('rejects an invalid trusted context without exposing details', async (
  context,
) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => {
      throw new ContextAssertionError();
    },
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: {
      'x-cso-context-assertion': 'invalid-context',
      'idempotency-key': 'create-1',
    },
    payload: { channel: 'web' },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: {
      code: 'CONTEXT_UNAUTHORIZED',
      message: 'Trusted context is required',
      retryable: false,
    },
  });
});

test('returns a stable conflict for idempotency-key reuse', async (context) => {
  const repository = new FakeConversationRepository();
  repository.messageError = new IdempotencyConflictError();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages`,
    headers: {
      'x-cso-context-assertion': 'signed-context',
      'idempotency-key': 'message-1',
    },
    payload: {
      clientMessageId: 'browser-message-1',
      content: { type: 'text', text: 'Please refund me.' },
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, 'IDEMPOTENCY_CONFLICT');
});

test('returns a customer-safe ordered transcript to its owner', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async (assertion) => {
      assert.equal(assertion, 'signed-context');
      return TEST_CONTEXT;
    },
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}`,
    headers: { 'x-cso-context-assertion': 'signed-context' },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    data: repository.transcript,
    meta: {
      requestId: 'request-1',
      apiVersion: '2026-08-05',
    },
  });
  assert.equal(JSON.stringify(response.json()).includes('ciphertext'), false);
});

test('does not reveal a conversation to another customer', async (context) => {
  const repository = new FakeConversationRepository();
  repository.transcriptError = new ConversationUnavailableError();
  const app = buildApp({
    verifyContextAssertion: async () => ({
      ...TEST_CONTEXT,
      subjectCustomerId: 'customer-other',
    }),
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}`,
    headers: { 'x-cso-context-assertion': 'signed-other-customer' },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'CONVERSATION_NOT_FOUND');
});

test('requires an Edge service assertion to append an assistant message', async (
  context,
) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async () => {
      throw new ServiceAssertionError();
    },
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/internal/conversations/${TEST_CONVERSATION_ID}/assistant-messages`,
    headers: {
      'idempotency-key': 'assistant-message-1',
      'x-cso-service-assertion': 'customer-context-must-not-work',
    },
    payload: {
      client_message_id: 'agent-turn-1',
      content: { type: 'text', text: 'I can help with that.' },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'SERVICE_UNAUTHORIZED');
});

test('appends a service-authenticated assistant message', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async (assertion) => {
      assert.equal(assertion, 'signed-edge-service');
      return TEST_SERVICE_CONTEXT;
    },
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/internal/conversations/${TEST_CONVERSATION_ID}/assistant-messages`,
    headers: {
      'idempotency-key': 'assistant-message-1',
      'x-cso-service-assertion': 'signed-edge-service',
    },
    payload: {
      client_message_id: 'agent-turn-1',
      content: { type: 'text', text: 'I can help with that.' },
    },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json().data, {
    conversationId: TEST_CONVERSATION_ID,
    messageId: '019c321e-8650-7000-8000-000000000003',
    sequenceNumber: 2,
    status: 'ACCEPTED',
  });
  assert.equal(
    repository.assistantMessageRecord?.context.subjectCustomerId,
    'customer-42',
  );
});

test('links a refund workflow to a service-authenticated assistant message', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async (assertion) => {
      assert.equal(assertion, 'signed-edge-service');
      return TEST_SERVICE_CONTEXT;
    },
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/internal/conversations/${TEST_CONVERSATION_ID}/messages/019c321e-8650-7000-8000-000000000003/refund-workflow`,
    headers: {
      'idempotency-key': 'assistant-workflow-link-1',
      'x-cso-service-assertion': 'signed-edge-service',
    },
    payload: { workflow_id: 'refund-proposal-001' },
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json().data, {
    conversationId: TEST_CONVERSATION_ID,
    messageId: '019c321e-8650-7000-8000-000000000003',
    workflowId: 'refund-proposal-001',
    status: 'LINKED',
  });
});
