import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceProvider } from '../src/commerce.js';

const commerceProvider: CommerceProvider = {
  async getOrderByReference() {
    return null;
  },
};

test('GET /health reports that the gateway is healthy', async (context) => {
  const app = buildApp({ commerceProvider });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/health',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    service: 'integration-gateway',
    status: 'ok',
  });
});
