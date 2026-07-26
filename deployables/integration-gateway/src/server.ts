import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createVendureCommerceProvider } from './vendure-client.js';

const config = loadConfig();
const commerceProvider = createVendureCommerceProvider({
  adminApiUrl: config.VENDURE_ADMIN_API_URL,
  apiKey: config.VENDURE_API_KEY,
});
const app = buildApp({
  commerceProvider,
  logger: true,
});

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
