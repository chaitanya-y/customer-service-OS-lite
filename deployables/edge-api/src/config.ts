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
    TENANT_ID: z.string().min(1),
    ENVIRONMENT_ID: z.string().min(1),
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
  });

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment);
}
