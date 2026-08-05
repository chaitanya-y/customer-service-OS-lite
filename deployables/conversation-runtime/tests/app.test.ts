import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { IdempotencyConflictError } from '../src/conversation-service.js';
import { ContextAssertionError } from '../src/trusted-context.js';
import {
  createTestConversationService,
  FakeConversationRepository,
  TEST_CONTEXT,
  TEST_CONVERSATION_ID,
  TEST_MESSAGE_ID,
} from './test-fixtures.js';

test('health reports database readiness', async (context) => {
  const repository = new FakeConversationRepository();
  const app = buildApp({
    verifyContextAssertion: async () => TEST_CONTEXT,
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
