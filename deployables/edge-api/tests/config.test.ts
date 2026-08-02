import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  TENANT_ID: 'tenant-local',
  ENVIRONMENT_ID: 'local',
  LOCAL_AUTH_HMAC_SECRET: 'local-auth-secret-at-least-32-bytes',
  CONTEXT_ASSERTION_HMAC_SECRET:
    'context-assertion-secret-at-least-32-bytes',
};

test('loads safe local defaults', () => {
  const config = loadConfig(BASE_ENV);

  assert.equal(config.AUTH_MODE, 'local');
  assert.equal(config.PORT, 3000);
  assert.equal(config.AGENT_RUNTIME_BASE_URL, 'http://127.0.0.1:8000');
});

test('refuses local authentication in production', () => {
  assert.throws(
    () => loadConfig({ ...BASE_ENV, NODE_ENV: 'production' }),
    /Local authentication cannot run in production/,
  );
});

test('requires separate local-auth and context-signing keys', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        CONTEXT_ASSERTION_HMAC_SECRET: BASE_ENV.LOCAL_AUTH_HMAC_SECRET,
      }),
    /Local authentication and context signing require separate keys/,
  );
});
