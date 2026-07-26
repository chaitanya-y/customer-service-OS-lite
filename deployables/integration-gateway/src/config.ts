import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  VENDURE_ADMIN_API_URL: z.url(),
  VENDURE_API_KEY: z.string().min(1),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment);
}
