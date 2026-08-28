import { z } from 'zod';

const configSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    AUTH_MODE: z.literal('local').default('local'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    AGENT_RUNTIME_BASE_URL: z.url().default('http://127.0.0.1:8000'),
    AGENT_RUNTIME_TIMEOUT_MILLISECONDS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(60_000),
    CONVERSATION_RUNTIME_BASE_URL: z
      .url()
      .default('http://127.0.0.1:3004'),
    CONVERSATION_RUNTIME_TIMEOUT_MILLISECONDS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(15_000),
    TEMPORAL_ADDRESS: z.string().min(1).default('127.0.0.1:7233'),
    TEMPORAL_TASK_QUEUE: z.string().min(1).default('refund-workflows'),
    REFUND_POLICY_VERSION: z.string().min(1).default('refund-policy-v1'),
    TENANT_ID: z.string().min(1),
    ENVIRONMENT_ID: z.string().min(1),
    HOME_REGION: z.string().min(1).default('local'),
    HOME_CELL: z.string().min(1).default('local-cell-1'),
    ROUTING_EPOCH: z.coerce.number().int().min(1).default(1),
    LOCAL_AUTH_HMAC_SECRET: z.string().min(32),
    LOCAL_AUTH_ISSUER: z
      .string()
      .min(1)
      .default('customer-service-os-local-auth'),
    LOCAL_AUTH_AUDIENCE: z
      .string()
      .min(1)
      .default('customer-service-os-edge'),
    CONTEXT_ASSERTION_HMAC_SECRET: z.string().min(32),
    CONTEXT_ASSERTION_ISSUER: z
      .string()
      .min(1)
      .default('customer-service-os-edge'),
    CONTEXT_ASSERTION_AUDIENCE: z
      .string()
      .min(1)
      .default('integration-gateway'),
    AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE: z
      .string()
      .min(1)
      .default('agent-runtime'),
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE: z
      .string()
      .min(1)
      .default('knowledge-rag'),
    CONVERSATION_RUNTIME_CONTEXT_ASSERTION_AUDIENCE: z
      .string()
      .min(1)
      .default('conversation-runtime'),
    EDGE_SERVICE_ASSERTION_HMAC_SECRET: z.string().min(32),
    EDGE_SERVICE_ASSERTION_ISSUER: z
      .string()
      .min(1)
      .default('customer-service-os-edge'),
    EDGE_SERVICE_ASSERTION_AUDIENCE: z
      .string()
      .min(1)
      .default('conversation-runtime'),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === 'production' && config.AUTH_MODE === 'local') {
      context.addIssue({
        code: 'custom',
        message: 'Local authentication cannot run in production',
        path: ['AUTH_MODE'],
      });
    }

    if (
      config.LOCAL_AUTH_HMAC_SECRET ===
      config.CONTEXT_ASSERTION_HMAC_SECRET
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Local authentication and context signing require separate keys',
        path: ['CONTEXT_ASSERTION_HMAC_SECRET'],
      });
    }

    if (
      config.EDGE_SERVICE_ASSERTION_HMAC_SECRET ===
        config.LOCAL_AUTH_HMAC_SECRET ||
      config.EDGE_SERVICE_ASSERTION_HMAC_SECRET ===
        config.CONTEXT_ASSERTION_HMAC_SECRET
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Edge service assertions require a separate key from customer authentication and context signing',
        path: ['EDGE_SERVICE_ASSERTION_HMAC_SECRET'],
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment);
}
