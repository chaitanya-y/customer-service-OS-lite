import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { buildApp } from '../src/app.js';
import type {
  CommerceOrder,
  CommerceProvider,
} from '../src/commerce.js';

const commerceOrder: CommerceOrder = {
  source: {
    provider: 'vendure',
    orderId: '3',
  },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: {
    id: 'customer-42',
    name: 'Private Customer',
    email: 'private@example.com',
  },
  total: {
    amountMinor: 10_000,
    currency: 'USD',
  },
  items: [],
  payments: [
    {
      id: 'payment-1',
      status: 'Settled',
      amount: {
        amountMinor: 10_000,
        currency: 'USD',
      },
      method: 'standard-payment',
      transactionReference: 'secret-transaction-reference',
    },
  ],
  fulfillments: [],
};

async function connectMcpClient(
  context: TestContext,
  commerceProvider: CommerceProvider,
): Promise<Client> {
  const app = buildApp({ commerceProvider });
  await app.listen({
    host: '127.0.0.1',
    port: 0,
  });
  context.after(() => app.close());

  const address = app.server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  const client = new Client({
    name: 'integration-gateway-test-client',
    version: '0.1.0',
  });
  await client.connect(transport);
  context.after(() => client.close());

  return client;
}

test('MCP lists and calls the read-only lookup_order tool', async (context) => {
  let receivedReference: string | undefined;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference(reference) {
      receivedReference = reference;
      return commerceOrder;
    },
  };
  const client = await connectMcpClient(context, commerceProvider);

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 1);
  assert.equal(tools.tools[0]?.name, 'lookup_order');
  assert.equal(tools.tools[0]?.title, 'Look up order');
  assert.deepEqual(tools.tools[0]?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: '  ORDER-123  ',
    },
  });

  assert.equal(receivedReference, 'ORDER-123');
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent?.reference, 'ORDER-123');
  assert.deepEqual(result.structuredContent?.customerRef, {
    customerId: 'customer-42',
  });

  const serializedResult = JSON.stringify(result);
  assert.doesNotMatch(serializedResult, /Private Customer/);
  assert.doesNotMatch(serializedResult, /private@example\.com/);
  assert.doesNotMatch(serializedResult, /secret-transaction-reference/);
});

test('lookup_order returns a stable error for an unknown order', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return null;
    },
  };
  const client = await connectMcpClient(context, commerceProvider);

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: 'MISSING',
    },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: {
      code: 'order_not_found',
      message: 'Order was not found',
    },
  });
});

test('lookup_order rejects an empty order reference', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      throw new Error('The provider should not be called');
    },
  };
  const client = await connectMcpClient(context, commerceProvider);

  const result = await client.callTool({
    name: 'lookup_order',
    arguments: {
      orderReference: '',
    },
  });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Invalid arguments/);
});
