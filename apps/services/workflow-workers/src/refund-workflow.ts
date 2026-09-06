import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  CloseHumanCaseInput,
  HumanCaseAction,
  HumanCaseType,
  OpenHumanCaseInput,
  RefundWorkflowActivities,
} from "./refund-workflow-activities.js";
import type { RefundProposal } from "./refund-policy-input.js";
import type { RefundPolicyDecision } from "./refund-policy.js";
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';
import type { RefundPreview } from './refund-preview.js';
import type { AcceptedDamageEvidence, EvidenceSnapshot, RefundEvidenceActivities } from './refund-evidence-client.js';

const activities = proxyActivities<RefundWorkflowActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});
const evidenceActivities = proxyActivities<RefundEvidenceActivities>({
  startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 },
});

export type RefundWorkflowRequest = Readonly<{
  orderReference?: string;
  proposal: RefundProposal;
  policyVersion: string;
  access: WorkflowJourneyAccess;
  evidenceRecovery?: Readonly<{ deadline: number; decision: RefundPolicyDecision }>;
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
  decision: 'APPROVE' | 'APPROVE_EXCEPTIONAL_REFUND' | 'REJECT' | 'RESOLVE_TAKEOVER';
  decidedBy: string;
  decidedAt: string;
  reasonCode?: string;
}>;
export type RefundProviderOutcome = Readonly<{
  eventId: string;
  providerRefundId: string;
  outcome: 'COMPLETED' | 'FAILED';
  occurredAt: string;
}>;

