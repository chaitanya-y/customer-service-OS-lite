import type { RefundWorkflowView } from './temporal-refund-client.js';
import { refundEvidenceSummarySchema, type RefundEvidenceSummary } from './refund-evidence-client.js';

export const REFUND_JOURNEY_VIEW_VERSION = 'v1';

export type RefundJourneyView = Readonly<{
  version: typeof REFUND_JOURNEY_VIEW_VERSION;
  workflow_id: string;
  stage:
    | 'REQUEST_RECEIVED'
    | 'REFUND_PREVIEW_READY'
    | 'SPECIALIST_REVIEWING'
    | 'REFUND_PROCESSING'
    | 'REFUND_COMPLETED'
    | 'MORE_INFORMATION_NEEDED'
    | 'REFUND_NOT_APPROVED'
    | 'REFUND_CANCELLED'
    | 'PREVIEW_EXPIRED'
    | 'REFUND_FAILED'
    | 'REQUEST_RESOLVED'
    | 'AWAITING_CUSTOMER_EVIDENCE'
    | 'AWAITING_EVIDENCE_REVIEW'
    | 'EVIDENCE_COLLECTION_EXPIRED';
  evidence?: RefundEvidenceSummary;
  preview?: Readonly<{
    preview_id: string;
    amount: Readonly<{ amount_minor: number; currency: string }>;
    refund_destination: string;
    valid_until: string;
  }>;
  next_action: Readonly<{
    type:
      | 'CONFIRM_REFUND'
      | 'WAIT_FOR_SPECIALIST'
      | 'WAIT_FOR_REFUND'
      | 'CONTACT_SUPPORT'
      | 'PROVIDE_EVIDENCE'
      | 'NONE';
    label: string;
  }>;
  timeline: readonly Readonly<{
    id: 'REQUEST_RECEIVED' | 'PREVIEW_READY' | 'SPECIALIST_REVIEW' | 'REFUND_PROCESSING' | 'COMPLETED';
    label: string;
    status: 'COMPLETED' | 'CURRENT' | 'PENDING' | 'SKIPPED';
  }>[];
}>;

export type RefundJourneyUpdateEvent = Readonly<{
  version: typeof REFUND_JOURNEY_VIEW_VERSION;
  type: 'refund_journey_updated';
  workflow_id: string;
  event_id: string;
  occurred_at: string;
}>;

type JourneyStage = RefundJourneyView['stage'];

const STAGE_BY_WORKFLOW_STAGE: Readonly<Record<string, JourneyStage>> = {
  EVALUATING: 'REQUEST_RECEIVED',
  AWAITING_CUSTOMER_EVIDENCE: 'AWAITING_CUSTOMER_EVIDENCE',
  AWAITING_EVIDENCE_REVIEW: 'AWAITING_EVIDENCE_REVIEW',
  EVIDENCE_COLLECTION_EXPIRED: 'EVIDENCE_COLLECTION_EXPIRED',
  AWAITING_CUSTOMER_CONFIRMATION: 'REFUND_PREVIEW_READY',
  AWAITING_APPROVAL: 'SPECIALIST_REVIEWING',
  HUMAN_TAKEOVER_REQUIRED: 'SPECIALIST_REVIEWING',
  CONFIRMED: 'REFUND_PROCESSING',
  APPROVED: 'REFUND_PROCESSING',
  REFUND_PROCESSING: 'REFUND_PROCESSING',
  PENDING_RECONCILIATION: 'REFUND_PROCESSING',
  REFUND_SUCCEEDED: 'REFUND_COMPLETED',
  NEEDS_FACTS: 'MORE_INFORMATION_NEEDED',
  DENIED: 'REFUND_NOT_APPROVED',
  REJECTED: 'REFUND_NOT_APPROVED',
  TAKEOVER_RESOLVED: 'REQUEST_RESOLVED',
  CANCELLED: 'REFUND_CANCELLED',
  PREVIEW_INVALIDATED: 'PREVIEW_EXPIRED',
  REFUND_FAILED: 'REFUND_FAILED',
};

const TIMELINE: readonly Readonly<{
  id: RefundJourneyView['timeline'][number]['id'];
  label: string;
}>[] = [
  { id: 'REQUEST_RECEIVED', label: 'Refund request received' },
  { id: 'PREVIEW_READY', label: 'Refund preview prepared' },
  { id: 'SPECIALIST_REVIEW', label: 'Specialist review' },
  { id: 'REFUND_PROCESSING', label: 'Refund processing' },
  { id: 'COMPLETED', label: 'Refund completed' },
];

function nextActionFor(stage: JourneyStage): RefundJourneyView['next_action'] {
  switch (stage) {
    case 'AWAITING_CUSTOMER_EVIDENCE':
      return { type: 'PROVIDE_EVIDENCE', label: 'Add a clear photo of the damaged item' };
    case 'AWAITING_EVIDENCE_REVIEW':
      return { type: 'WAIT_FOR_SPECIALIST', label: 'A specialist is reviewing your photos' };
    case 'EVIDENCE_COLLECTION_EXPIRED':
      return { type: 'NONE', label: 'Start a new request if you still need help' };
    case 'REFUND_PREVIEW_READY':
      return { type: 'CONFIRM_REFUND', label: 'Review and confirm your refund' };
    case 'SPECIALIST_REVIEWING':
      return { type: 'WAIT_FOR_SPECIALIST', label: 'A specialist is reviewing your request' };
    case 'REQUEST_RECEIVED':
    case 'REFUND_PROCESSING':
      return { type: 'WAIT_FOR_REFUND', label: 'We are processing your request' };
    case 'MORE_INFORMATION_NEEDED':
      return { type: 'CONTACT_SUPPORT', label: 'Please contact support for more information' };
    default:
      return { type: 'NONE', label: 'No action is needed' };
  }
}

