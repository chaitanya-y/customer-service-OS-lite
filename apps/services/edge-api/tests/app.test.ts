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
