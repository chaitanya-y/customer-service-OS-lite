import { z } from 'zod';

import { signLocalHumanAccessAssertion } from './local-human-access.js';

const config = z.object({
  HUMAN_ACCESS_HMAC_SECRET: z.string().min(32),
  HUMAN_ACCESS_ISSUER: z.string().min(1).default('customer-service-os-human-operations'),
  TENANT_ID: z.string().min(1),
  ENVIRONMENT_ID: z.string().min(1),
  LOCAL_HUMAN_STAFF_ID: z.string().min(1).default('local-refund-supervisor'),
  LOCAL_HUMAN_ROLE: z.enum(['REFUND_APPROVER', 'REFUND_SUPERVISOR']).default('REFUND_SUPERVISOR'),
}).parse(process.env);

const token = await signLocalHumanAccessAssertion({
  secret: config.HUMAN_ACCESS_HMAC_SECRET,
  issuer: config.HUMAN_ACCESS_ISSUER,
  audience: 'human-operations',
  identity: {
    staffId: config.LOCAL_HUMAN_STAFF_ID,
    tenantId: config.TENANT_ID,
    environmentId: config.ENVIRONMENT_ID,
    role: config.LOCAL_HUMAN_ROLE,
  },
});

process.stdout.write(`${token}\n`);
