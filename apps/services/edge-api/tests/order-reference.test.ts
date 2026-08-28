import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveOrderReference } from '../src/order-reference.js';

test('keeps an explicit order reference', () => {
  assert.equal(
    resolveOrderReference({
      customerMessage: 'Refund order AVV8JSZH8G6ZZDMX because it arrived damaged.',
      explicitOrderReference: 'ORDER-123',
    }),
    'ORDER-123',
  );
});

test('extracts one unambiguous code-like order reference from customer text', () => {
  assert.equal(
    resolveOrderReference({
      customerMessage: 'I want a refund for order avv8jszh8g6zzdmx. It arrived damaged.',
    }),
    'AVV8JSZH8G6ZZDMX',
  );
});

test('does not infer an order reference from ambiguous or ordinary text', () => {
  assert.equal(
    resolveOrderReference({
      customerMessage: 'Please refund order AVV8JSZH8G6ZZDMX or QXB4NEW2EPG6YJ7Q.',
    }),
    undefined,
  );
  assert.equal(
    resolveOrderReference({ customerMessage: 'I need a refund because my item is damaged.' }),
    undefined,
  );
});