export type RefundWorkflowState = Readonly<{
  stage:
    | "EVALUATING"
    | "AWAITING_CUSTOMER_EVIDENCE"
    | "AWAITING_EVIDENCE_REVIEW"
    | "EVIDENCE_COLLECTION_EXPIRED"
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
    | "REFUND_PROCESSING"
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
export const recordProviderRefundOutcome = defineSignal<[RefundProviderOutcome]>('refund.provider-outcome');

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
  let humanDecision: RefundHumanDecision | undefined;

  setHandler(getRefundWorkflowState, () => state);
  setHandler(getRefundWorkflowAccess, () => request.access);

  if (request.recovery) {
    state = { stage: 'PENDING_RECONCILIATION', decision: request.recovery.decision, preview: request.recovery.preview };
    state = await reconcilePendingRefund(request, request.recovery.decision, request.recovery.preview, request.recovery.attemptsInRun);
    return state;
  }

  let refundContext = await activities.refreshRefundContext({
    proposal: request.proposal,
    workflowId: workflowInfo().workflowId,
    access: request.access,
  });
  let decision = request.evidenceRecovery?.decision ?? await activities.evaluateRefundPolicy({
    proposal: request.proposal,
    refundContext,
    policyVersion: request.policyVersion,
  });

  let evidence: EvidenceSnapshot | undefined;
  const evidenceAccess = { proposal: request.proposal, workflowId: workflowInfo().workflowId,
    access: request.access, policyVersion: request.policyVersion };
  if (request.policyVersion === 'refund-policy-v2' && decision.effect === 'NEEDS_FACTS'
    && decision.missingFacts.length === 1 && decision.missingFacts[0] === 'DAMAGE_PHOTO') {
    evidence = await evidenceActivities.openRefundEvidence(buildOpenHumanCaseInput({
      request, workflowId: workflowInfo().workflowId, decision,
      caseType: 'REFUND_EVIDENCE_REVIEW', allowedActions: [],
    }));
    const deadline = request.evidenceRecovery?.deadline ?? Date.now() + 24 * 60 * 60_000;
    let polls = 0;
    while (evidence.accepted === undefined) {
      if (Date.now() >= deadline) {
        await evidenceActivities.closeRefundEvidence({ ...evidenceAccess,
          caseId: evidence.caseId, outcome: 'EVIDENCE_COLLECTION_EXPIRED' });
        state = { stage: 'EVIDENCE_COLLECTION_EXPIRED', decision };
        return state;
      }
      state = { stage: evidence.assessment !== 'MORE_REQUIRED'
        && (evidence.readyCount > 0 || evidence.processingCount > 0)
        ? 'AWAITING_EVIDENCE_REVIEW' : 'AWAITING_CUSTOMER_EVIDENCE', decision };
      await sleep(Math.min(30_000, deadline - Date.now()));
      evidence = await evidenceActivities.readRefundEvidence(evidenceAccess);
      // Bound history size without extending the customer's original deadline.
      if (++polls >= 120 && evidence.accepted === undefined && Date.now() < deadline) {
        return continueAsNew<typeof refundWorkflow>({ ...request, evidenceRecovery: { deadline, decision } });
      }
    }
    if (Date.now() >= deadline) {
      await evidenceActivities.closeRefundEvidence({ ...evidenceAccess,
        caseId: evidence.caseId, outcome: 'EVIDENCE_COLLECTION_EXPIRED' });
      state = { stage: 'EVIDENCE_COLLECTION_EXPIRED', decision };
      return state;
    }
    refundContext = await activities.refreshRefundContext(evidenceAccess);
    decision = await activities.evaluateRefundPolicy({ proposal: request.proposal,
      refundContext, policyVersion: request.policyVersion, damageEvidence: evidence.accepted });
    if (decision.effect === 'ALLOW' || decision.effect === 'DENY' || decision.effect === 'NEEDS_FACTS') {
      await evidenceActivities.closeRefundEvidence({ ...evidenceAccess,
        caseId: evidence.caseId, outcome: 'EVIDENCE_REVIEW_COMPLETED' });
    }
  }

  const openMonetaryCase = async (input: OpenHumanCaseInput) => evidence?.accepted === undefined
    ? activities.openHumanCase(input)
    : evidenceActivities.transitionRefundEvidence({ ...input, evidenceVersion: evidence.accepted.evidenceVersion });

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
        const confirmation = await waitForRefundConfirmation(preview);
        if (confirmation === undefined) {
          if (evidence?.accepted) await evidenceActivities.closeRefundEvidence({
            ...evidenceAccess, caseId: evidence.caseId, outcome: 'EVIDENCE_REVIEW_COMPLETED',
          });
          state = { ...state, stage: 'PREVIEW_INVALIDATED' };
          return state;
        }
        if (!confirmation.accepted) {
          if (evidence?.accepted) await evidenceActivities.closeRefundEvidence({
            ...evidenceAccess, caseId: evidence.caseId, outcome: 'EVIDENCE_REVIEW_COMPLETED',
          });
          state = { stage: 'CANCELLED', decision, preview };
          return state;
        }
        const humanCase = await openMonetaryCase(
          buildOpenHumanCaseInput({
            request,
            workflowId: workflowInfo().workflowId,
            decision,
            preview,
            caseType: 'REFUND_APPROVAL',
            allowedActions: ['APPROVE', 'REJECT'],
          }),
        );
        state = { stage: 'AWAITING_APPROVAL', decision, preview };
        setHandler(decideRefund, (received) => {
          if (humanDecision === undefined && (received.decision === 'APPROVE' || received.decision === 'REJECT')) humanDecision = received;
        });
        await condition(() => humanDecision !== undefined);
        if (humanDecision?.decision === 'REJECT') {
          await activities.closeHumanCase(
            buildCloseHumanCaseInput({
              request,
              workflowId: workflowInfo().workflowId,
              caseId: humanCase.caseId,
              decision: humanDecision,
              outcome: 'REJECTED',
            }),
          );
          state = { stage: 'REJECTED', decision, preview };
          return state;
        }
        if (humanDecision === undefined) {
          throw new Error('HUMAN_DECISION_INVARIANT');
        }
        await activities.closeHumanCase(
          buildCloseHumanCaseInput({
            request,
            workflowId: workflowInfo().workflowId,
            caseId: humanCase.caseId,
            decision: humanDecision,
            outcome: 'APPROVED',
          }),
        );
        state = await executeAuthorizedRefund(request, decision, preview, (nextState) => { state = nextState; }, evidence?.accepted);
        return state;
      }
    case "TAKEOVER_REQUIRED":
      const humanCase = await openMonetaryCase(
        buildOpenHumanCaseInput({
          request,
          workflowId: workflowInfo().workflowId,
            decision,
            caseType: 'REFUND_TAKEOVER',
          allowedActions: ['APPROVE_EXCEPTIONAL_REFUND', 'RESOLVE_TAKEOVER', 'REJECT'],
        }),
      );
      state = { stage: "HUMAN_TAKEOVER_REQUIRED", decision };
      setHandler(decideRefund, (received) => {
        if (
          humanDecision === undefined &&
          (received.decision === 'APPROVE_EXCEPTIONAL_REFUND' ||
            received.decision === 'RESOLVE_TAKEOVER' ||
            received.decision === 'REJECT')
        ) {
          humanDecision = received;
        }
      });
      await condition(() => humanDecision !== undefined);
      if (humanDecision === undefined) {
        throw new Error('HUMAN_DECISION_INVARIANT');
      }
      if (humanDecision.decision === 'APPROVE_EXCEPTIONAL_REFUND') {
        await activities.closeHumanCase(
          buildCloseHumanCaseInput({
            request,
            workflowId: workflowInfo().workflowId,
            caseId: humanCase.caseId,
            decision: humanDecision,
            outcome: 'APPROVED',
          }),
        );

        // The supervisor's approval authorizes this exception, but never
        // supplies an amount or destination. Re-read those facts from the
        // trusted commerce boundary before preparing the customer offer.
        const refreshedContext = await activities.refreshRefundContext({
          proposal: request.proposal,
          workflowId: workflowInfo().workflowId,
          access: request.access,
        });
        if (evidence?.accepted !== undefined) {
          const current = await evidenceActivities.readRefundEvidence(evidenceAccess);
          if (!sameAcceptedEvidence(evidence.accepted, current.accepted)) {
            state = { stage: 'PREVIEW_INVALIDATED', decision };
            return state;
          }
          decision = await activities.evaluateRefundPolicy({ proposal: request.proposal,
            refundContext: refreshedContext, policyVersion: request.policyVersion, damageEvidence: current.accepted! });
          if (decision.effect === 'DENY' || decision.effect === 'NEEDS_FACTS') {
            state = { stage: decision.effect === 'DENY' ? 'DENIED' : 'NEEDS_FACTS', decision };
            return state;
          }
        }
        const preview = await activities.createRefundPreview({
          proposal: request.proposal,
          refundContext: refreshedContext,
          decision,
          authorization: {
            kind: 'HUMAN_EXCEPTIONAL_APPROVAL',
            caseId: humanCase.caseId,
            decision: 'APPROVE_EXCEPTIONAL_REFUND',
          },
        });
        state = { stage: 'AWAITING_CUSTOMER_CONFIRMATION', decision, preview };
        const confirmation = await waitForRefundConfirmation(preview);
        if (confirmation === undefined) {
          state = { ...state, stage: 'PREVIEW_INVALIDATED' };
          return state;
        }
        if (!confirmation.accepted) {
          state = { stage: 'CANCELLED', decision, preview };
          return state;
        }
        state = await executeAuthorizedRefund(request, decision, preview, (nextState) => { state = nextState; }, evidence?.accepted);
        return state;
      }

      const outcome = humanDecision.decision === 'REJECT'
        ? 'REJECTED'
        : 'TAKEOVER_RESOLVED';
      await activities.closeHumanCase(
        buildCloseHumanCaseInput({
          request,
          workflowId: workflowInfo().workflowId,
          caseId: humanCase.caseId,
          decision: humanDecision,
          outcome,
        }),
      );
      state = {
        stage: outcome,
        decision,
      };
      return state;
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
        const confirmation = await waitForRefundConfirmation(preview);
        if (confirmation === undefined) {
          state = { ...state, stage: 'PREVIEW_INVALIDATED' };
          return state;
        }
        if (!confirmation.accepted) {
          state = { stage: 'CANCELLED', decision, preview };
          return state;
        }
        state = await executeAuthorizedRefund(request, decision, preview, (nextState) => { state = nextState; }, evidence?.accepted);
        return state;
      }
  }
}

