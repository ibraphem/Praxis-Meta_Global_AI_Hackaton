import { z } from 'zod';

const integer = (fallback: number, max: number) =>
  z.coerce.number().int().positive().max(max).default(fallback);

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: integer(3000, 65535),
  META_API_KEY: z.string().trim().min(1),
  META_BASE_URL: z.url().default('https://api.meta.ai/v1'),
  META_SAM_MODEL: z.string().trim().min(1).max(100).default('sam-3.1'),
  META_REASONING_MODEL: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default('muse-spark-1.3'),
  VISION_MODE: z.enum(['combined', 'reasoning-only']).default('combined'),
  PRAXIS_API_TOKEN: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).max(256).optional(),
  ),
  MAX_UPLOAD_BYTES: integer(8 * 1024 * 1024, 20 * 1024 * 1024),
  MAX_IMAGE_PIXELS: integer(16_000_000, 25_000_000),
  MAX_CONCURRENT_ANALYSES: integer(2, 8),
  JOB_WORKER_CONCURRENCY: integer(1, 8),
  WIRE_AUDIT_MAX_DIMENSION: integer(1280, 2048),
  WIRE_RECOVERY_MAX_REQUESTS: z.coerce.number().int().min(0).max(12).default(4),
  WIRE_RECOVERY_REQUESTS_PER_ROUND: integer(2, 4),
  WIRE_RECOVERY_MAX_ROUNDS: integer(2, 4),
  WIRE_RECOVERY_MAX_PIXELS: integer(6000000, 16000000),
  WIRE_RECOVERY_MAX_CROP_PIXELS: integer(2000000, 4000000),
  WIRE_RECOVERY_TIMEOUT_MS: integer(60000, 120000),
  WIRE_VERIFY_MAX_REQUESTS: integer(8, 16),
  SAM_CONCURRENCY: integer(2, 4),
  MAX_WIRE_REFINEMENTS: z.coerce.number().int().min(0).max(16).default(6),
  REFINEMENT_TIMEOUT_MS: integer(15_000, 45_000),
  ANALYSIS_TIMEOUT_MS: integer(180_000, 300_000),
  PROVIDER_TIMEOUT_MS: integer(45_000, 120_000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
  ANALYSIS_JOB_DIR: z.string().min(1).default('.praxis-jobs'),
  MAX_STORED_JOBS: integer(100, 1000),
  JOB_RETENTION_HOURS: integer(24, 168),
  MUSE_MAX_DIMENSION: z.coerce.number().int().min(0).max(4096).default(0),
  MUSE_MINIMAL_PROMPT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  RATE_LIMIT_MAX: integer(20, 1000),
  RATE_LIMIT_WINDOW_MS: integer(60_000, 3_600_000),
});

/** Validate at startup without ever printing environment values or secrets. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  const config = result.data;
  const endpoint = new URL(config.META_BASE_URL);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'META_BASE_URL must be an HTTPS URL without credentials, query, or fragment.',
    );
  }
  const local = ['127.0.0.1', '::1', 'localhost'].includes(config.HOST);
  if (
    (!local || config.NODE_ENV === 'production') &&
    !config.PRAXIS_API_TOKEN
  ) {
    throw new Error(
      'PRAXIS_API_TOKEN is required outside loopback development.',
    );
  }
  if (config.PRAXIS_API_TOKEN === config.META_API_KEY) {
    throw new Error('PRAXIS_API_TOKEN must differ from META_API_KEY.');
  }
  return Object.freeze(config);
}

export type Config = ReturnType<typeof loadConfig>;
