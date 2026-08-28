import { Pool } from 'pg';

import { buildApp } from './app.js';
import { decodeMessageEncryptionKey, loadConfig } from './config.js';
import { createConversationService } from './conversation-service.js';
import {
  createAesGcmMessageProtector,
  createAesGcmMessageUnprotector,
} from './message-protection.js';
import { PostgresConversationRepository } from './postgres-conversation-repository.js';
import { createHmacServiceAssertionVerifier } from './service-assertion.js';
import { createHmacContextAssertionVerifier } from './trusted-context.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const messageEncryptionKey = decodeMessageEncryptionKey(
  config.MESSAGE_ENCRYPTION_KEY_BASE64,
);
const repository = new PostgresConversationRepository(
  pool,
  createAesGcmMessageUnprotector({
    key: messageEncryptionKey,
    keyVersion: config.MESSAGE_ENCRYPTION_KEY_VERSION,
  }),
);
const conversationService = createConversationService({
  repository,
  protectMessage: createAesGcmMessageProtector({
    key: messageEncryptionKey,
    keyVersion: config.MESSAGE_ENCRYPTION_KEY_VERSION,
  }),
});
const verifyContextAssertion = createHmacContextAssertionVerifier({
  secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
  expectedIssuer: config.CONTEXT_ASSERTION_ISSUER,
  expectedAudience: config.CONTEXT_ASSERTION_AUDIENCE,
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const verifyServiceAssertion = createHmacServiceAssertionVerifier({
  secret: config.EDGE_SERVICE_ASSERTION_HMAC_SECRET,
  expectedIssuer: config.EDGE_SERVICE_ASSERTION_ISSUER,
  expectedAudience: config.EDGE_SERVICE_ASSERTION_AUDIENCE,
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const app = buildApp({
  verifyContextAssertion,
  verifyServiceAssertion,
  conversationService,
  checkHealth: () => repository.checkHealth(),
  logger: true,
});

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}

async function shutdown() {
  await app.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