/** The deadline is exclusive: a decision received exactly at expiry is too late. */
export function isRefundPreviewCurrent(validUntil: string, nowMilliseconds: number): boolean {
  const deadline = Date.parse(validUntil);
  return Number.isFinite(deadline) && nowMilliseconds < deadline;
}

async function waitForRefundConfirmation(
  preview: RefundPreview,
): Promise<RefundCustomerConfirmation | undefined> {
  let confirmation: RefundCustomerConfirmation | undefined;
  let expired = false;
  // Old parked histories did not schedule a timer. Preserve their command history;
  // the separate handler patch still rejects their next late live confirmation.
  const timedWait = patched('refund-preview-expiry-timer-v1');
  setHandler(confirmRefund, (received) => {
    if (confirmation !== undefined || expired || received.previewId !== preview.previewId) return;
    // Temporal replaces Date.now() with its replay-safe workflow clock. Never
    // trust confirmedAt to backdate acceptance. Preserve historical signals on replay.
    if (patched('refund-preview-expiry-confirmation-v1')
      && !isRefundPreviewCurrent(preview.validUntil, Date.now())) {
      expired = true;
      return;
    }
    confirmation = received;
  });

  if (confirmation === undefined && !expired) {
    if (timedWait) {
      const remainingMilliseconds = Date.parse(preview.validUntil) - Date.now();
      if (!Number.isFinite(remainingMilliseconds) || remainingMilliseconds <= 0) return undefined;
      await condition(() => confirmation !== undefined || expired, remainingMilliseconds);
    } else {
      await condition(() => confirmation !== undefined || expired);
    }
  }
  // A timely decision is final for this preview. Human review and provider
  // processing may outlive the deadline; existing fresh-facts checks still apply.
  return confirmation;
}

