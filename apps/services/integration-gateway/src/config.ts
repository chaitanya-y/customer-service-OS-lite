import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  DATABASE_URL: z.string().min(1),
  VENDURE_ADMIN_API_URL: z.url(),
  VENDURE_API_KEY: z.string().min(1),
  TENANT_ID: z.string().min(1),
  ENVIRONMENT_ID: z.string().min(1),
  CONTEXT_ASSERTION_HMAC_SECRET: z.string().min(32),
  CONTEXT_ASSERTION_ISSUER: z
    .string()
    .min(1)
    .default('customer-service-os-edge'),
  WORKFLOW_ACCESS_HMAC_SECRET: z.string().min(32),
  WORKFLOW_ACCESS_ISSUER: z
    .string()
    .min(1)
    .default('customer-service-os-workflow-workers'),
  TEMPORAL_ADDRESS: z.string().min(1).default('127.0.0.1:7233'),
  PROVIDER_WEBHOOK_HMAC_SECRET: z.string().min(32).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment);
}
