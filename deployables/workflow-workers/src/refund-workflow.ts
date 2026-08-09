import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

import type { RefundWorkflowActivities } from "./refund-workflow-activities.js";
import type { RefundProposal } from "./refund-policy-input.js";
import type { RefundPolicyDecision } from "./refund-policy.js";
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';
import type { RefundPreview } from './refund-preview.js';

const activities = proxyActivities<RefundWorkflowActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export type RefundWorkflowRequest = Readonly<{
  proposal: RefundProposal;
  policyVersion: string;
  access: WorkflowJourneyAccess;
  recovery?: Readonly<{
    decision: RefundPolicyDecision;
    preview: RefundPreview;
    attemptsInRun: number;
  }>;
}>;

const RECONCILIATION_INTERVAL = '5 minutes';
const MAX_RECONCILIATION_ATTEMPTS_PER_RUN = 288;

export type RefundCustomerConfirmation = Readonly<{
  previewId: string;
  accepted: boolean;
  confirmedAt: string;
}>;
export type RefundHumanDecision = Readonly<{
  decision: 'APPROVE' | 'REJECT' | 'RESOLVE_TAKEOVER';
  decidedBy: string;
  decidedAt: string;
  reasonCode?: string;
}>;

export type RefundWorkflowState = Readonly<{
  stage:
    | "EVALUATING"
    | "AWAITING_CUSTOMER_CONFIRMATION"
    | "CONFIRMED"
    | "CANCELLED"
    | "NEEDS_FACTS"
    | "DENIED"
    | "AWAITING_APPROVAL"
    | "HUMAN_TAKEOVER_REQUIRED"
    | "APPROVED"
    | "REJECTED"
    | "TAKEOVER_RESOLVED"
    | "PREVIEW_INVALIDATED"
    | "REFUND_SUCCEEDED"
    | "REFUND_FAILED"
    | "PENDING_RECONCILIATION";
  decision?: RefundPolicyDecision;
  preview?: RefundPreview;
  providerRefundId?: string;
}>;

export const confirmRefund = defineSignal<[RefundCustomerConfirmation]>(
  "refund.confirmation",
);
export const decideRefund = defineSignal<[RefundHumanDecision]>('refund.human-decision');

export const getRefundWorkflowState = defineQuery<RefundWorkflowState>(
  "refund.state",
);
export const getRefundWorkflowAccess = defineQuery<WorkflowJourneyAccess>(
  "refund.access",
);

/**
 * Coordinates a refund journey. It does not decide eligibility or issue a
 * refund; those responsibilities remain in policy activities and future
 * authorized-action activities respectively.
 */
export async function refundWorkflow(
  request: RefundWorkflowRequest,
): Promise<RefundWorkflowState> {
  let state: RefundWorkflowState = { stage: "EVALUATING" };
  let confirmation: RefundCustomerConfirmation | undefined;
  let humanDecision: RefundHumanDecision | undefined;

  setHandler(getRefundWorkflowState, () => state);
  setHandler(getRefundWorkflowAccess, () => request.access);

  if (request.recovery) {
    state = { stage: 'PENDING_RECONCILIATION', decision: request.recovery.decision, preview: request.recovery.preview };
    return reconcilePendingRefund(request, request.recovery.decision, request.recovery.preview, request.recovery.attemptsInRun);
  }

  const refundContext = await activities.refreshRefundContext({
    proposal: request.proposal,
    workflowId: workflowInfo().workflowId,
    access: request.access,
  });
  const decision = await activities.evaluateRefundPolicy({
    proposal: request.proposal,
    refundContext,
    policyVersion: request.policyVersion,
  });

  switch (decision.effect) {
    case "NEEDS_FACTS":
      state = { stage: "NEEDS_FACTS", decision };
      return state;
    case "DENY":
      state = { stage: "DENIED", decision };
      return state;
    case "APPROVAL_REQUIRED":
      {
        const preview = await activities.createRefundPreview({ proposal: request.proposal, refundContext, decision });
        state = { stage: 'AWAITING_CUSTOMER_CONFIRMATION', decision, preview };
        setHandler(confirmRefund, (received) => {
          if (confirmation === undefined && received.previewId === preview.previewId) confirmation = received;
        });
        await condition(() => confirmation?.previewId === preview.previewId);
        if (!confirmation?.accepted) return { stage: 'CANCELLED', decision, preview };
        state = { stage: 'AWAITING_APPROVAL', decision, preview };
        setHandler(decideRefund, (received) => {
          if (humanDecision === undefined && (received.decision === 'APPROVE' || received.decision === 'REJECT')) humanDecision = received;
        });
        await condition(() => humanDecision !== undefined);
        if (humanDecision?.decision === 'REJECT') return { stage: 'REJECTED', decision, preview };
        return executeAuthorizedRefund(request, decision, preview, (nextState) => { state = nextState; });
      }
    case "TAKEOVER_REQUIRED":
      state = { stage: "HUMAN_TAKEOVER_REQUIRED", decision };
      setHandler(decideRefund, (received) => {
        if (humanDecision === undefined && (received.decision === 'RESOLVE_TAKEOVER' || received.decision === 'REJECT')) humanDecision = received;
      });
      await condition(() => humanDecision !== undefined);
      return { stage: humanDecision?.decision === 'REJECT' ? 'REJECTED' : 'TAKEOVER_RESOLVED', decision };
    case "ALLOW":
      {
        const preview = await activities.createRefundPreview({
          proposal: request.proposal,
          refundContext,
          decision,
        });
        state = {
          stage: "AWAITING_CUSTOMER_CONFIRMATION",
          decision,
          preview,
        };
        setHandler(confirmRefund, (receivedConfirmation) => {
          if (
            confirmation === undefined &&
            receivedConfirmation.previewId === preview.previewId
          ) {
            confirmation = receivedConfirmation;
          }
        });
        await condition(() => confirmation?.previewId === preview.previewId);
        if (confirmation === undefined) {
          throw new Error("REFUND_CONFIRMATION_INVARIANT");
        }
        if (!confirmation.accepted) return { stage: 'CANCELLED', decision, preview };
        return executeAuthorizedRefund(request, decision, preview, (nextState) => { state = nextState; });
      }
  }
}

