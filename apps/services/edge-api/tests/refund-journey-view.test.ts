import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRefundJourneyUpdateEvent,
  formatSseEvent,
  toRefundJourneyView,
} from '../src/refund-journey-view.js';

test('projects an approval workflow into a customer-safe journey view', () => {
  const journey = toRefundJourneyView('refund-001', {
    stage: 'AWAITING_APPROVAL',
    preview: {
      previewId: 'preview-001',
      requestedAmount: { amountMinor: 5_000, currency: 'USD' },
      refundDestination: 'Original payment method',
      validUntil: '2026-08-25T10:00:00.000Z',
    },
  });

  assert.deepEqual(journey, {
    version: 'v1',
    workflow_id: 'refund-001',
    stage: 'SPECIALIST_REVIEWING',
    preview: {
      preview_id: 'preview-001',
      amount: { amount_minor: 5_000, currency: 'USD' },
      refund_destination: 'Original payment method',
      valid_until: '2026-08-25T10:00:00.000Z',
    },
    next_action: {
      type: 'WAIT_FOR_SPECIALIST',
      label: 'A specialist is reviewing your request',
    },
    timeline: [
      { id: 'REQUEST_RECEIVED', label: 'Refund request received', status: 'COMPLETED' },
      { id: 'PREVIEW_READY', label: 'Refund preview prepared', status: 'COMPLETED' },
      { id: 'SPECIALIST_REVIEW', label: 'Specialist review', status: 'CURRENT' },
      { id: 'REFUND_PROCESSING', label: 'Refund processing', status: 'PENDING' },
      { id: 'COMPLETED', label: 'Refund completed', status: 'PENDING' },
    ],
  });
});

test('does not leak internal workflow fields into the customer journey view', () => {
  const journey = toRefundJourneyView('refund-001', {
    stage: 'REFUND_SUCCEEDED',
    preview: {
      previewId: 'preview-001',
      requestedAmount: { amountMinor: 5_000, currency: 'USD' },
      refundDestination: 'Original payment method',
      validUntil: '2026-08-25T10:00:00.000Z',
    },
    decision: { reasonCodes: ['INTERNAL_ONLY'] },
    providerRefundId: 'provider-refund-001',
  } as never);

  assert.equal(JSON.stringify(journey).includes('INTERNAL_ONLY'), false);
  assert.equal(JSON.stringify(journey).includes('provider-refund-001'), false);
});

test('shows completed specialist review and skipped refund steps for a resolved takeover', () => {
  const journey = toRefundJourneyView('refund-001', { stage: 'TAKEOVER_RESOLVED' });

  assert.deepEqual(journey.timeline, [
    { id: 'REQUEST_RECEIVED', label: 'Refund request received', status: 'COMPLETED' },
    { id: 'PREVIEW_READY', label: 'Refund preview prepared', status: 'SKIPPED' },
    { id: 'SPECIALIST_REVIEW', label: 'Specialist review', status: 'COMPLETED' },
    { id: 'REFUND_PROCESSING', label: 'Refund processing', status: 'SKIPPED' },
    { id: 'COMPLETED', label: 'Refund completed', status: 'SKIPPED' },
  ]);
});

test('formats an SSE wake-up event without journey details', () => {
  const event = createRefundJourneyUpdateEvent(
    'refund-001',
    'refund-001:1',
    '2026-08-24T12:00:00.000Z',
  );

  assert.equal(formatSseEvent(event), [
    'id: refund-001:1',
    'event: refund_journey_updated',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n'));
  assert.equal(formatSseEvent(event).includes('SPECIALIST_REVIEWING'), false);
});