function currentTimelineStep(stage: JourneyStage): RefundJourneyView['timeline'][number]['id'] {
  switch (stage) {
    case 'REFUND_PREVIEW_READY':
      return 'PREVIEW_READY';
    case 'SPECIALIST_REVIEWING':
      return 'SPECIALIST_REVIEW';
    case 'REFUND_PROCESSING':
      return 'REFUND_PROCESSING';
    case 'REFUND_COMPLETED':
      return 'COMPLETED';
    default:
      return 'REQUEST_RECEIVED';
  }
}

function timelineFor(stage: JourneyStage, hasPreview: boolean): RefundJourneyView['timeline'] {
  if (stage === 'PREVIEW_EXPIRED') {
    return [
      { id: 'REQUEST_RECEIVED', label: 'Refund request received', status: 'COMPLETED' },
      { id: 'PREVIEW_READY', label: 'Refund preview no longer available', status: 'SKIPPED' },
    ];
  }
  if (stage === 'SPECIALIST_REVIEWING' && !hasPreview) {
    return [
      { id: 'REQUEST_RECEIVED', label: 'Refund request received', status: 'COMPLETED' },
      { id: 'SPECIALIST_REVIEW', label: 'Specialist review', status: 'CURRENT' },
      { id: 'PREVIEW_READY', label: 'Refund preview prepared', status: 'PENDING' },
      { id: 'REFUND_PROCESSING', label: 'Refund processing', status: 'PENDING' },
      { id: 'COMPLETED', label: 'Refund completed', status: 'PENDING' },
    ];
  }
  if (stage === 'AWAITING_CUSTOMER_EVIDENCE' || stage === 'AWAITING_EVIDENCE_REVIEW' || stage === 'EVIDENCE_COLLECTION_EXPIRED') {
    return [
      { id: 'REQUEST_RECEIVED', label: 'Refund request received', status: 'COMPLETED' },
      { id: 'SPECIALIST_REVIEW', label: 'Photo evidence review', status: stage === 'EVIDENCE_COLLECTION_EXPIRED' ? 'SKIPPED' : 'CURRENT' },
      { id: 'PREVIEW_READY', label: 'Refund preview prepared', status: stage === 'EVIDENCE_COLLECTION_EXPIRED' ? 'SKIPPED' : 'PENDING' },
      { id: 'REFUND_PROCESSING', label: 'Refund processing', status: stage === 'EVIDENCE_COLLECTION_EXPIRED' ? 'SKIPPED' : 'PENDING' },
      { id: 'COMPLETED', label: 'Refund completed', status: stage === 'EVIDENCE_COLLECTION_EXPIRED' ? 'SKIPPED' : 'PENDING' },
    ];
  }
  if (stage === 'REQUEST_RESOLVED') {
    return TIMELINE.map((step) => ({
      ...step,
      status:
        step.id === 'REQUEST_RECEIVED' || step.id === 'SPECIALIST_REVIEW'
          ? 'COMPLETED' as const
          : 'SKIPPED' as const,
    }));
  }

  const currentStep = currentTimelineStep(stage);
  const currentIndex = TIMELINE.findIndex((step) => step.id === currentStep);

  return TIMELINE.map((step, index) => ({
    ...step,
    status:
      index < currentIndex ? 'COMPLETED' as const : index === currentIndex ? 'CURRENT' as const : 'PENDING' as const,
  }));
}

/**
 * Deliberately projects the Temporal state into a customer contract. Internal
 * policy decisions, trusted facts, provider identifiers and recovery details
 * never cross this boundary.
 */
export function toRefundJourneyView(
  workflowId: string,
  workflow: RefundWorkflowView,
  evidence?: RefundEvidenceSummary,
): RefundJourneyView {
  const stage = STAGE_BY_WORKFLOW_STAGE[workflow.stage] ?? 'REQUEST_RECEIVED';

  return {
    version: REFUND_JOURNEY_VIEW_VERSION,
    workflow_id: workflowId,
    stage,
    ...(evidence === undefined ? {} : { evidence: refundEvidenceSummarySchema.parse({
      ...evidence,
      can_upload: evidence.can_upload && (stage === 'AWAITING_CUSTOMER_EVIDENCE' || stage === 'AWAITING_EVIDENCE_REVIEW'),
    }) }),
    ...(workflow.preview === undefined
      ? {}
      : {
          preview: {
            preview_id: workflow.preview.previewId,
            amount: {
              amount_minor: workflow.preview.requestedAmount.amountMinor,
              currency: workflow.preview.requestedAmount.currency,
            },
            refund_destination: workflow.preview.refundDestination,
            valid_until: workflow.preview.validUntil,
          },
        }),
    next_action: nextActionFor(stage),
    timeline: timelineFor(stage, workflow.preview !== undefined),
  };
}

/** SSE intentionally carries only a wake-up signal; callers re-fetch the authoritative journey. */
export function refundJourneyFingerprint(workflowId: string, workflow: RefundWorkflowView, evidence?: RefundEvidenceSummary): string {
  return JSON.stringify(toRefundJourneyView(workflowId, workflow, evidence));
}

export function createRefundJourneyUpdateEvent(
  workflowId: string,
  eventId: string,
  occurredAt: string,
): RefundJourneyUpdateEvent {
  return {
    version: REFUND_JOURNEY_VIEW_VERSION,
    type: 'refund_journey_updated',
    workflow_id: workflowId,
    event_id: eventId,
    occurred_at: occurredAt,
  };
}

export function formatSseEvent(event: RefundJourneyUpdateEvent): string {
  return `id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
