import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';

const TEST_IDENTITY = {
  principalId: 'customer-42',
  tenantId: 'tenant-local',
  environmentId: 'local',
  customerId: 'customer-42',
};

test('health reports the Edge API is ready', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => TEST_IDENTITY,
    signContextAssertion: async () => 'signed-context',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
  });
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { service: 'edge-api', status: 'ok' });
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
    intakeRefund: async (request, assertion) => {
      assert.deepEqual(request, {
        customer_message: 'Please refund my order.',
        order_reference: 'ORDER-123',
      });
      assert.equal(assertion, 'signed-context');
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
