import type { RefundContext, RefundProposal } from "./refund-policy-input.js";
import {
  evaluateRefundPolicy,
  type PolicyDecisionContext,
  type RefundPolicyDecision,
} from "./refund-policy.js";
import type { RefundPolicyRelease } from "./refund-policy-release.js";
import { createRefundPolicyInput } from "./refund-policy-input.js";
import type { RefundEvidenceActivities, AcceptedDamageEvidence } from './refund-evidence-client.js';
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';
import {
  createRefundPreview,
  type RefundPreview,
  type RefundPreviewAuthorization,
} from './refund-preview.js';

export type HumanCaseType = 'REFUND_APPROVAL' | 'REFUND_TAKEOVER' | 'REFUND_EVIDENCE_REVIEW';
export type HumanCaseAction = 'APPROVE' | 'APPROVE_EXCEPTIONAL_REFUND' | 'REJECT' | 'RESOLVE_TAKEOVER';

/**
 * A minimized review packet. It intentionally excludes raw customer messages,
 * payment credentials, and provider transaction details.
 */
export type HumanCaseReviewPacket = Readonly<{
  orderReference?: string;
  proposal: Readonly<{
    proposalId: string;
    orderId: string;
    reasonCode: string;
    scope: RefundProposal['intent']['scope'];
    itemIds: readonly string[];
    requestedAmount?: Readonly<{ amountMinor: number; currency: string }>;
  }>;
  policy: Readonly<{
    decisionId: string;
    effect: RefundPolicyDecision['effect'];
    policyVersion: string;
    inputFactsHash: string;
    reasonCodes: readonly string[];
    factRefs: RefundPolicyDecision['factRefs'];
  }>;
  preview?: RefundPreview;
}>;

export type OpenHumanCaseInput = Readonly<{
  caseId: string;
  workflowId: string;
  idempotencyKey: string;
  access: WorkflowJourneyAccess;
  caseType: HumanCaseType;
  allowedActions: readonly HumanCaseAction[];
  reviewPacket: HumanCaseReviewPacket;
}>;

export type OpenHumanCaseResult = Readonly<{
  /** Service-owned ID returned by Human Operations after an idempotent open. */
  caseId: string;
}>;

export type CloseHumanCaseInput = Readonly<{
  caseId: string;
  workflowId: string;
  idempotencyKey: string;
  access: WorkflowJourneyAccess;
  outcome: 'APPROVED' | 'REJECTED' | 'TAKEOVER_RESOLVED';
  decision: Readonly<{
    action: HumanCaseAction;
    decidedBy: string;
    decidedAt: string;
    reasonCode?: string;
  }>;
}>;

export type RefreshRefundContextInput = Readonly<{
  proposal: RefundProposal;
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;

export type EvaluateRefundPolicyInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  policyVersion: string;
  damageEvidence?: AcceptedDamageEvidence;
}>;

export type CreateRefundPreviewActivityInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  decision: RefundPolicyDecision;
  authorization?: RefundPreviewAuthorization;
}>;
export type ExecuteRefundInput = Readonly<{
  proposal: RefundProposal;
  preview: RefundPreview;
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;
export type ExecuteRefundResult = Readonly<{
  status: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
  providerRefundId?: string;
}>;
export type ReconcileRefundInput = Readonly<{ proposal: RefundProposal; preview: RefundPreview; workflowId: string; access: WorkflowJourneyAccess }>;
export type ReconcileRefundResult = Readonly<{ status: 'SUCCEEDED' | 'FAILED' | 'PROCESSING' | 'NOT_FOUND'; providerRefundId?: string }>;

type ActivityObservation<T> = Readonly<{
  operation: string;
  dependency?: string;
  outcome?: (value: T) => string | undefined;
}>;

type ActivityTelemetry = Readonly<{
  withActivity<T>(
    input: ActivityObservation<T>,
    activity: () => Promise<T>,
  ): Promise<T>;
}>;

export type RefundWorkflowActivities = Readonly<{
  refreshRefundContext(
    input: RefreshRefundContextInput,
  ): Promise<RefundContext>;
  evaluateRefundPolicy(
    input: EvaluateRefundPolicyInput,
  ): Promise<RefundPolicyDecision>;
  createRefundPreview(
    input: CreateRefundPreviewActivityInput,
  ): Promise<RefundPreview>;
  recordRefundConfirmation(): Promise<void>;
  executeRefund(input: ExecuteRefundInput): Promise<ExecuteRefundResult>;
  reconcileRefund(input: ReconcileRefundInput): Promise<ReconcileRefundResult>;
  openHumanCase(input: OpenHumanCaseInput): Promise<OpenHumanCaseResult>;
  closeHumanCase(input: CloseHumanCaseInput): Promise<void>;
}>;

type RefundWorkflowActivityDependencies = Readonly<{
  fetchRefundContext(
    input: RefreshRefundContextInput,
  ): Promise<RefundContext>;
  executeRefund(input: ExecuteRefundInput): Promise<ExecuteRefundResult>;
  reconcileRefund(input: ReconcileRefundInput): Promise<ReconcileRefundResult>;
  openHumanCase(input: OpenHumanCaseInput): Promise<OpenHumanCaseResult>;
  closeHumanCase(input: CloseHumanCaseInput): Promise<void>;
  refundPolicyRelease: RefundPolicyRelease;
  getPolicyRelease?: (version: string) => RefundPolicyRelease;
  evidence?: RefundEvidenceActivities;
  telemetry?: ActivityTelemetry;
  createDecisionContext(
    input: EvaluateRefundPolicyInput,
  ): PolicyDecisionContext;
  createPreviewContext(): Readonly<{ previewId: string; createdAt: string }>;
}>;

/**
 * Creates the non-deterministic activity implementations used by Temporal.
 * The worker host supplies the Gateway-backed fact refresh implementation.
 */
export function createRefundWorkflowActivities({
  fetchRefundContext,
  executeRefund,
  reconcileRefund,
  openHumanCase,
  closeHumanCase,
  refundPolicyRelease,
  getPolicyRelease,
  evidence,
  telemetry,
  createDecisionContext,
  createPreviewContext,
}: RefundWorkflowActivityDependencies): RefundWorkflowActivities & Partial<RefundEvidenceActivities> {
  const observe = <T>(
    input: ActivityObservation<T>,
    activity: () => Promise<T>,
  ): Promise<T> => telemetry === undefined ? activity() : telemetry.withActivity(input, activity);

  return {
    ...(evidence === undefined ? {} : {
      async openRefundEvidence(input: OpenHumanCaseInput) {
        return observe(
          { operation: 'temporal.activity.refund_evidence_open', dependency: 'human_operations' },
          () => evidence.openRefundEvidence(input),
        );
      },
      async readRefundEvidence(input: Parameters<RefundEvidenceActivities['readRefundEvidence']>[0]) {
        return observe(
          { operation: 'temporal.activity.refund_evidence_read', dependency: 'human_operations' },
          () => evidence.readRefundEvidence(input),
        );
      },
      async transitionRefundEvidence(input: Parameters<RefundEvidenceActivities['transitionRefundEvidence']>[0]) {
        return observe(
          { operation: 'temporal.activity.refund_evidence_transition', dependency: 'human_operations' },
          () => evidence.transitionRefundEvidence(input),
        );
      },
      async closeRefundEvidence(input: Parameters<RefundEvidenceActivities['closeRefundEvidence']>[0]) {
        await observe(
          { operation: 'temporal.activity.refund_evidence_close', dependency: 'human_operations' },
          () => evidence.closeRefundEvidence(input),
        );
      },
    }),
    async refreshRefundContext(input) {
      return observe({
        operation: 'temporal.activity.refund_context_refresh',
        dependency: 'integration_gateway',
      }, () => fetchRefundContext(input));
    },
    async evaluateRefundPolicy(input) {
      return observe({ operation: 'temporal.activity.refund_policy_evaluation' }, async () => {
        const policyInput = createRefundPolicyInput({
          proposal: input.proposal,
          refundContext: input.refundContext,
          policyVersion: input.policyVersion,
          ...(input.damageEvidence === undefined ? {} : { damageEvidence: input.damageEvidence }),
        });

        return evaluateRefundPolicy(
          policyInput,
          getPolicyRelease?.(input.policyVersion) ?? refundPolicyRelease,
          createDecisionContext(input),
        );
      });
    },
    async createRefundPreview(input) {
      return observe(
        { operation: 'temporal.activity.refund_preview_create' },
        async () => createRefundPreview({ ...input, ...createPreviewContext() }),
      );
    },
    async recordRefundConfirmation() {
      await observe(
        { operation: 'temporal.activity.refund_confirmation_handle' },
        async () => undefined,
      );
    },
    async executeRefund(input) {
      return observe(
        {
          operation: 'temporal.activity.refund_submission',
          dependency: 'integration_gateway',
          outcome: (result: ExecuteRefundResult) => result.status.toLowerCase(),
        },
        () => executeRefund(input),
      );
    },
    async reconcileRefund(input) {
      return observe(
        {
          operation: 'temporal.activity.refund_reconciliation',
          dependency: 'integration_gateway',
          outcome: (result: ReconcileRefundResult) => result.status.toLowerCase(),
        },
        () => reconcileRefund(input),
      );
    },
    async openHumanCase(input) {
      return observe(
        { operation: 'temporal.activity.human_case_open', dependency: 'human_operations' },
        () => openHumanCase(input),
      );
    },
    async closeHumanCase(input) {
      await observe(
        { operation: 'temporal.activity.human_case_close', dependency: 'human_operations' },
        () => closeHumanCase(input),
      );
    },
  };
}
