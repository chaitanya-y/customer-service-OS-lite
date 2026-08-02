import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance } from 'fastify';

import type { GetOrderContext } from './get-order-context.js';
import { createIntegrationMcpServer } from './mcp-server.js';
import {
  CONTEXT_ASSERTION_HEADER,
  type OrderAccessContext,
  type VerifyContextAssertion,
} from './trusted-context.js';

const methodNotAllowedResponse = {
  jsonrpc: '2.0',
  error: {
    code: -32_000,
    message: 'Method not allowed',
  },
  id: null,
};

export function registerMcpRoutes(
  app: FastifyInstance,
  getOrderContext: GetOrderContext,
  verifyContextAssertion: VerifyContextAssertion,
): void {
  app.post('/mcp', async (request, reply) => {
    let accessContext: OrderAccessContext | null = null;
    const assertion = request.headers[CONTEXT_ASSERTION_HEADER];

    try {
      accessContext = await verifyContextAssertion(
        typeof assertion === 'string' ? assertion : undefined,
      );
    } catch {
      accessContext = null;
    }

    const server = createIntegrationMcpServer({
      getOrderContext,
      accessContext,
    });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    reply.hijack();

    try {
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, 'MCP request failed');

      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, {
          'content-type': 'application/json',
        });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32_603,
              message: 'Internal server error',
            },
            id: null,
          }),
        );
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.get('/mcp', async (_request, reply) =>
    reply.code(405).send(methodNotAllowedResponse),
  );

  app.delete('/mcp', async (_request, reply) =>
    reply.code(405).send(methodNotAllowedResponse),
  );
}
