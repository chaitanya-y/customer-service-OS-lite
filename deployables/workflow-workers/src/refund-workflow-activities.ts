import type { RefundContext, RefundProposal } from "./refund-policy-input.js";
import {
  evaluateRefundPolicy,
  type PolicyDecisionContext,
  type RefundPolicyDecision,
} from "./refund-policy.js";
import type { RefundPolicyRelease } from "./refund-policy-release.js";
import { createRefundPolicyInput } from "./refund-policy-input.js";
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';
import {
  createRefundPreview,
  type RefundPreview,
} from './refund-preview.js';

export type RefreshRefundContextInput = Readonly<{
  proposal: RefundProposal;
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;

export type EvaluateRefundPolicyInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  policyVersion: string;
}>;

export type CreateRefundPreviewActivityInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  decision: RefundPolicyDecision;
}>;
export type ExecuteRefundInput = Readonly<{
  proposal: RefundProposal;
  preview: RefundPreview;
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;
export type ExecuteRefundResult = Readonly<{
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
  providerRefundId?: string;
}>;
export type ReconcileRefundInput = Readonly<{ proposal: RefundProposal; preview: RefundPreview; workflowId: string; access: WorkflowJourneyAccess }>;
export type ReconcileRefundResult = Readonly<{ status: 'SUCCEEDED' | 'NOT_FOUND'; providerRefundId?: string }>;

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
  executeRefund(input: ExecuteRefundInput): Promise<ExecuteRefundResult>;
  reconcileRefund(input: ReconcileRefundInput): Promise<ReconcileRefundResult>;
}>;

type RefundWorkflowActivityDependencies = Readonly<{
  fetchRefundContext(
    input: RefreshRefundContextInput,
  ): Promise<RefundContext>;
  executeRefund(input: ExecuteRefundInput): Promise<ExecuteRefundResult>;
  reconcileRefund(input: ReconcileRefundInput): Promise<ReconcileRefundResult>;
  refundPolicyRelease: RefundPolicyRelease;
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
  refundPolicyRelease,
  createDecisionContext,
  createPreviewContext,
}: RefundWorkflowActivityDependencies): RefundWorkflowActivities {
  return {
    refreshRefundContext: fetchRefundContext,
    async evaluateRefundPolicy(input) {
      const policyInput = createRefundPolicyInput({
        proposal: input.proposal,
        refundContext: input.refundContext,
        policyVersion: input.policyVersion,
      });

      return evaluateRefundPolicy(
        policyInput,
        refundPolicyRelease,
        createDecisionContext(input),
      );
    },
    async createRefundPreview(input) {
      return createRefundPreview({ ...input, ...createPreviewContext() });
    },
    executeRefund,
    reconcileRefund,
  };
}
