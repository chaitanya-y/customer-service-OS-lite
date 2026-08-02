export type AuthenticatedCustomer = {
  principalId: string;
  tenantId: string;
  environmentId: string;
  customerId: string;
};

export type VerifyCustomerIdentity = (
  accessToken: string | undefined,
) => Promise<AuthenticatedCustomer>;

export class CustomerAuthenticationError extends Error {
  constructor() {
    super('Customer authentication is invalid');
    this.name = 'CustomerAuthenticationError';
  }
}
