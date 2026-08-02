import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentRuntimeUnavailableError,
  createAgentRuntimeClient,
} from '../src/agent-runtime-client.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/context-assertion.js';

test('forwards the refund request and context assertion', async () => {
  const client = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime:8000',
    fetchImpl: async (input, init) => {
      assert.equal(input.toString(), 'http://agent-runtime:8000/refunds/intake');
      assert.equal(init?.method, 'POST');
      assert.equal(
        new Headers(init?.headers).get(CONTEXT_ASSERTION_HEADER),
        'signed-context',
      );
      assert.equal(
        init?.body,
        JSON.stringify({
          customer_message: 'Please refund my order.',
          order_reference: 'ORDER-123',
        }),
      );

      return Response.json({ status: 'order_context_loaded' }, { status: 200 });
    },
  });

  assert.deepEqual(
    await client.intakeRefund(
      {
        customer_message: 'Please refund my order.',
        order_reference: 'ORDER-123',
      },
      'signed-context',
    ),
    {
      statusCode: 200,
      body: { status: 'order_context_loaded' },
    },
  );
});

test('maps transport failures to a stable client error', async () => {
  const client = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime:8000',
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  await assert.rejects(
    () => client.intakeRefund({ customer_message: 'Refund it.' }, 'context'),
    AgentRuntimeUnavailableError,
  );
});
