import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRefundJourneyUpdateEvent,
  formatSseEvent,
  refundJourneyFingerprint,
  toRefundJourneyView,
} from '../src/refund-journey-view.js';
import type { RefundEvidenceSummary } from '../src/refund-evidence-client.js';

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

test('unavailable previews have no current or upcoming refund steps', () => {
  const journey = toRefundJourneyView('refund-001', { stage: 'PREVIEW_INVALIDATED' });
  assert.deepEqual(journey.timeline.map(step => step.status), ['COMPLETED', 'SKIPPED']);
});

test('takeover without a preview does not claim preview preparation completed', () => {
  const journey = toRefundJourneyView('refund-001', { stage: 'HUMAN_TAKEOVER_REQUIRED' });
  assert.equal(journey.timeline.find(step => step.id === 'PREVIEW_READY')?.status, 'PENDING');
  assert.equal(journey.timeline[1]?.id, 'SPECIALIST_REVIEW');
});

test('projects an invalidated preview as unavailable with no confirmation or internal decision facts', () => {
  const workflow = {
    stage: 'PREVIEW_INVALIDATED',
    preview: {
      previewId: 'preview-expiry-test',
      requestedAmount: { amountMinor: 5_309, currency: 'USD' },
      refundDestination: 'ORIGINAL_PAYMENT_METHOD',
      validUntil: '2026-09-10T12:00:00.000Z',
      inputFactsHash: 'private-facts-hash',
      decisionId: 'private-decision-id',
    },
    decision: { reasonCodes: ['INTERNAL_DECISION_REASON'] },
  };
  const journey = toRefundJourneyView('refund-expiry-test', workflow);

  assert.equal(journey.stage, 'PREVIEW_EXPIRED');
  assert.deepEqual(journey.next_action, { type: 'NONE', label: 'No action is needed' });
  assert.deepEqual(journey.preview, {
    preview_id: 'preview-expiry-test',
    amount: { amount_minor: 5_309, currency: 'USD' },
    refund_destination: 'ORIGINAL_PAYMENT_METHOD',
    valid_until: '2026-09-10T12:00:00.000Z',
  });
  assert.equal(Object.hasOwn(journey, 'decision'), false);
  for (const internalValue of ['PREVIEW_INVALIDATED', 'private-facts-hash', 'private-decision-id', 'INTERNAL_DECISION_REASON']) {
    assert.equal(JSON.stringify(journey).includes(internalValue), false);
  }
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

test('evidence-only revisions change the SSE fingerprint without advancing workflow stage', () => {
  const evidence: RefundEvidenceSummary = { version: 'v1', requirement: 'DAMAGE_PHOTO', evidence_version: 1, assessment: 'UNREVIEWED', can_upload: true,
    attachments: [{ evidence_id: '00000000-0000-4000-8000-000000000001', display_label: 'Photo 1', content_type: 'image/png', byte_size: 50, uploaded_at: '2026-09-05T12:00:00Z', technical_status: 'PROCESSING' }] };
  const workflow = { stage: 'AWAITING_EVIDENCE_REVIEW' };
  const before = refundJourneyFingerprint('refund-1', workflow, evidence);
  const after = refundJourneyFingerprint('refund-1', workflow, { ...evidence, evidence_version: 2, attachments: [{ ...evidence.attachments[0]!, technical_status: 'READY', width: 1, height: 1 }] });
  assert.notEqual(before, after);
  const journey = toRefundJourneyView('refund-1', workflow, evidence);
  assert.equal(journey.next_action.type, 'WAIT_FOR_SPECIALIST');
  assert.equal(journey.evidence?.can_upload, true);
  assert.equal(journey.timeline.find(event => event.id === 'PREVIEW_READY')?.status, 'PENDING');
});

test('photo collection expiry disables uploads and skips preview and money steps', () => {
  const evidence: RefundEvidenceSummary = { version: 'v1', requirement: 'DAMAGE_PHOTO', evidence_version: 0, assessment: 'UNREVIEWED', can_upload: true, attachments: [] };
  const journey = toRefundJourneyView('refund-1', { stage: 'EVIDENCE_COLLECTION_EXPIRED' }, evidence);
  assert.equal(journey.stage, 'EVIDENCE_COLLECTION_EXPIRED'); assert.equal(journey.evidence?.can_upload, false);
  assert.equal(journey.next_action.type, 'NONE'); assert.equal(journey.preview, undefined);
  for (const event of journey.timeline.filter(event => event.id !== 'REQUEST_RECEIVED')) assert.equal(event.status, 'SKIPPED');
});
