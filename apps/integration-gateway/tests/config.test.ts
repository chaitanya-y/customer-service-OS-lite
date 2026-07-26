import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';

test('loadConfig applies local server defaults', () => {
  const config = loadConfig({
    VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
    VENDURE_API_KEY: 'test-api-key',
  });

  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.PORT, 3002);
});

test('loadConfig rejects an empty Vendure API key', () => {
  assert.throws(() =>
    loadConfig({
      VENDURE_ADMIN_API_URL: 'http://localhost:3001/admin-api',
      VENDURE_API_KEY: '',
    }),
  );
});
