import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    /** The share-link host; must match the app's LINK_HOST (Android manifest, iOS entitlements). */
    PUBLIC_HOST: z
      .string()
      .regex(/^[a-z0-9.-]+$/, 'PUBLIC_HOST is a bare hostname, e.g. links.example.com')
      .default('links.example.com'),
    /** The API as this container reaches it (Docker network), without the /v1 prefix. */
    API_INTERNAL_URL: z.url().default('http://localhost:3000'),
    /** Same value as the API's LINK_SERVICE_KEY: previews are then rate limited per visitor. */
    LINK_SERVICE_KEY: z.string().min(16).optional(),
    /** Header the edge proxy puts the visitor IP in. For x-forwarded-for the last entry is used. */
    CLIENT_IP_HEADER: z.string().toLowerCase().default('x-forwarded-for'),
    ANDROID_PACKAGE: z
      .string()
      .regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/)
      .default('com.bigbosslive.bigboss_live'),
    ANDROID_SHA256_FINGERPRINTS: csv.pipe(
      z.array(z.string().regex(FINGERPRINT, 'expected AA:BB:… (32 bytes, hex)')),
    ),
    IOS_BUNDLE_ID: z
      .string()
      .regex(/^[a-zA-Z][\w-]*(\.[\w-]+)+$/)
      .default('com.bigbosslive.bigbossLive'),
    APPLE_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/, 'APPLE_TEAM_ID is the 10-character Team ID')
      .optional(),
    IOS_APP_STORE_ID: z
      .string()
      .regex(/^\d{6,12}$/, 'IOS_APP_STORE_ID is the numeric App Store id')
      .optional(),
    /** The Play listing once published, or an APK download page. Unset = "coming soon". */
    ANDROID_STORE_URL: z.url().startsWith('https://').optional(),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== 'production') return;
    if (c.ANDROID_SHA256_FINGERPRINTS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'ANDROID_SHA256_FINGERPRINTS is required in production (upload + Play App Signing keys)',
      });
    }
    if (!c.LINK_SERVICE_KEY) {
      ctx.addIssue({ code: 'custom', message: 'LINK_SERVICE_KEY is required in production' });
    }
  });

export type RawConfig = z.infer<typeof configSchema>;

export interface Config extends RawConfig {
  androidStoreUrl: string | null;
  appStoreUrl: string | null;
  /** `TEAMID.bundle` when the Team ID is known; iOS verification is off without it. */
  iosAppId: string | null;
}

/** Parse and validate env. A blank variable means "not set" (compose passes `VAR=""`). */
export function loadConfig(raw: Record<string, unknown> = process.env): Config {
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => !(typeof v === 'string' && v.trim() === '')),
  );
  const parsed = configSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  return {
    ...c,
    androidStoreUrl: c.ANDROID_STORE_URL ?? null,
    appStoreUrl: c.IOS_APP_STORE_ID ? `https://apps.apple.com/app/id${c.IOS_APP_STORE_ID}` : null,
    iosAppId: c.APPLE_TEAM_ID ? `${c.APPLE_TEAM_ID}.${c.IOS_BUNDLE_ID}` : null,
  };
}
