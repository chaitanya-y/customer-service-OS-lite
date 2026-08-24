export type Money = {
  amountMinor: number;
  currency: string;
};

export type CommerceOrder = {
  source: {
    provider: string;
    orderId: string;
  };
  reference: string;
  status: string;
  active: boolean;
  placedAt: string | null;
  customer: {
    id: string;
    name: string;
    email: string;
  } | null;
  total: Money;
  items: Array<{
    id: string;
    sku: string;
    name: string;
    quantity: number;
    unitPrice: Money;
    lineTotal: Money;
  }>;
  payments: Array<{
    id: string;
    status: string;
    amount: Money;
    method: string;
    transactionReference: string | null;
    refunds: Array<{
      id: string;
      status: string;
      amount: Money;
      lineIds: string[];
    }>;
  }>;
  fulfillments: Array<{
    id: string;
    status: string;
    method: string;
    trackingCode: string | null;
  }>;
};

export interface CommerceProvider {
  getOrderByReference(reference: string): Promise<CommerceOrder | null>;
  getOrderById(orderId: string): Promise<CommerceOrder | null>;
  executeRefund?(input: {
    paymentId: string;
    amount: Money;
    reason: string;
  }): Promise<{ status: 'SUCCEEDED' | 'FAILED'; providerRefundId?: string }>;
}
