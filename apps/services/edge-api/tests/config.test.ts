import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  TENANT_ID: 'tenant-local',
  ENVIRONMENT_ID: 'local',
  LOCAL_AUTH_HMAC_SECRET: 'local-auth-secret-at-least-32-bytes',
  CONTEXT_ASSERTION_HMAC_SECRET:
    'context-assertion-secret-at-least-32-bytes',
  EDGE_SERVICE_ASSERTION_HMAC_SECRET:
    'edge-service-assertion-secret-at-least-32-bytes',
};

test('loads safe local defaults', () => {
  const config = loadConfig(BASE_ENV);

  assert.equal(config.AUTH_MODE, 'local');
  assert.equal(config.PORT, 3000);
  assert.equal(config.HUMAN_OPERATIONS_BASE_URL, 'http://127.0.0.1:3003');
  assert.equal(config.EVIDENCE_REQUEST_TIMEOUT_MILLISECONDS, 30_000);
  assert.equal(config.REFUND_POLICY_VERSION, 'refund-policy-v1');
  assert.equal(config.AGENT_RUNTIME_BASE_URL, 'http://127.0.0.1:8000');
  assert.equal(config.AGENT_RUNTIME_TIMEOUT_MILLISECONDS, 60_000);
  assert.equal(
    config.CONVERSATION_RUNTIME_BASE_URL,
    'http://127.0.0.1:3004',
  );
  assert.equal(config.CONVERSATION_RUNTIME_TIMEOUT_MILLISECONDS, 15_000);
  assert.equal(
    config.AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE,
    'agent-runtime',
  );
  assert.equal(
    config.KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE,
    'knowledge-rag',
  );
  assert.equal(
    config.CONVERSATION_RUNTIME_CONTEXT_ASSERTION_AUDIENCE,
    'conversation-runtime',
  );
});

test('loads a configured Agent Runtime timeout', () => {
  const config = loadConfig({
    ...BASE_ENV,
    AGENT_RUNTIME_TIMEOUT_MILLISECONDS: '45000',
  });

  assert.equal(config.AGENT_RUNTIME_TIMEOUT_MILLISECONDS, 45_000);
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

test('requires a distinct Edge service assertion key', () => {
  assert.throws(
    () =>
      loadConfig({
        ...BASE_ENV,
        EDGE_SERVICE_ASSERTION_HMAC_SECRET:
          BASE_ENV.CONTEXT_ASSERTION_HMAC_SECRET,
      }),
    /Edge service assertions require a separate key/,
  );
});
