import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3003),
  DATABASE_URL: z.string().min(1),
  TENANT_ID: z.string().min(1),
  ENVIRONMENT_ID: z.string().min(1),
  CONTEXT_ASSERTION_HMAC_SECRET: z.string().min(32),
  CONTEXT_ASSERTION_ISSUER: z
    .string()
    .min(1)
    .default('customer-service-os-edge'),
  CONTEXT_ASSERTION_AUDIENCE: z
    .string()
    .min(1)
    .default('conversation-runtime'),
  MESSAGE_ENCRYPTION_KEY_BASE64: z.string().min(1),
  MESSAGE_ENCRYPTION_KEY_VERSION: z.string().min(1).default('local-v1'),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment);
}

export function decodeMessageEncryptionKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');

  if (key.byteLength !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error(
      'Message encryption key must be exactly 32 bytes encoded as base64',
    );
  }

  return key;
}