async function executeAuthorizedRefund(
  request: RefundWorkflowRequest,
  decision: RefundPolicyDecision,
  preview: RefundPreview,
  setState: (nextState: RefundWorkflowState) => void,
): Promise<RefundWorkflowState> {
  const refreshed = await activities.refreshRefundContext({ proposal: request.proposal, workflowId: workflowInfo().workflowId, access: request.access });
  const amountStillAvailable = refreshed.facts.transactionRefundable && refreshed.facts.itemSelectionValid && refreshed.facts.refundableAmount.currency === preview.requestedAmount.currency && refreshed.facts.refundableAmount.amountMinor >= preview.requestedAmount.amountMinor;
  if (!amountStillAvailable) return { stage: 'PREVIEW_INVALIDATED', decision, preview };
  const result = await activities.executeRefund({ proposal: request.proposal, preview, workflowId: workflowInfo().workflowId, access: request.access });
  if (result.status === 'SUCCEEDED') {
    return result.providerRefundId === undefined
      ? { stage: 'REFUND_SUCCEEDED', decision, preview }
      : { stage: 'REFUND_SUCCEEDED', decision, preview, providerRefundId: result.providerRefundId };
  }
  if (result.status === 'PENDING_RECONCILIATION') {
    setState({ stage: 'PENDING_RECONCILIATION', decision, preview });
    return reconcilePendingRefund(request, decision, preview, 0);
  }
  return { stage: 'REFUND_FAILED', decision, preview };
}

/** Keeps recovery durable. Continue-as-new prevents an unbounded Temporal history. */
async function reconcilePendingRefund(
  request: RefundWorkflowRequest,
  decision: RefundPolicyDecision,
  preview: RefundPreview,
  attemptsInRun: number,
): Promise<RefundWorkflowState> {
  const reconciliation = await activities.reconcileRefund({ proposal: request.proposal, preview, workflowId: workflowInfo().workflowId, access: request.access });
  if (reconciliation.status === 'SUCCEEDED') {
    return reconciliation.providerRefundId === undefined
      ? { stage: 'REFUND_SUCCEEDED', decision, preview }
      : { stage: 'REFUND_SUCCEEDED', decision, preview, providerRefundId: reconciliation.providerRefundId };
  }
  await sleep(RECONCILIATION_INTERVAL);
  if (attemptsInRun + 1 >= MAX_RECONCILIATION_ATTEMPTS_PER_RUN) {
    return continueAsNew<typeof refundWorkflow>({ ...request, recovery: { decision, preview, attemptsInRun: 0 } });
  }
  return reconcilePendingRefund(request, decision, preview, attemptsInRun + 1);
}
