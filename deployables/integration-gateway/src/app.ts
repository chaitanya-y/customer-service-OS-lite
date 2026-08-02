import Fastify, { type FastifyInstance } from 'fastify';

import type { CommerceProvider } from './commerce.js';
import { createGetOrderContext } from './get-order-context.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { registerOrderRoutes } from './order-routes.js';
import type { VerifyContextAssertion } from './trusted-context.js';

type BuildAppOptions = {
  commerceProvider: CommerceProvider;
  verifyContextAssertion: VerifyContextAssertion;
  logger?: boolean;
};

export function buildApp(
  options: BuildAppOptions,
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.get('/health', async () => ({
    service: 'integration-gateway',
    status: 'ok',
  }));

  const getOrderContext = createGetOrderContext({
    commerceProvider: options.commerceProvider,
  });

  registerOrderRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
  );
  registerMcpRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
  );

  return app;
}
