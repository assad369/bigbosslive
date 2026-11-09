import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: csv.default([]),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  /**
   * Shared with link-web, which renders share-link pages for every visitor from one address:
   * with this key, its `X-Client-Ip` header (the visitor) is what the preview rate limit counts.
   */
  LINK_SERVICE_KEY: z.string().min(16).optional(),

  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default('bigbosslive'),

  REDIS_URL: z.string().optional(),

  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_BASE64: z.string().optional(),

  LIVEKIT_URL: z.string().default(''),
  LIVEKIT_API_KEY: z.string().default(''),
  LIVEKIT_API_SECRET: z.string().default(''),
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 60 * 60),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),
  /** Second factor for viewing or changing storage credentials in the admin dashboard. */
  STORAGE_SETTINGS_PASSCODE: z.string().min(4).default('9797'),

  // In-app purchases (diamond recharge). Leave unset to disable a store.
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  APPLE_BUNDLE_ID: z.string().optional(),
  APPLE_ISSUER_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  /** Base64 of the App Store Connect API .p8 private key. */
  APPLE_PRIVATE_KEY_BASE64: z.string().optional(),
  APPLE_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),

  /**
   * SightGuard content moderation (images, text, video, live streams). Off unless enabled: when
   * off every check allows and nothing is sent. See CLAUDE.md "Content moderation".
   */
  SIGHTGUARD_ENABLED: bool.default(false),
  SIGHTGUARD_API_URL: z.url().optional(),
  SIGHTGUARD_API_KEY: z.string().startsWith('sg_live_').optional(),
  /** Signing secret of the SightGuard webhook endpoint pointing at /v1/webhooks/sightguard. */
  SIGHTGUARD_WEBHOOK_SECRET: z.string().min(16).optional(),
  /** LiveKit connection id from the SightGuard dashboard. Unset = live streams unsupervised. */
  SIGHTGUARD_LIVEKIT_CONNECTION_ID: z.string().optional(),
  /** Time budget for a live chat check; on timeout the message goes through (fail open). */
  SIGHTGUARD_CHAT_TIMEOUT_MS: z.coerce.number().int().min(50).max(5000).default(300),
  /**
   * Ban automatically when SightGuard ends a stream and recommends a ban, or a moderator
   * confirms a live violation. Off by default: moderators confirm bans themselves.
   */
  SIGHTGUARD_AUTO_BAN: bool.default(false),

  JOBS_ENABLED: bool.default(true),
  AGENCY_RESET_TIMEZONE: z.string().default('Asia/Dhaka'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parse and validate process env. Throws with every problem listed, so a bad deploy fails at boot. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings as "unset" so `.env` placeholders fall back to defaults.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const env = parsed.data;
  if (
    env.SIGHTGUARD_ENABLED &&
    !(env.SIGHTGUARD_API_URL && env.SIGHTGUARD_API_KEY && env.SIGHTGUARD_WEBHOOK_SECRET)
  ) {
    throw new Error(
      'SIGHTGUARD_API_URL, SIGHTGUARD_API_KEY and SIGHTGUARD_WEBHOOK_SECRET are required when SIGHTGUARD_ENABLED',
    );
  }
  if (env.NODE_ENV === 'production') {
    const missing = (
      [
        'REDIS_URL',
        'LIVEKIT_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'FIREBASE_PROJECT_ID',
      ] as const
    ).filter((k) => !env[k]);
    if (missing.length) {
      throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
    }
  }
  return env;
}
