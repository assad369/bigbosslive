import { z } from 'zod';
import type { StorageSettingsView } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import { s3SettingsFromEnv, type S3Settings } from '../../infra/storage.js';
import { badRequest } from '../../lib/errors.js';

/** Kept outside `CONFIG_SCHEMAS`, so the generic `/admin/config` listing never includes it. */
const DOC_ID = 'storage';
const CACHE_TTL_MS = 30_000;
const R2_ENDPOINT = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com\/?$/;

export const storageSettingsInput = z.object({
  accountId: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{32}$/, 'Cloudflare account ID is 32 hex characters'),
  bucket: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'Invalid bucket name'),
  accessKeyId: z.string().trim().min(1).max(128),
  secretAccessKey: z.string().trim().min(1).max(256).optional(),
  publicBaseUrl: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/$/, '')),
});

type Stored = Required<z.output<typeof storageSettingsInput>>;

/**
 * Cloudflare R2 credentials editable from the dashboard. A saved document overrides the
 * `S3_*` env variables; clearing it falls back to them. Other replicas pick up a change
 * within the cache TTL.
 */
export class StorageSettingsService {
  private cache: { value: S3Settings | null; at: number } | null = null;

  constructor(private readonly ctx: Ctx) {}

  private async stored(): Promise<{ value: Stored; updatedAt: Date } | null> {
    const doc = await this.ctx.col.appConfig.findOne({ _id: DOC_ID });
    if (!doc) return null;
    const parsed = storageSettingsInput.required().safeParse(doc.value);
    if (!parsed.success) {
      this.ctx.log.error({ issues: parsed.error.issues }, 'stored storage settings invalid');
      return null;
    }
    return { value: parsed.data, updatedAt: doc.updatedAt };
  }

  /** What the storage gateway uses. */
  async resolve(): Promise<S3Settings | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.value;
    const doc = await this.stored();
    const value = doc
      ? {
          endpoint: `https://${doc.value.accountId}.r2.cloudflarestorage.com`,
          region: 'auto',
          bucket: doc.value.bucket,
          accessKeyId: doc.value.accessKeyId,
          secretAccessKey: doc.value.secretAccessKey,
          publicBaseUrl: doc.value.publicBaseUrl,
        }
      : s3SettingsFromEnv(this.ctx.env);
    this.cache = { value, at: Date.now() };
    return value;
  }

  async view(): Promise<StorageSettingsView> {
    const doc = await this.stored();
    const env = doc ? null : s3SettingsFromEnv(this.ctx.env);
    const cfg = doc
      ? { ...doc.value }
      : env && {
          accountId: R2_ENDPOINT.exec(env.endpoint ?? '')?.[1] ?? '',
          bucket: env.bucket,
          accessKeyId: env.accessKeyId,
          secretAccessKey: env.secretAccessKey,
          publicBaseUrl: env.publicBaseUrl,
        };
    return {
      source: doc ? 'database' : env ? 'env' : 'none',
      accountId: cfg?.accountId ?? '',
      bucket: cfg?.bucket ?? '',
      accessKeyId: cfg?.accessKeyId ?? '',
      publicBaseUrl: cfg?.publicBaseUrl ?? '',
      secretSet: Boolean(cfg?.secretAccessKey),
      secretHint: cfg?.secretAccessKey ? `••••${cfg.secretAccessKey.slice(-4)}` : null,
      updatedAt: doc?.updatedAt.toISOString() ?? null,
    };
  }

  /** Returns whether the secret changed, for the audit log (which must never see it). */
  async set(input: unknown, adminId: string): Promise<{ secretChanged: boolean }> {
    const parsed = storageSettingsInput.safeParse(input);
    if (!parsed.success) {
      throw badRequest(
        'Invalid storage settings',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const secretAccessKey =
      parsed.data.secretAccessKey ?? (await this.stored())?.value.secretAccessKey;
    if (!secretAccessKey) throw badRequest('Secret access key is required');
    const value: Stored = { ...parsed.data, secretAccessKey };
    await this.ctx.col.appConfig.updateOne(
      { _id: DOC_ID },
      { $set: { value, updatedAt: this.ctx.clock.now(), updatedBy: adminId } },
      { upsert: true },
    );
    this.cache = null;
    return { secretChanged: parsed.data.secretAccessKey !== undefined };
  }

  /** Drop the dashboard settings and fall back to env. */
  async clear(): Promise<void> {
    await this.ctx.col.appConfig.deleteOne({ _id: DOC_ID });
    this.cache = null;
  }
}
