import { z } from 'zod';

import { loadConfig } from './config.js';
import { signLocalCustomerAccessToken } from './local-customer-auth.js';

const customerIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const config = loadConfig();
const customerId = customerIdSchema.parse(process.env.LOCAL_CUSTOMER_ID);
const token = await signLocalCustomerAccessToken({
  secret: config.LOCAL_AUTH_HMAC_SECRET,
  issuer: config.LOCAL_AUTH_ISSUER,
  audience: config.LOCAL_AUTH_AUDIENCE,
  identity: {
    principalId: customerId,
    tenantId: config.TENANT_ID,
    environmentId: config.ENVIRONMENT_ID,
    customerId,
  },
});

process.stdout.write(`${token}\n`);
