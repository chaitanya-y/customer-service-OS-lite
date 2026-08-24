import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeMessageEncryptionKey, loadConfig } from '../src/config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://localhost/customer_service_os',
  TENANT_ID: 'tenant-local',
  ENVIRONMENT_ID: 'local',
  CONTEXT_ASSERTION_HMAC_SECRET:
    'context-assertion-secret-at-least-32-bytes',
  MESSAGE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
};

test('loads safe Conversation Runtime defaults', () => {
  const config = loadConfig(BASE_ENV);

  assert.equal(config.PORT, 3003);
  assert.equal(config.CONTEXT_ASSERTION_AUDIENCE, 'conversation-runtime');
  assert.equal(config.MESSAGE_ENCRYPTION_KEY_VERSION, 'local-v1');
});

test('accepts only an exact 32-byte base64 message key', () => {
  const encoded = Buffer.alloc(32, 9).toString('base64');

  assert.deepEqual(decodeMessageEncryptionKey(encoded), Buffer.alloc(32, 9));
  assert.throws(
    () => decodeMessageEncryptionKey(Buffer.alloc(31).toString('base64')),
    /exactly 32 bytes/,
  );
});
