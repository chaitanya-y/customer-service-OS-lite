import Fastify, { type FastifyInstance } from 'fastify';

import type { CommerceProvider } from './commerce.js';
import { registerOrderRoutes } from './order-routes.js';

type BuildAppOptions = {
  commerceProvider: CommerceProvider;
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

  registerOrderRoutes(app, options.commerceProvider);

  return app;
}