function buildOpenHumanCaseInput({
  request,
  workflowId,
  decision,
  preview,
  caseType,
  allowedActions,
}: Readonly<{
  request: RefundWorkflowRequest;
  workflowId: string;
  decision: RefundPolicyDecision;
  preview?: RefundPreview;
  caseType: HumanCaseType;
  allowedActions: readonly HumanCaseAction[];
}>): OpenHumanCaseInput {
  const requestedAmount = request.proposal.intent.requestedAmount;
  return {
    caseId: `case:${workflowId}`,
    workflowId,
    idempotencyKey: `workflow:${workflowId}:human-case`,
    access: request.access,
    caseType,
    allowedActions: [...allowedActions],
    reviewPacket: {
      ...(request.orderReference === undefined
        ? {}
        : { orderReference: request.orderReference }),
      proposal: {
        proposalId: request.proposal.proposalId,
        orderId: request.proposal.intent.orderId,
        reasonCode: request.proposal.intent.reasonCode,
        scope: request.proposal.intent.scope,
        itemIds: [...request.proposal.intent.itemIds],
        ...(requestedAmount === undefined
          ? {}
          : {
              requestedAmount: {
                amountMinor: requestedAmount.amountMinor,
                currency: requestedAmount.currency,
              },
            }),
      },
      policy: {
        decisionId: decision.decisionId,
        effect: decision.effect,
        policyVersion: decision.policyVersion,
        inputFactsHash: decision.inputFactsHash,
        reasonCodes: [...decision.reasonCodes],
        factRefs: decision.factRefs.map((factRef) => ({ ...factRef })),
      },
      ...(preview === undefined ? {} : { preview }),
    },
  };
}

function buildCloseHumanCaseInput({
  request,
  workflowId,
  caseId,
  decision,
  outcome,
}: Readonly<{
  request: RefundWorkflowRequest;
  workflowId: string;
  caseId: string;
  decision: RefundHumanDecision;
  outcome: 'APPROVED' | 'REJECTED' | 'TAKEOVER_RESOLVED';
}>): CloseHumanCaseInput {
  return {
    caseId,
    workflowId,
    idempotencyKey: `workflow:${workflowId}:human-case:close:${decision.decision}`,
    access: request.access,
    outcome,
    decision: {
      action: decision.decision,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
    },
  };
}

