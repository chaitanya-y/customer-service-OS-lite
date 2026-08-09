import { z } from 'zod';

const configSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1).default('127.0.0.1:7233'),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('refund-workflows'),
  INTEGRATION_GATEWAY_BASE_URL: z.url(),
  TENANT_ID: z.string().min(1),
  ENVIRONMENT_ID: z.string().min(1),
  WORKFLOW_ACCESS_HMAC_SECRET: z.string().min(32),
  WORKFLOW_ACCESS_ISSUER: z.string().min(1).default('customer-service-os-workflow-workers'),
});

export type WorkflowWorkerConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkflowWorkerConfig {
  return configSchema.parse(environment);
}
