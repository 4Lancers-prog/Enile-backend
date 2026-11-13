import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const secret = z.string().min(32, 'must be at least 32 characters');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  MONGODB_URI: z.string().min(1),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(20),
  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  FILE_URL_SECRET: secret,
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  STORAGE_DIR: z.string().default('./storage'),
  // Optional: folder of the built frontend (enile-crm-frontend/dist) to serve from the same origin.
  CLIENT_DIST_DIR: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(10),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('Enile CRM <no-reply@enile.local>'),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  WORKER_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  SCHEDULER_INTERVAL_MIN: z.coerce.number().int().min(1).default(60),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@enile.local'),
  SEED_ADMIN_PASSWORD: z.string().min(10).default('ChangeMe!2026'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot: never run with missing or weak secrets.
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
  maxUploadBytes: Math.round(parsed.data.MAX_UPLOAD_MB * 1024 * 1024),
};