async function executeAuthorizedRefund(
  request: RefundWorkflowRequest,
  decision: RefundPolicyDecision,
  preview: RefundPreview,
  setState: (nextState: RefundWorkflowState) => void,
  damageEvidence?: AcceptedDamageEvidence,
): Promise<RefundWorkflowState> {
  if (request.policyVersion === 'refund-policy-v2' && request.proposal.intent.reasonCode === 'DAMAGED') {
    const current = await evidenceActivities.readRefundEvidence({ proposal: request.proposal,
      workflowId: workflowInfo().workflowId, access: request.access, policyVersion: request.policyVersion });
    if (!sameAcceptedEvidence(damageEvidence, current.accepted)) return { stage: 'PREVIEW_INVALIDATED', decision, preview };
  }
  const refreshed = await activities.refreshRefundContext({ proposal: request.proposal, workflowId: workflowInfo().workflowId, access: request.access });
  const amountStillAvailable = refreshed.facts.transactionRefundable && refreshed.facts.itemSelectionValid && refreshed.facts.refundableAmount.currency === preview.requestedAmount.currency && refreshed.facts.refundableAmount.amountMinor >= preview.requestedAmount.amountMinor;
  if (!amountStillAvailable) return { stage: 'PREVIEW_INVALIDATED', decision, preview };
  const result = await activities.executeRefund({ proposal: request.proposal, preview, workflowId: workflowInfo().workflowId, access: request.access });
  if (result.status === 'SUCCEEDED') {
    return result.providerRefundId === undefined
      ? { stage: 'REFUND_SUCCEEDED', decision, preview }
      : { stage: 'REFUND_SUCCEEDED', decision, preview, providerRefundId: result.providerRefundId };
  }
  if (result.status === 'SUBMITTED') {
    const processingState: RefundWorkflowState = result.providerRefundId === undefined
      ? { stage: 'REFUND_PROCESSING', decision, preview }
      : { stage: 'REFUND_PROCESSING', decision, preview, providerRefundId: result.providerRefundId };
    setState(processingState);
    return await awaitProviderRefundOutcome(
      request,
      decision,
      preview,
      result.providerRefundId,
      setState,
    );
  }
  if (result.status === 'PENDING_RECONCILIATION') {
    setState({ stage: 'PENDING_RECONCILIATION', decision, preview });
    return reconcilePendingRefund(request, decision, preview, 0);
  }
  return { stage: 'REFUND_FAILED', decision, preview };
}

function sameAcceptedEvidence(expected: AcceptedDamageEvidence | undefined, current: AcceptedDamageEvidence | undefined): boolean {
  return expected !== undefined && current !== undefined && expected.evidenceVersion === current.evidenceVersion
    && expected.assessmentId === current.assessmentId && expected.manifestHash === current.manifestHash;
}

/**
 * A provider webhook is the fast path. Gateway reconciliation is the recovery
 * path when that webhook is delayed, duplicated, or unavailable.
 */
async function awaitProviderRefundOutcome(
  request: RefundWorkflowRequest,
  decision: RefundPolicyDecision,
  preview: RefundPreview,
  initialProviderRefundId: string | undefined,
  setState: (nextState: RefundWorkflowState) => void,
): Promise<RefundWorkflowState> {
  let providerRefundId = initialProviderRefundId;
  let providerOutcome: RefundProviderOutcome | undefined;

  setHandler(recordProviderRefundOutcome, (received) => {
    if (
      providerOutcome === undefined
      && providerRefundId !== undefined
      && received.providerRefundId === providerRefundId
    ) {
      providerOutcome = received;
    }
  });

  while (true) {
    const reconciliation = await activities.reconcileRefund({
      proposal: request.proposal,
      preview,
      workflowId: workflowInfo().workflowId,
      access: request.access,
    });
    providerRefundId ??= reconciliation.providerRefundId;

    if (reconciliation.status === 'SUCCEEDED' || providerOutcome?.outcome === 'COMPLETED') {
      return providerRefundId === undefined
        ? { stage: 'REFUND_SUCCEEDED', decision, preview }
        : { stage: 'REFUND_SUCCEEDED', decision, preview, providerRefundId };
    }
    if (reconciliation.status === 'FAILED' || providerOutcome?.outcome === 'FAILED') {
      return providerRefundId === undefined
        ? { stage: 'REFUND_FAILED', decision, preview }
        : { stage: 'REFUND_FAILED', decision, preview, providerRefundId };
    }

    setState(providerRefundId === undefined
      ? { stage: 'REFUND_PROCESSING', decision, preview }
      : { stage: 'REFUND_PROCESSING', decision, preview, providerRefundId });
    await condition(() => providerOutcome !== undefined, RECONCILIATION_INTERVAL);
  }
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
  if (reconciliation.status === 'FAILED') {
    return reconciliation.providerRefundId === undefined
      ? { stage: 'REFUND_FAILED', decision, preview }
      : { stage: 'REFUND_FAILED', decision, preview, providerRefundId: reconciliation.providerRefundId };
  }
  await sleep(RECONCILIATION_INTERVAL);
  if (attemptsInRun + 1 >= MAX_RECONCILIATION_ATTEMPTS_PER_RUN) {
    return continueAsNew<typeof refundWorkflow>({ ...request, recovery: { decision, preview, attemptsInRun: 0 } });
  }
  return reconcilePendingRefund(request, decision, preview, attemptsInRun + 1);
}
