import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveOrderReference,
  resolveOrderReferenceFromCustomerMessages,
} from '../src/order-reference.js';

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

test('carries forward the most recent unambiguous customer order reference', () => {
  assert.equal(
    resolveOrderReferenceFromCustomerMessages({
      customerMessages: [
        { text: 'My order is AVV8JSZH8G6ZZDMX.' },
        { text: 'The item arrived damaged and I want a full refund.' },
      ],
      explicitOrderReference: undefined,
    }),
    'AVV8JSZH8G6ZZDMX',
  );
});

test('does not carry an older reference past a later ambiguous customer message', () => {
  assert.equal(
    resolveOrderReferenceFromCustomerMessages({
      customerMessages: [
        { text: 'My order is AVV8JSZH8G6ZZDMX.' },
        { text: 'Please refund AVV8JSZH8G6ZZDMX or QXB4NEW2EPG6YJ7Q.' },
      ],
      explicitOrderReference: undefined,
    }),
    undefined,
  );
});
