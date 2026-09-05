import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentRuntimeUnavailableError,
  createAgentRuntimeClient,
} from '../src/agent-runtime-client.js';
import {
  AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
  CONTEXT_ASSERTION_HEADER,
  KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
} from '../src/context-assertion.js';

test('forwards the refund request and audience-specific context assertions', async () => {
  const client = createAgentRuntimeClient({
    baseUrl: 'http://agent-runtime:8000',
    fetchImpl: async (input, init) => {
      assert.equal(input.toString(), 'http://agent-runtime:8000/refunds/intake');
      assert.equal(init?.method, 'POST');
      assert.equal(
        new Headers(init?.headers).get(CONTEXT_ASSERTION_HEADER),
        'gateway-context',
      );
      assert.equal(
        new Headers(init?.headers).get(
          AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
        ),
        'agent-runtime-context',
      );
      assert.equal(
        new Headers(init?.headers).get(
          KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
        ),
        'knowledge-rag-context',
      );
      assert.equal(
        init?.body,
        JSON.stringify({
          customer_message: 'Please refund my order.',
          order_reference: 'ORDER-123',
          conversation_messages: [
            { sequence_number: 1, text: 'Please refund my order.' },
          ],
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
        conversation_messages: [
          { sequence_number: 1, text: 'Please refund my order.' },
        ],
      },
      {
        agentRuntime: 'agent-runtime-context',
        integrationGateway: 'gateway-context',
        knowledgeRag: 'knowledge-rag-context',
      },
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
    () =>
      client.intakeRefund(
        { customer_message: 'Refund it.' },
        {
          agentRuntime: 'agent-runtime-context',
          integrationGateway: 'gateway-context',
          knowledgeRag: 'knowledge-rag-context',
        },
      ),
    AgentRuntimeUnavailableError,
  );
});
