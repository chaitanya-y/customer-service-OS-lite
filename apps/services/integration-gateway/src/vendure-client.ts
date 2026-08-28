import { z } from 'zod';

import type {
  CommerceOrder,
  CommerceProvider,
  Money,
} from './commerce.js';

const orderFields = `
  id
  code
  state
  active
  currencyCode
  orderPlacedAt
  totalWithTax
  customer {
    id
    firstName
    lastName
    emailAddress
  }
  lines {
    id
    quantity
    unitPriceWithTax
    linePriceWithTax
    productVariant {
      id
      sku
      name
    }
  }
  payments {
    id
    state
    amount
    method
    transactionId
    refunds {
      id
      state
      total
      lines {
        orderLineId
      }
    }
  }
  fulfillments {
    id
    state
    method
    trackingCode
  }
`;

const orderByCodeQuery = `
  query Orders($options: OrderListOptions) {
    orders(options: $options) {
      totalItems
      items { ${orderFields} }
    }
  }
`;

const orderByIdQuery = `
  query Order($id: ID!) {
    order(id: $id) { ${orderFields} }
  }
`;
const refundOrderMutation = `
  mutation RefundOrder($input: RefundOrderInput!) {
    refundOrder(input: $input) {
      __typename
      ... on Refund { id }
    }
  }
`;

const vendureOrderSchema = z.object({
  id: z.string(),
  code: z.string(),
  state: z.string(),
  active: z.boolean(),
  currencyCode: z.string(),
  orderPlacedAt: z.string().nullable(),
  totalWithTax: z.number().int(),
  customer: z
    .object({
      id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      emailAddress: z.string(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      quantity: z.number().int(),
      unitPriceWithTax: z.number().int(),
      linePriceWithTax: z.number().int(),
      productVariant: z.object({
        id: z.string(),
        sku: z.string(),
        name: z.string(),
      }),
    }),
  ),
  payments: z
    .array(
      z.object({
        id: z.string(),
        state: z.string(),
        amount: z.number().int(),
        method: z.string(),
        transactionId: z.string().nullable(),
        refunds: z.array(
          z.object({
            id: z.string(),
            state: z.string(),
            total: z.number().int(),
            lines: z.array(
              z.object({
                orderLineId: z.string(),
              }),
            ),
          }),
        ).nullable(),
      }),
    )
    .nullable(),
  fulfillments: z
    .array(
      z.object({
        id: z.string(),
        state: z.string(),
        method: z.string(),
        trackingCode: z.string().nullable(),
      }),
    )
    .nullable(),
});

const vendureResponseSchema = z.object({
  data: z
    .object({
      orders: z.object({
        totalItems: z.number().int().nonnegative(),
        items: z.array(vendureOrderSchema),
      }),
    })
    .optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      }),
    )
    .optional(),
});
const vendureOrderByIdResponseSchema = z.object({
  data: z.object({ order: vendureOrderSchema.nullable() }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type VendureClientOptions = {
  adminApiUrl: string;
  apiKey: string;
  fetcher?: Fetcher;
};

function money(amountMinor: number, currency: string): Money {
  return {
    amountMinor,
    currency,
  };
}

function toCommerceOrder(
  order: z.infer<typeof vendureOrderSchema>,
): CommerceOrder {
  const currency = order.currencyCode;

  return {
    source: {
      provider: 'vendure',
      orderId: order.id,
    },
    reference: order.code,
    status: order.state,
    active: order.active,
    placedAt: order.orderPlacedAt,
    customer: order.customer
      ? {
          id: order.customer.id,
          name: `${order.customer.firstName} ${order.customer.lastName}`.trim(),
          email: order.customer.emailAddress,
        }
      : null,
    total: money(order.totalWithTax, currency),
    items: order.lines.map((line) => ({
      id: line.id,
      sku: line.productVariant.sku,
      name: line.productVariant.name,
      quantity: line.quantity,
      unitPrice: money(line.unitPriceWithTax, currency),
      lineTotal: money(line.linePriceWithTax, currency),
    })),
    payments: (order.payments ?? []).map((payment) => ({
      id: payment.id,
      status: payment.state,
      amount: money(payment.amount, currency),
      method: payment.method,
      transactionReference: payment.transactionId,
      refunds: (payment.refunds ?? []).map((refund) => ({
        id: refund.id,
        status: refund.state,
        amount: money(refund.total, currency),
        lineIds: refund.lines.map((line) => line.orderLineId),
      })),
    })),
    fulfillments: (order.fulfillments ?? []).map((fulfillment) => ({
      id: fulfillment.id,
      status: fulfillment.state,
      method: fulfillment.method,
      trackingCode: fulfillment.trackingCode,
    })),
  };
}

export function createVendureCommerceProvider(
  options: VendureClientOptions,
): CommerceProvider {
  const fetcher = options.fetcher ?? fetch;

  return {
    async getOrderByReference(reference) {
      const response = await fetcher(options.adminApiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'vendure-api-key': options.apiKey,
        },
        body: JSON.stringify({
          query: orderByCodeQuery,
          variables: {
            options: {
              filter: {
                code: {
                  eq: reference,
                },
              },
              take: 2,
            },
          },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Vendure request failed with HTTP status ${response.status}`,
        );
      }

      const payload = vendureResponseSchema.parse(await response.json());

      if (payload.errors?.length) {
        throw new Error('Vendure returned a GraphQL error');
      }

      if (!payload.data) {
        throw new Error('Vendure returned no GraphQL data');
      }

      if (payload.data.orders.totalItems > 1) {
        throw new Error('Vendure returned duplicate order references');
      }

      const order = payload.data.orders.items[0];
      return order ? toCommerceOrder(order) : null;
    },
    async getOrderById(orderId) {
      const response = await fetcher(options.adminApiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'vendure-api-key': options.apiKey,
        },
        body: JSON.stringify({
          query: orderByIdQuery,
          variables: { id: orderId },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Vendure request failed with HTTP status ${response.status}`,
        );
      }

      const payload = vendureOrderByIdResponseSchema.parse(
        await response.json(),
      );

      if (payload.errors?.length || !payload.data) {
        throw new Error('Vendure returned a GraphQL error');
      }

      return payload.data.order ? toCommerceOrder(payload.data.order) : null;
    },
    async executeRefund(input) {
      const response = await fetcher(options.adminApiUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', 'vendure-api-key': options.apiKey },
        body: JSON.stringify({ query: refundOrderMutation, variables: { input: { paymentId: input.paymentId, amount: input.amount.amountMinor, reason: input.reason } } }),
      });
      if (!response.ok) throw new Error(`Vendure refund failed with HTTP status ${response.status}`);
      const payload = z.object({ data: z.object({ refundOrder: z.object({ __typename: z.string(), id: z.string().optional() }) }).optional(), errors: z.array(z.object({ message: z.string() })).optional() }).parse(await response.json());
      if (payload.errors?.length || !payload.data) throw new Error('Vendure refund GraphQL outcome unknown');
      const result = payload.data.refundOrder;
      if (result.__typename !== 'Refund') return { status: 'FAILED' as const };
      return result.id === undefined
        ? { status: 'SUBMITTED' as const }
        : { status: 'SUBMITTED' as const, providerRefundId: result.id };
    },
  };
}
