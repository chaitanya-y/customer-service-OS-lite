import { z } from 'zod';

import type { RefundContext } from './refund-policy-input.js';
import type { RefreshRefundContextInput } from './refund-workflow-activities.js';
import type { SignWorkflowAccessAssertion } from './workflow-access-assertion.js';

const WORKFLOW_ACCESS_ASSERTION_HEADER = 'x-cso-workflow-assertion';

const moneySchema = z.object({ amountMinor: z.number().int(), currency: z.string() }).strict();
const refundContextSchema = z.object({
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
} {
  const endpoint = new URL('/internal/v1/refund-contexts', baseUrl);

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

      const assertion = await signWorkflowAccessAssertion({ workflowId, access });
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WORKFLOW_ACCESS_ASSERTION_HEADER]: assertion,
          },
          body: JSON.stringify({
            orderReference: proposal.intent.orderId,
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
  };
}
