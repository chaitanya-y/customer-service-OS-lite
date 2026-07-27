import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { GetOrderContext } from './get-order-context.js';

type McpServerDependencies = {
  getOrderContext: GetOrderContext;
};

function toolResult(
  payload: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function createIntegrationMcpServer({
  getOrderContext,
}: McpServerDependencies): McpServer {
  const server = new McpServer({
    name: 'customer-service-os-integration-gateway',
    version: '0.1.0',
  });

  server.registerTool(
    'lookup_order',
    {
      title: 'Look up order',
      description:
        'Read an order by reference and return an authorization-filtered order context.',
      inputSchema: {
        orderReference: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe('Customer-facing order reference'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ orderReference }) => {
      try {
        const orderContext = await getOrderContext(orderReference);

        if (!orderContext) {
          return toolResult(
            {
              error: {
                code: 'order_not_found',
                message: 'Order was not found',
              },
            },
            true,
          );
        }

        return toolResult(orderContext);
      } catch {
        return toolResult(
          {
            error: {
              code: 'commerce_provider_unavailable',
              message: 'Commerce provider request failed',
            },
          },
          true,
        );
      }
    },
  );

  return server;
}
