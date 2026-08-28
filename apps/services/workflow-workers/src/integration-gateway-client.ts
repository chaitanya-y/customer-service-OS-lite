import { z } from 'zod';

import type { RefundContext } from './refund-policy-input.js';
import type { ExecuteRefundInput, ReconcileRefundInput, RefreshRefundContextInput } from './refund-workflow-activities.js';
import type { SignWorkflowAccessAssertion } from './workflow-access-assertion.js';

const WORKFLOW_ACCESS_ASSERTION_HEADER = 'x-cso-workflow-assertion';

const moneySchema = z.object({ amountMinor: z.number().int(), currency: z.string() }).strict();
const refundContextSchema = z.object({
  schemaVersion: z.literal('1'),
  observationId: z.string(),
  observedAt: z.string(),
  source: z.object({ provider: z.string(), orderId: z.string(), factsVersion: z.string() }).strict(),
  selection: z.object({ scope: z.enum(['FULL_ORDER', 'SELECTED_ITEMS']), itemIds: z.array(z.string()) }).strict(),
  facts: z.object({
    customerVerified: z.literal(true),
    transactionRefundable: z.boolean(),
    itemSelectionValid: z.boolean(),
    priorRefundCount: z.number().int().min(0),
    refundableAmount: moneySchema,
    refundDestination: z.literal('ORIGINAL_PAYMENT_METHOD'),
  }).strict(),
}).strict();
const refundExecutionSchema = z.object({
  status: z.enum(['SUBMITTED', 'SUCCEEDED', 'FAILED', 'PENDING_RECONCILIATION']),
  providerRefundId: z.string().optional(),
}).strict();

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type IntegrationGatewayRefundContextClientOptions = Readonly<{
  baseUrl: string;
  signWorkflowAccessAssertion: SignWorkflowAccessAssertion;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  timeoutMilliseconds?: number;
  fetchImpl?: FetchLike;
}>;

export class IntegrationGatewayUnavailableError extends Error {
  constructor(message = 'Integration Gateway refund context request failed') {
    super(message);
    this.name = 'IntegrationGatewayUnavailableError';
  }
}

export function createIntegrationGatewayRefundContextClient({
  baseUrl,
  signWorkflowAccessAssertion,
  expectedTenantId,
  expectedEnvironmentId,
  timeoutMilliseconds = 5_000,
  fetchImpl = fetch,
}: IntegrationGatewayRefundContextClientOptions): {
  fetchRefundContext(input: RefreshRefundContextInput): Promise<RefundContext>;
  executeRefund(input: ExecuteRefundInput): Promise<{ status: 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION'; providerRefundId?: string }>;
  reconcileRefund(input: ReconcileRefundInput): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'PROCESSING' | 'NOT_FOUND'; providerRefundId?: string }>;
} {
  const endpoint = new URL('/internal/v1/refund-contexts', baseUrl);
  const executionEndpoint = new URL('/internal/v1/refunds', baseUrl);
  const reconciliationEndpoint = new URL('/internal/v1/refund-reconciliations', baseUrl);

  return {
    async fetchRefundContext(input) {
      const { proposal, workflowId, access } = input;
      if (
        access.tenantId !== expectedTenantId ||
        access.environmentId !== expectedEnvironmentId
      ) {
        throw new Error('WORKFLOW_ACCESS_SCOPE_MISMATCH');
      }
      if (proposal.intent.scope === 'UNSPECIFIED') {
        throw new Error('REFUND_SELECTION_REQUIRED');
      }

      const assertion = await signWorkflowAccessAssertion({ workflowId, access, purpose: 'refund_fact_refresh' });
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WORKFLOW_ACCESS_ASSERTION_HEADER]: assertion,
          },
          body: JSON.stringify({
            orderId: proposal.intent.orderId,
            selection: {
              scope: proposal.intent.scope,
              itemIds: proposal.intent.itemIds,
            },
          }),
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch {
        throw new IntegrationGatewayUnavailableError();
      }

      if (!response.ok) {
        throw new IntegrationGatewayUnavailableError(`Integration Gateway returned ${response.status}`);
      }

      return refundContextSchema.parse(await response.json()) as RefundContext;
    },
    async executeRefund(input) {
      const { access, workflowId, preview, proposal } = input;
      if (access.tenantId !== expectedTenantId || access.environmentId !== expectedEnvironmentId) {
        throw new Error('WORKFLOW_ACCESS_SCOPE_MISMATCH');
      }
      const assertion = await signWorkflowAccessAssertion({ workflowId, access, purpose: 'refund_execute' });
      let response: Response;
      try {
        response = await fetchImpl(executionEndpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', [WORKFLOW_ACCESS_ASSERTION_HEADER]: assertion },
          body: JSON.stringify({ orderId: proposal.intent.orderId, reasonCode: proposal.intent.reasonCode, amount: preview.requestedAmount, selection: preview.selection, previewId: preview.previewId, idempotencyKey: `refund:${workflowId}:${preview.previewId}` }),
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch { return { status: 'PENDING_RECONCILIATION' }; }
      if (response.status >= 500) return { status: 'PENDING_RECONCILIATION' };
      if (!response.ok) return { status: 'FAILED' };
      const result = refundExecutionSchema.parse(await response.json());
      return result.providerRefundId === undefined
        ? { status: result.status }
        : { status: result.status, providerRefundId: result.providerRefundId };
    },
    async reconcileRefund(input) {
      const assertion = await signWorkflowAccessAssertion({ workflowId: input.workflowId, access: input.access, purpose: 'refund_reconcile' });
      let response: Response;
      try { response = await fetchImpl(reconciliationEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', [WORKFLOW_ACCESS_ASSERTION_HEADER]: assertion }, body: JSON.stringify({ orderId: input.proposal.intent.orderId, previewId: input.preview.previewId, amount: input.preview.requestedAmount }), signal: AbortSignal.timeout(timeoutMilliseconds) }); } catch { return { status: 'NOT_FOUND' }; }
      if (!response.ok) return { status: 'NOT_FOUND' };
      const result = z.object({ status: z.enum(['SUCCEEDED', 'FAILED', 'PROCESSING', 'NOT_FOUND']), providerRefundId: z.string().optional() }).strict().parse(await response.json());
      return result.providerRefundId === undefined ? { status: result.status } : { status: result.status, providerRefundId: result.providerRefundId };
    },
  };
}
